// The setup stage: the setup pack reads the repo checkout and proposes its luna.yaml; the
// machine then proves every proposed check once, with the proposed services beside it, and
// hands the file text and the proof to the awaiting_setup gate. Approving writes the file.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { gitIdentity as hostGitIdentity } from "../../adapters/git/worktree.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { checkCommand } from "../../domain/checks.ts";
import { renderLunaConfig, validateLunaConfig } from "../../domain/luna-config.ts";
import type { ServiceSpec } from "@hardness/contracts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

const MINUTE = 60_000;
/** The whole proof shares verifying's budget. */
export const PROOF_TIMEOUT_MS = 30 * MINUTE;
const TAIL_LINES = 60;

export interface SetupDeps {
  /** Runs the setup pack over the checkout. */
  runPack: (context: StageContext) => Promise<StageResult>;
  /** Runs one check in the stage image over `cwd`, with the services beside it. */
  exec: (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; services?: Record<string, ServiceSpec> },
  ) => Promise<ExecResult>;
  stateDir: string;
  gitIdentity?: (repoPath: string) => Promise<{ name: string; email: string } | null>;
}

export interface ProofReport {
  name: string;
  cmd: string;
  ok: boolean;
  tail: string;
}

const tailOf = (text: string): string => text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

const answerOf = (detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  const answer = detail?.answer;
  return answer && typeof answer === "object" ? (answer as Record<string, unknown>) : undefined;
};

export function setupRunner(deps: SetupDeps): StageRunner {
  const resolveIdentity = deps.gitIdentity ?? hostGitIdentity;
  return async (context) => {
    const { task, signal } = context;
    if (!task.repoPath) return { outcome: "fail", detail: { error: "the task has no repoPath; setup reads a repo checkout" } };
    const pack = await deps.runPack(context);
    if (pack.outcome !== "pass") return pack;
    const answer = answerOf(pack.detail);
    if (answer?.kind === "escalated") return pack;

    let text: string;
    let config;
    try {
      config = validateLunaConfig(answer?.config ?? {});
      text = renderLunaConfig(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...pack, outcome: "fail", detail: { ...pack.detail, error: `the proposal is not a luna.yaml the machine can read: ${message}` } };
    }

    // The proof: every proposed check, once, as a check container would run it.
    const identity = await resolveIdentity(task.repoPath);
    const identityEnv = identity
      ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email }
      : {};
    const proof: ProofReport[] = [];
    const log: string[] = [];
    const deadline = Date.now() + PROOF_TIMEOUT_MS;
    for (const check of config.checks ?? []) {
      const { name, cmd, argv } = checkCommand(check);
      const remaining = deadline - Date.now();
      const result =
        remaining <= 0
          ? { code: 1, stdout: "", stderr: "skipped: the 30 minute proof budget ran out" }
          : await deps.exec(argv[0]!, argv.slice(1), {
              cwd: task.repoPath,
              signal,
              timeoutMs: remaining,
              env: { ...process.env, ...identityEnv, HARDNESS_STAGE: "setup" },
              services: config.services ?? {},
            });
      if (signal.aborted) return { outcome: "fail", detail: { error: "aborted" } };
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
      log.push(`$ ${cmd}\n(exit ${result.code})\n${output}\n`);
      proof.push({ name, cmd, ok: result.code === 0, tail: tailOf(output) });
    }
    const runDir = join(deps.stateDir, "runs", context.runId);
    await mkdir(runDir, { recursive: true });
    const transcriptPath = join(runDir, "checks.log");
    await writeFile(transcriptPath, log.join("\n") || "no checks proposed\n");

    return {
      ...pack,
      outcome: "pass",
      detail: {
        summary: typeof answer?.summary === "string" ? answer.summary : "",
        notes: Array.isArray(answer?.notes) ? answer.notes : [],
        config: text,
        proof,
        ...(identity ? {} : { note: "git has no identity for this repo; checks that commit would fail as nobody" }),
      },
      run: { ...pack.run, transcriptPath },
    };
  };
}
