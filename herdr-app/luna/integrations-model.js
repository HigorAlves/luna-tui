// Pure rules for the Slack, Economy and Jira pages: splits and their order, counts, snooze
// times, priority steps, watch scopes, economy rows, repo choices. No drawing and no host calls,
// so `test/integrations.test.js` runs them directly. They follow the TUI board (`board/src/slack.rs`,
// `economy.rs`, `model.rs`), word for word where the user sees them.

/** One line, no control characters: text a stranger wrote, safe to draw. */
export function flat(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/** The same, keeping line breaks (a message body). */
export function plain(text) {
  return String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

const secs = (iso) => {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/** `45s`, `12m`, `3h`, `2d`: a length of time in seconds. */
export function span(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** How old an ISO time is: `4m`, `2h`, `-` when unknown. */
export function age(iso, now = Date.now()) {
  const at = secs(iso);
  return at == null ? "-" : span(now / 1000 - at);
}

// ---- Slack ----

export const SLACK_SPLITS = [
  ["needs_reply", "Needs reply"],
  ["waiting_on_them", "Waiting on them"],
  ["decide", "Decide"],
  ["fyi", "FYI"],
  ["snoozed", "Snoozed"],
  ["done", "Done"],
];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const KINDS = ["incident", "bug", "request", "question", "fyi", "chatter"];
export const SNOOZE_OPTIONS = ["1 hour", "3 hours", "tomorrow 9:00", "next Monday 9:00"];

const NEEDS_ME = new Set(["needs_reply", "decide"]);
const OPEN = (split) => split !== "snoozed" && split !== "done";

/** 0 for P0 to 3 for P3, 4 when triage has not run: lower sorts first. */
export function priorityRank(item) {
  const i = PRIORITIES.indexOf(item?.triage?.priority);
  return i < 0 ? PRIORITIES.length : i;
}

/** P0 or P1. */
export const urgent = (item) => priorityRank(item) <= 1;

/**
 * The items of one split, in the TUI's order: Needs reply and Decide put the overdue first (the
 * longest overdue on top), then P0 first, then oldest; the other splits newest first.
 */
export function slackItems(all, split) {
  const at = (i) => secs(i.ts) ?? 0;
  const found = (all ?? []).filter((i) => i.split === split);
  if (NEEDS_ME.has(split)) {
    const key = (i) => (i.overdue ? [0, secs(i.dueAt) ?? 0, at(i)] : [1, priorityRank(i), at(i)]);
    return found.sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  }
  return found.sort((a, b) => at(b) - at(a));
}

/** How many items sit in each split. */
export function slackCounts(all) {
  const out = Object.fromEntries(SLACK_SPLITS.map(([id]) => [id, 0]));
  for (const i of all ?? []) if (i.split in out) out[i.split] += 1;
  return out;
}

/** Items past their reply SLA in a split that is still open (not Snoozed, not Done). */
export const overdueCount = (all) => (all ?? []).filter((i) => i.overdue && OPEN(i.split)).length;

/** The sidebar badge: the needs-reply count, in the error tone while any open item is overdue. */
export function slackBadge(snap) {
  const items = snap?.items ?? [];
  const n = slackCounts(items).needs_reply;
  const overdue = overdueCount(items);
  if (!n && !overdue) return null;
  return { n: n || overdue, tone: overdue ? "error" : null };
}

/** Triage's one-line summary, or the message's first line until triage ran. */
export function summaryOf(item) {
  return flat(item?.triage?.summary) || flat(String(item?.text ?? "").split("\n")[0]);
}

/** `#channel`, `dm` or `group dm`. */
export function channelLabel(item) {
  const c = item?.channel ?? {};
  if (c.kind === "dm") return "dm";
  if (c.kind === "mpim") return "group dm";
  return c.name ? `#${flat(c.name)}` : "unknown channel";
}

/** `due in 12m` or `overdue 40m`; null with no due time. */
export function dueLabel(item, now = Date.now()) {
  const due = secs(item?.dueAt);
  if (due == null) return null;
  const left = due - now / 1000;
  return item.overdue || left < 0 ? `overdue ${span(Math.abs(left))}` : `due in ${span(left)}`;
}

/** Due within five minutes and not yet overdue. */
export function dueSoon(item, now = Date.now()) {
  const due = secs(item?.dueAt);
  if (due == null || item.overdue) return false;
  const left = due - now / 1000;
  return left >= 0 && left <= 300;
}

/** The priority one step up or down; null at either end or without one. */
export function priorityStep(current, up) {
  const i = PRIORITIES.indexOf(current);
  if (i < 0) return null;
  return PRIORITIES[up ? i - 1 : i + 1] ?? null;
}

/**
 * When a snooze ends, in unix seconds. `option` indexes SNOOZE_OPTIONS and `offset` is the local
 * zone's seconds east of UTC, so "9:00" is the person's own 9:00.
 */
export function snoozeUntil(option, now, offset = 0) {
  const DAY = 86400;
  if (option === 0) return now + 3600;
  if (option === 1) return now + 3 * 3600;
  const today = Math.floor((now + offset) / DAY);
  // 1970-01-01 was a Thursday: (days + 4) % 7 is 0 for Sunday, 1 for Monday.
  const weekday = (((today + 4) % 7) + 7) % 7;
  const toMonday = (8 - weekday) % 7;
  const ahead = option === 2 ? 1 : toMonday === 0 ? 7 : toMonday;
  return Math.max(0, (today + ahead) * DAY + 9 * 3600 - offset);
}

/** The local zone's seconds east of UTC, 0 when the host cannot say. */
export function localOffset() {
  try {
    const m = new Date().getTimezoneOffset();
    return Number.isFinite(m) ? -m * 60 : 0;
  } catch {
    return 0;
  }
}

/** Why an action is off for this item, or null when it works. */
export function blocker(item, key) {
  const split = item?.split;
  switch (key) {
    case "kind":
    case "relation":
      return item?.conversation ? null : "not assessed yet";
    case "task":
      return item?.linked?.taskId ? "already a ticket" : null;
    case "done":
      return split === "done" ? "already done" : null;
    case "nudge":
      return split === "waiting_on_them" ? null : "only while waiting on them";
    case "up":
    case "down": {
      const p = item?.triage?.priority;
      if (!p) return "not triaged yet";
      if (key === "up" && p === "P0") return "already P0";
      if (key === "down" && p === "P3") return "already P3";
      return null;
    }
    default:
      return null;
  }
}

/** The words a reply opens with: the waiting draft's text, else triage's draft. */
export function draftText(item) {
  const waiting = item?.draft?.text;
  if (waiting) return waiting;
  return item?.triage?.draft ?? "";
}

/** The draft's id and hash when one waits and both are known: with them the machine settles it. */
export function draftRef(item) {
  const d = item?.draft;
  return d?.id && d?.hash ? { id: d.id, hash: d.hash } : null;
}

export const NUDGE_TEXT = "gentle nudge on this one: any news?";

/** The body of POST /slack/items/:id/reply. */
export function replyBody(text, nudge, draft) {
  const body = { text, nudge: Boolean(nudge) };
  if (draft?.id && draft?.hash) {
    body.draftId = draft.id;
    body.draftHash = draft.hash;
  }
  return body;
}

/** `/slack/items/<id><verb>`: the id carries `:` and `.`, so it travels percent-encoded. */
export const itemPath = (id, verb = "") => `/slack/items/${encodeURIComponent(id)}${verb}`;

/** The body of the PATCH that clears an item: the reason is kept for a dismissed draft. */
export const doneBody = (reason) => (reason ? { done: true, reason } : { done: true });

export const DISMISS_REASONS = [
  ["no_reply_needed", "The thread needed no reply"],
  ["bad_draft", "The draft was bad"],
  [null, "Skip: no reason"],
];

/** One line of the link picker: what it says, the relation it sets and its target. */
export function relationChoices(item) {
  const out = [];
  for (const e of item?.conversation?.shortlist ?? []) {
    const backlog = e.kind === "backlog";
    const from = e.otherSource ? ` (from ${flat(e.otherSource.kind)} ${flat(e.otherSource.key)})` : "";
    out.push({
      label: `${backlog ? "backlog" : "card"}: ${flat(e.title ?? e.id)}${from}`,
      relation: backlog ? "related_to_backlog" : "related_to_in_progress",
      target: e.id,
    });
  }
  out.push({ label: "a new candidate", relation: "new_candidate", target: null });
  out.push({ label: "none: not about any work", relation: "none", target: null });
  return out;
}

/** What the machine decided about the conversation, as [name, text] pairs. */
export function conversationLines(item, now = Date.now()) {
  const out = [];
  const c = item?.conversation;
  const k = c?.classification;
  if (k) {
    const who = k.by === "person" ? "you" : "the machine";
    out.push(["kind", `${flat(k.kind)} (${Math.round((k.confidence ?? 0) * 100)}% sure, set by ${who})`]);
    const parts = ["who", "what", "impact", "time", "demand"]
      .filter((n) => k.scores?.[n])
      .map((n) => `${n} ${k.scores[n].score} (${Math.round((k.scores[n].confidence ?? 0) * 100)}%)`);
    if (parts.length) out.push(["scores", `${parts.join(", ")}${k.total != null ? ` · total ${k.total}` : ""}`]);
    if (k.knockOut) out.push(["knock-out", `${flat(k.knockOut)} (P0 before any scoring)`]);
    if (k.verdict === "ask") out.push(["asks you", "the machine is not sure of the kind or of the need for a reply: set the kind"]);
  }
  const r = c?.relation;
  if (r) {
    const words = { related_to_in_progress: "a card in progress", related_to_backlog: "a backlog item", new_candidate: "new work", none: "no existing work" }[r.type] ?? "not sure: pick one with Link";
    const title = (c.shortlist ?? []).find((e) => e.id === r.target)?.title;
    out.push(["relation", `${words}${title ? `: ${flat(title)}` : ""}`]);
    if (r.otherSource) out.push(["source", `about a card from ${flat(r.otherSource.kind)} ${flat(r.otherSource.key)}`]);
  }
  if (c?.redactions > 0) out.push(["cut", `${c.redactions} secret(s) were cut from this thread`]);
  if (item?.draft) {
    const exp = secs(item.draft.expiresAt);
    const left = exp != null ? `, expires in ${Math.max(0, Math.floor((exp - now / 1000) / 3600))}h` : "";
    out.push(["waiting", `a ${flat(item.draft.kind)} draft${left}`]);
  }
  return out;
}

/** The SLA targets in priority order: `10m/30m/1h/1h`, `-` for none. */
export function slaTargets(sla) {
  return PRIORITIES.map((p) => (sla?.[p] ? span(sla[p]) : "-")).join("/");
}

/** The repo a channel most likely belongs to: one a ticket uses, sharing a word with the channel. */
export function guessRepo(channel, tasks) {
  const c = String(channel ?? "").toLowerCase();
  if (!c) return null;
  const repos = [...new Set((tasks ?? []).map((t) => t.repoPath).filter(Boolean))].sort();
  return (
    repos.find((p) => {
      const name = p.replace(/\/+$/, "").split("/").pop().toLowerCase();
      return name && (c.includes(name) || name.includes(c));
    }) ?? null
  );
}

/** The repositories the board's tasks use, sorted. */
export const taskRepos = (tasks) => [...new Set((tasks ?? []).map((t) => t.repoPath).filter(Boolean))].sort();

/** What a watch query means: `@handle` a usergroup, `#name` a channel, anything else a keyword. */
export function watchKindOf(query) {
  const q = String(query ?? "").trim();
  if (q.startsWith("@")) return { kind: "usergroup", text: q.slice(1) };
  if (q.startsWith("#")) return { kind: "channel", text: q.slice(1) };
  return { kind: "keyword", text: q };
}

/** A catalogue entry from the machine, whichever way it names itself: `{id, label}` for the id, `{handle|name|label}` for the words. */
export function option(o) {
  const label = flat(o?.handle ?? o?.label ?? o?.name ?? o?.id);
  return { id: String(o?.id ?? ""), label, hint: o?.handle && o?.name ? flat(o.name) : "" };
}

/** The completions for a watch query: user groups for `@…`, channels for `#…`, none for a keyword. */
export function watchMatches(query, catalog) {
  const { kind, text } = watchKindOf(query);
  if (kind === "keyword") return [];
  const pool = (kind === "usergroup" ? catalog?.groups : catalog?.channels) ?? [];
  const needle = text.toLowerCase();
  return pool.map(option).filter((o) => o.id && (!needle || o.label.toLowerCase().includes(needle) || o.hint.toLowerCase().includes(needle)));
}

/** The body of POST /slack/watches for a query and the completion picked (the first by default). */
export function watchInput(query, matches, picked = 0) {
  const { kind, text } = watchKindOf(query);
  if (!text) return { error: "Type @handle, #channel or a word." };
  if (kind === "keyword") return { body: { kind, value: text, label: text } };
  const pick = matches[Math.min(picked, matches.length - 1)];
  if (!pick) return { error: `No ${kind === "usergroup" ? "user group" : "channel"} matches ${query.trim()}.` };
  const sigil = kind === "usergroup" ? "@" : "#";
  return { body: { kind, value: pick.id, label: pick.label.startsWith(sigil) ? pick.label : `${sigil}${pick.label}` } };
}

/** The watches column: `P2 · in #eng`, `as mention`, `FYI`. */
export function watchScope(w) {
  const scope = w.kind === "usergroup" ? "as mention" : w.kind === "channel" ? "FYI" : w.kind === "keyword" && w.channels?.length ? `in ${w.channels.join(", ")}` : null;
  return [w.priority, scope].filter(Boolean).join(" · ");
}

/** The priority floor a watch moves to next: none, P0, P1, P2, none. */
export function nextFloor(priority) {
  return { P0: "P1", P1: "P2" }[priority] ?? (priority ? null : "P0");
}

/** What the Slack page says when there is nothing to list: why, and how to set it up. */
export function slackSetup(snap, error) {
  if (error && !snap) return { title: "The machine did not answer for Slack", body: error, setup: true };
  if (!snap) return null;
  if (snap.error && !(snap.items ?? []).length) return { title: "Slack says", body: flat(snap.error), setup: true };
  if (snap.socket === "off" && !(snap.items ?? []).length && !snap.polledAt) {
    return { title: "Slack is not set up on this machine", body: "The machine reads Slack with a user token (MACHINE_SLACK_USER_TOKEN) and, for live messages, an app token (socket: off without one).", setup: true };
  }
  if (snap.scope === "opted_in" && snap.optedIn === 0 && !(snap.items ?? []).length) {
    return { title: "No conversation is opted in", body: "The machine reads only the channels you watch (Watches) or list under conversation.channels in a repository's luna.yaml.", setup: false };
  }
  return null;
}

// ---- Economy ----

export const ECONOMY_OFF = "The economy is off on this machine (MACHINE_ECONOMY=off, or an older machine without the route).";

const FACT_ORDER = ["active", "candidate", "promoted", "retired", "dropped"];
const GUARD_ROWS = 20;

/** The rows of the list: facts (active first), each pack's tools, the newest guard events. */
export function economyRows(eco) {
  const rows = [];
  const facts = (eco?.facts ?? []).map((f, i) => [f, i]).sort((a, b) => (FACT_ORDER.indexOf(a[0].state) + 1 || 9) - (FACT_ORDER.indexOf(b[0].state) + 1 || 9));
  for (const [f] of facts) rows.push({ id: `fact-${f.id}`, section: "Facts", kind: "fact", fact: f, text: flat(f.text), tag: flat(f.state), sub: [flat(f.source), flat(f.family)].filter(Boolean).join(" · ") });
  for (const [pack, tools] of Object.entries(eco?.tools ?? {})) {
    for (const unit of tools?.mask ?? []) rows.push({ id: `mask-${pack}-${unit}`, section: "Tools", kind: "masked", pack, unit, text: `${flat(pack)}: ${flat(unit)}`, tag: "masked", sub: "restore puts the tool back" });
    for (const p of tools?.proposal ?? []) {
      rows.push({ id: `prop-${pack}-${p.unit}`, section: "Tools", kind: "proposed", pack, unit: p.unit, text: `${flat(pack)}: ${flat(p.unit)}`, tag: "proposed", sub: `unused in ${p.unusedRuns ?? 0} runs over ${p.cards ?? 0} cards` });
    }
  }
  const guard = [...(eco?.guard ?? [])].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, GUARD_ROWS);
  guard.forEach((g, i) => rows.push({ id: `guard-${i}-${g.runId ?? ""}`, section: "Loop guard", kind: "guard", guard: g, text: `${flat(g.action)} ${flat(g.pack)}  ${g.calls ?? 0} calls`, tag: flat(g.action), sub: [g.cause ? `cause ${flat(g.cause)}` : null, g.failure ? `failure ${flat(g.failure)}` : null].filter(Boolean).join(" · ") }));
  return rows;
}

/** Only a candidate or active fact can be dropped. */
export const canDrop = (row) => row?.kind === "fact" && (row.fact.state === "candidate" || row.fact.state === "active");

/** The proposed units of a pack: what approving its mask trusts it without. */
export const proposedUnits = (eco, pack) => (eco?.tools?.[pack]?.proposal ?? []).map((p) => p.unit);

/** The cost block and the envelopes, as lines. */
export function costLines(eco) {
  const c = eco?.cost ?? {};
  const lines = [
    `effective tokens: exec ${Math.round(c.exec ?? 0)} · overhead ${Math.round(c.overhead ?? 0)}`,
    `overhead share ${((c.overheadShare ?? 0) * 100).toFixed(1)}%`,
  ];
  if (c.overheadUnpriced > 0) lines.push(`${c.overheadUnpriced} overhead runs had no token count`);
  for (const [pack, e] of Object.entries(eco?.envelopes ?? {})) {
    lines.push(`${flat(pack)}: ${e?.envelope != null ? Math.round(e.envelope) : `learning (${e?.samples ?? 0} samples)`}`);
  }
  return lines;
}

/** The detail lines of a fact. */
export function factLines(f) {
  return [
    `${flat(f.state)} · ${flat(f.source)} · ${flat(f.family)}`,
    `confirmed ${f.confirmations ?? 0} · contradicted ${f.contradictions ?? 0}`,
    `exercised ${f.exercised ?? 0} · fired ${f.fired ?? 0}`,
    `id ${flat(f.id)}`,
  ];
}

/** The repos the Economy page can show: those the tasks use, then any the machine lists. */
export function economyRepos(tasks, machineRepos) {
  const listed = (Array.isArray(machineRepos) ? machineRepos : []).map((r) => (typeof r === "string" ? r : r?.path ?? r?.repoPath ?? r?.repo)).filter((r) => typeof r === "string" && r.startsWith("/"));
  return [...new Set([...taskRepos(tasks), ...listed])];
}

export const repoName = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop() || String(path ?? "");

// ---- Jira ----

/** The Jira page's status line and tone from GET /jira/status. */
export function jiraSummary(status, absent, error, now = Date.now()) {
  if (absent) return { text: "Jira is not set up on this machine", tone: null, configured: false };
  if (error && !status) return { text: error, tone: "error", configured: false };
  if (!status) return { text: "Reading Jira…", tone: null, configured: null };
  if (!status.configured) return { text: "Jira is not configured", tone: null, configured: false };
  const parts = [status.site ? flat(status.site) : "connected"];
  const exp = secs(status.tokenExpiresAt);
  if (exp != null) {
    const left = exp - now / 1000;
    parts.push(left < 0 ? "token expired" : `token expires in ${span(left)}`);
  }
  if (status.error) return { text: [...parts, flat(status.error)].join(" · "), tone: "error", configured: true };
  return { text: parts.join(" · "), tone: exp != null && exp - now / 1000 < 14 * 86400 ? "blocked" : null, configured: true };
}

/** A Jira key such as PLAT-7 typed whole: it links as is, without a search. */
export const isJiraKey = (q) => /^[A-Z][A-Z0-9_]+-\d+$/.test(String(q ?? "").trim());

/** A search hit with every field the machine may leave out. */
export function hit(h) {
  return { key: flat(h?.key), summary: flat(h?.summary), status: h?.status ? flat(h.status) : null, issueType: h?.issueType ? flat(h.issueType) : null, url: typeof h?.url === "string" ? h.url : "" };
}
