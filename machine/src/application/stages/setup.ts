// The setup stage: the setup pack reads the repo checkout and proposes its luna.yaml; the
// machine then proves every proposed check once, with the proposed services beside it, and
// hands the file text and the proof to the awaiting_setup gate. Approving writes the file.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { gitIdentity as hostGitIdentity } from "../../adapters/git/worktree.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { renderLunaConfig, validateLunaConfig } from "../../domain/luna-config.ts";
import { type ProofExec, allowEntriesOf, proveConfig } from "../config-proof.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

export { PROOF_TIMEOUT_MS, type ProofReport } from "../config-proof.ts";

export interface SetupDeps {
  /** Runs the setup pack over the checkout. */
  runPack: (context: StageContext) => Promise<StageResult>;
  /** Runs one check in the stage image over `cwd`, with the services beside it and the proposal's egress list on top of the machine's. */
  exec: ProofExec;
  stateDir: string;
  gitIdentity?: (repoPath: string) => Promise<{ name: string; email: string } | null>;
}

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
    const proven = await proveConfig(config, { exec: deps.exec, repoPath: task.repoPath, signal, env: identityEnv, stage: "setup" });
    if (signal.aborted) return { outcome: "fail", detail: { error: "aborted" } };
    const { proof, refused } = proven;
    const runDir = join(deps.stateDir, "runs", context.runId);
    await mkdir(runDir, { recursive: true });
    const transcriptPath = join(runDir, "checks.log");
    await writeFile(transcriptPath, proven.log);
    // A check that reached for a host no list names: the proposal does not add it (approving a setup must not widen the sandbox unseen),
    // the gate names it, with the entry to add.
    const egressNotes = refused.length > 0 ? [`the checks tried to reach hosts the sandbox refused: ${refused.join(", ")}; if a check needs them, add to sandbox.egress.allow: ${allowEntriesOf(refused).join(", ")}`] : [];

    return {
      ...pack,
      outcome: "pass",
      detail: {
        summary: typeof answer?.summary === "string" ? answer.summary : "",
        notes: [...(Array.isArray(answer?.notes) ? answer.notes : []), ...egressNotes],
        ...(refused.length > 0 ? { egressRefused: refused } : {}),
        config: text,
        // The base image is singled out of the long proposal: it runs the stage's process, so approving this setup does not approve it.
        ...(config.sandbox?.image?.base ? { sandboxBase: `sandbox.image.base: ${safe(config.sandbox.image.base).slice(0, 255)} (this setup sets it; approving the setup does not approve the base, which a person approves from the repository's row on the Floor)` } : {}),
        proof,
        ...(identity ? {} : { note: "git has no identity for this repo; checks that commit would fail as nobody" }),
      },
      run: { ...pack.run, transcriptPath },
    };
  };
}
