// Renders a pack's prompt: the factory header (the role, the stage and how this stage ends when
// it cannot settle something), then the template with its {{placeholders}} filled from the
// stage input. The answer's shape is not in the prompt: the SDK's structured output enforces it
// (main.ts, `outputFormat`). Pure: the caller passes the template and the project context, so a
// test needs no files.
import type { Pack, StageInput } from "@hardness/contracts";
import { answerJsonSchema } from "@hardness/contracts";
import { createHash } from "node:crypto";

const NONE = "(none)";

const txt = (value: unknown): string => (value == null || value === "" ? NONE : String(value));
const bullets = (value: unknown): string =>
  Array.isArray(value) && value.length > 0 ? value.map((item) => `- ${String(item)}`).join("\n") : NONE;

const decisionLine = (d: StageInput["decisions"][number]): string => {
  const why = d.reason && d.reason !== "" ? d.reason : Object.keys(d.answers ?? {}).length > 0 ? JSON.stringify(d.answers) : NONE;
  return `- ${d.decision} at ${d.at}: ${why}`;
};

const findingLine = (f: StageInput["priorFindings"][number]): string => `- ${f.severity} ${f.path}:${f.line} ${f.title}`;

/** The PR, its checks and the failed run's log tail, as ci_watch reads them. */
const ciText = (ci: StageInput["context"]["ci"]): string => {
  if (!ci) return NONE;
  const pr = ci.pr ? `PR #${ci.pr.number}${ci.pr.url ? ` (${ci.pr.url})` : ""}` : "PR: (none)";
  const checks = ci.checks.length > 0 ? ci.checks.map((c) => `- ${c.name}: ${c.state}${c.url ? ` (${c.url})` : ""}`).join("\n") : "- (no checks)";
  const logs = ci.logs ? `Failed run log tail:\n\`\`\`\n${ci.logs}\n\`\`\`` : "(no log fetched)";
  return `${pr}\nChecks:\n${checks}\n${logs}`;
};

const prLine = (pr: NonNullable<StageInput["context"]["review"]>["pr"]): string =>
  `PR #${pr.number} ${pr.title} by @${pr.author}: ${pr.headRef} into ${pr.baseRef} (${pr.url})`;

/** The PR, its files, the comments already on it and the diff, as reviewing reads them. */
const reviewText = (review: StageInput["context"]["review"]): string => {
  if (!review) return NONE;
  const body = review.pr.body && review.pr.body.trim() !== "" ? review.pr.body.trim() : "(no description)";
  const files = review.files.length > 0 ? review.files.map((f) => `- ${f.path} (+${f.additions} -${f.deletions})`).join("\n") : "- (none)";
  const comments =
    review.existingComments.length > 0
      ? review.existingComments.map((c) => `- ${c.path ?? "(general)"}${c.line !== null ? `:${c.line}` : ""} @${c.author}: ${c.body}`).join("\n")
      : "- (none)";
  return `${prLine(review.pr)}\n\n${body}\n\nFiles:\n${files}\n\nComments already on the PR:\n${comments}\n\nDiff:\n\`\`\`diff\n${review.diff}\n\`\`\``;
};

/** The unresolved threads, each under its GraphQL id, as addressing reads them. */
const threadsText = (threads: StageInput["context"]["threads"]): string => {
  if (!threads) return NONE;
  const list = threads.threads.map((t) => {
    const where = t.path ? `${t.path}${t.line !== null ? `:${t.line}` : ""}` : "the PR as a whole";
    const comments = t.comments.map((c) => `- @${c.author} (${c.at}): ${c.body}`).join("\n");
    return `### Thread ${t.id} at ${where}\n${comments}`;
  });
  return `${prLine(threads.pr)}\n\n${list.join("\n\n") || "(no unresolved threads)"}`;
};

/** The inbox batch, as slack_triage reads it: one block per item, context and matches inline. */
const slackText = (slack: StageInput["context"]["slack"]) => {
  if (!slack) return { me: NONE, watches: NONE, rules: NONE, items: NONE };
  const items = slack.items.map((item, i) => {
    const head = `${i + 1}. id ${item.id} · ${item.channel} · ${item.author}${item.isBot ? " (app)" : ""} · matched ${item.matched.join(", ") || "(none)"}${item.threadReplies > 0 ? ` · ${item.threadReplies} thread repl${item.threadReplies === 1 ? "y" : "ies"}` : ""}`;
    const context = item.context.map((m) => `   earlier · ${m.user}: ${m.text}`);
    return [head, ...context, `   text: ${item.text}`].join("\n");
  });
  return {
    me: `${slack.me.name} (${slack.me.id})`,
    watches: slack.watches.length > 0 ? slack.watches.map((w) => `- ${w.label} (${w.kind})`).join("\n") : NONE,
    rules: slack.rules.trim() === "" ? NONE : slack.rules.trim(),
    items: items.length > 0 ? items.join("\n") : NONE,
  };
};

/** The signals, as datadog_triage reads them: one block per item, in the order the machine sent. */
const datadogText = (datadog: StageInput["context"]["datadog"]) => {
  if (!datadog) return { scope: NONE, items: NONE };
  const items = datadog.items.map((item, i) => {
    const facts = [
      item.source,
      item.service ? `service ${item.service}` : null,
      `env ${item.env ?? "(none)"}`,
      `status ${item.status}`,
      item.severity ? `severity ${item.severity}` : null,
      item.count !== null ? `${item.count} in the window` : null,
      `first ${item.firstSeen}`,
      `last ${item.lastSeen}`,
      item.floor ? `floor ${item.floor}` : null,
      item.reopened ? "reopened" : null,
    ].filter(Boolean);
    return [`${i + 1}. id ${item.id} · ${facts.join(" · ")}`, `   title: ${JSON.stringify(item.title)}`, ...item.samples.map((s) => `   sample: ${JSON.stringify(s)}`)].join("\n");
  });
  return { scope: datadog.scope.trim() === "" ? NONE : datadog.scope.trim(), items: items.length > 0 ? items.join("\n") : NONE };
};

/** The issue, as jira_intake reads it: one header line, the description, the comments, the repo. */
const jiraText = (jira: StageInput["context"]["jira"]) => {
  if (!jira) return { issue: NONE, description: NONE, comments: NONE, repoPath: NONE };
  const facts = [
    `${jira.key} · ${jira.issueType ?? "no type"} · priority ${jira.priority ?? "none"}`,
    jira.labels.length > 0 ? `labels ${jira.labels.join(", ")}` : null,
    jira.dueAt ? `due ${jira.dueAt}` : null,
  ].filter(Boolean);
  return {
    issue: `${jira.summary}\n${facts.join(" · ")}\n${jira.url}`,
    description: jira.description.trim() === "" ? NONE : jira.description.trim(),
    comments: jira.comments.length > 0 ? jira.comments.map((c) => `- ${c}`).join("\n") : NONE,
    repoPath: jira.repoPath ?? "(unknown: /work is empty)",
  };
};

/** The rules every stage runs under, appended to the system prompt. This is the one place they
 *  are stated: the templates and the role bodies add only what is specific to their stage. */
export const FACTORY_RULES = [
  "You are running in factory mode (LUNA_FACTORY=1): no person is present. The machine wrote /in/stage.json and reads your structured answer as the stage result; it reads nothing else you write.",
  "Never call AskUserQuestion: nobody would answer it. A question you cannot settle from the stage input ends the stage, in the shape this stage's answer allows (your prompt names it).",
  "Never push, never open or edit pull requests, never post reviews or write to a tracker: the machine does those after a person approves. A stage whose answer has requested[] puts the outward action it needs there.",
  "Never write outside /work and /out, and never touch /work/.git directly: everything else is mounted read-only and a hook denies the write.",
  "Bash runs only the commands on this stage's allow-list, and a chained command (&&, ;, |) runs only when every part is allowed: one simple command per call, no cd, and Read/Glob/Grep for files. A denied command is not a finding; use an allowed one.",
  "Report progress with the mcp__luna__step tool when it is available; it is a label for the board, not a gate.",
].join("\n");

/** How this stage ends when it cannot settle something: the pack's own answer shape, read from
 *  its schema, so the header never promises a `kind: "questions"` a pack cannot give. */
export function escalationLine(pack: Pack): string {
  const properties = (answerJsonSchema(pack).properties ?? {}) as Record<string, { enum?: unknown[] }>;
  const kinds = properties.kind?.enum ?? [];
  const verdicts = properties.verdict?.enum ?? [];
  if (kinds.includes("questions")) return 'A question you cannot settle from the stage input ends the stage: answer kind "questions" (at most three, each with a recommended answer).';
  if (kinds.includes("escalated")) return 'What you cannot settle from the stage input ends the stage: answer kind "escalated" with reason and options[].';
  if (verdicts.includes("needs_brief")) return 'What you cannot settle from the issue ends the stage: verdict "needs_brief" with reason and questions[] (at most three, each with a recommended answer).';
  return "This stage has no escalation: settle what the input leaves open with the rules in your prompt.";
}

export interface RenderInput {
  pack: Pack;
  input: StageInput;
  template: string;
  /** The worktree's docs/agents/project-context.md, when the input carries none. */
  projectContext?: string | null;
}

/** The prompt the model gets. */
export function renderPrompt({ pack, input, template, projectContext }: RenderInput): string {
  const agent = pack.agent ?? "script";
  const context = input.context.projectContext ?? projectContext ?? null;
  const slack = slackText(input.context.slack);
  const jira = jiraText(input.context.jira);
  const datadog = datadogText(input.context.datadog);
  const subs: Record<string, string> = {
    "{{task.title}}": txt(input.task.title),
    "{{task.description}}": txt(input.task.description),
    "{{task.criteria}}": bullets(input.task.criteria),
    "{{task.branch}}": txt(input.task.branch),
    "{{plan.brief}}": txt(input.plan?.brief),
    "{{plan.criteria}}": bullets(input.plan?.criteria),
    "{{plan.assumptions}}": bullets(input.plan?.assumptions),
    "{{plan.slices}}": bullets(
      (input.plan?.slices ?? []).map((s, i) => {
        const slice = s as { title?: string; est_loc?: number; touchpoints?: string[]; acceptance?: string[] };
        return `${i + 1}. ${slice.title ?? "(untitled)"} (~${slice.est_loc ?? "?"} LOC; touches ${(slice.touchpoints ?? []).join(", ") || "?"}): ${(slice.acceptance ?? []).join("; ") || "(no acceptance)"}`;
      }),
    ),
    "{{decisions}}": input.decisions.length > 0 ? input.decisions.map(decisionLine).join("\n") : NONE,
    "{{priorFindings}}": input.priorFindings.length > 0 ? input.priorFindings.map(findingLine).join("\n") : NONE,
    "{{context.projectContext}}": txt(context),
    "{{context.testCases}}": bullets(
      (input.context.testCases ?? []).map((c) => {
        const approach = "approach" in c ? c.approach : c.test;
        return `${c.title}${c.criterion ? ` (criterion: ${c.criterion})` : ""}: ${approach}`;
      }),
    ),
    "{{context.baseCommit}}": txt(input.context.baseCommit),
    "{{context.ci}}": ciText(input.context.ci),
    "{{context.review}}": reviewText(input.context.review),
    "{{context.threads}}": threadsText(input.context.threads),
    "{{context.checks}}": input.context.checks
      ? bullets(
          input.context.checks.map((c) => {
            const where = c.cwd && c.cwd !== "." ? ` in ${c.cwd.replace(/\/$/, "")}/` : "";
            const scope = c.paths && c.paths.length > 0 ? ` (for changes under ${c.paths.join(", ")})` : "";
            return `${c.name}: \`${c.run}\`${where}${scope}`;
          }),
        )
      : "(none declared; detect the suite from the tree)",
    "{{context.qaTargets}}": bullets((input.context.qaTargets ?? []).map((t) => `${t.name}: ${t.baseUrl}${t.credential ? ` (credential: ${t.credential})` : ""}`)),
    "{{context.slack.me}}": slack.me,
    "{{context.slack.watches}}": slack.watches,
    "{{context.slack.rules}}": slack.rules,
    "{{context.slack.items}}": slack.items,
    "{{context.datadog.scope}}": datadog.scope,
    "{{context.datadog.items}}": datadog.items,
    "{{context.jira.issue}}": jira.issue,
    "{{context.jira.description}}": jira.description,
    "{{context.jira.comments}}": jira.comments,
    "{{context.jira.repoPath}}": jira.repoPath,
    "{{attempt}}": txt(input.attempt),
    "{{agent}}": agent,
    "{{skills}}": pack.skills.length > 0 ? pack.skills.join(", ") : NONE,
  };
  let body = template;
  for (const [key, value] of Object.entries(subs)) body = body.split(key).join(value);
  const header = [`You are the \`${agent}\` role running the \`${pack.id}\` stage in factory mode (LUNA_FACTORY=1); no person is present. ${escalationLine(pack)}`, ""].join("\n");
  return header + body;
}

const CALL_TARGET_MAX = 160;

/** The transcript line for one tool call: `→ <Tool> <target>`. The machine's stuck detector
 *  counts identical lines, so an edit carries a fingerprint of what it changes: four
 *  different edits of one file are four calls, the same failing edit four times is a loop. */
export function callLine(name: string, input: Record<string, unknown>): string {
  const target = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.label ?? "";
  // A paged read is a different call per page: a long file read in four pages is not a loop.
  const page = name === "Read" && (input.offset !== undefined || input.limit !== undefined) ? `:${input.offset ?? 0}+${input.limit ?? ""}` : "";
  const first = `${String(target).split("\n")[0]!}${page}`.slice(0, CALL_TARGET_MAX);
  const change = name === "Edit" || name === "MultiEdit" ? `${input.old_string ?? ""}\u0000${input.new_string ?? ""}${JSON.stringify(input.edits ?? "")}` : name === "Write" ? String(input.content ?? "") : null;
  const fingerprint = change === null ? "" : ` ·${createHash("sha1").update(change).digest("hex").slice(0, 8)}`;
  return `→ ${name} ${first}`.trimEnd() + fingerprint;
}
