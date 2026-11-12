// Draws every page and every gate with the host stand-in (test/host), so a field the machine
// leaves out or shapes differently crashes here, not in the person's pane.
import assert from "node:assert/strict";
import { test } from "node:test";

import { theme } from "./host/stub.js";
import { boardPage, sidebar } from "../luna/board.js";
import { inspector } from "../luna/inspector.js";
import { prsPage } from "../luna/prs.js";

const t = theme();
const now = new Date().toISOString();
const task = (over = {}) => ({
  id: `id-${Math.random().toString(16).slice(2)}`, title: "A task", state: "draft", column: "Intake", route: "feature",
  repoPath: "/w/shop", waitingOnYou: false, running: false, queued: false, updatedAt: now, seq: 1, criteria: ["a", "b"], ...over,
});

const GATES = [
  task({ state: "awaiting_approval", column: "Plan", waitingOnYou: true, gate: { state: "awaiting_approval", requested: { brief: "Do **it**", risk: { level: "high", reason: "auth" }, steps: [{ description: "Add route", est_loc: 80 }], coverageReport: { gaps: [{ id: "C2" }] } } } }),
  task({ state: "awaiting_approval", column: "Plan", waitingOnYou: true, gate: { requested: { outcome: "split", split: { children: [{ title: "one" }, { title: "two" }] } } } }),
  task({ state: "awaiting_answers", column: "Triage", waitingOnYou: true, gate: { requested: { questions: ["Which DB?", { question: "Which page?" }] } } }),
  task({ state: "awaiting_test_check", column: "Plan", waitingOnYou: true, gate: { requested: { cases: [{ title: "logs in", criterion: "C1" }] } } }),
  task({ state: "awaiting_setup", column: "Intake", waitingOnYou: true, gate: { requested: { kind: "dedup", candidates: [{ id: "x", title: "Same", state: "triage", score: 0.8 }] } } }),
  task({ state: "awaiting_setup", column: "Intake", waitingOnYou: true, gate: { requested: { kind: "context", missing: ["repository"] } } }),
  task({ state: "awaiting_ship", column: "Ship", waitingOnYou: true, gate: { requested: { gate: "ship_approval", checklist: [{ id: "ci", ok: true }, { id: "review", ok: false, detail: "1 thread" }], evidence: { summary: "Works" }, prUrl: "https://github.com/o/r/pull/1" } } }),
  task({ state: "awaiting_ship", column: "Verify", route: "review", title: "PR #9: fix", waitingOnYou: true, gate: { requested: { pr_review_post: { event: "REQUEST_CHANGES", body: "Two bugs.", comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "Null here." }] } } } }),
  task({ state: "escalated", column: "Build", reason: "env_broken", gate: { requested: { summary: "Postgres is down", outputTail: "ECONNREFUSED", escalationDecision: { reason: "env_broken" } } } }),
  task({ state: "implementing", column: "Build", running: true, spentUsd: 1.2, diff: { added: 10, removed: 2 }, tests: { passed: 3, total: 5 } }),
  task({ state: "paused_rate_limit", column: "Build" }),
  task({ state: "closed", column: "Done", jira: { key: "DISC-1" }, lastRun: { stage: "shipping", outcome: "pass", summary: "Shipped" } }),
  task({ state: "archived", column: "Done", archiveReason: "duplicate" }),
];

const machine = { base: "http://127.0.0.1:4318", approver: null };

function app(over = {}) {
  return {
    machine, tasks: GATES, loaded: true, error: null, link: "live", page: "board", view: "all", project: null, query: "",
    selected: null, tab: "details", details: {}, diffs: {}, doneOpen: false, prs: { inbox: null, all: null }, prList: "inbox",
    prSplit: null, prRepo: null, prRefreshing: false, busy: new Set(), flash: { text: "Approved", tone: null }, width: 1400, boardWidth: 1100,
    search: {}, select() {}, act() {}, go() {}, reload() {}, newTask() {}, setTab() {}, openUrl() {}, showPrList() {}, pickRepo() {}, prAct() {}, refreshPrs() {},
    ...over,
  };
}

const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};

test("the board and the sidebar draw every kind of card", () => {
  const a = app();
  const page = boardPage(a, t);
  const words = texts(page).join(" | ");
  assert.match(words, /Waiting on you/);
  assert.match(words, /Escalated: the environment is broken/);
  assert.match(words, /Building · \$1\.20/);
  assert.equal(a.order.length, GATES.filter((g) => g.column !== "Done").length);
  // The review to post and the release are never a one-click button on the card.
  const ship = texts(boardPage(app({ tasks: [GATES[6], GATES[7]] }), t));
  assert.ok(ship.includes("Post the review?"), "the card still says what it waits on");
  assert.ok(!ship.includes("Post the review") && !ship.includes("Release"), "no button posts from the card");
  sidebar(a, t);
  boardPage(app({ doneOpen: true }), t);
  boardPage(app({ tasks: [], loaded: true }), t);
  boardPage(app({ loaded: false }), t);
});

test("the inspector draws every gate on every tab", () => {
  for (const g of GATES) {
    for (const tab of ["details", "activity", "runs", "changes"]) {
      const detail = { events: [{ id: "1", kind: "stage.finished", payload: { summary: "ok" }, at: now }], stageRuns: [{ stage: "triage", status: "passed", attempt: 1, startedAt: now, endedAt: now, costUsd: 0.1, engine: "claude:opus" }], ship: { pr: { url: "https://x", number: 1 } } };
      const diffs = { [g.id]: tab === "changes" ? { base: "main", files: [{ path: "a.ts", status: "M", added: 1, removed: 0 }] } : undefined };
      const el = inspector(app({ selected: g.id, tab, details: { [g.id]: detail }, diffs }), t, 420);
      assert.ok(el, `${g.state} on ${tab}`);
    }
  }
  const plan = texts(inspector(app({ selected: GATES[0].id }), t, 420)).join(" | ");
  assert.match(plan, /Approve the plan\?/);
  assert.match(plan, /1 criteria no test covers/);
  const review = texts(inspector(app({ selected: GATES[7].id }), t, 420)).join(" | ");
  assert.match(review, /Request changes/);
  assert.match(review, /a\.ts:3/);
});

test("the PR page draws both lists, a clone running and an error", () => {
  const pr = { repo: "o/r", number: 1, title: "t", url: "https://x", author: "me", mine: true, reviewRequested: false, isDraft: false, headRef: "h", baseRef: "main", fromFork: false, reviewDecision: null, mergeable: "MERGEABLE", mergeState: "CLEAN", checks: { state: "failure", passed: 1, total: 2, failed: [{ name: "ci" }], all: [] }, unresolvedThreads: 2, split: "ci_failed", localPath: null, task: null, updatedAt: now };
  const snap = { prs: [pr, { ...pr, number: 2, repo: "o/s", localPath: "/w/s" }], polledAt: now, error: null, clones: [{ repo: "o/r", state: "cloning" }] };
  prsPage(app({ page: "prs", prs: { inbox: snap, all: snap } }), t);
  prsPage(app({ page: "prs", prList: "all", prs: { inbox: null, all: { prs: [], polledAt: null, error: "rate limited" } } }), t);
  prsPage(app({ page: "prs", prs: { inbox: null, all: null } }), t);
});
