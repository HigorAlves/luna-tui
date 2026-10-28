// The Triager port on the Messages API: Haiku 5.5, low effort, structured output. The rubric,
// eight worked examples, the rules file's notes and the current watches form a cached system
// prompt; the user turn is the batch as JSON. One call per batch; usage is logged at debug.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageCreateParamsNonStreaming, Usage } from "@anthropic-ai/sdk/resources/messages";
import { SlackCategory, SlackPriority } from "@hardness/contracts";
import { z } from "zod";

import { TRIAGE_BATCH, type TriageAnswer, type TriageContext, type TriageItem, type Triager } from "../../application/slack-triage.ts";

export const TRIAGE_MODEL = "claude-haiku-5-5";

const Answer = z.object({
  id: z.string(),
  priority: SlackPriority,
  category: SlackCategory,
  expectsReply: z.boolean(),
  summary: z.string(),
  why: z.string(),
  draft: z.string().nullable(),
  refs: z.array(z.object({ kind: z.enum(["pr", "issue", "jira", "url"]), ref: z.string() })),
  deadline: z.string().nullable(),
});
const Answers = z.object({ items: z.array(Answer) });

/** The slice of the SDK client this adapter uses; the real client and a test mock both fit. */
export interface TriageClient {
  messages: {
    parse(params: MessageCreateParamsNonStreaming): Promise<{ parsed_output: unknown; usage: Usage }>;
  };
}

export const RUBRIC = `You triage one person's Slack inbox. Each item is a message (with up to three earlier messages of its thread) that reached them because it mentions them, a team handle or a keyword they watch, or is a DM. Decide, for each item, what they must do about it.

Priority
P0  production incident, someone blocked on them right now, a decision only they can make today
P1  asks them something and waits for it; a review requested; a deadline inside 48h
P2  mentions them for awareness, or a non-urgent ask; a thread they are in moved on
P3  FYI, social, automated, or already answered by someone else in the thread

Category: blocker | decision | question | request | fyi | social | automated.
expectsReply: the text asks them a question or for an action and nobody has answered it yet (read the context).
summary: one line, at most 90 characters, saying what they want from the person, not what they said.
why: one sentence.
draft: only when expectsReply; at most two sentences, in the person's own voice, no greeting, no sign-off, never mention that it was drafted.
refs: PR, issue, Jira keys or URLs the text names, as written. deadline: an ISO date only when the text names one, else null.
A team-handle or keyword match counts as addressed to the person. A broadcast (@here/@channel) is P2 unless it asks them for something.
Answer for every item id you receive, once.

Worked examples
1. "#payments-oncall @marta: checkout is returning 500s since the 14:02 deploy, can you look? Rolling back needs your approval." → P0 blocker, expectsReply, summary "approve the rollback for checkout 500s", draft "Approve the rollback, I'm on it. Cause follows in this thread."
2. "#platform @joão: could you review https://github.com/o/a/pull/212 when you have a minute? Needed for Thursday's release." → P1 request, expectsReply, refs [{pr, "o/a#212"}], deadline the Thursday if a date is given else null.
3. DM @ana: "standup at 10 or 10:30 tomorrow?" → P1 question, expectsReply, draft "10:30 works for me."
4. "#eng @here: the staging DB will be down 20 min at noon" → P2 fyi, not expectsReply.
5. "#luna-tui @sam: how do I link the board to a repo?" context: "@lee: :setup <path> on the board does it" → P3 question, not expectsReply (answered), why "lee already answered".
6. "#random @marta: congrats on the launch 🎉" → P3 social, not expectsReply.
7. "#deploys (app): deploy of api v2.3 finished" → P3 automated, not expectsReply.
8. "#data @platform-team: we need to pick between Postgres and ClickHouse for the events table by Friday; thoughts?" → P1 decision, expectsReply, deadline that Friday if dated, summary "pick Postgres or ClickHouse for events by Friday".`;

function contextBlock(context: TriageContext): string {
  const watches = context.watches.filter((w) => w.enabled).map((w) => `- ${w.label} (${w.kind}${w.priority ? `, at least ${w.priority}` : ""})`);
  return [
    "Watches (these count as addressed to the person):",
    watches.length > 0 ? watches.join("\n") : "- none",
    "",
    "Notes from the person:",
    context.notes || "- none",
    "",
    "Learned from what they did (lowered: they clear this author or channel without replying; raised: they answer it fast):",
    context.learned.length > 0 ? context.learned.join("\n") : "- none",
  ].join("\n");
}

export interface TriageAdapterOptions {
  model?: string;
  /** Debug logging; defaults to console.debug. */
  log?: (line: string) => void;
}

/** The port over any client shaped like the SDK's. */
export function createTriager(client: TriageClient, options: TriageAdapterOptions = {}): Triager {
  const model = options.model ?? TRIAGE_MODEL;
  const log = options.log ?? ((line: string) => console.debug(line));
  return {
    async triage(items, context) {
      const answers = new Map<string, TriageAnswer>();
      for (let at = 0; at < items.length; at += TRIAGE_BATCH) {
        const batch = items.slice(at, at + TRIAGE_BATCH);
        const response = await client.messages.parse({
          model,
          max_tokens: Math.min(16_000, 500 + 400 * batch.length),
          output_config: { effort: "low", format: zodOutputFormat(Answers) },
          system: [
            { type: "text", text: RUBRIC },
            { type: "text", text: contextBlock(context), cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: JSON.stringify(batch) }],
        });
        const u = response.usage;
        log(`slack triage: ${batch.length} item(s), ${u.input_tokens} in (${u.cache_read_input_tokens ?? 0} cached, ${u.cache_creation_input_tokens ?? 0} written), ${u.output_tokens} out`);
        const parsed = Answers.safeParse(response.parsed_output);
        if (!parsed.success) continue;
        const ids = new Set(batch.map((i) => i.id));
        for (const { id, ...answer } of parsed.data.items) {
          if (ids.has(id) && !answers.has(id)) answers.set(id, { ...answer, summary: answer.summary.slice(0, 90) });
        }
      }
      return answers;
    },
  };
}

/** The real thing, from an API key. */
export function createAnthropicTriager(apiKey: string, options: TriageAdapterOptions = {}): Triager {
  return createTriager(new Anthropic({ apiKey }), options);
}

export type { TriageItem };
