// The Triager port as the slack_triage pack: each batch of inbox items runs through the factory
// runner in the stage container, like every stage, with the same image and credential. There is
// no task and no worktree: /work is an empty folder under the run dir, the batch rides in
// `context.slack`, and the structured answer comes back in /out/result.json. One row per run
// goes to slack_triage_runs so the Floor can show what triage costs.
import { PACKS, SlackTriageAnswer, type SlackTriageContext, StageOutput } from "@hardness/contracts";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Credential } from "../../adapters/docker/credentials.ts";
import { type SandboxResult, type SandboxRun, runSandbox } from "../../adapters/docker/docker.ts";
import { buildSlackTriageInput } from "../../domain/stage-input.ts";
import type { SlackStore } from "../slack-store.ts";
import { TRIAGE_BATCH, type TriageAnswer, type TriageContext, type TriageItem, type Triager } from "../slack-triage.ts";

export interface SlackTriageDeps {
  /** The base stage image; the same one the packs run in. */
  image: string;
  credential: Credential;
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
const MINUTE = 60_000;
const SUMMARY_MAX = 90;

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
  const sandbox = deps.sandbox ?? runSandbox;

  async function runBatch(batch: TriageItem[], context: TriageContext, ordinal: number): Promise<Map<string, TriageAnswer>> {
    const startedAt = now();
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-") + (ordinal > 0 ? `-${ordinal + 1}` : "");
    const runDir = join(deps.stateDir, SLACK_TRIAGE_DIR, stamp);
    const work = join(runDir, "work");
    await mkdir(work, { recursive: true });
    const input = buildSlackTriageInput(slackContext(batch, context));
    const answers = new Map<string, TriageAnswer>();
    let ok = false;
    let error: string | null = null;
    let usage: { model: string; turns: number; costUsd: number | null } = { model: pack.model, turns: 0, costUsd: null };
    try {
      const result = await sandbox({
        name: `hardness-slack-triage-${stamp}`,
        image: deps.image,
        runDir,
        worktree: work,
        writable: false,
        gitDir: null,
        input: input as unknown as Record<string, unknown>,
        timeoutMs: input.limits.timeoutMs,
        credential: deps.credential,
        labels: { luna: "slack-triage" },
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
            const answer = SlackTriageAnswer.safeParse(out.answer);
            if (!answer.success) error = `the answer did not match the schema: ${answer.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
            else {
              ok = true;
              const ids = new Set(batch.map((i) => i.id));
              for (const { id, ...verdict } of answer.data.items) {
                if (ids.has(id) && !answers.has(id)) answers.set(id, { ...verdict, summary: verdict.summary.slice(0, SUMMARY_MAX) });
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
    log(ok ? `slack triage: ${batch.length} item(s), ${answers.size} verdict(s), ${usage.turns} turn(s)${cost}` : `slack triage: ${batch.length} item(s) failed: ${error}`);
    try {
      await deps.store.recordTriageRun({ startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), items: batch.length, model: usage.model, turns: usage.turns, costUsd: usage.costUsd, ok, error });
    } catch (thrown) {
      console.warn(`slack triage: could not record the run: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
    return answers;
  }

  return {
    async triage(items, context) {
      const answers = new Map<string, TriageAnswer>();
      for (let at = 0; at < items.length; at += TRIAGE_BATCH) {
        for (const [id, verdict] of await runBatch(items.slice(at, at + TRIAGE_BATCH), context, at / TRIAGE_BATCH)) answers.set(id, verdict);
      }
      return answers;
    },
  };
}
