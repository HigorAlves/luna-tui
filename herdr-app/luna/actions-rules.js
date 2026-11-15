// When each ticket action applies, and the bodies it sends: pure functions, no host calls, so
// `node --test` checks them. The rules are the TUI's (`board/src/keys.rs`, `board/src/app.rs`);
// the machine still decides, and refuses what does not fit.
import { approversOf, ended, gateKey, gateQuestion, namesNeeded, splitWhat } from "./model.js";

export const detailOf = (app, task) => app.details?.[task.id] ?? null;

/** The newest approval of `kind`, decided or not. */
export function latestApproval(detail, kind) {
  return [...(detail?.approvals ?? [])].reverse().find((a) => a.kind === kind) ?? null;
}

/** The approval nobody has answered yet. */
export const openApproval = (detail) => [...(detail?.approvals ?? [])].reverse().find((a) => !a.decision) ?? null;

/** The release question: an `awaiting_ship` gate that waits on you and asks `ship_approval`. */
export const atRelease = (task) => task.state === "awaiting_ship" && Boolean(task.waitingOnYou) && task.gate?.requested?.gate === "ship_approval";

export const atMemoryReview = (task) => task.state === "reviewing_memory" && Boolean(task.waitingOnYou);

export const isEscalated = (task) => task.state === "escalated";

export { gateKey, gateQuestion };

/** The ticket's short id as the TUI's confirm texts print it. */
const hash = (task) => `#${String(task.id ?? "").slice(0, 8)}`;

/**
 * The `a` key's question, in words: what saying yes does at this gate. The title is the TUI's confirm
 * text for the gate (`approval_gate`); the body says what happens, from the gate itself.
 */
export function approveWords(task, detail = null, approver = null) {
  const r = task.gate?.requested ?? {};
  const open = openApproval(detail);
  const have = approversOf(open ?? { requested: r }).length;
  const needed = namesNeeded(r);
  switch (task.state) {
    case "awaiting_approval": {
      if (r.outcome === "split") {
        const { text, noun } = splitWhat(r);
        const where = noun === "ticket" ? `Approving creates ${text} in the tracker, linked to this card.` : `The ${text} become cards of their own.`;
        return { title: `Approve the split of ${hash(task)}?`, body: needed > 1 ? `${where} ${peopleWords(needed, have, approver)}` : where };
      }
      if (r.outcome === "archive") return { title: `Archive ${hash(task)}?`, body: "The card ends archived." };
      if (r.outcome === "conversation") return { title: `Post the reply and close ${hash(task)}?`, body: "The reply goes where the ticket came from and the card closes." };
      const base = "Build starts on this plan.";
      return { title: `Approve the plan of ${hash(task)}?`, body: needed > 1 ? `${base} ${peopleWords(needed, have, approver)}` : base };
    }
    case "awaiting_test_check": return { title: `Approve the test cases of ${hash(task)}?`, body: "Build starts with these test cases." };
    case "awaiting_setup":
      return {
        title: `Write the proposed luna.yaml for ${hash(task)}?`,
        body: task.route === "setup" ? "The proposed luna.yaml is written to the repository and the card closes." : "The proposed luna.yaml is written to the repository and the card goes on to triage.",
      };
    case "awaiting_ship":
      if (task.route === "review") return { title: `Post the review of ${hash(task)}?`, body: "The review goes to GitHub as written, with its line comments." };
      if (r.gate === "ship_approval") return { title: `Approve the release of ${hash(task)}?`, body: "You answer yes to: safe to release now? The machine merges the PR." };
      return { title: `Ship ${hash(task)}?`, body: "The machine publishes the PR and goes on watching it. Merging is asked after the checks." };
    case "reviewing_memory": return { title: `Approve the retro's rules of ${hash(task)}?`, body: "Its proposed rules are written to project-context.md." };
    default: return { title: `Approve ${hash(task)}?`, body: "The card goes on from here." };
  }
}

/** `Two different people must approve; yours is the first name.` */
export function peopleWords(needed, have, approver = null) {
  const word = { 2: "Two", 3: "Three", 4: "Four" }[needed] ?? String(needed);
  const place = have === 0 ? "the first" : have + 1 >= needed ? "the last" : "the next";
  const name = approver ? "" : " Set LUNA_APPROVER so your name is kept.";
  return `${word} different people must approve; yours is ${place} name.${name}`;
}

/**
 * What to say after an approval that left the gate open: who approved and how many more are needed
 * (the TUI's "1 of 2"). `detail` is the task as read right after the decision; null when the gate closed.
 */
export function partialApproval(detail, approver = null) {
  const task = detail?.task;
  const open = openApproval(detail);
  if (!task || !open || !task.waitingOnYou) return null;
  const needed = namesNeeded(open.requested ?? {});
  const names = approversOf(open);
  if (needed < 2 || names.length < 1 || names.length >= needed) return null;
  const left = needed - names.length;
  const who = names.join(", ");
  return `Approved by ${who || approver || "you"}: ${names.length} of ${needed} approvals. ${left === 1 ? "One more name is" : `${left} more names are`} needed.`;
}

/** The criterion ids the open plan gate has already excused. */
export function excusedIds(requested = {}) {
  const u = requested.coverageReport?.untestable ?? requested.untestable ?? [];
  return (Array.isArray(u) ? u : []).map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean);
}

/** The coverage gaps still to decide: the machine's list less the criteria already excused. */
export function openGaps(gaps, excused = []) {
  const done = new Set(excused);
  return (gaps ?? []).filter((g) => !done.has(g?.id ?? g));
}

/** `e` on the ticket: any card still open. */
export const canEditTicket = (task) => !ended(task);

const NO_PLAN = ["split", "split_failed", "conversation", "archive"];

/** The plan may be edited at its own gate, or at the test check, before anything is built; not a split, a reply or an archive. */
export function canEditPlan(task, detail) {
  if (!["awaiting_approval", "awaiting_test_check"].includes(task.state) || !detail) return false;
  const a = latestApproval(detail, "awaiting_approval");
  if (!a) return false;
  if (!a.decision && NO_PLAN.includes(a.requested?.outcome)) return false;
  return true;
}

/** Steps, rollback and risk are refused once the plan is approved (`plan_approved`): only at the open plan gate. */
export const canEditPlanFully = (task, detail) => canEditPlan(task, detail) && task.state === "awaiting_approval" && !latestApproval(detail, "awaiting_approval")?.decision;

/** The gate that carries the cases: a test check, else the plan gate that holds them. */
export function casesApproval(detail) {
  return latestApproval(detail, "awaiting_test_check") ?? (() => {
    const a = latestApproval(detail, "awaiting_approval");
    return a && Array.isArray(a.requested?.cases) ? a : null;
  })();
}

export const casesOf = (detail) =>
  (casesApproval(detail)?.requested?.cases ?? []).filter((c) => c?.title).map((c) => ({ title: c.title, criterion: c.criterion ?? null, approach: c.approach ?? c.test ?? "" }));

/** Cases may be edited only while they wait for your check. */
export function canEditCases(task, detail) {
  if (!["awaiting_test_check", "awaiting_approval"].includes(task.state) || !detail) return false;
  const a = casesApproval(detail);
  return Boolean(a && !a.decision && casesOf(detail).length > 0);
}

export const canCorrectRecord = (task) => Boolean(task.record) && ["awaiting_answers", "awaiting_approval"].includes(task.state);

export const canWatch = (task) => Boolean(task.running) && !ended(task);

export const canRemoveWorktree = (task) => Boolean(task.worktreePath) && !task.running;

export const canSetRepo = (task) => !ended(task);

export const canMerge = (task) => !ended(task) && !task.mergedInto;

export const canUnmerge = (task) => Boolean(task.mergedInto);

export const canGiveFeedback = (task) => Boolean(task.evidence);

/** The findings Verify reported that nobody has resolved. */
export function openFindings(detail) {
  return (detail?.reports?.verify?.findings ?? []).filter((f) => f && f.id && !f.resolution);
}

export const canDismissFinding = (task, detail) => task.state === "awaiting_ship" && openFindings(detail).length > 0;

export const canAddFinding = (task, detail) => !ended(task) && (task.state === "awaiting_ship" || Boolean(detail?.reports?.verify));

/** Jira: offered only when the machine says it is configured. */
export const jiraOn = (app) => Boolean(app?.state?.("jira")?.configured);
export const canLinkJira = (task, app) => jiraOn(app) && !task.jira && !ended(task);
export const canUnlinkJira = (task, app) => jiraOn(app) && Boolean(task.jira);

/** The linked issue's page: the source's link, else the Jira issue's. */
export const issueLink = (task) => task.source?.url ?? task.source?.permalink ?? task.jira?.url ?? null;

/** The PR's page: the watched PR, the ship gate's report, else the inbox's row for the branch. */
export function prLink(task, detail, app) {
  const ship = detail?.ship?.pr;
  if (ship?.url && ship.number > 0) return ship.url;
  const gate = latestApproval(detail, "awaiting_ship")?.requested?.prUrl ?? task.gate?.requested?.prUrl;
  if (gate) return gate;
  const rows = [...(app?.prs?.inbox?.prs ?? []), ...(app?.prs?.all?.prs ?? [])];
  return task.branch ? rows.find((p) => p.headRef === task.branch)?.url ?? null : null;
}

// ---- words and enums, as the TUI has them ----

export const RECORD_FIELDS = [
  ["kind", "Kind", ["bug", "feature", "task", "chore", "question", "incident"]],
  ["typeOfWork", "Type of work", ["frontend", "backend", "infra", "data", "docs", "mixed"]],
  ["size", "Size", ["XS", "S", "M", "L", "XL"]],
  ["riskPrelim", "Risk", ["low", "medium", "high"]],
  ["priority", "Priority", ["P0", "P1", "P2", "P3"]],
];

export const recordValue = (task, key) => (key === "priority" ? task.record?.urgencyDetail?.priority : task.record?.[key]) ?? null;

export const ESCALATION_REASONS = [
  ["plan_wrong", "The plan cannot be built as written"],
  ["env_broken", "A service, tool or the container is at fault"],
  ["flaky_tests", "A test flips on unchanged code"],
  ["too_complex", "Bigger than the plan allowed for"],
  ["undeclared_scope", "Needs files the plan does not name"],
  ["other", "None of these, or it does not say"],
];

export const SEVERITIES = [
  ["blocker", "Blocker"],
  ["should_fix", "Should fix"],
  ["nit", "Nit"],
];

// ---- request bodies ----

/** Retry an escalation: the TUI sends `approved` with the guidance as the reason, `null` for none. */
export const guidanceBody = (note) => ({ reason: String(note ?? "").trim() || null });

/** Send back: the stage reads the reason, so it is required (the TUI: "say why it goes back"). Null when empty. */
export const sendBackBody = (note) => (String(note ?? "").trim() ? { reason: String(note).trim() } : null);

export const rejectReleaseBody = (comment) => ({ reason: String(comment).trim() });

export const dismissBody = (reason) => (String(reason ?? "").trim() ? { reason: String(reason).trim() } : {});

export const feedbackBody = (useful, note) => {
  const body = { useful: Boolean(useful) };
  const text = String(note ?? "").trim();
  if (text) body.note = text.slice(0, 500);
  return body;
};

export function findingBody({ severity, title, path, line }) {
  const body = { severity, title: String(title).trim() };
  if (String(path ?? "").trim()) body.path = path.trim();
  const n = Number.parseInt(line, 10);
  if (Number.isFinite(n) && n > 0 && body.path) body.line = n;
  return body;
}

/** Percent-encodes one path segment, as the TUI does. */
export const segment = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export const looksLikeJiraKey = (key) => /^[A-Z][A-Z0-9_]+-\d+$/.test(key);

// ---- the text editors' markdown, as the TUI writes and reads it ----

const list = (items) => items.map((i) => `- ${i}`).join("\n");

export function ticketMarkdown({ title, description, criteria }) {
  return `# ${title}\n\n## Description\n\n${description ?? ""}\n\n## Acceptance criteria\n\n${list(criteria ?? [])}\n`;
}

export function parseTicket(markdown, fallbackTitle) {
  let section = "other";
  let title = "";
  const description = [];
  const criteria = [];
  for (const line of markdown.split("\n")) {
    const heading = /^## (.*)$/.exec(line);
    if (heading) {
      const h = heading[1].trim().toLowerCase();
      section = h === "description" ? "description" : h === "acceptance criteria" ? "criteria" : "other";
    } else if (!title && section === "other" && line.startsWith("# ")) {
      title = line.slice(2).trim();
    } else if (section === "description") {
      description.push(line);
    } else if (section === "criteria") {
      const item = line.trim().replace(/^- /, "").replace(/^\[[ x]\] /, "").trim();
      if (item) criteria.push(item);
    }
  }
  return { title: title || fallbackTitle, description: description.join("\n").trim(), criteria };
}

/** One line per item; blank lines and a leading `- ` are dropped. */
export const lines = (text) => String(text ?? "").split("\n").map((l) => l.trim().replace(/^- /, "").trim()).filter(Boolean);

export function casesMarkdown(cases) {
  const groups = [];
  for (const c of cases) {
    let g = groups.find((x) => x.criterion === (c.criterion ?? null));
    if (!g) groups.push((g = { criterion: c.criterion ?? null, cases: [] }));
    g.cases.push(c);
  }
  let out = "# Test cases\n";
  for (const g of groups) {
    out += `\n## ${g.criterion ?? "(no criterion)"}\n\n`;
    for (const c of g.cases) {
      out += `- ${c.title}\n`;
      for (const l of String(c.approach ?? "").split("\n").filter((x) => x.trim())) out += `  ${l.trim()}\n`;
    }
  }
  return out;
}

export function parseCases(markdown) {
  const cases = [];
  let criterion = null;
  for (const line of markdown.split("\n")) {
    const heading = /^## (.*)$/.exec(line);
    if (heading) {
      const h = heading[1].trim();
      criterion = h && h !== "(no criterion)" ? h : null;
    } else if (line.startsWith("# ")) {
      continue;
    } else if (/^[-*] /.test(line)) {
      const title = line.slice(2).trim();
      if (title) cases.push({ title, criterion, approach: "" });
    } else if (cases.length) {
      const text = line.trim();
      if (text) {
        const c = cases.at(-1);
        c.approach += `${c.approach ? "\n" : ""}${text}`;
      }
    }
  }
  return cases;
}

/**
 * The plan's steps as the editor holds them, from the gate's real shape: `requested.plan.steps`
 * (v2.2 plan), else the older `requested.slices` (a slice has a title, not a description).
 */
export function planSteps(requested = {}) {
  const raw = Array.isArray(requested.plan?.steps) && requested.plan.steps.length ? requested.plan.steps : Array.isArray(requested.slices) ? requested.slices : [];
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" && v ? [v] : []);
  return raw
    .map((s) => ({
      description: typeof s?.description === "string" && s.description ? s.description : typeof s?.title === "string" ? s.title : "",
      files: strings(s?.files),
      done_when: strings(s?.done_when ?? s?.acceptance),
      est_loc: Number.isFinite(s?.est_loc) ? Math.max(0, Math.round(s.est_loc)) : 0,
    }))
    .filter((s) => s.description);
}

/** The fields of the plan the editor starts from, read from the gate's `requested`. */
export function planFields(requested = {}) {
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return {
    brief: typeof requested.brief === "string" ? requested.brief : typeof requested.plan?.goal === "string" ? requested.plan.goal : "",
    criteria: strings(requested.criteria),
    assumptions: strings(requested.assumptions),
    steps: planSteps(requested),
    rollback: typeof requested.rollback === "string" ? requested.rollback : typeof requested.plan?.rollback === "string" ? requested.plan.rollback : "",
    risk: requested.risk?.level ? { level: requested.risk.level, reason: requested.risk.reason ?? requested.overrides?.risk?.reason ?? "" } : null,
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Each new step keeps the files, `done_when` and size of the old step with the same words; else of the one at its place if that one is not kept elsewhere. */
function keepStepData(before, now) {
  const used = new Set();
  const words = new Set(now);
  return now.map((description, i) => {
    let at = before.findIndex((s, j) => !used.has(j) && s.description === description);
    if (at < 0 && before[i] && !used.has(i) && !words.has(before[i].description)) at = i;
    if (at >= 0) used.add(at);
    const old = at >= 0 ? before[at] : null;
    return { description, files: old?.files ?? [], done_when: old?.done_when ?? [], est_loc: old?.est_loc ?? 0 };
  });
}

/**
 * The PATCH body of a plan edit: only what changed. `now` is what the form holds
 * ({brief, criteria[], assumptions[], steps: string[] (descriptions), rollback, riskLevel, riskReason});
 * a step keeps its files, `done_when` and size from the step it was (same words, else same place).
 * The risk goes only with a reason: the machine refuses an empty one, so clearing the reason alone sends nothing.
 */
export function planPatch(before, now, full) {
  const body = {};
  if (now.brief.trim() !== before.brief.trim()) body.brief = now.brief.trim();
  if (!same(now.criteria, before.criteria)) body.criteria = now.criteria;
  if (!same(now.assumptions, before.assumptions)) body.assumptions = now.assumptions;
  if (full) {
    const old = before.steps.map((s) => s.description);
    if (!same(now.steps, old)) body.steps = keepStepData(before.steps, now.steps);
    if (now.rollback.trim() !== before.rollback.trim()) body.rollback = now.rollback.trim();
    const reason = now.riskReason.trim();
    if (now.riskLevel && reason && (now.riskLevel !== before.risk?.level || reason !== (before.risk?.reason ?? "").trim())) {
      body.risk = { level: now.riskLevel, reason };
    }
  }
  return body;
}

/** The first six characters of a task id, as the TUI shows it. */
export const shortId = (id) => String(id ?? "").slice(0, 8);

/** A container name the machine chose but a terminal will read: one plain word. */
export const validContainer = (name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(String(name ?? ""));

/** The tab `Watch` opens: `{name, argv, folder}`, or an error in words. */
export function watchTab(stage) {
  if (!stage) return { error: "Nothing to watch: no stage container has started for this ticket." };
  if (!validContainer(stage.container)) return { error: "Refused: the container name is not a plain name." };
  return { tab: { name: stage.label, argv: ["docker", "logs", "-f", stage.container], folder: stage.cwd } };
}
