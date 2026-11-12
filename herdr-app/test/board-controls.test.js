// The board's controls: folding, order, density, navigation, marks and bulk actions, the filters,
// the palette's matching and the keys sheet, as pure functions; then the board, the PR page and
// the dialogs drawn in each mode with the host stand-in, and the keys run against a fake pane.
import assert from "node:assert/strict";
import { test } from "node:test";

import { theme } from "./host/stub.js";
import "../luna/features.js";
import { boardPage } from "../luna/board.js";
import { boardKey } from "../luna/boardkeys.js";
import {
  BOARD_KEYS, BULK_KEYS, DENSITIES, PR_KEYS, applyToggles, approveStep, arrange, bulkQuestion, bulkResult, bulkTargets, checkRows, checkTone, flatOrder,
  foldKey, getCtl, hopStop, isFolded, keyName, markColumn, matchEntries, needsStops, nextDensity, openColumns, orderCards, paletteEntries, prKeyRefusal,
  resolveLine, sheetGroups, stepColumn, stepRow, stepSplit, toggleMark,
} from "../luna/controls.js";
import { DIALOGS, COMMANDS, PALETTE } from "../luna/registry.js";
import { renderDialog } from "../luna/dialogs.js";
import { prsKey, prsPage } from "../luna/prs.js";

const t = theme();
const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
const task = (id, over = {}) => ({
  id, title: `Task ${id}`, state: "implementing", column: "Build", route: "feature", repoPath: "/w/shop", waitingOnYou: false, running: false, queued: false,
  createdAt: iso(100), updatedAt: iso(1), seq: 1, criteria: [], ...over,
});

const TASKS = [
  task("a1", { column: "Intake", state: "draft", createdAt: iso(500) }),
  task("a2", { column: "Intake", state: "draft", repoPath: "/w/api", createdAt: iso(300) }),
  task("p1", { column: "Plan", state: "awaiting_approval", waitingOnYou: true, createdAt: iso(200), gate: { requested: {} } }),
  task("b1", { column: "Build", running: true, createdAt: iso(50) }),
  task("b2", { column: "Build", running: true, repoPath: "/w/api", createdAt: iso(400) }),
  task("s1", { column: "Ship", state: "awaiting_ship", waitingOnYou: true, createdAt: iso(20), gate: { requested: { gate: "ship_approval" } } }),
  task("s2", { column: "Ship", state: "awaiting_ship", route: "review", waitingOnYou: true, createdAt: iso(30), gate: { requested: {} } }),
  task("e1", { column: "Build", state: "escalated", reason: "env_broken", createdAt: iso(10) }),
  task("z1", { column: "Plan", state: "paused_rate_limit", createdAt: iso(600) }),
  task("d1", { column: "Done", state: "closed", worktreePath: "/tmp/wt" }),
];

const ctlBase = () => ({ folded: new Set(), foldAll: false, focus: "Build" });

test("keyName reads a key as the character it types", () => {
  assert.equal(keyName({ key: "j", modifiers: {} }), "j");
  assert.equal(keyName({ key: "v", key_char: "V", modifiers: { shift: true } }), "V");
  assert.equal(keyName({ key: "V", modifiers: { shift: true } }), "V");
  assert.equal(keyName({ key: "1", modifiers: { shift: true } }), "!");
  assert.equal(keyName({ key: "/", key_char: "?", modifiers: { shift: true } }), "?");
  assert.equal(keyName({ key: ";", modifiers: { shift: true } }), ":");
  assert.equal(keyName({ key: "tab", modifiers: { shift: true } }), "shift-tab");
  assert.equal(keyName({ key: "tab", modifiers: {} }), "tab");
  assert.equal(keyName({ key: "d", modifiers: { control: true } }), "ctrl-d");
  assert.equal(keyName({ key: "escape" }), "escape");
});

test("folding: zc, zo and zz leave the state the TUI's keys leave", () => {
  let c = ctlBase();
  assert.equal(isFolded(c, "Build"), false);
  assert.equal(isFolded(c, "Done", false), true, "Done is a rail unless it is open");
  const folded = foldKey(c, "c");
  assert.ok(folded.folded.has("Build"));
  assert.equal(isFolded(folded, "Build"), true);
  assert.equal(isFolded(foldKey(folded, "o"), "Build"), false);
  const others = foldKey(c, "z");
  assert.equal(others.foldAll, true);
  assert.deepEqual(openColumns(others, false), ["Build"], "only the focused column is open");
  assert.equal(foldKey(others, "z").foldAll, false, "zz again unfolds");
  // zo after zz keeps the others folded and opens the focus.
  const back = foldKey(others, "o");
  assert.equal(back.foldAll, false);
  assert.ok(back.folded.has("Intake") && !back.folded.has("Build"));
  // Done folds with the app's doneOpen.
  const doneFocus = { ...c, focus: "Done" };
  assert.equal(foldKey(doneFocus, "o", false).doneOpen, true);
  assert.equal(foldKey(doneFocus, "c", true).doneOpen, false);
  // The input is left alone.
  assert.equal(c.folded.size, 0);
});

test("order: stage, repo and age mean what the TUI means; Done reads newest first", () => {
  const cards = TASKS.filter((x) => x.column === "Build");
  const stage = orderCards(cards, "stage", "Build", now).map((x) => x.id);
  assert.equal(stage[0], "e1", "what needs you leads");
  const repo = orderCards(cards, "repo", "Build", now).map((x) => x.id);
  assert.deepEqual(repo.slice(0, 1), ["b2"], "api before shop");
  assert.equal(repo.at(-1) === "b2", false);
  const age = orderCards(cards, "age", "Build", now).map((x) => x.id);
  assert.deepEqual(age, ["b2", "b1", "e1"], "the oldest first, whatever the look");
  const done = orderCards([task("o", { updatedAt: iso(50) }), task("n", { updatedAt: iso(1) })], "age", "Done", now).map((x) => x.id);
  assert.deepEqual(done, ["n", "o"]);
  const by = arrange(TASKS, "repo", now);
  assert.equal(by.Intake[0].id, "a2");
  assert.equal(by.Done.length, 1);
});

test("density cycles 3 lines, 4, 1", () => {
  assert.deepEqual(DENSITIES.map((d) => d.id), ["three", "four", "one"]);
  assert.equal(nextDensity("three"), "four");
  assert.equal(nextDensity("four"), "one");
  assert.equal(nextDensity("one"), "three");
});

test("navigation: columns stop at the ends, rows walk a column, tab hops to what needs you", () => {
  assert.equal(stepColumn("Intake", -1), "Intake");
  assert.equal(stepColumn("Build", 1), "Verify");
  assert.equal(stepColumn("Done", 1), "Done");
  assert.equal(stepRow(["x", "y", "z"], "x", 1), "y");
  assert.equal(stepRow(["x", "y", "z"], "z", 1), "z");
  assert.equal(stepRow(["x", "y"], "nope", 1), "x");
  assert.equal(stepRow(["x", "y"], null, -1), "y");
  assert.equal(stepRow([], "x", 1), null);
  const by = arrange(TASKS, "stage", now);
  const cols = Object.fromEntries(Object.entries(by).map(([c, l]) => [c, l.map((x) => x.id)]));
  const stops = needsStops(cols, TASKS, now);
  assert.deepEqual(stops.map((s) => s.id).sort(), ["e1", "p1", "s1", "s2"].sort());
  const first = hopStop(stops, { c: 0, r: 0 }, true);
  assert.equal(first.id, "p1", "Plan is the first column with a stop");
  const second = hopStop(stops, { c: first.c, r: first.r }, true);
  assert.equal(second.id, "e1");
  assert.equal(hopStop(stops, { c: 0, r: 0 }, false).c, stops.at(-1).c, "back from the start wraps to the last");
  assert.equal(hopStop(stops, { c: 7, r: 0 }, true).id, "p1", "forward from the end wraps");
  assert.equal(hopStop([], { c: 0, r: 0 }, true), null);
  assert.deepEqual(flatOrder({ Intake: ["a"], Build: ["b"], Done: ["d"] }, ctlBase(), false), ["a", "b"]);
  assert.deepEqual(flatOrder({ Intake: ["a"], Build: ["b"], Done: ["d"] }, ctlBase(), true), ["a", "b", "d"]);
});

test("the filters: ! keeps what needs you, @ one repo", () => {
  assert.deepEqual(applyToggles(TASKS, { needsOnly: true }, now).map((x) => x.id).sort(), ["e1", "p1", "s1", "s2"]);
  assert.ok(applyToggles(TASKS, { thisRepo: "/w/api" }, now).every((x) => x.repoPath === "/w/api"));
  assert.equal(applyToggles(TASKS, {}, now).length, TASKS.length);
});

test("marks: v toggles, V marks a column or unmarks it when it is all marked", () => {
  let m = toggleMark(new Set(), "a");
  assert.ok(m.has("a"));
  assert.ok(!toggleMark(m, "a").has("a"));
  m = markColumn(new Set(), ["a", "b"]);
  assert.equal(m.size, 2);
  assert.equal(markColumn(m, ["a", "b"]).size, 0);
  assert.equal(markColumn(new Set(["a"]), ["a", "b"]).size, 2);
});

test("bulk: each action applies only where it can, and says how many it ran", () => {
  const ids = TASKS.map((x) => x.id);
  const approve = bulkTargets(TASKS, ids, "approve", now);
  const steps = Object.fromEntries(approve.map((x) => [x.id, x.step]));
  assert.deepEqual(steps, { a1: "start", a2: "start", p1: "approve", s1: "approve", z1: "resume" });
  assert.equal(approveStep(TASKS.find((x) => x.id === "e1"), now), null, "an escalation needs words");
  assert.equal(approveStep(TASKS.find((x) => x.id === "s2"), now), null, "a review is never posted from a key");
  assert.equal(approveStep(task("nr", { state: "draft", repoPath: null }), now), null, "no repo, no start");
  assert.deepEqual(bulkTargets(TASKS, ids, "abort", now).map((x) => x.id).sort(), ["b1", "b2", "z1"]);
  assert.deepEqual(bulkTargets(TASKS, ids, "delete", now).map((x) => x.id).sort(), ["a1", "a2", "d1"]);
  assert.deepEqual(bulkTargets(TASKS, ids, "worktree", now).map((x) => x.id), ["d1"]);
  assert.ok(!bulkTargets(TASKS, ids, "archive", now).some((x) => x.id === "d1"), "an ended ticket is not archived again");
  assert.deepEqual(bulkTargets(TASKS, ["nope"], "delete", now), []);
  assert.deepEqual(BULK_KEYS, { a: "approve", X: "abort", d: "delete", w: "worktree", Z: "archive" });
  assert.match(bulkQuestion("delete", 2), /Delete 2 tickets/);
  assert.match(bulkQuestion("abort", 1), /1 ticket\?/);
  assert.equal(bulkResult("approve", 3, 4, 1), "advanced 3 of 4 · 1 failed");
  assert.equal(bulkResult("delete", 2, 2), "deleted 2 of 2");
});

test("the palette: entries, matching, completing and running as the TUI does", () => {
  const entries = paletteEntries([{ id: "x1", label: "Inbox view", hint: "open the inbox" }], ["slack", "new", "inbox"]);
  const names = entries.map((e) => e.name);
  assert.ok(["new", "filter", "open", "group", "fold", "unfold", "start", "slots", "drain", "resume", "Inbox view", "slack", "inbox"].every((n) => names.includes(n)));
  assert.equal(names.filter((n) => n === "new").length, 1, "a registered verb already listed is not listed twice");
  assert.equal(entries.find((e) => e.name === "Inbox view").line, "palette x1");
  assert.deepEqual(matchEntries("fo", entries).map((e) => e.name), ["fold"]);
  assert.deepEqual(matchEntries("", entries).length, entries.length);
  assert.ok(matchEntries("sla", entries).some((e) => e.name === "slack"));
  assert.ok(matchEntries("view", entries).some((e) => e.name === "Inbox view"), "a word inside matches too");
  // The only one left runs; one that needs an argument completes first.
  assert.deepEqual(resolveLine("fo", null, matchEntries("fo", entries)), { action: "run", line: "fold" });
  assert.deepEqual(resolveLine("new", null, matchEntries("new", entries)), { action: "complete", line: "new " });
  assert.deepEqual(resolveLine("new Fix login", null, matchEntries("new Fix login", entries)), { action: "run", line: "new Fix login" });
  assert.deepEqual(resolveLine("group repo", null, matchEntries("group repo", entries)), { action: "run", line: "group repo" });
  assert.deepEqual(resolveLine("zzz", null, []), { action: "run", line: "zzz" }, "else the text as typed");
  assert.deepEqual(resolveLine("", null, entries), { action: "none", line: "" });
  const picked = entries.find((e) => e.name === "Inbox view");
  assert.deepEqual(resolveLine("in", picked, matchEntries("in", entries)), { action: "run", line: "palette x1" });
});

test("the board's commands are registered where the inbox folder finds them", () => {
  for (const v of ["new", "filter", "open", "group", "fold", "unfold", "start", "slots", "drain", "resume", "help"]) assert.equal(typeof COMMANDS[v], "function", v);
  assert.equal(typeof COMMANDS.palette, "function");
  assert.ok(Array.isArray(PALETTE));
});

test("the keys sheet lists every key group, the page's first", () => {
  const names = (id) => sheetGroups(id).map((g) => g.name);
  assert.deepEqual(names("board"), BOARD_KEYS.map((g) => g.name));
  assert.deepEqual(names("prs"), [...PR_KEYS.map((g) => g.name), "App"]);
  const rows = BOARD_KEYS.flatMap((g) => g.rows.map((r) => r[0])).join(" ");
  for (const k of ["zc / zo", "zz", "gs / gr / ga", "gg / G", "1-8", "tab / shift+tab", "v", "V", "X / d / w / Z", "!", "@", "=", ":", "?"]) assert.ok(rows.includes(k), k);
  assert.ok(sheetGroups("slack", [{ name: "Slack", rows: [["r", "reply"]] }]).some((g) => g.name === "Slack"));
});

test("PR checks: failing first, tones by state, a split step, why a key is off", () => {
  const rows = checkRows({ checks: { all: [{ name: "b", state: "SUCCESS" }, { name: "a", state: "FAILURE" }, { name: "c", state: "IN_PROGRESS" }, { name: "d", state: "SKIPPED" }] } });
  assert.deepEqual(rows.map((r) => r.name), ["a", "c", "d", "b"]);
  assert.equal(checkRows({ checks: { failed: [{ name: "x", state: "FAILURE" }] } }).length, 1);
  assert.equal(checkRows({}).length, 0);
  assert.equal(checkTone("success"), "done");
  assert.equal(checkTone("CANCELLED"), "error");
  assert.equal(checkTone("SKIPPED"), null);
  assert.equal(stepSplit([null, "a", "b"], "a", 1), "b");
  assert.equal(stepSplit([null, "a", "b"], "b", 1), "b");
  assert.equal(stepSplit([null, "a", "b"], null, -1), null);
  assert.equal(prKeyRefusal({ localPath: "/x" }, "merge", ["merge"]), null);
  assert.match(prKeyRefusal({ task: { id: "t" }, localPath: "/x" }, "review", []), /task already runs/);
  assert.match(prKeyRefusal({}, "review", []), /not cloned/);
  assert.match(prKeyRefusal({ localPath: "/x", fromFork: true }, "ci_fix", []), /fork/);
  assert.match(prKeyRefusal({ localPath: "/x", mine: true }, "review", []), /other people/);
});

// ---- drawing and keys against a fake pane ----

const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};
const cx = { notify() {}, stop_propagation() {}, timer: { after() {} } };

function pane(over = {}) {
  const a = {
    machine: { base: "http://x", approver: null }, tasks: TASKS, loaded: true, error: null, link: "live", page: "board", view: "all", project: null, query: "",
    selected: null, tab: "details", details: {}, diffs: {}, doneOpen: false, prs: { inbox: null, all: null }, prList: "inbox", prSplit: null, prRepo: null,
    prRefreshing: false, busy: new Set(), flash: null, width: 1400, boardWidth: 1100, search: { set_value() {} },
    select(id) { this.selected = id; }, act() {}, go(p) { this.page = p; }, reload() {}, newTask() {}, say(text, tone) { this.flash = { text, tone }; },
    primary() { this.primed = true; }, dialog(spec) { this.dialogs.push(spec); }, dialogs: [], showPrList(id) { this.prList = id; this.prSplit = null; },
    pickRepo() {}, prAct(pr, id) { this.acted = [pr.number, id]; }, refreshPrs() {}, openUrl(u) { this.opened = u; },
    toggleMark() {}, unfold() {}, focusColumn() {}, palette() {},
    ...over,
  };
  return a;
}
const press = (a, key, extra = {}) => boardKey(a, { key, modifiers: {}, ...extra }, cx);

test("the board draws in every mode: densities, folds, marks, filters, grouping", () => {
  for (const density of DENSITIES.map((d) => d.id)) {
    for (const foldAll of [false, true]) {
      for (const group of ["stage", "repo", "age"]) {
        const a = pane();
        Object.assign(getCtl(a), { density, foldAll, group, marked: new Set(["b1", "p1"]), needsOnly: false });
        const page = boardPage(a, t);
        assert.ok(page);
        if (density === "one") assert.ok(!texts(page).includes("Waiting on you"), "the one-line card has no tag");
      }
    }
  }
  const a = pane({ doneOpen: true });
  Object.assign(getCtl(a), { folded: new Set(["Intake", "Triage"]), needsOnly: true, thisRepo: "/w/shop", focus: "Plan" });
  const page = boardPage(a, t);
  assert.ok(texts(page).join("|").includes("only what needs you"));
  assert.ok(a.order.every((id) => TASKS.find((x) => x.id === id).column !== "Intake"), "a folded column is not walked");
  assert.deepEqual(a.cols.Intake, []);
  assert.ok(a.allCols.Intake !== undefined);
  // Three lines drop the chips, four keep them.
  const withChips = pane({ tasks: [task("c1", { tests: { passed: 1, total: 2 } })] });
  getCtl(withChips).density = "three";
  assert.ok(!texts(boardPage(withChips, t)).includes("1/2 tests"));
  const four = pane({ tasks: [task("c1", { tests: { passed: 1, total: 2 } })] });
  assert.ok(texts(boardPage(four, t)).includes("1/2 tests"));
  const marked = pane();
  getCtl(marked).marked = new Set(["b1"]);
  assert.match(texts(boardPage(marked, t)).join("|"), /1 marked/);
});

test("the keys move through columns and rows the TUI's way", () => {
  const a = pane();
  boardPage(a, t);
  getCtl(a).focus = "Build";
  assert.ok(press(a, "j"));
  assert.equal(a.selected, "e1", "the first card of the focused column");
  press(a, "j");
  assert.equal(a.selected, "b1");
  press(a, "k");
  assert.equal(a.selected, "e1");
  press(a, "G");
  assert.equal(a.selected, a.cols.Build.at(-1));
  press(a, "g");
  assert.equal(getCtl(a).prefix.c, "g");
  press(a, "g");
  assert.equal(a.selected, a.cols.Build[0], "gg is the first");
  press(a, "l");
  assert.equal(getCtl(a).focus, "Verify");
  assert.equal(a.selected, null, "an empty column selects nothing");
  press(a, "h");
  press(a, "h");
  assert.equal(getCtl(a).focus, "Plan");
  assert.equal(a.selected, a.cols.Plan[0]);
  press(a, "1");
  assert.equal(getCtl(a).focus, "Intake");
  press(a, "8");
  assert.equal(getCtl(a).focus, "Done");
  assert.equal(a.doneOpen, true, "8 opens Done");
  assert.equal(a.selected, "d1");
});

test("tab and ] hop to what needs you; ! and @ filter; esc clears; = and gs/gr/ga change the board", () => {
  const a = pane();
  boardPage(a, t);
  press(a, "tab");
  assert.equal(a.selected, "p1");
  press(a, "]");
  assert.ok(["e1", "s1", "s2"].includes(a.selected));
  const before = a.selected;
  press(a, "tab", { modifiers: { shift: true } });
  assert.notEqual(a.selected, before);
  press(a, "!", { key_char: "!" });
  assert.equal(getCtl(a).needsOnly, true);
  press(a, "@");
  assert.equal(getCtl(a).thisRepo, a.tasks.find((x) => x.id === a.selected).repoPath);
  a.query = "x";
  press(a, "v");
  assert.ok(getCtl(a).marked.has(a.selected), "v marks the selected card");
  assert.equal(press(a, "escape"), true);
  assert.equal(getCtl(a).needsOnly, false);
  assert.equal(getCtl(a).thisRepo, null);
  assert.equal(a.query, "");
  assert.equal(press(a, "escape"), false, "nothing to clear: esc closes the card");
  press(a, "=");
  assert.equal(getCtl(a).density, "one");
  assert.match(a.flash.text, /1 line/);
  press(a, "g");
  press(a, "r");
  assert.equal(getCtl(a).group, "repo");
  press(a, "g");
  press(a, "a");
  assert.equal(getCtl(a).group, "age");
  press(a, "g");
  press(a, "s");
  assert.equal(getCtl(a).group, "stage");
  press(a, "g");
  press(a, "x");
  assert.match(a.flash.text, /not a key/);
  assert.equal(getCtl(a).prefix, null);
  // zc folds, zo unfolds, zz folds the others.
  const f = pane();
  boardPage(f, t);
  getCtl(f).focus = "Build";
  press(f, "z");
  press(f, "c");
  assert.ok(getCtl(f).folded.has("Build"));
  press(f, "z");
  press(f, "o");
  assert.ok(!getCtl(f).folded.has("Build"));
  press(f, "z");
  press(f, "z");
  assert.equal(getCtl(f).foldAll, true);
  assert.equal(boardPage(f, t) != null, true);
  assert.deepEqual(f.order, f.cols.Build, "only the focused column is walked");
});

test("marks: V marks the column and a, X, d, w, Z ask first with the tickets that can take it", () => {
  const a = pane();
  boardPage(a, t);
  getCtl(a).focus = "Build";
  press(a, "V");
  assert.deepEqual([...getCtl(a).marked].sort(), ["b1", "b2", "e1"]);
  press(a, "V");
  assert.equal(getCtl(a).marked.size, 0);
  getCtl(a).marked = new Set(TASKS.map((x) => x.id));
  press(a, "X");
  const abort = a.dialogs.at(-1);
  assert.equal(abort.kind, "bulk");
  assert.equal(abort.action, "abort");
  assert.deepEqual(abort.items.map((x) => x.id).sort(), ["b1", "b2", "z1"]);
  assert.ok(abort.skipped > 0);
  press(a, "a");
  assert.equal(a.dialogs.at(-1).action, "approve");
  press(a, "d");
  assert.equal(a.dialogs.at(-1).action, "delete");
  press(a, "w");
  assert.deepEqual(a.dialogs.at(-1).items.map((x) => x.id), ["d1"]);
  press(a, "Z");
  assert.equal(a.dialogs.at(-1).action, "archive");
  // Nothing that can take it: it says so and asks nothing.
  const none = pane();
  boardPage(none, t);
  getCtl(none).marked = new Set(["d1"]);
  const n = none.dialogs.length;
  press(none, "X");
  assert.equal(none.dialogs.length, n);
  assert.match(none.flash.text, /cannot take/);
  // Without marks a, enter run the card's main action; X acts on the selected card.
  const solo = pane({ selected: "b1" });
  boardPage(solo, t);
  assert.equal(press(solo, "a"), false, "a falls through to the app's approve");
  press(solo, "enter");
  assert.equal(solo.primed, true);
  press(solo, "X");
  assert.deepEqual(solo.dialogs.at(-1).items.map((x) => x.id), ["b1"]);
});

test("the dialogs draw: keys sheet, palette, bulk (each action), close PR", () => {
  const dlg = (d, init) => {
    const a = { d, error: null, sending: false, handle: {}, machine: {}, send() {}, fail() {} };
    init?.(a);
    return renderDialog(a, t);
  };
  const keys = texts(dlg({ kind: "keys", page: "board" })).join("|");
  assert.match(keys, /MARKS AND BULK/);
  assert.match(keys, /fold \/ unfold the focused column/);
  assert.match(texts(dlg({ kind: "keys", page: "prs" })).join("|"), /close the PR, unmerged/);
  const palette = texts(dlg({ kind: "palette" }, (a) => DIALOGS.palette.init(a, cx))).join("|");
  assert.match(palette, /:group/);
  assert.match(palette, /:slots/);
  for (const action of ["approve", "abort", "delete", "worktree", "archive"]) {
    const items = bulkTargets(TASKS, TASKS.map((x) => x.id), action, now);
    const words = texts(dlg({ kind: "bulk", action, items, skipped: 2, question: bulkQuestion(action, items.length) })).join("|");
    assert.match(words, new RegExp(items.length ? bulkQuestion(action, items.length).slice(0, 12) : "."));
    if (action === "archive") assert.match(words, /Duplicate of another ticket/);
  }
  assert.match(texts(dlg({ kind: "close_pr", repo: "o/r", number: 4, subtitle: "Fix it" })).join("|"), /o\/r#4 closes without merging/);
});

test("the palette dialog: typing narrows, arrows pick, tab completes, enter hands the line back", () => {
  const a = { d: { kind: "palette" }, handle: {}, machine: {} };
  DIALOGS.palette.init(a, cx);
  const total = texts(renderDialog(a, t)).filter((w) => w.startsWith(":")).length;
  assert.ok(total >= 10);
  a.line = "gr";
  a.base = null;
  assert.equal(texts(renderDialog(a, t)).filter((w) => w.startsWith(":")).length, 1);
  a.line = "";
  assert.ok(DIALOGS.palette.key(a, { key: "down", modifiers: {} }, cx));
  assert.equal(a.pick, 0);
  assert.ok(DIALOGS.palette.key(a, { key: "up", modifiers: {} }, cx));
  assert.equal(a.pick, null);
  assert.equal(DIALOGS.palette.key(a, { key: "x", modifiers: {} }, cx), false);
});

// ---- the PR page ----

const pr = (n, over = {}) => ({
  repo: "o/shop", number: n, title: `PR ${n}`, url: `https://github.com/o/shop/pull/${n}`, author: "sam", mine: false, isDraft: false, headRef: "feat", baseRef: "main",
  split: "review_requested", localPath: "/w/shop", updatedAt: iso(n), unresolvedThreads: 2,
  checks: { state: "failure", passed: 1, total: 3, failed: [{ name: "lint", state: "FAILURE", url: "https://ci/1" }], all: [{ name: "lint", state: "FAILURE", url: "https://ci/1" }, { name: "build", state: "SUCCESS", url: "https://ci/2" }, { name: "docs", state: "SKIPPED", url: null }] },
  ...over,
});

test("the PR page opens a row to every check by name, with its state and the threads", () => {
  const snap = { prs: [pr(1), pr(2, { task: { id: "t9" }, split: "mine", mine: true })], polledAt: iso(1), error: null };
  const a = pane({ page: "prs", prs: { inbox: snap, all: snap }, prOpen: new Set(["o/shop#1"]) });
  const words = texts(prsPage(a, t)).join("|");
  for (const w of ["lint", "build", "docs", "failure", "success", "feat → main", "2 unresolved threads", "Close…", "task running"]) assert.ok(words.includes(w), w);
  assert.ok(!texts(prsPage(pane({ page: "prs", prs: { inbox: snap, all: snap } }), t)).includes("build"), "closed rows hide the checks");
  assert.equal(a.prRows.length, 2);
  assert.deepEqual(a.prSplitIds, [null, "review_requested", "mine"]);
});

test("PR keys: j/k, splits, actions with their refusals, close, enter, filters", () => {
  const snap = { prs: [pr(1), pr(2, { task: { id: "t9" }, split: "mine", mine: true }), pr(3, { localPath: null })], polledAt: iso(1), error: null };
  const a = pane({ page: "prs", prs: { inbox: snap, all: snap } });
  prsPage(a, t);
  const k = (key, extra = {}) => prsKey(a, { key, modifiers: {}, ...extra }, cx);
  const first = a.prSel;
  k("j");
  assert.notEqual(a.prSel, first);
  k("k");
  assert.equal(a.prSel, first);
  // review on the first row (newest = number 1) goes to the machine.
  assert.equal(a.prSel, "o/shop#1");
  k("v");
  assert.deepEqual(a.acted, [1, "review"]);
  k("c");
  assert.deepEqual(a.acted, [1, "ci_fix"]);
  k("t");
  assert.match(a.flash.text, /threads: /, "an off key says why");
  k("m");
  assert.match(a.flash.text, /merge: it is not ready/);
  k("X");
  assert.deepEqual(a.dialogs.at(-1), { kind: "close_pr", repo: "o/shop", number: 1, subtitle: "PR 1" });
  k("o");
  assert.equal(a.opened, "https://github.com/o/shop/pull/1");
  k("enter");
  assert.equal(a.opened, "https://github.com/o/shop/pull/1", "no task: opens the PR");
  k("j");
  k("enter");
  assert.deepEqual(a.acted, [2, "open_task"], "a PR with a task jumps to it");
  k("j");
  k("C");
  assert.deepEqual(a.acted, [3, "clone"]);
  k("space");
  assert.ok(a.prOpen.has("o/shop#3"));
  k("space");
  assert.ok(!a.prOpen.has("o/shop#3"));
  k("l");
  assert.equal(a.prSplit, "review_requested");
  k("h");
  assert.equal(a.prSplit, null);
  k("3");
  assert.equal(a.prSplit, "ci_failed");
  k("7");
  assert.equal(a.prList, "all");
  a.prRepo = "o/shop";
  k("F");
  assert.equal(a.prRepo, null);
  assert.equal(k("zz"), false);
  k("escape");
  assert.equal(a.page, "board");
  assert.equal(k("?"), false, "the sheet is the app's key");
});
