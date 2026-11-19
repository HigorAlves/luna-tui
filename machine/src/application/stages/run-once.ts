// One pack run in the stage container outside the task pipeline: only the engine's credential,
// prepared under the run folder and released once the container is gone; the input written to
// /in, the container run by the docker sandbox like every stage, /out/result.json read back and
// validated. The Slack triage runner, Jira intake and the replay evals (evals/run.ts) run a pack this way.
import { type EngineId, type StageInput, StageOutput, credentialOwner } from "@hardness/contracts";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CredentialWaitError, type Credentials } from "../../adapters/credentials/index.ts";
import { type SandboxResult, type SandboxRun, runSandbox } from "../../adapters/docker/docker.ts";
import type { BridgedTool } from "@hardness/contracts";
import type { Trust } from "../../domain/trust.ts";
import { sandboxSizeOf } from "../../domain/sandbox-bounds.ts";
import type { EgressPolicy } from "../egress-policy.ts";
import type { Mcp } from "../mcp.ts";
import type { PolicyStore } from "../policy.ts";
import { buildWatch } from "./build-watch.ts";
import { DESIGN_MOUNT, type McpCallRow, cappedRow, mcpAnswers } from "./design-bridge.ts";

const MINUTE = 60_000;

export interface OneRun {
  /** The container's name. */
  name: string;
  image: string;
  /** The run folder: in/, out/, the transcript and the credential's per-run copy go here. */
  runDir: string;
  /** Mounted read-only at /work: an empty folder, or a checkout the pack may read. */
  worktree: string;
  input: StageInput;
  /** The engine whose credential the run gets; the input names the same one. */
  engine: EngineId;
  labels: Record<string, string>;
  /** Extra container env: the run's trace context (RunSpan.childEnv()). */
  extraEnv?: Record<string, string>;
  /** Which list the run gets: the pack list (default, no repository) or the list a real run of an agent pack gets (an eval measures what runs). */
  egressKind?: "pack" | "github" | "agent";
  /** How long to wait for a login another run holds (the Codex one is one run at a time); absent, the run's own time limit. */
  credentialWaitMs?: number;
  /** Whose input the pack reads: `untrusted` (the default) for text from Slack, Jira, a client or a GitHub source with no trusted association; it picks the runtime and the cache. */
  trust?: Trust;
  signal?: AbortSignal;
  /** The bridged tools of the run (RFC 0013): `input.bridge` is set to `tools`, `designDir` is mounted read-only at /design, and the machine answers the container's calls through `mcp` while it runs. The client is closed when the run ends. */
  bridge?: { tools: BridgedTool[]; mcp: Mcp; designDir: string; log: (row: McpCallRow) => void | Promise<void> };
  /** A browser pack's run: the hosts of its QA target for the egress list, the secret values it is handed (its target's credential), the app's network, the names it reaches directly, and values its output is cleaned of. */
  egressTargets?: string[];
  secrets?: Record<string, string>;
  alsoJoin?: string[];
  noProxy?: string[];
  redactValues?: Record<string, string>;
}

export interface OneRunDeps {
  credentials: Pick<Credentials, "prepare">;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  /** The list a pack run with no repository may reach (its engine's hosts); absent, the run joins an ordinary bridge as before. */
  egress?: EgressPolicy;
  /** The machine's sandbox policy, as the policy store bounds it: the run's container size comes from it. Absent (tests), docker's defaults. */
  policies?: Pick<PolicyStore, "for">;
}

/** The run's result when the container left a readable one; `error` says why when it did not. */
export type OneRunResult = { output: StageOutput; error: null } | { output: null; error: string; /** The login was held by another run for the whole wait: nothing ran. */ credentialBusy?: true };

/** Runs `run.input` once. A missing credential rejects (NoCredentialError); every other failure,
 *  a credential another run held past the timeout included, is in `error`. */
export async function runPackOnce(run: OneRun, deps: OneRunDeps): Promise<OneRunResult> {
  let credential;
  try {
    credential = await deps.credentials.prepare(run.engine, run.runDir, { signal: run.signal, timeoutMs: run.credentialWaitMs ?? run.input.limits.timeoutMs });
  } catch (error) {
    if (error instanceof CredentialWaitError) return { output: null, error: error.message, ...(run.signal?.aborted ? {} : { credentialBusy: true as const }) };
    throw error;
  }
  const egress = deps.egress ? await deps.egress.for({ repoPath: null, kind: run.egressKind ?? "pack", owners: [credentialOwner(run.engine)], ...(credential.relay ? { relayed: ["claude" as const] } : {}), ...(run.egressTargets?.length ? { targets: run.egressTargets } : {}) }).catch((error) => credential.release().then(() => Promise.reject(error))) : undefined;
  // The container is sized by the machine's sandbox policy (cpu, memory, process limit, seccomp, runtime, which also run the daemon's start checks); the input is text a stranger may have written.
  const size = deps.policies ? sandboxSizeOf(await deps.policies.for(null).catch((error) => credential.release().then(() => Promise.reject(error))), run.trust ?? "untrusted") : undefined;
  const bridge = run.bridge;
  const spec: SandboxRun = {
    ...(egress ? { egress } : {}),
    ...(size ? { limits: size } : {}),
    name: run.name,
    image: run.image,
    runDir: run.runDir,
    worktree: run.worktree,
    writable: false,
    gitDir: null,
    input: (bridge ? { ...run.input, bridge: bridge.tools } : run.input) as unknown as Record<string, unknown>,
    timeoutMs: run.input.limits.timeoutMs,
    credential: { env: credential.env, mounts: credential.mounts, ...(credential.relay ? { relay: credential.relay } : {}) },
    labels: run.labels,
    extraEnv: run.extraEnv ?? {},
    signal: run.signal,
    ...(bridge ? { mounts: [{ host: bridge.designDir, container: DESIGN_MOUNT, readOnly: true }] } : {}),
    ...(run.secrets ? { secrets: run.secrets } : {}),
    ...(run.redactValues ? { redactValues: run.redactValues } : {}),
    ...(run.alsoJoin?.length ? { alsoJoin: run.alsoJoin } : {}),
    ...(run.noProxy?.length ? { noProxy: run.noProxy } : {}),
  };
  // The bridged tools are answered while the container runs, from its own mailbox; nothing else is watched.
  let watch: ReturnType<typeof buildWatch> | null = null;
  const result = await Promise.resolve()
    .then(async () => {
      if (bridge) {
        await mkdir(bridge.designDir, { recursive: true });
        watch = buildWatch({
          outDir: join(run.runDir, "out"),
          every: 500,
          log: () => {},
          onCommitted: async () => {},
          onMcpRequest: mcpAnswers({ mcp: bridge.mcp, bridge: bridge.tools, designDir: bridge.designDir, log: bridge.log }),
          onMcpCapped: (request) => void Promise.resolve(bridge.log(cappedRow(request))).catch(() => {}),
        });
      }
      return (deps.sandbox ?? runSandbox)(spec);
    })
    .finally(async () => {
      await (watch as ReturnType<typeof buildWatch> | null)?.stop();
      await bridge?.mcp.close().catch(() => {});
      await credential.release();
    });
  if (result.aborted) return { output: null, error: "aborted" };
  if (result.timedOut) return { output: null, error: `timed out after ${run.input.limits.timeoutMs / MINUTE} minutes` };
  const raw = await readFile(join(run.runDir, "out", "result.json"), "utf8").catch(() => null);
  if (raw === null) return { output: null, error: `the container left no result (exit code ${result.exitCode})` };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { output: null, error: "unreadable result: not JSON" };
  }
  const output = StageOutput.safeParse(json);
  if (!output.success) return { output: null, error: `unreadable result: ${output.error.issues.map((i) => i.message).join("; ")}` };
  return { output: output.data, error: null };
}

/** Why a readable result did not answer: its error, else its summary. */
export function outputError(output: StageOutput): string {
  return typeof output.error === "string" ? output.error : output.error ? JSON.stringify(output.error) : output.summary || "the stage failed";
}
