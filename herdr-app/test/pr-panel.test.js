// The PR panel lists every action with its TUI key; one that cannot run now stays, with the reason.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./host/stub.js";
import "../luna/features.js";
import { panelActions, panelPr } from "../luna/pr-inspector.js";

const pr = (over = {}) => ({
  repo: "o/shop", number: 7, title: "t", url: "https://github.com/o/shop/pull/7", author: "ana", mine: false, isDraft: false,
  headRef: "feat", baseRef: "main", fromFork: false, reviewDecision: null, mergeable: "MERGEABLE", mergeState: "BLOCKED",
  checks: { state: "success", passed: 2, total: 2, failed: [], all: [] }, unresolvedThreads: 0, split: "review_requested",
  localPath: "/w/shop", task: null, updatedAt: "2026-11-15T10:00:00Z", ...over,
});
const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a]));

test("someone else's PR: review is the main action, close is off and says why, every key is the TUI's", () => {
  const a = byId(panelActions(pr()));
  assert.equal(a.review.key, "v");
  assert.equal(a.review.why, null);
  assert.equal(a.review.primary, true);
  assert.equal(a.ci_fix.key, "c");
  assert.match(a.ci_fix.why, /not failing/);
  assert.equal(a.address.key, "t");
  assert.equal(a.merge.key, "m");
  assert.match(a.close.why, /your own PRs/);
  assert.equal(a.clone.key, "C");
  assert.match(a.clone.why, /already cloned/);
  assert.equal(a.browser.key, "o");
});

test("an uncloned PR: a review clones first, so it stays on; clone is on", () => {
  const a = byId(panelActions(pr({ localPath: null })));
  assert.equal(a.review.why, null);
  assert.equal(a.clone.why, null);
});

test("your PR with red checks and open threads: fix CI and answer the threads are on, review is off", () => {
  const a = byId(panelActions(pr({ mine: true, split: "mine", checks: { state: "failure", passed: 1, total: 2, failed: [{ name: "ci" }], all: [] }, unresolvedThreads: 2 })));
  assert.equal(a.ci_fix.why, null);
  assert.equal(a.address.why, null);
  assert.match(a.review.why, /other people's PRs/);
  assert.equal(a.close.why, null);
});

test("a PR with a task running: opening its card comes first", () => {
  const list = panelActions(pr({ task: { id: "t1", state: "reviewing", route: "review" } }));
  assert.equal(list[0].id, "open_task");
  assert.equal(list[0].primary, true);
});

test("the panel shows only once a PR is opened, and only while it is listed", () => {
  const p = pr();
  assert.equal(panelPr({ prPanel: false, prSel: "o/shop#7", prRows: [p] }), null);
  assert.equal(panelPr({ prPanel: true, prSel: "o/shop#7", prRows: [p] }), p);
  assert.equal(panelPr({ prPanel: true, prSel: "o/shop#9", prRows: [p] }), null);
});
