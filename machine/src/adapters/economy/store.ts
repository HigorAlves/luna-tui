// The economy's state per repository, in the machine's own state: `<stateDir>/economy/<repo slug>/` holds `envelope.json` (the tool-call counts of
// passing runs, per pack), `ledger.jsonl` (one record per run) and `guard.jsonl` (what the loop guard did, the newest kept). Folders are 0700, files
// 0600, a JSON file is replaced through tmp + rename, and writes to one file are served one at a time. A file that cannot be read or parsed reads as empty.
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GuardEventRow } from "@hardness/contracts";

import type { EconomyStore } from "../../application/economy.ts";
import type { LedgerRecord } from "../../domain/economy/ledger.ts";
import { repoSlug } from "../graph/slug.ts";
import { readRegularFile } from "../fs/bounded.ts";

const READ_CAP = 16 * 1024 * 1024;
/** The run's own events, as the factory wrote them. */
const EVENTS_CAP = 32 * 1024 * 1024;
const GUARD_KEEP = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The parsed lines of a jsonl text; a line that does not parse is dropped. */
function lines(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export function fileStore(stateDir: string): EconomyStore {
  const root = join(stateDir, "economy");
  const folder = (repoPath: string) => join(root, repoSlug(repoPath));
  const queues = new Map<string, Promise<unknown>>();
  /** Runs `job` after every earlier job on the same file. */
  const serial = <T>(path: string, job: () => Promise<T>): Promise<T> => {
    const run = (queues.get(path) ?? Promise.resolve()).then(job);
    queues.set(path, run.catch(() => undefined));
    return run;
  };
  const ensure = async (dir: string) => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
  };
  const replace = async (path: string, text: string) => {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  };
  const readText = async (path: string, cap = READ_CAP): Promise<string> => {
    try {
      return await readRegularFile(path, cap);
    } catch {
      return "";
    }
  };
  const readLines = async (path: string): Promise<unknown[]> => lines(await readText(path));
  const readEnvelopes = async (path: string): Promise<Record<string, number[]>> => {
    try {
      const parsed = JSON.parse(await readText(path)) as unknown;
      if (!isRecord(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).flatMap(([pack, samples]) => (Array.isArray(samples) && samples.every((n) => typeof n === "number" && Number.isFinite(n)) ? [[pack, samples as number[]]] : [])));
    } catch {
      return {};
    }
  };
  const append = (path: string, rows: unknown[]) =>
    serial(path, async () => {
      await ensure(join(path, ".."));
      await appendFile(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    });

  return {
    envelopes: (repoPath) => readEnvelopes(join(folder(repoPath), "envelope.json")),
    updateEnvelopes: (repoPath, change) => {
      const path = join(folder(repoPath), "envelope.json");
      return serial(path, async () => {
        const next = change(await readEnvelopes(path));
        await ensure(folder(repoPath));
        await replace(path, JSON.stringify(next));
      });
    },
    appendLedger: (repoPath, record) => append(join(folder(repoPath), "ledger.jsonl"), [record]),
    ledger: async (repoPath) => (await readLines(join(folder(repoPath), "ledger.jsonl"))).filter(isRecord) as unknown as LedgerRecord[],
    appendGuard: (repoPath, rows) => {
      const path = join(folder(repoPath), "guard.jsonl");
      // The file is cut back to the newest rows once it holds more than the cap; before that a row is one append.
      return serial(path, async () => {
        await ensure(folder(repoPath));
        const have = (await readLines(path)).filter(isRecord);
        const all = [...have, ...rows];
        if (all.length > GUARD_KEEP) await replace(path, all.slice(-GUARD_KEEP).map((r) => `${JSON.stringify(r)}\n`).join(""));
        else await appendFile(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
      });
    },
    guard: async (repoPath) => (await readLines(join(folder(repoPath), "guard.jsonl"))).filter(isRecord).slice(-GUARD_KEEP) as unknown as GuardEventRow[],
    events: async (runId) => lines(await readText(join(stateDir, "runs", runId, "out", "events.jsonl"), EVENTS_CAP)),
  };
}
