// The rules behind the Inbox, Digest, Floor, Backlog and Tickets pages: pure functions with no host
// calls, so `node --test` checks them. They follow the Rust board (`board/src/inbox.rs`,
// `digest.rs`, `backlog.rs`, `tickets.rs`). The machine decides; these only read.
import { ended, look } from "./model.js";

/** A stranger's text on one line: control characters (escape codes, newlines) become spaces. */
export function plain(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/ {2,}/g, " ").trim();
}

const at = (iso) => {
  const n = Date.parse(iso ?? "");
  return Number.isFinite(n) ? n : null;
};

// ---- Inbox ----

/** The Inbox's splits, in tab order: why a ticket needs you. */
export const INBOX_SPLITS = [
  ["approve", "Approve"],
  ["review", "Review"],
  ["failed", "Failed"],
  ["stale", "Stale"],
  ["all", "All"],
];

/** Which split a ticket belongs to, or null when it needs nothing from you. */
export function inboxSplitOf(task, now = Date.now()) {
  switch (task.state) {
    case "awaiting_setup":
    case "awaiting_approval":
    case "awaiting_test_check":
    case "awaiting_ship":
      return "approve";
    case "awaiting_answers":
    case "reviewing_memory":
      return "review";
    case "escalated":
      return "failed";
    case "paused_rate_limit":
      return "stale";
    default:
      return look(task, now) === "stale" ? "stale" : null;
  }
}

/** The tickets of `split`, the one waiting longest first. */
export function inboxItems(tasks, split = "all", now = Date.now(), query = "") {
  const q = String(query ?? "").trim().toLowerCase();
  return (tasks ?? [])
    .filter((t) => {
      const s = inboxSplitOf(t, now);
      if (!s || (split !== "all" && s !== split)) return false;
      return !q || `${t.title ?? ""} ${t.id ?? ""} ${t.repoPath ?? ""} ${t.jira?.key ?? ""}`.toLowerCase().includes(q);
    })
    .sort((a, b) => (at(a.updatedAt) ?? 0) - (at(b.updatedAt) ?? 0));
}

export function inboxCounts(tasks, now = Date.now()) {
  const out = { approve: 0, review: 0, failed: 0, stale: 0, all: 0 };
  for (const t of tasks ?? []) {
    const s = inboxSplitOf(t, now);
    if (!s) continue;
    out[s] += 1;
    out.all += 1;
  }
  return out;
}

/**
 * What approving a ticket together with others commits to (the TUI's `committing_kind`): `plan`,
 * `split`, `ship` or `release`; null for everything that needs reading first (answers, the cases,
 * the setup, a review to post, the memory rules, an archive or a reply).
 */
export function bulkKind(task) {
  if (!task.waitingOnYou || task.state === "reviewing_memory") return null;
  const requested = task.gate?.requested ?? {};
  if (task.state === "awaiting_approval") {
    if (!requested.outcome) return "plan";
    return requested.outcome === "split" ? "split" : null;
  }
  if (task.state === "awaiting_ship") {
    if (task.route === "review") return null;
    return requested.gate === "ship_approval" ? "release" : "ship";
  }
  return null;
}

/** The Approve split's tickets that one yes can approve: `[{task, kind}]`. */
export function bulkTargets(tasks, now = Date.now()) {
  return inboxItems(tasks, "approve", now)
    .map((task) => ({ task, kind: bulkKind(task) }))
    .filter((x) => x.kind);
}

/** `3 plans, 1 release` for the bulk dialog. */
export function bulkWords(targets) {
  const n = {};
  for (const { kind } of targets) n[kind] = (n[kind] ?? 0) + 1;
  const names = { plan: "plan", split: "split", ship: "ship", release: "release" };
  return Object.entries(n).map(([k, c]) => `${c} ${names[k]}${c === 1 || k === "ship" ? "" : "s"}`).join(", ");
}

// ---- Digest ----

export const DIGEST_GROUPS = [
  ["shipped", "Shipped"],
  ["escalated", "Escalated"],
  ["needs_you", "Needs you"],
  ["closed", "Closed"],
];

/** Where a ticket's latest change belongs, or null when it is not news. */
export function digestGroupOf(task) {
  switch (task.state) {
    case "closed":
    case "archived":
      return "closed";
    case "escalated":
      return "escalated";
    case "awaiting_ship":
    case "shipping":
    case "reviewing_memory":
      return "shipped";
    default:
      return task.waitingOnYou ? "needs_you" : null;
  }
}

/** True when the ticket changed after `since` (ms); with no `since`, nothing is new. */
export function isNew(task, since) {
  const updated = at(task.updatedAt);
  return since != null && updated != null && updated > since;
}

/**
 * `[{group, task}]` for every ticket that changed since `since` (ms) and has a group, by group and
 * newest first within one. With no `since` (a first run) every ticket with a group.
 */
export function digestEntries(tasks, since = null) {
  const order = DIGEST_GROUPS.map(([id]) => id);
  return (tasks ?? [])
    .filter((t) => since == null || isNew(t, since))
    .map((task) => ({ group: digestGroupOf(task), task }))
    .filter((e) => e.group)
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || (at(b.task.updatedAt) ?? 0) - (at(a.task.updatedAt) ?? 0));
}

/** The link to open for a ticket: its PR, else its source issue or thread, else its Jira issue. */
export function ticketLink(task, prs = []) {
  const pr = (prs ?? []).find((p) => p?.task?.id === task.id)?.url;
  return pr ?? task.gate?.requested?.prUrl ?? task.source?.url ?? task.source?.permalink ?? task.jira?.url ?? null;
}

// ---- Floor ----

export const pct = (x) => (typeof x === "number" && Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");
export const num = (x) => (typeof x === "number" && Number.isFinite(x) ? String(Math.round(x * 10) / 10) : "–");
export const usd = (x) => (typeof x === "number" && Number.isFinite(x) ? `$${x.toFixed(2)}` : "–");

/** `3m 12s`, `2h 5m`, `1d 4h`, from milliseconds; a dash for nothing. */
export function span(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "–";
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const medp90 = (x) => (x && typeof x === "object" ? `${span(x.median)} / ${span(x.p90)}` : "–");
const firstPass = (m) => {
  const f = m?.firstPassRate;
  if (!f) return "–";
  return ["verifying", "ci_watch", "implementing"].map((k) => `${k.replace("_", " ")} ${pct(f[k])}`).join(" · ");
};

/**
 * The Floor's table: one row per number, a 7d and a 30d cell each. A missing window or field
 * reads as a dash, so a machine that does not send a number never crashes the page.
 */
export function floorRows(m7, m30) {
  const row = (label, f) => {
    const cell = (m) => {
      if (!m) return "–";
      try {
        return f(m) ?? "–";
      } catch {
        return "–";
      }
    };
    return { label, d7: cell(m7), d30: cell(m30) };
  };
  const top = (m) => (m.escalations?.topReasons ?? []).slice(0, 2).map((r) => `${plain(r.reason).slice(0, 40)} ×${r.count}`).join(", ");
  return [
    row("Tasks closed", (m) => String(m.tasks.closed)),
    row("Created", (m) => String(m.tasks.created)),
    row("Open", (m) => String(m.tasks.open)),
    row("Need you", (m) => String(m.tasks.waitingOnYou)),
    row("Running / queued now", (m) => `${m.tasks.running} / ${m.tasks.queued}`),
    row("Cycle time (median / p90)", (m) => medp90(m.cycleTimeMs?.task)),
    row("Gates answered", (m) => `${m.gates.answered} · ${pct(m.gates.withinSla)} in SLA`),
    row("Wait for approval (median)", (m) => span(m.gates.waitMs?.awaiting_approval?.median)),
    row("First pass", firstPass),
    row("Escalation rate", (m) => `${pct(m.escalations?.rate)}${top(m) ? ` · ${top(m)}` : ""}`),
    row("Retries per task (median)", (m) => num(m.retries?.perTask?.median)),
    row("Cost", (m) => !m.cost ? null : `${usd(m.cost?.totalUsd)} · ${usd(m.cost?.perTaskUsd?.median)} per task`),
    row("Queue", (m) => `depth ${m.queue.depth} · ${pct(m.queue.utilisation)} of slots`),
  ];
}

/** The stage table from a window's per-stage cycle times: slowest median first. */
export function stageRows(m) {
  const per = m?.cycleTimeMs?.perStage ?? {};
  const cost = m?.cost?.byStage ?? {};
  return Object.entries(per)
    .map(([stage, s]) => ({ stage, runs: s?.runs ?? 0, median: s?.median, p90: s?.p90, cost: cost[stage] }))
    .sort((a, b) => (b.median ?? 0) - (a.median ?? 0));
}

/** The engine table (`byEngine`), joined with this month's spend and cap from `/engines`. */
export function engineRows(m, engines = []) {
  const rows = new Map();
  for (const e of m?.byEngine ?? []) rows.set(e.engine ?? null, { ...e, name: e.engine ?? "(none)" });
  for (const e of Array.isArray(engines) ? engines : []) {
    if (!e?.id) continue;
    const row = rows.get(e.id) ?? { engine: e.id, name: e.id, stageRuns: 0 };
    rows.set(e.id, row);
    row.month = e.spentThisMonthUsd;
    row.cap = e.budgetUsd;
  }
  return [...rows.values()].filter((r) => r.stageRuns || r.month || r.cap).map((r) => ({ ...r, over: typeof r.cap === "number" && typeof r.month === "number" && r.month >= r.cap }));
}

/** The repos that wait on a base image nobody approved: `[{repo, base}]`. */
export function pendingBases(repos) {
  return (Array.isArray(repos) ? repos : []).filter((r) => r?.image?.pendingBase).map((r) => ({ repo: r.repo, base: plain(r.image.pendingBase) }));
}

/** The tickets paused on a usage limit. */
export const pausedTasks = (tasks) => (tasks ?? []).filter((t) => t.state === "paused_rate_limit");

/** What a latched credential says: a name, or `name until 14:30` when the machine gave the time. */
export function latchedWords(l) {
  if (typeof l === "string") return l;
  const name = l?.credential ?? l?.name ?? "credential";
  const until = l?.until ?? l?.resetAt ?? null;
  const n = at(until);
  return n ? `${name} until ${new Date(n).toISOString().slice(11, 16)} UTC` : name;
}

// ---- Backlog ----

/** `1.04  M  ×2` and the rest of an item as chips: `[{text, tone}]`. */
export function backlogChips(item) {
  const out = [];
  if (typeof item.score === "number") out.push({ text: item.score.toFixed(2), tone: "accent" });
  if (item.size) out.push({ text: plain(item.size), tone: null });
  out.push({ text: `×${item.demand ?? 1}`, tone: null });
  if (item.stale) out.push({ text: "stale", tone: "blocked" });
  if (item.schedulable === false) out.push({ text: `blocked by ${(item.blockedBy ?? []).length}`, tone: "error" });
  if ((item.dependsOn ?? []).length) out.push({ text: `after ${item.dependsOn.length}`, tone: null });
  return out;
}

/** One line per source, as far as the page can name it. */
export function sourceLines(item) {
  return (item.sources ?? []).map((s) => {
    const text = (k) => (typeof s?.[k] === "string" ? plain(s[k]) : null);
    const kind = text("kind") ?? text("type");
    if (kind === "github") return `GitHub ${text("repo") ?? ""}#${Number(s.number) || 0}`;
    if (kind === "jira") return `Jira ${text("key") ?? ""}`;
    if (kind === "slack") return "Slack thread";
    return kind ?? "unknown source";
  });
}

/** What an item that cannot be scheduled waits for, one line each. */
export function blockedLines(item) {
  if (item.schedulable !== false) return [];
  return (item.blockedBy ?? []).map((b) => `waits for ${plain(b?.kind)} ${plain(b?.id)} (${plain(b?.state)})`);
}

/** The machine's `409 not_schedulable` as one sentence, with what the item waits for. */
export function refusalText(body) {
  const message = plain(body?.message ?? "request failed");
  const blockers = (body?.blockedBy ?? []).map((b) => `${plain(b?.id)} (${plain(b?.state)})`);
  return blockers.length ? `${message}: ${blockers.join("; ")}` : message;
}

// ---- Tickets ----

/** A ticket key as one path segment: all but letters, digits and `-._~` percent-encoded (a GitHub key has `/` and `#`). */
export function encodeKey(key) {
  return [...new TextEncoder().encode(String(key))]
    .map((b) => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");
}

/** The latest assessment that scored the ticket (a workable one), or null. */
export const scoredOf = (t) => [...(t.assessments ?? [])].reverse().find((a) => a?.outcome === "workable") ?? null;

/** The drafts a person can still act on. */
export const waitingDrafts = (t) => (t.drafts ?? []).filter((d) => d?.status === "waiting" || d?.status === "edited");

export const overdueClocks = (t) => (Array.isArray(t.clocks?.overdue) ? t.clocks.overdue.map(plain) : []);

/** The ticket's one-line facts: `P1 M low 0.80 schedule`, or null when nothing scored it. */
export function scoreLine(t) {
  const a = scoredOf(t);
  if (!a) return null;
  const score = typeof a.score === "number" ? a.score.toFixed(2) : "";
  return [a.priority, a.size, a.blastRadius, score, a.recommendation?.action ? String(a.recommendation.action).replaceAll("_", " ") : ""].filter(Boolean).map(plain).join(" ");
}

/** The detail: sub-scores with their confidence, the recommendation and what it is linked to. */
export function ticketDetail(t) {
  const out = [];
  const a = scoredOf(t);
  if (a) {
    for (const [name, s] of Object.entries(a.subScores ?? {}).sort(([x], [y]) => x.localeCompare(y))) {
      out.push(`${plain(name)}: ${Math.round(Number(s?.value) || 0)} (confidence ${(Number(s?.confidence) || 0).toFixed(2)})`);
    }
    if (a.recommendation) out.push(`recommended: ${plain(a.recommendation.action).replaceAll("_", " ")} (${plain(a.recommendation.reason)})`);
  }
  const links = t.canonical?.links ?? {};
  const linked = ["blocks", "duplicates"].flatMap((k) => (Array.isArray(links[k]) ? links[k] : [])).filter((v) => typeof v === "string").map(plain);
  if (linked.length) out.push(`linked: ${linked.join(", ")}`);
  return out;
}

/** What approving a split draft creates: one fixed line, then each child with size, order, goal and criteria. */
export function splitLines(t, draft) {
  const children = draft.children ?? [];
  const n = children.length;
  const target = plain(t.splitTarget ?? "") || "this ticket's own project";
  const out = [`Approving creates ${n} ticket${n === 1 ? "" : "s"} in ${target}`];
  children.forEach((c, i) => {
    const after = (Array.isArray(c?.depends_on) ? c.depends_on : []).filter((v) => Number.isFinite(v));
    const loc = Number.isFinite(c?.est_loc) ? `, about ${c.est_loc} lines` : "";
    out.push(`${i + 1}. ${plain(c?.title)}${loc}${after.length ? `, after ${after.join(", ")}` : ""}`);
    out.push(`   goal: ${plain(c?.goal)}`);
    for (const k of Array.isArray(c?.acceptance_criteria) ? c.acceptance_criteria : []) out.push(`   - ${plain(k)}`);
  });
  return out;
}

/**
 * The taps a ticket offers, with the TUI's conditions: approve, edit and ignore need a draft
 * waiting; a card only when it has none; the backlog only when it was assessed as workable.
 * Each `{id, label, kind}`.
 */
export function ticketActions(t) {
  const out = [];
  const waiting = waitingDrafts(t).length > 0;
  if (waiting) {
    out.push({ id: "approve", label: waitingDrafts(t)[0].kind === "split" ? "Approve the split" : "Approve and post", kind: "primary" });
    out.push({ id: "edit", label: "Post my text…", kind: "plain" });
    out.push({ id: "ignore", label: "Ignore", kind: "plain" });
  }
  if (!t.cardId) out.push({ id: "card", label: "Make a card", kind: "plain" });
  if (scoredOf(t)) out.push({ id: "backlog", label: "To the backlog", kind: "plain" });
  return out;
}
