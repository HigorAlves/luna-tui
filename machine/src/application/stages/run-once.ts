// One pack run in the stage container outside the task pipeline: only the engine's credential,
// prepared under the run folder and released once the container is gone; the input written to
// /in, the container run by the docker sandbox like every stage, /out/result.json read back and
// validated. The Slack triage runner, Jira intake and the replay evals (evals/run.ts) run a pack this way.
import { type EngineId, type StageInput, StageOutput, credentialOwner } from "@hardness/contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CredentialWaitError, type Credentials } from "../../adapters/credentials/index.ts";
import { type SandboxResult, type SandboxRun, runSandbox } from "../../adapters/docker/docker.ts";
import type { EgressPolicy } from "../egress-policy.ts";

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
  egressKind?: "pack" | "agent";
  signal?: AbortSignal;
}

export interface OneRunDeps {
  credentials: Pick<Credentials, "prepare">;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  /** The list a pack run with no repository may reach (its engine's hosts); absent, the run joins an ordinary bridge as before. */
  egress?: EgressPolicy;
}

/** The run's result when the container left a readable one; `error` says why when it did not. */
export type OneRunResult = { output: StageOutput; error: null } | { output: null; error: string };

/** Runs `run.input` once. A missing credential rejects (NoCredentialError); every other failure,
 *  a credential another run held past the timeout included, is in `error`. */
export async function runPackOnce(run: OneRun, deps: OneRunDeps): Promise<OneRunResult> {
  let credential;
  try {
    credential = await deps.credentials.prepare(run.engine, run.runDir, { signal: run.signal, timeoutMs: run.input.limits.timeoutMs });
  } catch (error) {
    if (error instanceof CredentialWaitError) return { output: null, error: error.message };
    throw error;
  }
  const egress = deps.egress ? await deps.egress.for({ repoPath: null, kind: run.egressKind ?? "pack", owners: [credentialOwner(run.engine)] }).catch((error) => credential.release().then(() => Promise.reject(error))) : undefined;
  const result = await (deps.sandbox ?? runSandbox)({
    ...(egress ? { egress } : {}),
    name: run.name,
    image: run.image,
    runDir: run.runDir,
    worktree: run.worktree,
    writable: false,
    gitDir: null,
    input: run.input as unknown as Record<string, unknown>,
    timeoutMs: run.input.limits.timeoutMs,
    credential: { env: credential.env, mounts: credential.mounts },
    labels: run.labels,
    extraEnv: run.extraEnv ?? {},
    signal: run.signal,
  }).finally(() => credential.release());
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
