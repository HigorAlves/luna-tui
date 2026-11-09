// Memory at boot (RFC 0007): the port is `noMemory()` until Cognee answers, then the real one, so a Cognee that is down at boot (or off)
// never blocks the machine and every caller keeps one object. The machine tries again every minute until it connects, then sends the
// writes still `pending` every minute and lines Cognee up with the table every hour.
import type { MemoryFloor } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import { type CogneeClient, cogneeClient } from "../adapters/cognee/client.ts";
import { type MemoryService, cogneeMemory } from "../adapters/cognee/memory.ts";
import { PgMemoryStore } from "../adapters/persistence/memory-store.ts";
import { type Memory, noMemory } from "../application/memory.ts";
import type { MemoryConfig } from "../config.ts";

export interface MemoryBoot {
  /** What every stage, route and loop calls: forwards to the real memory once it is connected, answers nothing before. */
  memory: Memory;
  /** The Floor's numbers; always an object (`enabled: false` with the reason while off or not connected). */
  floor(): Promise<MemoryFloor>;
  /** Connects (retrying), then runs the retry and reconcile loops. Returns at once. */
  start(): void;
  stop(): void;
}

export interface MemoryBootOptions {
  config: MemoryConfig;
  db: DataSource;
  log?: (event: Record<string, unknown>) => void;
  /** For tests. */
  makeClient?: (config: MemoryConfig & { password: string }) => CogneeClient;
  retryMs?: number;
  /** Called once, when Cognee first takes the login: what the boot skipped while memory was quiet (the docs, the code graph, the company folder) can be synced at once instead of at the next timer. */
  onConnected?: () => void;
  reconcileMs?: number;
}

const off = (note: string, cap: number): MemoryFloor => ({ enabled: false, mode: null, cognifiedToday: 0, dailyCognifyItems: cap, tokensToday: null, costUsdToday: null, pending: 0, items: 0, note });

export function memoryBoot(options: MemoryBootOptions): MemoryBoot {
  const { config } = options;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  let service: MemoryService | null = null;
  let why: string | null = config.enabled ? "memory is starting: Cognee has not answered yet" : "memory is off (MACHINE_MEMORY=off)";
  const timers: NodeJS.Timeout[] = [];
  const quiet = noMemory();
  const current = (): Memory => service ?? quiet;

  // One object for the callers whichever way boot went: each call goes to whatever is current.
  const memory: Memory = {
    get enabled() {
      return current().enabled;
    },
    get mode() {
      return current().mode;
    },
    write: (items) => current().write(items),
    cognify: (datasets) => current().cognify(datasets),
    ingestDoc: (doc) => current().ingestDoc(doc),
    removeDoc: (doc) => current().removeDoc(doc),
    ingestCode: (code) => current().ingestCode(code),
    recall: (query) => current().recall(query),
    code: (query) => current().code(query),
    answer: (query) => current().answer(query),
    forget: (id, by, reason) => current().forget(id, by, reason),
    setStatus: (id, status, note) => current().setStatus(id, status, note),
    list: (filter) => current().list(filter),
    get: (id) => current().get(id),
    adopt: (id, by) => current().adopt(id, by),
    reconcile: () => current().reconcile(),
    usage: () => current().usage(),
  };

  async function connect(): Promise<boolean> {
    if (config.password === null) {
      why = "memory has no Cognee password: run `pnpm start` (it makes ~/.config/hardness/cognee-password)";
      return false;
    }
    const client = (options.makeClient ?? ((c) => cogneeClient({ baseUrl: c.url, email: c.email, password: c.password })))({ ...config, password: config.password });
    try {
      await client.connect();
    } catch (error) {
      why = `memory is off: Cognee at ${config.url} did not take the login (${error instanceof Error ? error.message : String(error)}); trying again`.slice(0, 300);
      return false;
    }
    service = cogneeMemory({ client, store: new PgMemoryStore(options.db), mode: config.mode, dailyCognifyItems: config.dailyCognifyItems, log });
    why = null;
    log({ event: "memory.connected", url: config.url, mode: config.mode });
    return true;
  }

  return {
    memory,
    async floor() {
      if (!service) return off(why ?? "memory is off", config.dailyCognifyItems);
      return service.floor();
    },
    start() {
      if (!config.enabled) return;
      const retryMs = options.retryMs ?? 60_000;
      const reconcileMs = options.reconcileMs ?? 60 * 60_000;
      const loop = (): void => {
        void (async () => {
          if (!service) {
            if (await connect()) {
              void memory.reconcile();
              try {
                options.onConnected?.();
              } catch (error) {
                log({ event: "memory.on_connected_failed", error: String(error).slice(0, 200) });
              }
            }
            return;
          }
          await service.retryPending();
        })().catch((error: unknown) => log({ event: "memory.loop_failed", error: String(error).slice(0, 200) }));
      };
      loop();
      timers.push(setInterval(loop, retryMs).unref(), setInterval(() => void service?.reconcile(), reconcileMs).unref());
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  };
}
