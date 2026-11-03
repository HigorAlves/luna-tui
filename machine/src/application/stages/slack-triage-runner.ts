// The Triager port as the slack_triage pack: each batch of inbox items runs through the factory
// runner in the stage container, like every stage, with the same image and its engine's credential. There is
// no task and no worktree: /work is an empty folder under the run dir, the batch rides in
// `context.slack`, and the structured answer comes back in /out/result.json. One row per run
// goes to slack_triage_runs so the Floor can show what triage costs. A run that answered has
// its folder removed at once; a failed one keeps it for the retention sweep (sweepSlackTriageRuns).
import { PACKS, SlackTriageAnswer, type SlackTriageContext, resolveEngine } from "@hardness/contracts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Credentials } from "../../adapters/credentials/index.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { buildSlackTriageInput } from "../../domain/stage-input.ts";
import { pickEngine } from "../engine.ts";
import type { SlackStore } from "../slack-store.ts";
import { outputError, runPackOnce } from "./run-once.ts";
import { TRIAGE_BATCH, type TriageAnswer, type TriageContext, type TriageItem, TriageRunError, type Triager } from "../slack-triage.ts";

export interface SlackTriageDeps {
  /** The base stage image; the same one the packs run in. */
  image: string;
  /** Each engine's credential; a run gets only its own engine's. */
  credentials: Credentials;
  stateDir: string;
  /** Records one row per run. */
  store: Pick<SlackStore, "recordTriageRun">;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  now?: () => Date;
  /** One line per run; defaults to console.log. */
  log?: (line: string) => void;
}

/** Where the runs live under the state dir; each run is a folder named by its start time. */
export const SLACK_TRIAGE_DIR = "slack-triage";

/** The rules file's sections the model reads, as one markdown block. */
export function rulesText(context: TriageContext): string {
  const list = (lines: string[]) => (lines.length > 0 ? lines.map((l) => (l.startsWith("- ") ? l : `- ${l}`)).join("\n") : "- none");
  return [
    "## VIPs (at least P1)",
    list(context.vips),
    "",
    "## Notes",
    context.notes.trim() || "- none",
    "",
    "## Learned (lowered: they clear this author or channel without replying; raised: they answer it fast)",
    list(context.learned),
  ].join("\n");
}

/** The pack's input block for one batch. */
export function slackContext(items: TriageItem[], context: TriageContext): SlackTriageContext {
  return {
    me: context.me,
    watches: context.watches.filter((w) => w.enabled).map((w) => ({ label: w.label, kind: w.kind })),
    rules: rulesText(context),
    items: items.map((item) => ({
      id: item.id,
      channel: item.channel,
      author: item.author,
      isBot: item.isBot,
      text: item.text,
      context: item.context.map((line) => {
        const at = line.indexOf(": ");
        return at > 0 ? { user: line.slice(0, at), text: line.slice(at + 2) } : { user: "", text: line };
      }),
      matched: item.matched,
      threadReplies: item.threadReplies,
    })),
  };
}

/** The Triager that runs the slack_triage pack in the stage container, one run per batch. */
export function createSlackTriager(deps: SlackTriageDeps): Triager {
  const pack = PACKS.slack_triage;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));

  async function runBatch(batch: TriageItem[], context: TriageContext, ordinal: number): Promise<{ answers: Map<string, TriageAnswer>; error: string | null }> {
    const startedAt = now();
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-") + (ordinal > 0 ? `-${ordinal + 1}` : "");
    const runDir = join(deps.stateDir, SLACK_TRIAGE_DIR, stamp);
    const work = join(runDir, "work");
    await mkdir(work, { recursive: true });
    // The inbox is no repo's and no task's: the pack's default, unless this machine cannot run it.
    const { engine } = await pickEngine(deps.credentials, pack, null, null);
    // What the run is recorded as when the result names no model: the pinned ID it was started on.
    const model = resolveEngine(engine).modelId;
    const input = buildSlackTriageInput(slackContext(batch, context), engine);
    const answers = new Map<string, TriageAnswer>();
    let ok = false;
    let error: string | null = null;
    let usage: { model: string; turns: number; costUsd: number | null } = { model, turns: 0, costUsd: null };
    try {
      const run = await runPackOnce(
        { name: `hardness-slack-triage-${stamp}`, image: deps.image, runDir, worktree: work, input, engine, labels: { luna: "slack-triage" } },
        { credentials: deps.credentials, sandbox: deps.sandbox },
      );
      if (run.error !== null) error = run.error;
      else {
        const out = run.output;
        usage = { model: out.usage.model || model, turns: out.usage.turns, costUsd: out.usage.costUsd };
        if (!out.ok) error = outputError(out);
        else {
          const answer = SlackTriageAnswer.safeParse(out.answer);
          if (!answer.success) error = `the answer did not match the schema: ${answer.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          else {
            ok = true;
            const ids = new Set(batch.map((i) => i.id));
            for (const { id, ...verdict } of answer.data.items) {
              // The schema caps `summary` at 90 characters; structured output enforces it in the container.
              if (ids.has(id) && !answers.has(id)) answers.set(id, verdict);
            }
          }
        }
      }
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const endedAt = now();
    const cost = usage.costUsd === null ? "" : ` · $${usage.costUsd.toFixed(4)}`;
    log(ok ? `slack triage: ${batch.length} item(s), ${answers.size} verdict(s), ${usage.turns} turn(s)${cost}` : `slack triage: ${batch.length} item(s) failed: ${error}`);
    try {
      await deps.store.recordTriageRun({ startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), items: batch.length, model: usage.model, engine, turns: usage.turns, costUsd: usage.costUsd, ok, error });
    } catch (thrown) {
      console.warn(`slack triage: could not record the run: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
    // A run that answered leaves nothing worth keeping; a failed one keeps its folder (the transcript says why) for the retention sweep.
    if (ok) await rm(runDir, { recursive: true, force: true }).catch(() => {});
    return { answers, error: ok ? null : error };
  }

  return {
    async triage(items, context) {
      const answers = new Map<string, TriageAnswer>();
      for (let at = 0; at < items.length; at += TRIAGE_BATCH) {
        const batch = await runBatch(items.slice(at, at + TRIAGE_BATCH), context, at / TRIAGE_BATCH);
        for (const [id, verdict] of batch.answers) answers.set(id, verdict);
        if (batch.error !== null) throw new TriageRunError(batch.error, answers);
      }
      return answers;
    },
  };
}
