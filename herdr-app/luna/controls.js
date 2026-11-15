// The board's controls as pure functions (no host calls, so `node --test` checks them): folding,
// ordering columns, card density, the focused column, marks and bulk actions, the filters, key
// names, the keys sheet's rows and the command palette's matching. board.js draws from them and
// boardkeys.js wires them to keys. The rules are the TUI's (`board/src/app.rs`).
import { planCriteria } from "./detail-model.js";
import * as model from "./model.js";
import { COLUMNS, ARCHIVE_REASONS, ended, needsYou, projectOf, sortCards } from "./model.js";

/** The board key that runs each ticket action (boardkeys.js), shown beside the inspector's buttons. */
export const ACTION_KEYS = {
  start: "a", approve: "a", resume: "a", answer: "a", keep_whole: ":whole", send_back: "r", reject: "N", reject_release: "N",
  abort: "X", archive: "Z", delete: "d", remove_worktree: "w", post_questions: "p", memory_skip_rules: "A",
  edit_plan: "e", edit_ticket: "e", edit_record: "T", escalation_reason: "C", set_repo: "R", jira_link: "J", jira_unlink: "J",
  watch: "f", open_issue: "o", open_pr: "O", merge_into: "M", unmerge: "U", context: ":context", dedup: ":dedup",
};

/** What a gate is: model.js's `gateKey`, captured when a dialog opens and checked when it sends. */
export const gateKey = (task) => model.gateKey(task);

// ---- key names ----

const SHIFTED = { 1: "!", 2: "@", 3: "#", 4: "$", 5: "%", 6: "^", 7: "&", 8: "*", 9: "(", 0: ")", "-": "_", "=": "+", ";": ":", "/": "?", "[": "{", "]": "}", "'": '"', ",": "<", ".": ">", "`": "~", "\\": "|" };

/**
 * A key event as one name: `j`, `V`, `?`, `:`, `tab`, `shift-tab`, `escape`, `ctrl-d`. A letter or
 * symbol is the character it types, so `V` and `!` need no modifier test.
 */
export function keyName(e) {
  const m = e?.modifiers ?? {};
  const k = String(e?.key ?? "");
  if (m.control || m.platform || m.alt) {
    return [m.control && "ctrl", m.alt && "alt", m.platform && "cmd", m.shift && "shift", k].filter(Boolean).join("-");
  }
  if (k.length === 1) {
    const c = e.key_char;
    if (typeof c === "string" && c.length === 1 && c !== " ") return c;
    if (m.shift) return /[a-z]/.test(k) ? k.toUpperCase() : SHIFTED[k] ?? k;
    return k;
  }
  return m.shift ? `shift-${k}` : k;
}

// ---- how the board is laid out ----

/** Card density, in the order `=` cycles them (the TUI's: 3 lines, 4, 1). */
export const DENSITIES = [
  { id: "three", label: "3 lines" },
  { id: "four", label: "4 lines with chips · diff · tests" },
  { id: "one", label: "1 line" },
];
export const nextDensity = (id) => DENSITIES[(DENSITIES.findIndex((d) => d.id === id) + 1) % DENSITIES.length].id;
export const densityLabel = (id) => (DENSITIES.find((d) => d.id === id) ?? DENSITIES[1]).label;

/** How the cards inside a column are ordered: `gs`, `gr`, `ga`. */
export const GROUP_BY = [
  { id: "stage", label: "stage", does: "the ones that need you first, then running, then the latest" },
  { id: "repo", label: "repo", does: "by repository, then by stage: one board reads per repo" },
  { id: "age", label: "age", does: "the oldest ticket first, whatever its look" },
];

const repoName = (task) => (task.repoPath ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
const created = (task) => Date.parse(task.createdAt ?? task.updatedAt ?? "") || 0;
const lateGate = (task) => (task.sla?.gate?.overdue ? 0 : 1);

/** One column's cards in `group` order. Done always reads newest first. */
export function orderCards(tasks, group, column, now = Date.now()) {
  if (column === "Done") return [...tasks].sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
  if (group === "age") return [...tasks].sort((a, b) => lateGate(a) - lateGate(b) || created(a) - created(b));
  // A gate past its SLA sorts first whatever the order: it has waited longest on you (the TUI's rule).
  const stage = sortCards(tasks, now).sort((a, b) => lateGate(a) - lateGate(b));
  if (group === "repo") return stage.sort((a, b) => repoName(a).localeCompare(repoName(b)));
  return stage;
}

/** The board: each column's cards, in `group` order. */
export function arrange(tasks, group = "stage", now = Date.now()) {
  const by = Object.fromEntries(COLUMNS.map((c) => [c, []]));
  for (const t of tasks) (by[t.column] ?? by.Intake).push(t);
  for (const c of COLUMNS) by[c] = orderCards(by[c], group, c, now);
  return by;
}

/** Whether a column is drawn as a rail. `zz` folds every column but the focused one. */
export function isFolded(ctl, name, doneOpen = false) {
  if (ctl.foldAll) return name !== ctl.focus;
  if (name === "Done") return !doneOpen;
  return ctl.folded.has(name);
}

/** The state `zc`, `zo` and `zz` leave (a new object; `ctl` untouched). Done folds with the app's `doneOpen`. */
export function foldKey(ctl, c, doneOpen = false) {
  const folded = new Set(ctl.folded);
  let open = doneOpen;
  let foldAll = ctl.foldAll;
  if (c === "c") {
    if (foldAll) foldAll = true;
    else if (ctl.focus === "Done") open = false;
    else folded.add(ctl.focus);
  }
  if (c === "o") {
    if (foldAll) {
      foldAll = false;
      for (const n of COLUMNS) if (n !== ctl.focus && n !== "Done") folded.add(n);
      folded.delete(ctl.focus);
    }
    if (ctl.focus === "Done") open = true;
    else folded.delete(ctl.focus);
  }
  if (c === "z") foldAll = !foldAll;
  return { ...ctl, folded, foldAll, doneOpen: open };
}

/** The columns a person can see (not folded), in board order. */
export const openColumns = (ctl, doneOpen) => COLUMNS.filter((c) => !isFolded(ctl, c, doneOpen));

/** The ids j and k walk: the open columns top to bottom, as drawn. */
export const flatOrder = (cols, ctl, doneOpen) => openColumns(ctl, doneOpen).flatMap((c) => cols[c] ?? []);

/** The column `step` away from `from`, stopping at the ends. */
export function stepColumn(from, step) {
  const i = Math.max(0, COLUMNS.indexOf(from));
  return COLUMNS[Math.max(0, Math.min(COLUMNS.length - 1, i + step))];
}

/** The id `step` rows from `selected` in a column's ids; the first (or last) when nothing in it is selected. */
export function stepRow(ids, selected, step) {
  if (!ids.length) return null;
  const at = ids.indexOf(selected);
  if (at < 0) return step > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.max(0, Math.min(ids.length - 1, at + step))];
}

/** The tickets that need you, in board order: `[{c, r, id}]` (column index, row, id). */
export function needsStops(cols, tasks, now = Date.now()) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];
  COLUMNS.forEach((name, c) => (cols[name] ?? []).forEach((id, r) => needsYou(byId.get(id) ?? {}, now) && out.push({ c, r, id })));
  return out;
}

/** `]` and `[`: the stop after (or before) `here` `{c, r}`, wrapping; null when nothing needs you. */
export function hopStop(stops, here, forward) {
  if (!stops.length) return null;
  const at = (s) => s.c * 1e6 + s.r;
  const h = here.c * 1e6 + here.r;
  const i = stops.findIndex((s) => at(s) >= h);
  let next;
  if (forward) next = i < 0 ? 0 : at(stops[i]) === h ? (i + 1) % stops.length : i;
  else next = i > 0 ? i - 1 : stops.length - 1;
  return stops[next];
}

// ---- the filters ----

/** The tasks the `!` and `@` filters keep (`ctl.needsOnly`, `ctl.thisRepo`: a repo path or null). */
export function applyToggles(tasks, ctl, now = Date.now()) {
  return tasks.filter((t) => (!ctl.needsOnly || needsYou(t, now)) && (!ctl.thisRepo || t.repoPath === ctl.thisRepo));
}

/** True when anything narrows the board: a search, `!`, `@`. */
export const isFiltered = (ctl, query = "") => Boolean(query.trim() || ctl.needsOnly || ctl.thisRepo);

// ---- the card's markers (the TUI's `card_prefix` and `card_lines`) ----

const clocks = (t) => [t.sla?.gate, t.sla?.stage, t.sla?.cycle, t.sla?.jiraDue];
/** Any SLA clock past its target: `‼` and a red title. */
export const isOverdue = (t) => clocks(t).some((c) => c?.overdue);
/** Waiting on you past the gate SLA: sorts first in its column. */
export const gateOverdue = (t) => Boolean(t.sla?.gate?.overdue);
/** The running stage is past 80% of its target but not over it: the age turns yellow. */
export const stageWarn = (t) => Boolean(t.sla?.stage?.warn && !t.sla.stage.overdue);
/** The header's `‼ N overdue`. */
export const overdueCount = (tasks) => tasks.filter(isOverdue).length;

/** The spend above which a card gets its dim `$`: the p90 over the tickets that spent anything, once three can be compared. */
export function spendP90(tasks) {
  const spends = tasks.map((t) => t.spentUsd).filter((n) => typeof n === "number").sort((a, b) => a - b);
  if (spends.length < 3) return null;
  const at = 0.9 * (spends.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return spends[lo] + (spends[hi] - spends[lo]) * (at - lo);
}

/** `#42` for a ticket from an issue, `⌁` from Slack, the Jira key, `notch LUNA-14`; else "". */
export function issuePrefix(task) {
  const s = task.source;
  if (!s) return "";
  if (s.kind === "notch") return `notch ${s.ref ?? ""}`.trim();
  if (s.number != null) return `#${s.number}`;
  if (s.kind === "slack") return "⌁";
  if (s.kind === "jira" && s.key) return s.key;
  return "";
}

/** A draft the machine holds: a split child waiting on the cards it depends on. */
export const isHeld = (task) => task.state === "draft" && Boolean(task.dependsOn?.length) && task.startWhenReady !== false;

/** What a card says beyond its title: the TUI's badges. `p90` is `spendP90` over the board's tasks. */
export function cardMarks(task, p90 = null) {
  return {
    overdue: isOverdue(task),
    warn: stageWarn(task),
    retries: (task.retries?.total ?? 0) > 1 ? task.retries.total : 0,
    worktree: Boolean(task.worktreePath),
    part: task.splitPart ? `part ${task.splitPart.n}/${task.splitPart.of}` : null,
    prefix: issuePrefix(task),
    spendy: typeof task.spentUsd === "number" && p90 != null && task.spentUsd > p90,
    noRepo: task.state === "draft" && !task.repoPath,
    held: isHeld(task),
  };
}

/** Why a held draft waits, in words: the machine's own `card.held` text when the detail is loaded, else the dependency. */
export function heldReason(task, detail = null) {
  if (task.state !== "draft") return null;
  const last = [...(detail?.events ?? [])].reverse().find((e) => e?.kind === "card.held" || e?.kind === "card.released");
  if (last) return last.kind === "card.held" ? String(last.payload?.text ?? "").trim() || "held by the machine" : null;
  if (!isHeld(task)) return null;
  const on = task.dependsOn.map((id) => String(id).slice(0, 8)).join(", ");
  return `waits for ${on}${task.splitPart ? ` (part ${task.splitPart.n} of ${task.splitPart.of})` : ""}`;
}

// ---- marks and bulk actions ----

export const toggleMark = (marked, id) => {
  const next = new Set(marked);
  next.has(id) ? next.delete(id) : next.add(id);
  return next;
};

/** `V`: marks the whole column, or unmarks it when it is all marked. */
export function markColumn(marked, ids) {
  const next = new Set(marked);
  if (ids.length && ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  return next;
}

/** What `a` does to a ticket: `start`, `resume`, `approve`, or null when it needs your words. */
export function approveStep(task, now = Date.now()) {
  if (task.state === "draft") return task.repoPath && !isHeld(task) ? "start" : null;
  if (task.state === "paused_rate_limit") return "resume";
  if (!task.waitingOnYou || task.state === "escalated") return null;
  const requested = task.gate?.requested ?? {};
  switch (task.state) {
    case "awaiting_approval": return requested.outcome === "split_failed" ? null : "approve";
    case "awaiting_test_check": return "approve";
    case "awaiting_ship": return task.route === "review" ? null : "approve";
    case "awaiting_setup": return requested.kind ? null : "approve";
    default: return null;
  }
}

/**
 * What approving `task` would commit, when it is a gate that asks first: `plan`, `split`, `ship` or
 * `release` (the TUI's `committing_kind`). Replies, archives, setups, test checks, escalations,
 * review posts and the retro's rules are not: they need a look, or words, of their own.
 */
export function committingKind(task) {
  if (!task.waitingOnYou || task.state === "reviewing_memory") return null;
  const r = task.gate?.requested ?? {};
  if (task.state === "awaiting_approval") {
    if (r.outcome == null) return "plan";
    return r.outcome === "split" ? "split" : null;
  }
  if (task.state === "awaiting_ship") {
    if (task.route === "review") return null;
    return r.gate === "ship_approval" ? "release" : "ship";
  }
  return null;
}

const titleOf = (t) => `${projectOf(t)}: ${(t.title ?? "").replace(/^PR #\d+:\s*/, "")}`;

/** What `a` over the marks does: the draft starts and the paused resumes now; the committing gates wait for one yes. */
export function bulkApprovePlan(tasks, ids) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const plan = { immediate: [], committing: [], skipped: 0, missing: 0 };
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) {
      plan.missing++;
      continue;
    }
    const kind = committingKind(t);
    if (kind) plan.committing.push({ id, kind, expect: gateKey(t), step: "approve", title: titleOf(t) });
    else if (t.state === "draft" && t.repoPath && !isHeld(t)) plan.immediate.push({ id, step: "start" });
    else if (t.state === "paused_rate_limit") plan.immediate.push({ id, step: "resume" });
    else plan.skipped++;
  }
  return plan;
}

/** The line the one yes asks over the committing cards: `Approve 3 cards? 2 plans · 1 ship`. */
export function approveManyQuestion(items) {
  const parts = ["plan", "split", "ship", "release"]
    .map((k) => [k, items.filter((i) => i.kind === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
  return `Approve ${items.length} card${items.length === 1 ? "" : "s"}? ${parts.join(" · ")}`;
}

/** What the yes says when it is done (the TUI's `approve_each`): cards that moved on are skipped and counted. */
export function approveResult(done, total, moved = 0, failed = 0) {
  if (moved && failed) return `approved ${done} · skipped ${moved} that moved on · ${failed} failed`;
  if (moved) return `approved ${done} · skipped ${moved} that moved on`;
  return `approved ${done} of ${total}`;
}

const STEP_WORDS = { start: "start", resume: "resume", approve: "approve" };

/** The bulk actions: the key, what the dialog says, and which tickets each applies to. */
export const BULK = {
  approve: { key: "a", title: "Approve the marked tickets", label: "Approve", danger: false, done: "advanced", applies: (t) => committingKind(t) !== null },
  abort: { key: "X", title: "Stop the marked tickets", label: "Stop them", danger: true, done: "stopped", applies: (t) => Boolean(t.running || t.queued || t.state === "paused_rate_limit") },
  delete: { key: "d", title: "Delete the marked tickets", label: "Delete", danger: true, done: "deleted", applies: (t) => ended(t) || t.state === "draft" },
  worktree: { key: "w", title: "Remove the marked tickets' workspaces", label: "Remove", danger: true, done: "workspace removed on", applies: (t) => Boolean(t.worktreePath) && !t.running },
  archive: { key: "Z", title: "Archive the marked tickets", label: "Archive", danger: true, done: "archived", applies: (t) => !ended(t) },
};
export const BULK_KEYS = Object.fromEntries(Object.entries(BULK).map(([id, b]) => [b.key, id]));

/** The marked tickets `action` can apply to, as `{id, title, step}`. The rest are left out (and counted by the caller). */
export function bulkTargets(tasks, ids, action, now = Date.now()) {
  const spec = BULK[action];
  if (!spec) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return ids
    .map((id) => byId.get(id))
    .filter((t) => t && spec.applies(t, now))
    .map((t) => ({
      id: t.id,
      title: titleOf(t),
      step: action,
      ...(action === "approve" ? { kind: committingKind(t), expect: gateKey(t) } : {}),
    }));
}

/** The line a dialog asks over `n` tickets. */
export function bulkQuestion(action, n) {
  const s = n === 1 ? "ticket" : "tickets";
  switch (action) {
    case "approve": return `Approve ${n} ${s}? Each gets a yes at its own gate: a ship publishes the PR and a release merges it. A card that moved on is skipped.`;
    case "abort": return `Stop the running stage on ${n} ${s}? They then wait for you.`;
    case "worktree": return `Remove the workspace of ${n} ${s}? Branches and commits stay.`;
    case "delete": return `Delete ${n} ${s}? Runs and history go too. This cannot be undone.`;
    case "archive": return `Archive ${n} ${s}. Why?`;
    default: return `${n} ${s}`;
  }
}

/** What the dialog says when it is done: `advanced 3 of 4 · 1 failed`. */
export function bulkResult(action, ok, total, failed = 0) {
  const spec = BULK[action];
  return `${spec?.done ?? action} ${ok} of ${total}${failed ? ` · ${failed} failed` : ""}`;
}

export { ARCHIVE_REASONS, STEP_WORDS };

// ---- the keys sheet ----

/** The board's keys, as groups of `[keys, what it does]`: the keys sheet and the README read this. */
export const BOARD_KEYS = [
  { name: "Move", rows: [
    ["h / l", "previous / next column"],
    ["j / k", "previous / next ticket in the column"],
    ["gg / G", "first / last ticket in the column"],
    ["1-8", "jump to that column (8 opens Done)"],
    ["tab / shift+tab", "next / previous ticket that needs you"],
    ["] / [", "the same as tab / shift+tab"],
    ["enter", "open the ticket (the inspector)"],
    ["esc", "clear the filter and the marks, else close the ticket"],
  ] },
  { name: "Gate", rows: [
    ["a", "start; approve (asks first); answer; retry with guidance; resume; with marks: approve the plans, splits, ships and releases"],
    ["r", "send back with a reason"],
    ["N", "reject the plan or split; reject the release"],
    ["u", "approve excusing untestable criteria"],
    ["A", "memory review: approve, skip the rules"],
    ["T", "correct the triage record"],
    ["p", "post the questions at the source"],
    ["C", "correct the escalation reason"],
    ["x then S", "ship: approve and open the PR"],
    ["x then P / D / + / -", "resume the paused / drain / one more slot / one fewer"],
  ] },
  { name: "Ticket", rows: [
    ["e", "edit the plan or the ticket"],
    ["f", "open or focus the agent's watch tab"],
    ["J", "link a Jira issue; unlink it (asks first)"],
    ["R", "set the repo"],
    ["o / O", "open the linked issue / the PR in the browser"],
    ["M / U", "close as a duplicate of another / bring it back"],
    ["x x", "the inspector's More menu"],
  ] },
  { name: "Views", rows: [
    ["F / I / D", "Floor / Inbox / Digest"],
    ["B / $ / K / S", "Backlog / Economy / Tickets / Slack"],
  ] },
  { name: "Filter and order", rows: [
    ["/", "filter by title, #id or repo"],
    ["!", "only the tickets that need you"],
    ["@", "only the selected ticket's repo"],
    ["zc / zo", "fold / unfold the focused column"],
    ["zz", "fold every column but the focused one (again: unfold)"],
    ["gs / gr / ga", "order columns by stage / repo / age"],
    ["=", "card density: 3 lines, 4, 1"],
  ] },
  { name: "Marks and bulk", rows: [
    ["v", "mark the ticket (cmd or shift click does too)"],
    ["V", "mark the whole column"],
    ["a", "with marks: start and resume now; plans, splits, ships and releases ask once"],
    ["X / d / w / Z", "with marks: stop / delete / remove workspaces / archive (asks first)"],
  ] },
  { name: "App", rows: [
    ["n", "new task"],
    [":", "command palette"],
    ["ctrl+r", "read the board again (r is send back, as in the TUI)"],
    ["P", "pull requests"],
    ["b", "back to the board, from another page"],
    ["?", "this sheet"],
  ] },
];

export const PR_KEYS = [
  { name: "Pull request", rows: [
    ["m", "merge, delete the branch (asks first)"],
    ["c", "CI fix: an agent repairs the red run"],
    ["v", "review: an agent posts line comments"],
    ["t", "threads: an agent answers every one"],
    ["X", "close your own PR, unmerged, when no task runs on it (asks first)"],
    ["C", "clone the repo to a folder you pick"],
    ["o", "open the PR on GitHub"],
    ["space / x", "show or hide every check by name"],
    ["enter", "jump to its task, else open the PR"],
  ] },
  { name: "Move", rows: [
    ["j / k", "previous / next PR"],
    ["h / l", "previous / next split"],
    ["1-7", "jump to that split: review requested, ready to merge, CI failed, CI running, changes requested, mine; 7 all repos"],
    ["f / F", "show one repo / every repo"],
    ["R", "poll GitHub now"],
    ["esc / P / q", "back to the board"],
  ] },
];

/** The groups the sheet shows for a page: its own first, then the board's app keys. */
export function sheetGroups(pageId, extra = []) {
  const own = pageId === "prs" ? PR_KEYS : pageId === "board" ? BOARD_KEYS : [];
  const app = BOARD_KEYS.find((g) => g.name === "App");
  return [...own, ...extra, ...(pageId === "board" ? [] : app ? [app] : [])];
}

// ---- the command palette ----

/** The TUI's `:` commands that the board runs itself. `arg`: what it takes, null for none. */
export const BOARD_COMMANDS = [
  { verb: "new", arg: "<title>", does: "new ticket, titled" },
  { verb: "filter", arg: "<text>", does: "filter: title, #id or repo (bare clears)" },
  { verb: "open", arg: "<#id>", does: "open a ticket by id prefix" },
  { verb: "group", arg: "stage|repo|age", does: "order columns" },
  { verb: "fold", arg: null, does: "fold the focused column" },
  { verb: "unfold", arg: null, does: "unfold the focused column" },
  { verb: "start", arg: null, does: "start the selected ticket (a)" },
  { verb: "repo", arg: "<name>", does: "set the ticket's repo (bare: search)" },
  { verb: "whole", arg: null, does: "keep a split card whole (recorded)" },
  { verb: "dismiss", arg: "<finding id> [reason]", does: "dismiss a finding Verify reported" },
  { verb: "finding", arg: "<blocker|should_fix|nit> <title>", does: "add a finding Verify missed" },
  { verb: "ticket-edit", arg: "<text>", does: "post your text, not the draft's" },
  { verb: "dedup", arg: "duplicate <n> | related <ns> | neither", does: "answer the duplicate question" },
  { verb: "dup", arg: "<id>", does: "close as a duplicate of that ticket" },
  { verb: "undup", arg: null, does: "bring a closed duplicate back" },
  { verb: "context", arg: "repo|project|text <value>", does: "answer Intake: repo, project or text" },
  { verb: "jira", arg: "<KEY>", does: "link that Jira issue (bare: the search)" },
  { verb: "refresh", arg: null, does: "read the board again" },
  { verb: "slots", arg: "<n>", does: "resize the pool" },
  { verb: "drain", arg: null, does: "take no new work" },
  { verb: "resume", arg: null, does: "carry on taking new work" },
];

/**
 * The entries the palette lists: the board's own commands, the registered `PALETTE` entries
 * (`{id, label, hint}`, run as `palette <id>`) and every other registered `COMMANDS` verb.
 * Each `{name, arg, does, line}`: `line` is what runs when the entry takes no argument.
 */
export function paletteEntries(palette = [], verbs = []) {
  const out = BOARD_COMMANDS.map((c) => ({ name: c.verb, arg: c.arg, does: c.does, line: c.verb }));
  const have = new Set(out.map((e) => e.name));
  for (const p of palette) out.push({ name: p.label ?? p.id, arg: null, does: p.hint ?? "", line: `palette ${p.id}` });
  for (const v of [...verbs].sort()) if (!have.has(v)) out.push({ name: v, arg: null, does: "", line: v });
  return out;
}

/** The entries a typed line leaves: those that start with its first word, else those holding it. */
export function matchEntries(line, entries) {
  const text = line.trimStart();
  const [word = ""] = text.toLowerCase().split(/\s+/);
  if (!word) return entries;
  const starts = entries.filter((e) => e.name.toLowerCase().startsWith(word));
  if (starts.length || /\s/.test(text)) return starts.length ? starts : entries.filter((e) => e.name.toLowerCase() === word);
  return entries.filter((e) => `${e.name} ${e.does}`.toLowerCase().includes(word));
}

/**
 * What Enter does with `line` and the picked row (an entry, or null): run an entry, complete its
 * name when it still needs an argument, or run the text as typed (the TUI's rule: the picked one,
 * else the only one left, else the text).
 */
export function resolveLine(line, picked, matches) {
  const text = line.trim();
  const [word = "", ...rest] = text.split(/\s+/);
  const hasArg = rest.length > 0;
  const exact = matches.find((e) => e.name === word);
  const entry = picked ?? (hasArg ? exact : matches.length === 1 ? matches[0] : exact) ?? null;
  if (!entry) return text ? { action: "run", line: text } : { action: "none", line: "" };
  if (entry.arg && !hasArg) return { action: "complete", line: `${entry.name} ` };
  if (entry.line.startsWith("palette ") || !hasArg) return { action: "run", line: entry.line };
  return { action: "run", line: `${entry.name} ${rest.join(" ")}` };
}

// ---- the pane's control state ----

const keep = (k, v) => {
  try {
    localStorage.setItem(`luna.${k}`, v);
  } catch {
    // not kept: fine
  }
};
const kept = (k, fallback) => {
  try {
    return localStorage.getItem(`luna.${k}`) ?? fallback;
  } catch {
    return fallback;
  }
};

/** The pane's control state, made on first use: folds, order and density come from `localStorage` (per pane). */
export function getCtl(app) {
  if (app.ctl) return app.ctl;
  let folded = [];
  try {
    folded = JSON.parse(kept("folded", "[]")).filter((c) => COLUMNS.includes(c));
  } catch {
    folded = [];
  }
  const group = kept("group", "stage");
  const density = kept("density", "four");
  app.ctl = {
    folded: new Set(folded),
    foldAll: false,
    focus: "Intake",
    group: GROUP_BY.some((g) => g.id === group) ? group : "stage",
    density: DENSITIES.some((d) => d.id === density) ? density : "four",
    marked: new Set(),
    needsOnly: false,
    thisRepo: null,
    prefix: null,
    syncedSel: null,
  };
  return app.ctl;
}

// ---- the PR page ----

/** The splits in the TUI's order (`PrSplit::ALL`, digits 1-6; 7 is All repos), with their tab names. */
export const PR_SPLIT_ORDER = [
  ["review_requested", "Review requested"],
  ["ready_to_merge", "Ready to merge"],
  ["ci_failed", "CI failed"],
  ["ci_running", "CI running"],
  ["changes_requested", "Changes requested"],
  ["mine", "Mine"],
];
/** The splits that count on the badge and raise a notice: those that need a key from you. */
export const PR_NEEDS_ME = ["review_requested", "ready_to_merge", "ci_failed", "changes_requested"];
export const prSplitLabel = (id) => PR_SPLIT_ORDER.find(([s]) => s === id)?.[1] ?? "All repos";

const at = (pr) => Date.parse(pr.updatedAt ?? "");

/**
 * The PRs a split lists, as the TUI orders them: a split oldest first (the one waiting longest is on
 * top), All repos newest first (it is for browsing what just opened). `split` null is All repos.
 */
export function orderPrs(prs, { split = null, repo = null, query = "" } = {}) {
  const q = query.trim().toLowerCase();
  const found = prs.filter(
    (p) => (!split || p.split === split) && (!repo || p.repo === repo) && (!q || `${p.title} ${p.repo}#${p.number} ${p.author}`.toLowerCase().includes(q)),
  );
  const when = (p) => (Number.isFinite(at(p)) ? at(p) : null);
  return found.sort((a, b) => (split ? (when(a) ?? Infinity) - (when(b) ?? Infinity) : (when(b) ?? 0) - (when(a) ?? 0)));
}

/** The PR badge: how many PRs sit in a split that needs you (review requested, ready to merge, CI failed, changes requested). */
export const prNeedsCount = (prs) => prs.filter((p) => PR_NEEDS_ME.includes(p.split)).length;

/**
 * The notices a new snapshot is worth (`pr_notice`): a PR newly in a split that needs you, from
 * anywhere else or from nowhere. `seen` maps `repo#n` to the split last seen and is updated, so
 * each PR notifies once per move, across polls.
 */
export function prNotices(prs, seen) {
  const out = [];
  for (const pr of prs) {
    const key = `${pr.repo}#${pr.number}`;
    const before = seen.get(key);
    seen.set(key, pr.split);
    if (PR_NEEDS_ME.includes(pr.split) && before !== pr.split) out.push({ title: prSplitLabel(pr.split), body: `${key} ${pr.title}` });
  }
  return out;
}

/** Why Close is off, in the TUI's words (`pulls::blocker`), or null: it is for your own PRs, with no task running. */
export function prCloseRefusal(pr) {
  if (!pr.mine) return "closing is for your own PRs";
  if (pr.task) return "a task is already running for it";
  return null;
}

/** A check's state as a tone name for `toneColor` (null: muted). */
export function checkTone(state) {
  switch (String(state ?? "").toUpperCase()) {
    case "SUCCESS": return "done";
    case "FAILURE": case "ERROR": case "TIMED_OUT": case "CANCELLED": case "ACTION_REQUIRED": case "STARTUP_FAILURE": return "error";
    case "PENDING": case "QUEUED": case "IN_PROGRESS": case "WAITING": case "EXPECTED": return "working";
    default: return null;
  }
}

/** Every check of a PR, the failing ones first, then the running, then the rest by name. */
export function checkRows(pr) {
  const rank = (c) => ({ error: 0, working: 1 }[checkTone(c.state)] ?? (checkTone(c.state) === "done" ? 3 : 2));
  const all = pr.checks?.all?.length ? pr.checks.all : pr.checks?.failed ?? [];
  return [...all].sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
}

/** The split `step` away in `ids` (null is "All"), stopping at the ends. */
export function stepSplit(ids, current, step) {
  const i = Math.max(0, ids.indexOf(current ?? null));
  return ids[Math.max(0, Math.min(ids.length - 1, i + step))];
}

/** Why a PR key is off, in words (the TUI's `(only …)` lines), or null when `id` is among the actions. */
export function prKeyRefusal(pr, id, available) {
  if (available.includes(id)) return null;
  if (pr.task) return "a task already runs for this PR";
  if (!pr.localPath && id !== "browser") return "the repository is not cloned here: C clones it";
  if (id === "review") return pr.mine ? "review is for other people's PRs" : "not available";
  if ((id === "ci_fix" || id === "address") && pr.fromFork) return "nothing can push to a fork's branch";
  if (id === "ci_fix") return "its checks are not failing";
  if (id === "address") return pr.mine ? "no thread is open" : "threads are answered on your own PRs";
  if (id === "merge") return "it is not ready to merge";
  return "not available";
}

/** Saves what survives a reload: the folded columns, the order and the density. */
export function saveCtl(ctl) {
  keep("folded", JSON.stringify([...ctl.folded]));
  keep("group", ctl.group);
  keep("density", ctl.density);
}

// ---- the two-key prefix (g, z, x) ----

/** How long a prefix waits for its second key. */
export const PREFIX_MS = 1000;

/** The live prefix of `ctl` (null once it expired or the page changed); clears a dead one. */
export function livePrefix(ctl, page, now = Date.now()) {
  const p = ctl.prefix;
  if (!p) return null;
  if (now - (p.at ?? 0) > PREFIX_MS || (p.page && p.page !== page)) {
    ctl.prefix = null;
    return null;
  }
  return p;
}

// ---- ticket keys: the words each says when it does not apply (the TUI's) ----

/** A card's open approval outcome, from the loaded detail or the gate on the task. */
export function openOutcome(task, detail = null) {
  const open = [...(detail?.approvals ?? [])].reverse().find((a) => !a.decision);
  return (open?.requested ?? task.gate?.requested ?? {}).outcome ?? null;
}

/** `N`: the plan gate (a plan, a split) and the release question reject. */
export const rejectKind = (task, detail = null) => {
  if (task.state === "awaiting_ship" && task.waitingOnYou && task.gate?.requested?.gate === "ship_approval") return "release";
  if (task.state !== "awaiting_approval") return null;
  const o = openOutcome(task, detail);
  return o == null || o === "split" || o === "split_failed" ? "plan" : null;
};

/** `r`: a setup, plan or tests, an escalated feature card, the ship gate of a feature while it waits; not the release question. */
export function canSendBack(task) {
  if (task.state === "awaiting_ship" && task.gate?.requested?.gate === "ship_approval") return false;
  switch (task.state) {
    case "awaiting_setup": case "awaiting_approval": case "awaiting_test_check": return true;
    case "escalated": return task.route === "feature";
    case "awaiting_ship": return task.route !== "review" && Boolean(task.waitingOnYou);
    default: return false;
  }
}

/** Why `e` has nothing to edit, or null. */
export function editRefusal(task, detail = null) {
  const o = openOutcome(task, detail);
  if (task.state === "awaiting_approval" && (o === "split" || o === "split_failed")) return "a split has no plan to edit; :whole keeps it one card";
  if (task.state === "awaiting_approval" && (o === "conversation" || o === "archive")) return "a reply or an archive has nothing to edit";
  if (task.state === "awaiting_ship" && task.waitingOnYou && task.gate?.requested?.gate === "ship_approval") return "the release question has nothing to edit";
  return null;
}

/** The coverage gaps `u` can excuse: the open plan gate's gaps minus those already excused, as `{id, text}`. */
export function openGaps(task, detail) {
  const open = [...(detail?.approvals ?? [])].reverse().find((a) => !a.decision && a.kind === "awaiting_approval");
  if (!open || open.requested?.outcome) return [];
  const report = open.requested?.coverageReport ?? {};
  const excused = new Set(report.untestable ?? []);
  const rows = planCriteria(open, task);
  const text = (id) => rows.find((c) => c.id === id)?.text ?? "";
  return (report.gaps ?? []).filter((id) => !excused.has(id)).map((id) => ({ id, text: text(id) }));
}
