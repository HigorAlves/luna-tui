// What the board shows, worked out from the machine's tasks and PRs: pure functions, no host
// calls, so `node --test` checks them. The machine decides; this only reads.

/** The machine's columns (`COLUMNS` in contracts), in order. */
export const COLUMNS = ["Intake", "Triage", "Plan", "Build", "Verify", "Evidence", "Ship", "Done"];

/** The open columns in three groups, as the design draws them. Done folds to a rail. */
export const GROUPS = [
  { name: "Plan", columns: ["Intake", "Triage", "Plan"] },
  { name: "Make", columns: ["Build", "Verify", "Evidence"] },
  { name: "Ship", columns: ["Ship"] },
];

/** A running stage silent this long is stale (the Rust board's `STALE_SECS`). */
export const STALE_MS = 20 * 60 * 1000;

const ENDED = new Set(["closed", "archived"]);
export const ended = (task) => ENDED.has(task.state);

/** How a card looks: the Rust board's `Look`. */
export function look(task, now = Date.now()) {
  switch (task.state) {
    case "escalated": return "escalated";
    case "paused_rate_limit": return "paused";
    case "draft": return "draft";
    case "closed": return "done";
    case "archived": return "archived";
  }
  if (task.waitingOnYou) return "needs_you";
  if (task.queued) return "queued";
  if (task.running) {
    const at = Date.parse(task.updatedAt ?? "");
    return Number.isFinite(at) && now - at > STALE_MS ? "stale" : "working";
  }
  return "idle";
}

/** A gate waiting or an escalation: the person has something to do here. */
export const needsYou = (task, now) => ["needs_you", "escalated"].includes(look(task, now));
export const isWorking = (task, now) => ["working", "stale", "queued"].includes(look(task, now));

const ESCALATION_WORDS = {
  plan_wrong: "the plan is wrong",
  env_broken: "the environment is broken",
  flaky_tests: "the tests are flaky",
  too_complex: "too complex for this engine",
  undeclared_scope: "it changed files outside its scope",
  head_moved: "the branch moved under it",
  stopped: "you stopped it",
  other: "it needs a person",
};

export const escalationWords = (reason) => ESCALATION_WORDS[reason] ?? String(reason ?? "").replaceAll("_", " ");

export const ARCHIVE_REASONS = [
  ["duplicate", "Duplicate of another ticket"],
  ["sla_expired", "Nobody answered in time"],
  ["rejected", "Decided against"],
  ["not_for_agent", "Not work for an agent"],
  ["pr_closed", "Its PR was closed"],
  ["no_setup", "Nobody set the repository up"],
  ["no_answer", "Nobody answered the questions"],
];

const STAGE_WORDS = {
  draft: "Draft",
  setup: "Setting up",
  triage: "Triage",
  test_design: "Writing test cases",
  implementing: "Building",
  verifying: "Verifying",
  e2e: "End-to-end tests",
  delivering: "Opening the PR",
  ci_watch: "Watching CI",
  evidence: "Collecting evidence",
  shipping: "Shipping",
  reviewing_memory: "Retro",
  reviewing: "Reviewing the PR",
  addressing: "Addressing review threads",
  awaiting_ship: "Watching the PR",
  closed: "Closed",
  archived: "Archived",
};

export const stageWords = (state) => STAGE_WORDS[state] ?? String(state ?? "").replaceAll("_", " ");

/** The question a gate asks, from the task alone (its `gate`): null when nothing waits on you. */
export function gateQuestion(task) {
  const requested = task.gate?.requested ?? {};
  switch (task.state) {
    case "awaiting_approval":
      if (requested.outcome === "archive") return "Archive this ticket?";
      if (requested.outcome === "conversation") return "Post the reply and close?";
      if (requested.outcome === "split") return "Approve the split?";
      if (requested.outcome === "split_failed") return "The split failed: keep it whole?";
      return "Approve the plan?";
    case "awaiting_test_check": return "Approve the test cases?";
    case "awaiting_setup":
      if (requested.kind === "context") return "Give it context";
      if (requested.kind === "dedup") return "Is it a duplicate?";
      return "Approve the setup?";
    case "awaiting_answers": {
      const n = (requested.questions ?? []).length;
      return n ? `Answer ${n} question${n === 1 ? "" : "s"}` : "Answer the questions";
    }
    case "awaiting_ship":
      if (!task.waitingOnYou) return null;
      if (task.route === "review") return "Post the review?";
      if (requested.gate === "ship_approval") return "Safe to release now?";
      return "Ship this PR?";
    case "reviewing_memory": return task.waitingOnYou ? "Apply the memory rules?" : null;
    default: return null;
  }
}

export function money(usd) {
  if (usd == null || !Number.isFinite(usd)) return null;
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
}

export function duration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
}

/** `3m ago`, from an ISO time. */
export function ago(iso, now = Date.now()) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return null;
  const d = duration(Math.max(0, now - at));
  return d === "<1m" ? "just now" : `${d} ago`;
}

/** The card's one line about now, and its tone (a theme state color name, or null for muted). */
export function cardLine(task, now = Date.now()) {
  const l = look(task, now);
  if (l === "escalated") {
    const why = task.reason ? escalationWords(task.reason) : null;
    return { text: why ? `Escalated: ${why}` : "Escalated", tone: "blocked" };
  }
  if (l === "needs_you") return { text: gateQuestion(task) ?? "Waiting on you", tone: "blocked" };
  if (l === "paused") return { text: "Paused on a usage limit", tone: "blocked" };
  if (l === "queued") return { text: `Queued: ${stageWords(task.state).toLowerCase()}`, tone: null };
  if (l === "working" || l === "stale") {
    const parts = [stageWords(task.state), money(task.spentUsd)].filter(Boolean);
    if (l === "stale") parts.push(`quiet ${ago(task.updatedAt, now)?.replace(" ago", "")}`);
    return { text: parts.join(" · "), tone: l === "stale" ? "blocked" : "working" };
  }
  if (l === "draft") return { text: "Draft: start when ready", tone: null };
  if (l === "archived") return { text: `Archived${task.archiveReason ? `: ${task.archiveReason.replaceAll("_", " ")}` : ""}`, tone: null };
  if (l === "done") return { text: task.route === "feature" ? "Shipped" : "Done", tone: "done" };
  if (task.state === "awaiting_ship") return { text: "Watching the PR", tone: null };
  return { text: stageWords(task.state), tone: null };
}

/** The PR number a PR task is about (`PR #2292: …`), or null. */
export function prNumber(task) {
  const m = /^PR #(\d+)/.exec(task.title ?? "");
  return m ? Number(m[1]) : null;
}

/** The title without the `PR #N: ` prefix a PR task carries. */
export const plainTitle = (task) => (task.title ?? "").replace(/^PR #\d+:\s*/, "");

/** The card's id line: the Jira key, else `#N` for a PR task, else the id's first 6. */
export function cardId(task) {
  if (task.jira?.key) return task.jira.key;
  const n = prNumber(task);
  if (n) return `#${n}`;
  return String(task.id ?? "").slice(0, 6);
}

/** The project a task belongs to: its `project`, else its checkout's folder name, else "No repository". */
export function projectOf(task) {
  if (task.project) return task.project;
  const path = (task.repoPath ?? "").replace(/\/+$/, "");
  return path ? path.slice(path.lastIndexOf("/") + 1) : "No repository";
}

const ROUTE_WORDS = { review: "Review", ci_fix: "CI fix", address: "Address", setup: "Setup" };

/** Chips that say something: kind of work, PR route, priority, diff, tests, criteria. Each `{text, tone}`. */
export function chips(task) {
  const out = [];
  const priority = task.classification?.priority;
  if (priority === "P0" || priority === "P1") out.push({ text: priority, tone: "error" });
  if (ROUTE_WORDS[task.route]) out.push({ text: ROUTE_WORDS[task.route], tone: null });
  const kind = task.classification?.kind;
  if (kind === "bug" || kind === "incident") out.push({ text: kind, tone: "error" });
  if (task.tests?.total) {
    const ok = task.tests.passed === task.tests.total;
    out.push({ text: `${task.tests.passed}/${task.tests.total} tests`, tone: ok ? null : "error" });
  }
  if (task.diff) out.push({ text: `+${task.diff.added} −${task.diff.removed}`, tone: null });
  else if (task.criteria?.length && !ended(task)) out.push({ text: `${task.criteria.length} criteria`, tone: null });
  return out;
}

/** Cards in a column: the ones that need you first, then running, then the most recently changed. */
export function sortCards(tasks, now = Date.now()) {
  const rank = (t) => (needsYou(t, now) ? 0 : isWorking(t, now) ? 1 : 2);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
}

export const VIEWS = [
  { id: "all", label: "Everything", icon: "board" },
  { id: "you", label: "Waiting on you", icon: "hand" },
  { id: "working", label: "Agents working", icon: "play" },
  { id: "prs", label: "PR work", icon: "pr" },
];

/** The tasks a view, project and search keep. Ended tasks stay (Done shows them). */
export function filterTasks(tasks, { view = "all", project = null, query = "" } = {}, now = Date.now()) {
  const q = query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (project && projectOf(t) !== project) return false;
    if (view === "you" && !needsYou(t, now)) return false;
    if (view === "working" && !isWorking(t, now)) return false;
    if (view === "prs" && !["review", "ci_fix", "address"].includes(t.route)) return false;
    if (q && !`${t.title} ${cardId(t)} ${t.jira?.key ?? ""} ${projectOf(t)}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** How many open tasks each view holds. */
export function viewCounts(tasks, now = Date.now()) {
  const open = tasks.filter((t) => !ended(t));
  return Object.fromEntries(VIEWS.map((v) => [v.id, filterTasks(open, { view: v.id }, now).length]));
}

/** The board: each column's cards, sorted. */
export function columns(tasks, now = Date.now()) {
  const by = Object.fromEntries(COLUMNS.map((c) => [c, []]));
  for (const t of tasks) (by[t.column] ?? by.Intake).push(t);
  for (const c of COLUMNS) by[c] = c === "Done"
    ? [...by[c]].sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0))
    : sortCards(by[c], now);
  return by;
}

/** The sidebar's projects: each with its open, running and waiting counts, the busiest first. */
export function projects(tasks, now = Date.now()) {
  const by = new Map();
  for (const t of tasks) {
    const name = projectOf(t);
    const p = by.get(name) ?? { name, open: 0, running: 0, waiting: 0 };
    if (!ended(t)) p.open++;
    if (isWorking(t, now)) p.running++;
    if (needsYou(t, now)) p.waiting++;
    by.set(name, p);
  }
  return [...by.values()].sort((a, b) => b.waiting - a.waiting || b.open - a.open || a.name.localeCompare(b.name));
}

/** The header's summary line: `13 open · 2 waiting on you · 2 agents working`. */
export function summary(tasks, now = Date.now()) {
  const open = tasks.filter((t) => !ended(t));
  const parts = [`${open.length} open`];
  const waiting = open.filter((t) => needsYou(t, now)).length;
  const working = open.filter((t) => isWorking(t, now)).length;
  if (waiting) parts.push(`${waiting} waiting on you`);
  if (working) parts.push(`${working} agent${working === 1 ? "" : "s"} working`);
  return parts.join(" · ");
}

/**
 * What a person can do to a task now, most likely first. Each `{id, label, kind}`, `kind` being
 * `primary`, `plain` or `danger`. The ids are the mod's own; `act` in main.js maps them to calls.
 */
export function actionsFor(task, now = Date.now()) {
  const out = [];
  const add = (id, label, kind = "plain") => out.push({ id, label, kind });
  const requested = task.gate?.requested ?? {};
  const l = look(task, now);
  if (task.state === "draft") add("start", "Start", "primary");
  if (l === "needs_you") {
    switch (task.state) {
      case "awaiting_approval":
        if (requested.outcome === "split_failed") add("keep_whole", "Keep it whole", "primary");
        else add("approve", requested.outcome === "split" ? "Approve the split" : requested.outcome === "archive" ? "Archive it" : requested.outcome === "conversation" ? "Post and close" : "Approve", "primary");
        if (requested.outcome === "split") add("keep_whole", "Keep it whole");
        add("send_back", "Send back");
        if (!requested.outcome || requested.outcome === "split" || requested.outcome === "split_failed") add("reject", "Reject", "danger");
        break;
      case "awaiting_answers":
        add("answer", "Answer", "primary");
        add("post_questions", "Post the questions");
        break;
      case "awaiting_setup":
        if (requested.kind === "context") add("context", "Give context", "primary");
        else if (requested.kind === "dedup") add("dedup", "Decide", "primary");
        else { add("approve", "Approve", "primary"); add("send_back", "Send back"); }
        break;
      case "awaiting_ship":
        add("approve", task.route === "review" ? "Post the review" : requested.gate === "ship_approval" ? "Release" : "Ship", "primary");
        add("send_back", task.route === "review" ? "Drop it" : "Send back");
        break;
      default:
        add("approve", "Approve", "primary");
        add("send_back", "Send back");
    }
  }
  if (l === "escalated") {
    add("approve", "Retry", "primary");
    add("send_back", "Send back");
  }
  if (l === "paused") add("resume", "Resume", "primary");
  if (l === "working" || l === "stale" || l === "queued") add("abort", "Stop", "danger");
  if (!ended(task) && task.state !== "draft") add("archive", "Archive…", "danger");
  if (ended(task) || task.state === "draft") add("delete", "Delete", "danger");
  return out;
}

/** PR splits, in the inbox's order, with their tab names. */
export const PR_SPLITS = [
  ["review_requested", "Review requested"],
  ["changes_requested", "Changes requested"],
  ["ci_failed", "CI failed"],
  ["ci_running", "CI running"],
  ["ready_to_merge", "Ready to merge"],
  ["mine", "Mine"],
];

/** What a PR row says about its checks and review: `{text, tone}`. */
export function prStatus(pr) {
  if (pr.isDraft) return { text: "Draft", tone: null };
  if (pr.mergeState === "DIRTY" || pr.mergeable === "CONFLICTING") return { text: "Conflicts", tone: "error" };
  if (pr.checks?.state === "failure") {
    const n = pr.checks.failed?.length ?? 0;
    return { text: `${n || "Some"} check${n === 1 ? "" : "s"} failing`, tone: "error" };
  }
  if (pr.checks?.state === "pending") return { text: `Checks running ${pr.checks.passed}/${pr.checks.total}`, tone: "working" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { text: "Changes requested", tone: "blocked" };
  if (pr.split === "ready_to_merge") return { text: "Ready to merge", tone: "done" };
  if (pr.reviewDecision === "APPROVED") return { text: "Approved", tone: "done" };
  if (pr.mergeState === "BEHIND") return { text: "Behind its base", tone: null };
  return { text: "Review required", tone: null };
}

/** The PR actions that fit: `{id, label, kind}`, the machine's own refusals (fork, own PR) applied ahead. */
export function prActions(pr) {
  const out = [];
  if (pr.task) return [{ id: "open_task", label: "Open its card", kind: "primary" }];
  if (!pr.localPath) out.push({ id: "clone", label: "Clone…", kind: "primary" });
  else {
    if (!pr.mine) out.push({ id: "review", label: "Review", kind: "primary" });
    if (pr.checks?.state === "failure" && !pr.fromFork) out.push({ id: "ci_fix", label: "Fix CI", kind: pr.mine ? "primary" : "plain" });
    if (pr.mine && pr.unresolvedThreads > 0 && !pr.fromFork) out.push({ id: "address", label: `Address ${pr.unresolvedThreads}`, kind: "plain" });
  }
  if (pr.split === "ready_to_merge") out.push({ id: "merge", label: "Merge", kind: "plain" });
  out.push({ id: "browser", label: "Open on GitHub", kind: "plain" });
  return out;
}

/** PRs a split and a repo filter keep, newest first. */
export function filterPrs(prs, { split = null, repo = null, query = "" } = {}) {
  const q = query.trim().toLowerCase();
  return prs
    .filter((p) => (!split || p.split === split) && (!repo || p.repo === repo) && (!q || `${p.title} ${p.repo}#${p.number} ${p.author}`.toLowerCase().includes(q)))
    .sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
}

/** Applies one stream message (`{type, task}`, `{type, id}`) to the task list; answers the new list (the old one untouched). */
export function applyEvent(tasks, event, message) {
  const data = event === "task.updated" ? message?.task : message;
  if (event === "task.updated" && data?.id) {
    const i = tasks.findIndex((t) => t.id === data.id);
    if (i < 0) return [...tasks, data];
    if ((tasks[i].seq ?? 0) > (data.seq ?? 0)) return tasks;
    const next = tasks.slice();
    next[i] = data;
    return next;
  }
  if (event === "task.deleted" && data?.id) return tasks.filter((t) => t.id !== data.id);
  return tasks;
}
