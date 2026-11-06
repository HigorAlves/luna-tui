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
import { hostRedactor, secretRedactor } from "../domain/redact-secrets.ts";
import type { Policy } from "../domain/policy.ts";
import type { EgressPolicy } from "./egress-policy.ts";
import type { InstallInput, InstallOutcome } from "./install.ts";
import type { SecretStore } from "./secrets.ts";
import { previewUrlOf } from "../domain/preview-url.ts";

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
  onBlocked(step: "seed" | "app" | "deploy", rows: BlockedRow[]): void;
}

export interface OpenedApp {
  ok: true;
  target: { name: "app"; baseUrl: string };
  /** The app's network, for the browser run to join. */
  network: string;
  /** Names the browser run reaches directly (not through its proxy). */
  aliases: string[];
  /** The values of the app's and the seed's secrets, for the browser run's redactor only: they never enter its container or its environment. */
  redactValues: Record<string, string>;
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
  const redactHost = hostRedactor(values);
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
    // The host is text the app chose, lowercased by the proxy: a secret in it is replaced whatever its case.
    if (fresh.length > 0) input.onBlocked(step, fresh.map((row) => ({ ...row, host: redactHost(row.host) })));
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
  return { ok: true, target: { name: "app", baseUrl: `http://${APP_ALIAS}:${start.port}` }, network: card.name, aliases: [APP_ALIAS, ...Object.keys(policy.services)], redactValues: values, close };
}

export interface OpenedPreview {
  ok: true;
  target: { name: "preview"; baseUrl: string };
  /** The deploy's secret values, for the browser run's redactor only. */
  redactValues: Record<string, string>;
  close(): Promise<void>;
}
export type OpenPreviewResult = OpenedPreview | { ok: false; detail: Record<string, unknown> };

/** Waits for the preview from a container on the proxy: the URL and the path are arguments, never part of the script. */
export const HEALTH_SCRIPT = 'fetch(process.argv[1]+process.argv[2],{redirect:"manual",signal:AbortSignal.timeout(10000)}).then((r)=>process.exit(r.status<400?0:1),()=>process.exit(1));';

/** The preview the repository's config names (`verify.e2e.deploy`): the URL is the pattern filled by the machine; the deploy command, when there is one, runs in the repository's image with its own secrets, no credential, the check list plus the preview's host; then the health path is awaited through the proxy. */
export async function openPreview(deps: AppDeps, input: OpenAppInput & { branch: string }): Promise<OpenPreviewResult> {
  const policy = await deps.policies.for(input.repoPath);
  const { deploy } = policy.factory.verify.e2e;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const filled = previewUrlOf(deploy.url_pattern!, { branch: input.branch, sha: input.commit, card: input.taskId });
  const broken = (reason: string, logs = "", redact: (t: string) => string = (t) => t): OpenPreviewResult => ({
    ok: false,
    detail: { escalation: "env_broken", envBroken: true, step: "deploy", reason, logTail: safe(redact(logs)).slice(0, REASON_CAP), options: ["fix verify.e2e.deploy in luna.yaml (the command, the url_pattern or the health_check), then resume"] },
  });
  if (!filled.ok) return broken(`no preview URL can be made: ${filled.reason}`);
  const host = new URL(filled.url).hostname;

  let values: Record<string, string> = {};
  if (deploy.secrets.length > 0) {
    const loaded = deps.secrets ? await deps.secrets.load(input.repoPath, deploy.secrets) : { values: {}, missing: deploy.secrets.map((name) => ({ name, reason: "no secrets store is configured" })) };
    if (loaded.missing.length > 0) return { ok: false, detail: new SecretsMissingError(loaded.missing, deps.secrets?.folder(input.repoPath) ?? "(no secrets store)").detail };
    values = loaded.values;
  }
  const redact = secretRedactor(values);
  const redactHost = hostRedactor(values);
  const installed = await deps.install({ taskId: input.taskId, repoPath: input.repoPath, workspace: input.workspace, commit: input.commit, ...(input.signal ? { signal: input.signal } : {}) });
  if (!installed.ok) return { ok: false, detail: installed.detail };
  const image = await deps.imageFor(input.repoPath, input.taskId);
  const base = deps.egress ? await deps.egress.for({ repoPath: input.repoPath, kind: "check" }) : { allow: [], allowPrivate: [], proxyImage: image };
  const spec = { ...base, allow: [...new Set([...base.allow, `${host}:443`])].sort() };
  const runName = `${input.taskId.slice(0, 8)}-deploy-${input.attempt}`;
  const card = await deps.openCardNetwork(runName, spec, { proxyImage: spec.proxyImage });
  const seen = new Set<string>();
  const report = async (): Promise<void> => {
    const fresh = (await card.blocked()).filter((row) => !seen.has(`${row.via}|${row.host}|${row.port}`));
    for (const row of fresh) seen.add(`${row.via}|${row.host}|${row.port}`);
    if (fresh.length > 0) input.onBlocked("deploy", fresh.map((row) => ({ ...row, host: redactHost(row.host) })));
  };
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await report().catch(() => {});
    await card.teardown();
  };
  const limits = { cpu: policy.factory.sandbox.cpu, memoryGb: policy.factory.sandbox.memory_gb };
  const minutes = deploy.timeout_minutes;
  try {
    if (deploy.command) {
      const ran = await deps.exec({ name: `hardness-${runName}`, image, worktree: input.workspace, limits, argv: ["sh", "-c", deploy.command], cacheVolume: cacheVolumeFor(input.repoPath), cardNetwork: card, services: policy.services, ...(deploy.secrets.length > 0 ? { secrets: values } : {}) }, { timeoutMs: minutes * 60_000 });
      if (ran.code !== 0) {
        await close();
        return broken(`the deploy command exited ${ran.code}`, `${ran.stdout}\n${ran.stderr}`, redact);
      }
    }
    const deadline = now() + minutes * 60_000;
    for (let n = 0; ; n++) {
      const probe = await deps.exec({ name: `hardness-${runName}-health-${n}`, image, worktree: input.workspace, limits, argv: ["/opt/luna/bin/node", "-e", HEALTH_SCRIPT, filled.url, deploy.health_check], cardNetwork: card }, { timeoutMs: 30_000 });
      if (probe.code === 0) break;
      if (now() >= deadline) {
        await close();
        return broken(`the preview ${host} never answered ${deploy.health_check} within ${minutes} minutes`);
      }
      await sleep(5000);
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { ok: true, target: { name: "preview", baseUrl: filled.url }, redactValues: values, close };
}
