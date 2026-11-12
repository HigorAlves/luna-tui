// The board's controls as pure functions (no host calls, so `node --test` checks them): folding,
// ordering columns, card density, the focused column, marks and bulk actions, the filters, key
// names, the keys sheet's rows and the command palette's matching. board.js draws from them and
// boardkeys.js wires them to keys. The rules are the TUI's (`board/src/app.rs`).
import { COLUMNS, ARCHIVE_REASONS, ended, needsYou, projectOf, sortCards } from "./model.js";

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
  const stage = sortCards(tasks, now);
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
  if (task.state === "draft") return task.repoPath ? "start" : null;
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

const STEP_WORDS = { start: "start", resume: "resume", approve: "approve" };

/** The bulk actions: the key, what the dialog says, and which tickets each applies to. */
export const BULK = {
  approve: { key: "a", title: "Approve or start the marked tickets", label: "Go on", danger: false, done: "advanced", applies: (t, now) => approveStep(t, now) !== null },
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
    .map((t) => ({ id: t.id, title: `${projectOf(t)}: ${(t.title ?? "").replace(/^PR #\d+:\s*/, "")}`, step: action === "approve" ? approveStep(t, now) : action }));
}

/** The line a dialog asks over `n` tickets. */
export function bulkQuestion(action, n) {
  const s = n === 1 ? "ticket" : "tickets";
  switch (action) {
    case "approve": return `Approve or start ${n} ${s}? Each goes one step on; nothing is posted to GitHub from here.`;
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
    ["enter", "the ticket's main action (start, approve, retry, resume)"],
    ["esc", "clear the filter and the marks, else close the ticket"],
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
    ["a", "with marks: approve or start them (asks first)"],
    ["X / d / w / Z", "with marks: stop / delete / remove workspaces / archive (asks first)"],
  ] },
  { name: "App", rows: [
    ["n", "new task"],
    [":", "command palette"],
    ["r", "read the board again"],
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
    ["X", "close the PR, unmerged (asks first)"],
    ["C", "clone the repo to a folder you pick"],
    ["o", "open the PR on GitHub"],
    ["space / x", "show or hide every check by name"],
    ["enter", "jump to its task, else open the PR"],
  ] },
  { name: "Move", rows: [
    ["j / k", "previous / next PR"],
    ["h / l", "previous / next split"],
    ["1-7", "jump to that split (7: all repos)"],
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
  { verb: "start", arg: null, does: "start the selected ticket" },
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
