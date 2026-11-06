// The app the browser run drives, started by the machine (`verify.e2e.start`): its own container on its own network with the `check` list, the
// repository's services beside it, the seed run first, and the app only counted ready when the configured path answers from inside its container.
// The browser run's own network (the `agent` list) joins the app's; the app never gets the agent's proxy or the engine's host, and no port is
// published on the host. What the app and the seed print is untrusted: flattened, capped and redacted before it is in a reason.
import { cacheVolumeFor, type SandboxExec, SecretsMissingError } from "../adapters/docker/docker.ts";
import { APP_ALIAS, appArgs, probeArgs } from "../adapters/docker/app.ts";
import type { BlockedRow, CardNetwork, openCardNetwork } from "../adapters/docker/egress.ts";
import type { startServices } from "../adapters/docker/services.ts";
import type { ExecResult } from "../adapters/process/exec.ts";
import { safe } from "../domain/evidence-markdown.ts";
import { secretRedactor } from "../domain/redact-secrets.ts";
import type { Policy } from "../domain/policy.ts";
import type { EgressPolicy } from "./egress-policy.ts";
import type { InstallInput, InstallOutcome } from "./install.ts";
import type { SecretStore } from "./secrets.ts";

export type E2eMode = "deploy" | "start" | "target" | "agent";

/** deploy when the repository names a preview, else start when it names a start command, else target when it has QA targets, else the agent boots its own server. */
export function e2eModeOf(policy: Pick<Policy, "qaTargets" | "factory">): E2eMode {
  const e2e = policy.factory.verify.e2e;
  if (e2e.deploy.url_pattern) return "deploy";
  if (e2e.start.command) return "start";
  return policy.qaTargets.length > 0 ? "target" : "agent";
}

export interface AppDeps {
  policies: { for(repoPath: string): Promise<Policy> };
  imageFor(repoPath: string, taskId: string): Promise<string>;
  install(input: InstallInput): Promise<InstallOutcome>;
  egress?: EgressPolicy;
  secrets?: SecretStore;
  openCardNetwork: typeof openCardNetwork;
  startServices: typeof startServices;
  exec(run: SandboxExec, options: { timeoutMs?: number }): Promise<ExecResult & { blocked?: BlockedRow[] }>;
  docker(args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface OpenAppInput {
  taskId: string;
  repoPath: string;
  workspace: string;
  commit: string;
  attempt: number;
  signal?: AbortSignal;
  /** What the app's proxy refused, once per row, as `seed` and then `app`. */
  onBlocked(step: "seed" | "app", rows: BlockedRow[]): void;
}

export interface OpenedApp {
  ok: true;
  target: { name: "app"; baseUrl: string };
  /** The app's network, for the browser run to join. */
  network: string;
  /** Names the browser run reaches directly (not through its proxy). */
  aliases: string[];
  close(): Promise<void>;
}
export type OpenAppResult = OpenedApp | { ok: false; detail: Record<string, unknown> };

const SEED_TIMEOUT_MS = 10 * 60_000;
const LOG_TAIL = 40;
const REASON_CAP = 1500;

export async function openApp(deps: AppDeps, input: OpenAppInput): Promise<OpenAppResult> {
  const policy = await deps.policies.for(input.repoPath);
  const { start, seed } = policy.factory.verify.e2e;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const runName = `${input.taskId.slice(0, 8)}-app-${input.attempt}`;
  const container = `hardness-${runName}`;

  // The secrets first: a step whose secret is missing does not run.
  const names = [...new Set([...start.secrets, ...seed.secrets])];
  let values: Record<string, string> = {};
  if (names.length > 0) {
    const loaded = deps.secrets ? await deps.secrets.load(input.repoPath, names) : { values: {}, missing: names.map((name) => ({ name, reason: "no secrets store is configured" })) };
    if (loaded.missing.length > 0) return { ok: false, detail: new SecretsMissingError(loaded.missing, deps.secrets?.folder(input.repoPath) ?? "(no secrets store)").detail };
    values = loaded.values;
  }
  const pick = (list: readonly string[]): Record<string, string> => Object.fromEntries(list.map((n) => [n, values[n]!]));
  const redact = secretRedactor(values);
  const text = (raw: string): string => safe(redact(raw)).slice(0, REASON_CAP);

  const installed = await deps.install({ taskId: input.taskId, repoPath: input.repoPath, workspace: input.workspace, commit: input.commit, ...(input.signal ? { signal: input.signal } : {}) });
  if (!installed.ok) return { ok: false, detail: installed.detail };

  const image = await deps.imageFor(input.repoPath, input.taskId);
  const spec = deps.egress ? await deps.egress.for({ repoPath: input.repoPath, kind: "check" }) : { allow: [], allowPrivate: [], proxyImage: image };
  const card: CardNetwork = await deps.openCardNetwork(runName, spec, { proxyImage: spec.proxyImage });
  let services: Awaited<ReturnType<typeof startServices>> | null = null;
  const seen = new Set<string>();
  const report = async (step: "seed" | "app"): Promise<void> => {
    const fresh = (await card.blocked()).filter((row) => !seen.has(`${row.via}|${row.host}|${row.port}`));
    for (const row of fresh) seen.add(`${row.via}|${row.host}|${row.port}`);
    if (fresh.length > 0) input.onBlocked(step, fresh);
  };
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await report("app").catch(() => {});
    await deps.docker(["rm", "-f", container]);
    await services?.teardown();
    await card.teardown();
  };
  const fail = async (step: "seed" | "start", reason: string, logs: string): Promise<OpenAppResult> => {
    await close();
    return { ok: false, detail: { escalation: "env_broken", envBroken: true, step, reason, logTail: text(logs), options: [`fix the ${step === "seed" ? "seed command" : "start command"} (verify.e2e.${step === "seed" ? "seed" : "start"}) in luna.yaml, then resume`] } };
  };

  try {
    services = await deps.startServices(runName, policy.services, { network: { name: card.name, dns: card.dns } });
    const limits = { cpu: policy.factory.sandbox.cpu, memoryGb: policy.factory.sandbox.memory_gb };
    const cacheVolume = cacheVolumeFor(input.repoPath);
    if (seed.command) {
      const seeded = await deps.exec({ name: `${container}-seed`, image, worktree: input.workspace, limits, argv: ["sh", "-c", seed.command], env: services.env, cacheVolume, cardNetwork: card, services: policy.services, ...(seed.secrets.length > 0 ? { secrets: pick(seed.secrets) } : {}) }, { timeoutMs: SEED_TIMEOUT_MS });
      await report("seed");
      if (seeded.code !== 0) return await fail("seed", `the seed command exited ${seeded.code}`, `${seeded.stdout}\n${seeded.stderr}`);
    }
    const args = appArgs({ name: container, image, worktree: input.workspace, command: start.command!, port: start.port, limits, cacheVolume, cardNetwork: card, services: policy.services, serviceEnv: services.env, ...(start.secrets.length > 0 ? { secrets: pick(start.secrets) } : {}) });
    const started = await deps.docker(args, { env: { ...process.env, ...pick(start.secrets) } });
    if (started.code !== 0) return await fail("start", "the app container did not start", started.stderr);
    const deadline = now() + start.ready_timeout_s * 1000;
    for (;;) {
      if ((await deps.docker(probeArgs(container, start.port, start.ready))).code === 0) break;
      const running = (await deps.docker(["inspect", "-f", "{{.State.Running}}", container])).stdout.trim() === "true";
      const timedOut = now() >= deadline;
      if (!running || timedOut) {
        const logs = await deps.docker(["logs", "--tail", String(LOG_TAIL), container]);
        return await fail("start", running ? `the app did not answer ${start.ready} within ${start.ready_timeout_s} s` : "the app exited before it answered", `${logs.stdout}\n${logs.stderr}`);
      }
      await sleep(1000);
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { ok: true, target: { name: "app", baseUrl: `http://${APP_ALIAS}:${start.port}` }, network: card.name, aliases: [APP_ALIAS, ...Object.keys(policy.services)], close };
}
