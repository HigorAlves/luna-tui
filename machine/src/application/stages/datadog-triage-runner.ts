// The DatadogTriager port as the datadog_triage pack: each batch of items runs through the factory
// runner in the stage container, like every stage. No task and no worktree: /work is an empty
// folder under the run dir, the batch rides in `context.datadog`, and the structured answer comes
// back in /out/result.json. One row per run goes to the store; a run that answered has its folder
// removed at once, a failed one keeps it for the retention sweep (sweepDatadogTriageRuns).
import { DatadogTriageAnswer, type DatadogItem, type DatadogTriageContext, PACKS, StageOutput } from "@hardness/contracts";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Credential } from "../../adapters/docker/credentials.ts";
import { type SandboxResult, type SandboxRun, runSandbox } from "../../adapters/docker/docker.ts";
import { buildDatadogTriageInput } from "../../domain/stage-input.ts";
import type { DatadogStore } from "../datadog-store.ts";
import { DATADOG_TRIAGE_BATCH, type DatadogTriageVerdict, type DatadogTriager } from "../datadog-triage.ts";
import { TriageRunError } from "../slack-triage.ts";

export interface DatadogTriageDeps {
  /** The base stage image; the same one the packs run in. */
  image: string;
  credential: Credential;
  stateDir: string;
  /** Records one row per run. */
  store: Pick<DatadogStore, "recordTriageRun">;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  now?: () => Date;
  /** One line per run; defaults to console.log. */
  log?: (line: string) => void;
}

/** Where the runs live under the state dir; each run is a folder named by its start time. */
export const DATADOG_TRIAGE_DIR = "datadog-triage";
const MINUTE = 60_000;

/** The fields of an item the model sees. */
function toContextItem(item: DatadogItem): DatadogTriageContext["items"][number] {
  return {
    id: item.id,
    source: item.source,
    title: item.title,
    service: item.service,
    env: item.env,
    status: item.status,
    severity: item.severity,
    count: item.count,
    firstSeen: item.firstSeen,
    lastSeen: item.lastSeen,
    samples: item.samples,
    floor: item.floor,
    reopened: item.reopenedAt !== null,
  };
}

/** The DatadogTriager that runs the datadog_triage pack in the stage container, one run per batch. */
export function createDatadogTriager(deps: DatadogTriageDeps): DatadogTriager {
  const pack = PACKS.datadog_triage;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const sandbox = deps.sandbox ?? runSandbox;

  async function runBatch(batch: DatadogItem[], scope: string, ordinal: number): Promise<{ answers: Map<string, DatadogTriageVerdict>; error: string | null }> {
    const startedAt = now();
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-") + (ordinal > 0 ? `-${ordinal + 1}` : "");
    const runDir = join(deps.stateDir, DATADOG_TRIAGE_DIR, stamp);
    const work = join(runDir, "work");
    await mkdir(work, { recursive: true });
    const input = buildDatadogTriageInput({ scope, items: batch.map(toContextItem) });
    const answers = new Map<string, DatadogTriageVerdict>();
    let ok = false;
    let error: string | null = null;
    let usage: { model: string; turns: number; costUsd: number | null } = { model: pack.model, turns: 0, costUsd: null };
    try {
      const result = await sandbox({
        name: `hardness-datadog-triage-${stamp}`,
        image: deps.image,
        runDir,
        worktree: work,
        writable: false,
        gitDir: null,
        input: input as unknown as Record<string, unknown>,
        timeoutMs: input.limits.timeoutMs,
        credential: deps.credential,
        labels: { luna: "datadog-triage" },
      });
      if (result.aborted) error = "aborted";
      else if (result.timedOut) error = `timed out after ${input.limits.timeoutMs / MINUTE} minutes`;
      else {
        const raw = await readFile(join(runDir, "out", "result.json"), "utf8").catch(() => null);
        const output = raw === null ? null : StageOutput.safeParse(JSON.parse(raw));
        if (!output) error = `the container left no result (exit code ${result.exitCode})`;
        else if (!output.success) error = `unreadable result: ${output.error.issues.map((i) => i.message).join("; ")}`;
        else {
          const out = output.data;
          usage = { model: out.usage.model || pack.model, turns: out.usage.turns, costUsd: out.usage.costUsd };
          if (!out.ok) error = typeof out.error === "string" ? out.error : out.error ? JSON.stringify(out.error) : out.summary || "the stage failed";
          else {
            const answer = DatadogTriageAnswer.safeParse(out.answer);
            if (!answer.success) error = `the answer did not match the schema: ${answer.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
            else {
              ok = true;
              const ids = new Set(batch.map((i) => i.id));
              for (const { id, ...verdict } of answer.data.items) {
                if (ids.has(id) && !answers.has(id)) answers.set(id, verdict);
              }
            }
          }
        }
      }
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const endedAt = now();
    const cost = usage.costUsd === null ? "" : ` · $${usage.costUsd.toFixed(4)}`;
    log(ok ? `datadog triage: ${batch.length} item(s), ${answers.size} verdict(s), ${usage.turns} turn(s)${cost}` : `datadog triage: ${batch.length} item(s) failed: ${error}`);
    try {
      await deps.store.recordTriageRun({ startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), items: batch.length, model: usage.model, turns: usage.turns, costUsd: usage.costUsd, ok, error });
    } catch (thrown) {
      console.warn(`datadog triage: could not record the run: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
    if (ok) await rm(runDir, { recursive: true, force: true }).catch(() => {});
    return { answers, error: ok ? null : error };
  }

  return {
    async triage(items, scope) {
      const answers = new Map<string, DatadogTriageVerdict>();
      let firstError: string | null = null;
      for (let at = 0; at < items.length; at += DATADOG_TRIAGE_BATCH) {
        const batch = await runBatch(items.slice(at, at + DATADOG_TRIAGE_BATCH), scope, at / DATADOG_TRIAGE_BATCH);
        for (const [id, verdict] of batch.answers) answers.set(id, verdict);
        // A failed batch does not stop the later ones; the run reports the first failure once all have had their turn.
        if (batch.error !== null && firstError === null) firstError = batch.error;
      }
      if (firstError !== null) throw new TriageRunError(firstError, answers);
      return answers;
    },
  };
}
