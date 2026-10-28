// Renders a pack's prompt: the factory header, the answer schema, then the template with
// its {{placeholders}} filled from the stage input. Pure: the caller passes the template and
// the project context, so a test needs no files.
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

/** The rules every stage runs under; appended to the system prompt and restated in the header. */
export const FACTORY_RULES = [
  "You are running in factory mode (LUNA_FACTORY=1): no human is present. A controller wrote /in/stage.json and reads your final answer as the stage result.",
  "Never call AskUserQuestion. A question you cannot settle from the stage input ends the stage: answer with kind \"questions\" (at most three, each with a recommended answer).",
  "Never push, never open or edit pull requests, never post reviews or write to a tracker. An outward action goes in requested[] for the board to approve.",
  "Never write outside /work and /out. Never touch /work/.git directly.",
  "Bash runs only the commands on this stage's allow-list, and a chained command (&&, ;, |) runs only when every part is allowed: one simple command per call, no cd, and Read/Glob/Grep for files. A denied command is not a finding; use an allowed one.",
  "Report progress with the mcp__luna__step tool when it is available; it is a label for the board, not a gate.",
  "Answer ONLY with the JSON object matching the stage's output schema. No text before or after.",
].join("\n");

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
    "{{attempt}}": txt(input.attempt),
    "{{agent}}": agent,
    "{{skills}}": pack.skills.length > 0 ? pack.skills.join(", ") : NONE,
  };
  let body = template;
  for (const [key, value] of Object.entries(subs)) body = body.split(key).join(value);
  const header = [
    `You are the \`${agent}\` role running the \`${pack.id}\` stage in factory mode (LUNA_FACTORY=1). ${FACTORY_RULES.split("\n")[1]} Outward actions go to requested[]. Answer with JSON matching this schema:`,
    JSON.stringify(answerJsonSchema(pack)),
    "",
  ].join("\n");
  return header + body;
}

const CALL_TARGET_MAX = 160;

/** The transcript line for one tool call: `→ <Tool> <target>`. The machine's stuck detector
 *  counts identical lines, so an edit carries a fingerprint of what it changes: four
 *  different edits of one file are four calls, the same failing edit four times is a loop. */
export function callLine(name: string, input: Record<string, unknown>): string {
  const target = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.label ?? "";
  const first = String(target).split("\n")[0]!.slice(0, CALL_TARGET_MAX);
  const change = name === "Edit" || name === "MultiEdit" ? `${input.old_string ?? ""}\u0000${input.new_string ?? ""}${JSON.stringify(input.edits ?? "")}` : name === "Write" ? String(input.content ?? "") : null;
  const fingerprint = change === null ? "" : ` ·${createHash("sha1").update(change).digest("hex").slice(0, 8)}`;
  return `→ ${name} ${first}`.trimEnd() + fingerprint;
}
