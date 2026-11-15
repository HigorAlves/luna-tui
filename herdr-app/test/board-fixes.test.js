// Lane C's fixes: bulk approve over the committing gates only, the PR page's close guard, split
// order, badge and notices, clone-then-dispatch, the card's markers, the key prefix's expiry, Enter
// against `a`, the TUI's ticket keys and the palette's commands. Host stand-in, no machine.
import assert from "node:assert/strict";
import { test } from "node:test";

import { calls, theme } from "./host/stub.js";
import "../luna/features.js";
import { boardPage } from "../luna/board.js";
import { boardKey } from "../luna/boardkeys.js";
import { runBulk } from "../luna/bulk.js";
import {
  PR_SPLIT_ORDER, approveManyQuestion, approveResult, bulkApprovePlan, bulkTargets, cardMarks, committingKind, getCtl, heldReason, isHeld, livePrefix, orderCards, orderPrs,
  overdueCount, prCloseRefusal, prNeedsCount, prNotices, spendP90,
} from "../luna/controls.js";
import { DIALOGS, COMMANDS } from "../luna/registry.js";
import { renderDialog } from "../luna/dialogs.js";
import { dispatchPr, notePrs, prBadge, prsKey, prsPage } from "../luna/prs.js";

const t = theme();
const now = Date.now();
const iso = (m) => new Date(now - m * 60000).toISOString();
const task = (id, over = {}) => ({
  id, title: `Task ${id}`, state: "implementing", column: "Build", route: "feature", repoPath: "/w/shop", waitingOnYou: false, running: false, queued: false,
  createdAt: iso(100), updatedAt: iso(1), seq: 1, criteria: [], ...over,
});
const gate = (id, state, requested, over = {}) => task(id, { state, column: "Plan", waitingOnYou: true, gate: { requested }, ...over });

const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};
const cx = { notify() {}, stop_propagation() {}, spawn(fn) { this.spawned = fn(cx); }, timer: { after(_ms, fn) { fn?.(cx); } } };

function pane(over = {}) {
  return {
    machine: { base: "http://x" }, tasks: [], loaded: true, link: "live", page: "board", view: "all", project: null, query: "", selected: null, details: {}, doneOpen: false,
    prs: { inbox: null, all: null }, prList: "inbox", prSplit: null, prRepo: null, busy: new Set(), flash: null, width: 1400, boardWidth: 1100, search: { set_value() {} },
    select(id) { this.selected = id; }, act(task, id) { this.acted = [task.id, id]; }, go(p) { this.page = p; }, reload() { this.reloaded = true; }, newTask() {},
    say(text, tone) { this.flash = { text, tone }; }, primary() { this.primed = true; }, dialog(spec) { this.dialogs.push(spec); }, dialogs: [],
    showPrList(id) { this.prList = id; }, pickRepo() {}, prAct(pr, id) { (this.prActed ??= []).push([pr.number, id, pr.localPath]); }, refreshPrs() {}, openUrl() {},
    state(k) { return ((this._s ??= {})[k] ??= {}); }, handBack(kind, value) { (this.backs ??= []).push([kind, value]); },
    ...over,
  };
}
const press = (a, key, extra = {}) => boardKey(a, { key, modifiers: {}, ...extra }, cx);

// ---- C1: bulk approve ----

test("committing kinds are plan, split, ship and release; replies, archives, setups, tests, escalations and review posts are not", () => {
  assert.equal(committingKind(gate("a", "awaiting_approval", {})), "plan");
  assert.equal(committingKind(gate("a", "awaiting_approval", { outcome: "split" })), "split");
  for (const outcome of ["conversation", "archive", "split_failed"]) assert.equal(committingKind(gate("a", "awaiting_approval", { outcome })), null, outcome);
  assert.equal(committingKind(gate("a", "awaiting_ship", {})), "ship");
  assert.equal(committingKind(gate("a", "awaiting_ship", { gate: "ship_approval" })), "release");
  assert.equal(committingKind(gate("a", "awaiting_ship", {}, { route: "review" })), null, "a review is posted by hand");
  assert.equal(committingKind(gate("a", "awaiting_setup", {})), null);
  assert.equal(committingKind(gate("a", "awaiting_test_check", {})), null);
  assert.equal(committingKind(gate("a", "reviewing_memory", {})), null);
  assert.equal(committingKind(task("a", { state: "escalated", waitingOnYou: true })), null);
  assert.equal(committingKind(task("a", { state: "awaiting_approval" })), null, "nothing waits on you");
});

test("bulk plan: start and resume now, committing gates ask once, the rest is counted and left alone", () => {
  const tasks = [
    task("d1", { state: "draft" }), task("d2", { state: "draft", repoPath: null }), task("h1", { state: "draft", dependsOn: ["x1"], startWhenReady: true }),
    task("z1", { state: "paused_rate_limit" }), gate("p1", "awaiting_approval", {}), gate("s1", "awaiting_ship", {}), gate("r1", "awaiting_ship", { gate: "ship_approval" }),
    gate("c1", "awaiting_approval", { outcome: "conversation" }), gate("t1", "awaiting_test_check", {}),
  ];
  const plan = bulkApprovePlan(tasks, [...tasks.map((x) => x.id), "ghost"]);
  assert.deepEqual(plan.immediate.map((i) => `${i.id}:${i.step}`), ["d1:start", "z1:resume"]);
  assert.deepEqual(plan.committing.map((i) => `${i.id}:${i.kind}`), ["p1:plan", "s1:ship", "r1:release"]);
  assert.equal(plan.skipped, 4, "no repo, held, reply, tests");
  assert.equal(plan.missing, 1);
  assert.ok(plan.committing.every((i) => i.expect.includes("awaiting")), "each carries the gate it was asked about");
  assert.equal(approveManyQuestion(plan.committing), "Approve 3 cards? 1 plan · 1 ship · 1 release");
  assert.equal(approveManyQuestion([{ kind: "plan" }, { kind: "plan" }]), "Approve 2 cards? 2 plans");
  assert.equal(approveResult(2, 3), "approved 2 of 3");
  assert.equal(approveResult(1, 3, 2), "approved 1 · skipped 2 that moved on");
  assert.equal(approveResult(1, 4, 2, 1), "approved 1 · skipped 2 that moved on · 1 failed");
  assert.deepEqual(bulkTargets(tasks, tasks.map((x) => x.id), "approve").map((i) => i.id), ["p1", "s1", "r1"]);
});

test("a marks: starts run now, one dialog names the committing kinds, the question no longer says nothing is posted", async () => {
  const tasks = [task("d1", { state: "draft" }), gate("p1", "awaiting_approval", {}), gate("s1", "awaiting_ship", {})];
  const started = [];
  const a = pane({ tasks, machine: { start: async (id) => started.push(id), resume: async () => null } });
  boardPage(a, t);
  getCtl(a).marked = new Set(["d1", "p1", "s1"]);
  assert.equal(press(a, "a"), true);
  await cx.spawned;
  assert.deepEqual(started, ["d1"]);
  assert.match(a.flash.text, /advanced 1 of 1/);
  const d = a.dialogs.at(-1);
  assert.equal(d.kind, "bulk");
  assert.equal(d.question, "Approve 2 cards? 1 plan · 1 ship");
  assert.deepEqual([...getCtl(a).marked], ["p1", "s1"], "the started card is no longer marked");
  const words = texts(renderDialog({ d, error: null, handle: {}, machine: {}, send() {}, fail() {} }, t)).join("|");
  assert.match(words, /Approve 2 cards/);
  assert.ok(!/nothing is posted/i.test(words));
  // Only starts and nothing committing: no dialog, and the marks clear.
  const b = pane({ tasks, machine: { start: async () => null } });
  boardPage(b, t);
  getCtl(b).marked = new Set(["d1"]);
  press(b, "a");
  assert.equal(b.dialogs.length, 0);
  assert.equal(getCtl(b).marked.size, 0);
});

test("runBulk approves through decideIfStill with the expect from the dialog; a card that moved is skipped, counted and named", async () => {
  const seen = [];
  const machine = {
    async decideIfStill(id, expect, decision) {
      seen.push([id, expect, decision]);
      if (id === "m1") throw Object.assign(new Error("It moved on: shipping"), { code: "moved" });
      if (id === "f1") throw new Error("boom");
    },
  };
  const a = pane({ machine });
  const items = ["p1", "m1", "f1", "p2"].map((id) => ({ id, step: "approve", kind: "plan", expect: `gate-${id}`, title: `shop: ${id}` }));
  await runBulk(a, { action: "approve", items });
  assert.deepEqual(seen.map((s) => s.slice(0, 2)), [["p1", "gate-p1"], ["m1", "gate-m1"], ["f1", "gate-f1"], ["p2", "gate-p2"]]);
  const [kind, value] = a.backs.at(-1);
  assert.equal(kind, "bulk");
  assert.deepEqual(value.done, ["p1", "p2"]);
  assert.match(value.text, /approved 2 · skipped 1 that moved on · 1 failed \(shop: m1\): boom/);
  assert.equal(value.moved, 1);
});

// ---- C2: close ----

test("Close is for your own PRs with no task running; else a reason", () => {
  assert.equal(prCloseRefusal({ mine: true }), null);
  assert.equal(prCloseRefusal({ mine: false }), "closing is for your own PRs");
  assert.equal(prCloseRefusal({ mine: true, task: { id: "t" } }), "a task is already running for it");
  const pr = (n, over) => ({ repo: "o/s", number: n, title: `PR ${n}`, url: "u", author: "x", mine: true, split: "mine", localPath: "/w", updatedAt: iso(n), checks: { state: "success", all: [] }, ...over });
  const snap = { prs: [pr(1), pr(2, { task: { id: "t" } }), pr(3, { mine: false })], polledAt: iso(1) };
  const a = pane({ page: "prs", prs: { inbox: snap, all: snap } });
  const words = texts(prsPage(a, t)).join("|");
  assert.match(words, /Close…/);
  const k = (key) => prsKey(a, { key, modifiers: {} }, cx);
  a.prSel = "o/s#1";
  k("X");
  assert.deepEqual(a.dialogs.at(-1), { kind: "close_pr", repo: "o/s", number: 1, subtitle: "PR 1" });
  a.prSel = "o/s#2";
  k("X");
  assert.match(a.flash.text, /a task is already running for it/);
  a.prSel = "o/s#3";
  k("X");
  assert.match(a.flash.text, /closing is for your own PRs/);
  assert.equal(a.dialogs.length, 1);
});

// ---- C3: splits ----

test("PR splits follow the TUI's order and digits; a split lists oldest first, All repos newest first", () => {
  assert.deepEqual(PR_SPLIT_ORDER.map(([id]) => id), ["review_requested", "ready_to_merge", "ci_failed", "ci_running", "changes_requested", "mine"]);
  const prs = [
    { repo: "o/a", number: 1, title: "x", split: "mine", updatedAt: iso(10) },
    { repo: "o/a", number: 2, title: "x", split: "mine", updatedAt: iso(30) },
    { repo: "o/b", number: 3, title: "x", split: "mine", updatedAt: iso(20) },
  ];
  assert.deepEqual(orderPrs(prs, { split: "mine" }).map((p) => p.number), [2, 3, 1], "oldest first");
  assert.deepEqual(orderPrs(prs, { split: null }).map((p) => p.number), [1, 3, 2], "all repos: newest first");
  assert.deepEqual(orderPrs(prs, { split: "mine", repo: "o/a" }).map((p) => p.number), [2, 1]);
  const snap = { prs: [{ repo: "o/a", number: 1, title: "t", author: "x", mine: false, split: "ci_running", localPath: "/w", updatedAt: iso(1), checks: { all: [] } }], polledAt: iso(1) };
  const a = pane({ page: "prs", prs: { inbox: snap, all: snap } });
  prsPage(a, t);
  const k = (key) => prsKey(a, { key, modifiers: {} }, cx);
  k("2");
  assert.equal(a.prSplit, "ready_to_merge");
  k("5");
  assert.equal(a.prSplit, "changes_requested");
  k("4");
  assert.equal(a.prSplit, "ci_running");
});

test("the PR badge counts every split that needs you; a split that gains a PR notifies once, across polls", () => {
  const p = (n, split) => ({ repo: "o/a", number: n, title: `T${n}`, split });
  assert.equal(prNeedsCount([p(1, "review_requested"), p(2, "ready_to_merge"), p(3, "ci_failed"), p(4, "changes_requested"), p(5, "ci_running"), p(6, "mine")]), 4);
  const seen = new Map();
  assert.deepEqual(prNotices([p(1, "mine")], seen), []);
  assert.deepEqual(prNotices([p(1, "ci_failed")], seen), [{ title: "CI failed", body: "o/a#1 T1" }]);
  assert.deepEqual(prNotices([p(1, "ci_failed")], seen), [], "staying put is not news");
  assert.deepEqual(prNotices([p(1, "ci_running")], seen), [], "leaving is not news");
  assert.equal(prNotices([p(1, "ci_failed")], seen).length, 1, "back again is");
  assert.equal(prNotices([p(2, "review_requested")], seen)[0].title, "Review requested");
  // Through the page: the first snapshot is the baseline, the next one notifies.
  const a = pane({ prs: { inbox: { prs: [p(1, "review_requested")] }, all: null } });
  const before = calls.filter((c) => c[0] === "notify").length;
  assert.deepEqual(prBadge(a), { n: 1, tone: null });
  assert.equal(calls.filter((c) => c[0] === "notify").length, before, "baseline: no notice");
  a.prs = { inbox: { prs: [p(1, "review_requested"), p(2, "ready_to_merge"), p(3, "ci_running")] }, all: null };
  assert.equal(prBadge(a).n, 2);
  prBadge(a);
  notePrs(a, a.prs.inbox);
  const notes = calls.filter((c) => c[0] === "notify").slice(before);
  assert.equal(notes.length, 1, "one notice for the one PR that gained a split, however often it is looked at");
  assert.equal(notes[0][1].title, "Ready to merge");
});

// ---- C4: clone then dispatch ----

test("a dispatch on an uncloned PR asks for the folder, clones, waits for the snapshot, then runs the action", async () => {
  const pick = await import("./host/stub.js");
  const pr = { repo: "o/shop", number: 7, title: "x", mine: false, split: "review_requested", localPath: null, updatedAt: iso(1), checks: { all: [] } };
  const cloned = [];
  const polls = [{ prs: [pr] }, { prs: [{ ...pr, localPath: "/dest/shop" }] }];
  const a = pane({
    prs: { inbox: { prs: [pr], clones: [] }, all: null },
    machine: { clone: async (repo, dest) => cloned.push([repo, dest]), prs: async () => polls.shift() ?? polls[0] },
  });
  const c2 = { ...cx, notify() {}, timer: { after(_ms, fn) { fn(); } } };
  const run = { spawn: (fn) => { run.p = fn(c2); } };
  // pickFolder is the stand-in's: it answers null, so nothing is cloned.
  dispatchPr(a, pr, "review", run);
  await run.p;
  assert.deepEqual(cloned, [], "no folder picked: nothing happens");
  assert.equal(a.prActed, undefined);
  // A PR already cloned, or an action that needs no checkout, goes straight through.
  dispatchPr(a, { ...pr, localPath: "/x" }, "review", run);
  dispatchPr(a, pr, "merge", run);
  assert.deepEqual(a.prActed.map((x) => x[1]), ["review", "merge"]);
  void pick;
});

// ---- C5, C6: markers and stage order ----

test("card markers: overdue, warn, retries, worktree, part, prefix, spend above the p90, no repo", () => {
  const spend = [0.1, 0.2, 0.3, 0.4, 5].map((n, i) => task(`s${i}`, { spentUsd: n }));
  const p90 = spendP90(spend);
  assert.ok(p90 > 0.4 && p90 < 5);
  assert.equal(spendP90([task("a", { spentUsd: 1 }), task("b", { spentUsd: 2 })]), null, "three to compare");
  const m = cardMarks(
    task("x", { sla: { gate: { overdue: true } }, retries: { total: 3 }, worktreePath: "/wt", splitPart: { n: 2, of: 3 }, source: { kind: "github", number: 42 }, spentUsd: 5 }),
    p90,
  );
  assert.deepEqual([m.overdue, m.retries, m.worktree, m.part, m.prefix, m.spendy], [true, 3, true, "part 2/3", "#42", true]);
  assert.equal(cardMarks(task("y", { sla: { stage: { warn: true, overdue: false } } })).warn, true);
  assert.equal(cardMarks(task("y", { sla: { stage: { warn: true, overdue: true } } })).warn, false);
  assert.equal(cardMarks(task("y", { source: { kind: "slack" } })).prefix, "⌁");
  assert.equal(cardMarks(task("y", { source: { kind: "notch", ref: "LUNA-14" } })).prefix, "notch LUNA-14");
  assert.equal(cardMarks(task("y", { state: "draft", repoPath: null })).noRepo, true);
  assert.equal(cardMarks(task("y", { retries: { total: 1 } })).retries, 0);
  assert.equal(overdueCount([task("a", { sla: { cycle: { overdue: true } } }), task("b")]), 1);
});

test("the board draws ‼ and the header counts overdue; a gate past its SLA leads its column in every order", () => {
  const tasks = [
    gate("p1", "awaiting_approval", {}, { sla: { gate: { overdue: true } }, createdAt: iso(10), updatedAt: iso(1) }),
    gate("p2", "awaiting_approval", {}, { createdAt: iso(500), updatedAt: iso(1) }),
    task("b1", { sla: { stage: { overdue: true } } }),
  ];
  const page = texts(boardPage(pane({ tasks }), t)).join("|");
  assert.match(page, /‼ 2 overdue/);
  assert.ok(page.includes("‼"));
  const plan = [tasks[1], tasks[0]];
  for (const g of ["stage", "repo", "age"]) assert.equal(orderCards(plan, g, "Plan", now)[0].id, "p1", g);
});

test("a held draft shows why and offers no Start; a does not start it", () => {
  const held = task("h1", { state: "draft", dependsOn: ["abcdef12345"], startWhenReady: true, splitPart: { n: 2, of: 3 } });
  assert.equal(isHeld(held), true);
  assert.equal(heldReason(held), "waits for abcdef12 (part 2 of 3)");
  assert.equal(heldReason(held, { events: [{ kind: "card.held", payload: { text: "waits for part 1 to merge" } }] }), "waits for part 1 to merge");
  assert.equal(heldReason(held, { events: [{ kind: "card.held", payload: { text: "x" } }, { kind: "card.released" }] }), null);
  assert.equal(heldReason(task("d", { state: "draft" })), null);
  const a = pane({ tasks: [held], selected: "h1" });
  const words = texts(boardPage(a, t)).join("|");
  assert.match(words, /Held: waits for abcdef12/);
  assert.ok(!words.includes("Start"));
  press(a, "a");
  assert.match(a.flash.text, /held: waits for/);
  assert.equal(a.primed, undefined);
});

// ---- C7: prefix ----

test("g, z and x wait about a second for their second key, and not across a page change", () => {
  const a = pane({ tasks: [task("b1")] });
  boardPage(a, t);
  press(a, "g");
  const ctl = getCtl(a);
  assert.equal(ctl.prefix.c, "g");
  ctl.prefix.at = Date.now() - 1500;
  // A late `s` is its own key, not gs: nothing orders by stage.
  ctl.group = "age";
  press(a, "s");
  assert.equal(ctl.group, "age");
  assert.equal(ctl.prefix, null);
  press(a, "g");
  press(a, "s");
  assert.equal(ctl.group, "stage", "in time it is gs");
  press(a, "z");
  a.page = "prs";
  assert.equal(livePrefix(ctl, a.page), null, "a page change drops it");
  assert.equal(ctl.prefix, null);
  const live = { prefix: { c: "g", at: Date.now(), page: "board" } };
  assert.ok(livePrefix(live, "board"));
});

// ---- C8: Enter and a, the TUI's ticket keys ----

test("enter opens the ticket, a runs its main action; with nothing selected they say so", () => {
  const a = pane({ tasks: [task("b1"), task("b2")], selected: "b1" });
  boardPage(a, t);
  assert.equal(press(a, "enter"), true);
  assert.equal(a.primed, undefined);
  assert.equal(a.selected, "b1");
  press(a, "a");
  assert.equal(a.primed, true);
  const none = pane({ tasks: [], selected: null });
  assert.equal(press(none, "a"), true);
  assert.match(none.flash.text, /no ticket selected/);
});

test("the TUI's ticket keys run the ACTIONS ids with the TUI's refusals", () => {
  const pl = gate("p1", "awaiting_approval", {}, { record: { x: 1 }, running: false });
  const rel = gate("r1", "awaiting_ship", { gate: "ship_approval" });
  const esc = task("e1", { state: "escalated", waitingOnYou: true, running: false });
  const mem = gate("m1", "reviewing_memory", {});
  const ans = gate("q1", "awaiting_answers", {});
  const run = task("w1", { running: true, jira: { key: "P-1" }, mergedInto: "zz" });
  const tasks = [pl, rel, esc, mem, ans, run];
  const key = (id, k, over = {}) => {
    const a = pane({ tasks, selected: id, ...over });
    boardPage(a, t);
    press(a, k);
    return a;
  };
  assert.deepEqual(key("p1", "T").acted, ["p1", "edit_record"]);
  assert.deepEqual(key("q1", "p").acted, ["q1", "post_questions"]);
  assert.match(key("p1", "p").flash.text, /no questions are waiting/);
  assert.deepEqual(key("m1", "A").acted, ["m1", "memory_skip_rules"]);
  assert.match(key("p1", "A").flash.text, /no memory review/);
  assert.deepEqual(key("p1", "N").acted, ["p1", "reject"]);
  assert.deepEqual(key("r1", "N").acted, ["r1", "reject_release"]);
  assert.match(key("w1", "N").flash.text, /only the plan gate and the release question reject/);
  assert.deepEqual(key("p1", "r").acted, ["p1", "send_back"]);
  assert.match(key("r1", "r").flash.text, /only a setup, a plan or tests/);
  assert.deepEqual(key("e1", "C").acted, ["e1", "escalation_reason"]);
  assert.match(key("p1", "C").flash.text, /not escalated/);
  assert.deepEqual(key("p1", "e").acted, ["p1", "edit_ticket"]);
  assert.match(key("r1", "e").flash.text, /release question has nothing to edit/);
  assert.deepEqual(key("w1", "f").acted, ["w1", "watch"]);
  assert.deepEqual(key("w1", "J").acted, ["w1", "jira_unlink"]);
  assert.match(key("p1", "J").flash.text, /Jira is not configured/);
  assert.deepEqual(key("p1", "J", { state: () => ({ configured: true }) }).acted, ["p1", "jira_link"]);
  assert.deepEqual(key("p1", "R").acted, ["p1", "set_repo"]);
  assert.deepEqual(key("p1", "o").acted, ["p1", "open_issue"]);
  assert.deepEqual(key("p1", "O").acted, ["p1", "open_pr"]);
  assert.deepEqual(key("w1", "U").acted, ["w1", "unmerge"]);
  // u: needs the plan gate's loaded detail and a gap.
  assert.match(key("p1", "u").flash.text, /still reading this card/);
  const detail = { approvals: [{ kind: "awaiting_approval", decision: null, requested: { coverageReport: { gaps: ["C1", "C2"], untestable: ["C2"] } } }] };
  const u = key("p1", "u", { details: { p1: detail } });
  assert.deepEqual(u.dialogs.at(-1).gaps.map((g) => g.id), ["C1"], "a criterion already excused is not offered again");
  assert.equal(u.dialogs.at(-1).kind, "excuse");
  // The views.
  for (const [k, page] of Object.entries({ F: "floor", I: "inbox", D: "digest", B: "backlog", $: "economy", K: "tickets", S: "slack", P: "prs" })) assert.equal(key("p1", k).page, page, k);
  // r is send back; the board reloads on ctrl+r.
  const reload = pane({ tasks });
  assert.equal(boardKey(reload, { key: "r", modifiers: { control: true } }, cx), true);
  assert.equal(reload.reloaded, true);
  // x then S ships what waits to ship.
  const ship = pane({ tasks: [gate("s2", "awaiting_ship", {})], selected: "s2" });
  boardPage(ship, t);
  press(ship, "x");
  press(ship, "S");
  assert.deepEqual(ship.acted, ["s2", "approve"]);
});

// ---- C9: the palette ----

test("every listed palette command is registered; an unknown verb says so", async () => {
  for (const v of ["repo", "whole", "dismiss", "finding", "ticket-edit", "dedup", "dup", "undup", "context", "start", "refresh"]) assert.equal(typeof COMMANDS[v], "function", v);
  const entries = (await import("../luna/controls.js")).BOARD_COMMANDS.map((c) => c.verb);
  for (const v of ["repo", "whole", "dismiss", "finding", "ticket-edit", "dedup", "dup", "undup", "context", "jira"]) assert.ok(entries.includes(v), v);
  const a = { d: { kind: "palette" }, handle: {}, machine: {}, handBack(k, v) { this.back = [k, v]; } };
  DIALOGS.palette.init(a, cx);
  a.entries = a.entries ?? [];
  a.line = "frobnicate now";
  a.pick = null;
  DIALOGS.palette.submit(a, cx);
  assert.match(a.error, /unknown command: frobnicate/);
  assert.equal(a.back, undefined);
  a.line = "dup abc12";
  DIALOGS.palette.submit(a, cx);
  assert.deepEqual(a.back, ["command", { line: "dup abc12" }]);
});

test("palette commands act on the selected ticket with the TUI's guards", async () => {
  const calls2 = [];
  const machine = {
    patch: async (...x) => calls2.push(["patch", ...x]), post: async (...x) => calls2.push(["post", ...x]), get: async () => [], dedup: async (...x) => calls2.push(["dedup", ...x]),
    context: async (...x) => calls2.push(["context", ...x]),
  };
  const run = [];
  const mk = (over = {}) => pane({ tasks: [task("aaaa1111", { mergedInto: "zzzz" }), task("bbbb2222")], selected: "aaaa1111", machine, run(_cx, key, done, call) { run.push([key, done]); return call(); }, ...over });
  const c = { ...cx, spawn(fn) { c.p = fn(c); } };
  let a = mk({ selected: null });
  COMMANDS.dup(a, "bbbb", c);
  assert.match(a.flash.text, /no ticket selected/);
  a = mk();
  COMMANDS.dup(a, "bb", c);
  assert.match(a.flash.text, /at least 4 characters/);
  COMMANDS.dup(a, "cccc", c);
  assert.match(a.flash.text, /no ticket starts with cccc/);
  COMMANDS.dup(a, "bbbb", c);
  await Promise.resolve();
  assert.deepEqual(calls2.at(-1), ["post", "/tasks/aaaa1111/merge", { into: "bbbb2222" }]);
  COMMANDS.undup(a, "", c);
  assert.deepEqual(calls2.at(-1), ["post", "/tasks/aaaa1111/unmerge", {}]);
  COMMANDS.undup(mk({ selected: "bbbb2222" }), "", c);
  COMMANDS.finding(a, "bad title", c);
  assert.match(a.flash.text, /blocker, should_fix or nit/);
  COMMANDS.finding(a, "nit tidy up", c);
  assert.deepEqual(calls2.at(-1), ["post", "/tasks/aaaa1111/findings", { severity: "nit", title: "tidy up" }]);
  COMMANDS.dismiss(a, "f3 not a bug", c);
  assert.deepEqual(calls2.at(-1), ["post", "/tasks/aaaa1111/findings/f3/dismiss", { reason: "not a bug" }]);
  COMMANDS.dismiss(a, "", c);
  assert.match(a.flash.text, /dismiss takes a finding id/);
  COMMANDS.context(a, "repo /w/api", c);
  assert.deepEqual(calls2.at(-1), ["context", "aaaa1111", { repoPath: "/w/api" }]);
  COMMANDS.context(a, "nope x", c);
  assert.match(a.flash.text, /use :context repo\|project\|text/);
  COMMANDS.whole(a, "", c);
  assert.match(a.flash.text, /keep whole answers a plan or split gate/);
  COMMANDS.repo(a, "/w/other", c);
  assert.deepEqual(calls2.at(-1), ["patch", "/tasks/aaaa1111", { repoPath: "/w/other" }]);
  COMMANDS.repo(a, "", c);
  assert.deepEqual(a.acted, ["aaaa1111", "set_repo"]);
  COMMANDS.dedup(a, "neither", c);
  assert.match(a.flash.text, /not waiting on a duplicate question/);
  a = mk({ details: { aaaa1111: { approvals: [{ decision: null, requested: { candidates: [{ id: "u1", slot: 1 }, { id: "u2", slot: 2 }] } }] } } });
  COMMANDS.dedup(a, "duplicate 2", c);
  assert.deepEqual(calls2.at(-1), ["dedup", "aaaa1111", "duplicate", ["u2"]]);
  COMMANDS.dedup(a, "related 1,2", c);
  assert.deepEqual(calls2.at(-1), ["dedup", "aaaa1111", "related", ["u1", "u2"]]);
  COMMANDS.dedup(a, "duplicate 9", c);
  assert.match(a.flash.text, /no candidate in slot 9/);
  // ticket-edit uses the Tickets page's selection.
  const tk = mk();
  COMMANDS["ticket-edit"](tk, "hello", c);
  assert.match(tk.flash.text, /open the Tickets view/);
  tk.state("tickets").items = [{ key: "PLAT-1", drafts: [{ id: "d1", hash: "h1", status: "waiting" }] }];
  tk.state("tickets").selected = "PLAT-1";
  COMMANDS["ticket-edit"](tk, "", c);
  assert.match(tk.flash.text, /say what to post/);
  COMMANDS["ticket-edit"](tk, "my words", c);
  assert.deepEqual(calls2.at(-1).slice(0, 3), ["post", "/tickets/PLAT-1/edit", { draft: "d1", hash: "h1", text: "my words" }]);
});
