import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actionsFor, applyEvent, cardId, cardLine, chips, columns, filterPrs, filterTasks, gateQuestion, look,
  prActions, prStatus, projectOf, projects, summary, viewCounts,
} from "../luna/model.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const task = (over = {}) => ({
  id: "30f4574d-9638", title: "Divide our Luna", state: "draft", column: "Intake", route: "feature",
  repoPath: "/Users/me/luna-tui", waitingOnYou: false, running: false, queued: false,
  updatedAt: "2026-11-12T11:59:00Z", seq: 1, criteria: [], ...over,
});

test("a card looks like the Rust board's: escalated, waiting on you, working, stale", () => {
  assert.equal(look(task({ state: "escalated" }), NOW), "escalated");
  assert.equal(look(task({ state: "awaiting_approval", waitingOnYou: true }), NOW), "needs_you");
  assert.equal(look(task({ state: "implementing", running: true }), NOW), "working");
  assert.equal(look(task({ state: "implementing", running: true, updatedAt: "2026-11-12T11:00:00Z" }), NOW), "stale");
  assert.equal(look(task({ state: "closed" }), NOW), "done");
});

test("the gate question follows the gate's outcome and the ship gate's kind", () => {
  assert.equal(gateQuestion(task({ state: "awaiting_approval" })), "Approve the plan?");
  assert.equal(gateQuestion(task({ state: "awaiting_approval", gate: { requested: { outcome: "split" } } })), "Approve the split?");
  assert.equal(gateQuestion(task({ state: "awaiting_answers", gate: { requested: { questions: ["a", "b"] } } })), "Answer 2 questions");
  assert.equal(gateQuestion(task({ state: "awaiting_ship", waitingOnYou: true, gate: { requested: { gate: "ship_approval" } } })), "Safe to release now?");
  assert.equal(gateQuestion(task({ state: "awaiting_ship", waitingOnYou: true, route: "review" })), "Post the review?");
  assert.equal(gateQuestion(task({ state: "awaiting_ship", waitingOnYou: false })), null);
});

test("the card line says why it escalated in words, never the enum", () => {
  assert.deepEqual(cardLine(task({ state: "escalated", reason: "env_broken" }), NOW), { text: "Escalated: the environment is broken", tone: "blocked" });
  assert.deepEqual(cardLine(task({ state: "implementing", running: true, spentUsd: 1.234 }), NOW), { text: "Building · $1.23", tone: "working" });
});

test("a PR task's id is its number, a Jira-linked task's its key", () => {
  assert.equal(cardId(task({ title: "PR #2292: fix(cycles): x" })), "#2292");
  assert.equal(cardId(task({ jira: { key: "DISC-12" } })), "DISC-12");
  assert.equal(cardId(task()), "30f457");
});

test("the project is the checkout's folder name", () => {
  assert.equal(projectOf(task({ repoPath: "/Users/me/work/Discover/" })), "Discover");
  assert.equal(projectOf(task({ repoPath: null })), "No repository");
});

test("chips: a red P0, the route of a PR task, failing tests in red", () => {
  const got = chips(task({ route: "review", classification: { priority: "P0" }, tests: { passed: 3, total: 5 } }));
  assert.deepEqual(got.map((c) => c.text), ["P0", "Review", "3/5 tests"]);
  assert.equal(got[2].tone, "error");
});

test("columns put the cards that need you first", () => {
  const a = task({ id: "a", column: "Build", state: "implementing", running: true });
  const b = task({ id: "b", column: "Build", state: "escalated" });
  const c = task({ id: "c", column: "Build", state: "implementing", updatedAt: "2026-11-12T11:59:30Z" });
  assert.deepEqual(columns([c, a, b], NOW).Build.map((t) => t.id), ["b", "a", "c"]);
});

test("views and search filter, counts leave ended tasks out", () => {
  const tasks = [
    task({ id: "a", state: "awaiting_approval", waitingOnYou: true, column: "Plan" }),
    task({ id: "b", state: "implementing", running: true, column: "Build" }),
    task({ id: "c", state: "closed", column: "Done" }),
    task({ id: "d", title: "PR #9: a", route: "review", state: "reviewing", running: true, column: "Verify" }),
  ];
  assert.deepEqual(filterTasks(tasks, { view: "you" }, NOW).map((t) => t.id), ["a"]);
  assert.deepEqual(filterTasks(tasks, { query: "#9" }, NOW).map((t) => t.id), ["d"]);
  assert.deepEqual(viewCounts(tasks, NOW), { all: 3, you: 1, working: 2, prs: 1 });
  assert.equal(summary(tasks, NOW), "3 open · 1 waiting on you · 2 agents working");
  assert.deepEqual(projects(tasks, NOW), [{ name: "luna-tui", open: 3, running: 2, waiting: 1 }]);
});

test("actions: a plan gate approves, sends back and rejects; a split that failed keeps it whole", () => {
  const ids = (t) => actionsFor(t, NOW).map((a) => a.id);
  assert.deepEqual(ids(task({ state: "awaiting_approval", waitingOnYou: true, column: "Plan" })), ["approve", "send_back", "reject", "archive"]);
  assert.deepEqual(ids(task({ state: "awaiting_approval", waitingOnYou: true, gate: { requested: { outcome: "split_failed" } } })), ["keep_whole", "send_back", "reject", "archive"]);
  assert.deepEqual(ids(task({ state: "awaiting_approval", waitingOnYou: true, gate: { requested: { outcome: "archive" } } })), ["approve", "send_back", "archive"]);
  assert.deepEqual(ids(task()), ["start", "delete"]);
  assert.deepEqual(ids(task({ state: "implementing", running: true })), ["abort", "archive"]);
  assert.deepEqual(ids(task({ state: "escalated" })), ["approve", "send_back", "archive"]);
  assert.deepEqual(ids(task({ state: "closed" })), ["delete"]);
});

test("PRs: status reads conflicts before checks, actions follow the clone and the machine's refusals", () => {
  const pr = { repo: "o/r", number: 1, title: "t", author: "x", mine: false, isDraft: false, mergeState: "CLEAN", mergeable: "MERGEABLE", checks: { state: "failure", passed: 1, total: 2, failed: [{}] }, reviewDecision: null, split: "ci_failed", localPath: "/w/r", task: null, fromFork: true, unresolvedThreads: 0 };
  assert.deepEqual(prStatus(pr), { text: "1 check failing", tone: "error" });
  assert.deepEqual(prStatus({ ...pr, mergeState: "DIRTY" }), { text: "Conflicts", tone: "error" });
  assert.deepEqual(prActions(pr).map((a) => a.id), ["review", "browser"]);
  assert.deepEqual(prActions({ ...pr, localPath: null }).map((a) => a.id), ["clone", "browser"]);
  assert.deepEqual(prActions({ ...pr, task: { id: "t" } }).map((a) => a.id), ["open_task"]);
  assert.deepEqual(filterPrs([pr, { ...pr, repo: "o/s", number: 2 }], { repo: "o/s" }).map((p) => p.number), [2]);
});

test("the stream updates a task, ignores an older copy, adds a new one and drops a deleted one", () => {
  const list = [task({ id: "a", seq: 5 })];
  const updated = (t) => ({ type: "task.updated", task: t, seq: t.seq });
  assert.equal(applyEvent(list, "task.updated", updated(task({ id: "a", seq: 4, title: "old" })))[0].title, "Divide our Luna");
  assert.equal(applyEvent(list, "task.updated", updated(task({ id: "a", seq: 6, title: "new" })))[0].title, "new");
  assert.equal(applyEvent(list, "task.updated", updated(task({ id: "b" }))).length, 2);
  assert.equal(applyEvent(list, "task.deleted", { type: "task.deleted", id: "a", seq: 7 }).length, 0);
});
