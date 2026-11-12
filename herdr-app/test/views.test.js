// The Inbox, Digest, Floor, Backlog and Tickets pages: their rules as pure functions, and every
// page drawn with the host stand-in on realistic data, empty lists, errors and missing fields.
import assert from "node:assert/strict";
import { test } from "node:test";

import { theme } from "./host/stub.js";
import "../luna/features.js";
import { COMMANDS, DIALOGS, PAGES } from "../luna/registry.js";
import {
  bulkKind, bulkTargets, bulkWords, digestEntries, digestGroupOf, encodeKey, engineRows, floorRows, inboxCounts, inboxItems, inboxSplitOf,
  isNew, latchedWords, pendingBases, plain, refusalText, scoreLine, sourceLines, span, splitLines, stageRows, ticketActions, ticketDetail, ticketLink, waitingDrafts,
} from "../luna/views-model.js";

const t = theme();
const NOW = Date.parse("2026-11-12T12:00:00Z");
const task = (over = {}) => ({
  id: `id-${Math.random().toString(16).slice(2)}`, title: "A task", state: "draft", column: "Intake", route: "feature", repoPath: "/w/shop",
  waitingOnYou: false, running: false, queued: false, updatedAt: "2026-11-12T11:00:00Z", seq: 1, criteria: [], ...over,
});

test("a ticket lands in the inbox split that says what you do about it", () => {
  const s = (over) => inboxSplitOf(task(over), NOW);
  assert.equal(s({ state: "awaiting_approval", waitingOnYou: true }), "approve");
  assert.equal(s({ state: "awaiting_ship", waitingOnYou: true }), "approve");
  assert.equal(s({ state: "awaiting_answers", waitingOnYou: true }), "review");
  assert.equal(s({ state: "escalated" }), "failed");
  assert.equal(s({ state: "paused_rate_limit" }), "stale");
  assert.equal(s({ state: "implementing", running: true, updatedAt: "2026-11-12T10:00:00Z" }), "stale", "two hours of silence");
  assert.equal(s({ state: "implementing", running: true, updatedAt: "2026-11-12T11:59:00Z" }), null, "still working");
  assert.equal(s({ state: "draft" }), null);
  assert.equal(s({ state: "archived" }), null);
});

test("inbox items are oldest first, All is everything, and the search narrows", () => {
  const tasks = [
    task({ id: "new", state: "awaiting_approval", waitingOnYou: true, updatedAt: "2026-11-12T11:30:00Z" }),
    task({ id: "old", state: "awaiting_approval", waitingOnYou: true, updatedAt: "2026-11-12T08:00:00Z", title: "Refund bug" }),
    task({ id: "esc", state: "escalated", updatedAt: "2026-11-12T09:00:00Z" }),
    task({ id: "run", state: "implementing", running: true, updatedAt: "2026-11-12T11:59:00Z" }),
    task({ id: "nodate", state: "escalated", updatedAt: undefined }),
  ];
  const ids = (x) => x.map((y) => y.id);
  assert.deepEqual(ids(inboxItems(tasks, "approve", NOW)), ["old", "new"]);
  assert.deepEqual(ids(inboxItems(tasks, "all", NOW)), ["nodate", "old", "esc", "new"]);
  assert.deepEqual(ids(inboxItems(tasks, "review", NOW)), []);
  assert.deepEqual(ids(inboxItems(tasks, "all", NOW, "refund")), ["old"]);
  assert.deepEqual(inboxCounts(tasks, NOW), { approve: 2, review: 0, failed: 2, stale: 0, all: 4 });
  assert.deepEqual(inboxItems(null, "all", NOW), []);
});

test("only tickets one yes can approve are in the bulk set", () => {
  const plan = task({ state: "awaiting_approval", waitingOnYou: true });
  const split = task({ state: "awaiting_approval", waitingOnYou: true, gate: { requested: { outcome: "split" } } });
  const archive = task({ state: "awaiting_approval", waitingOnYou: true, gate: { requested: { outcome: "archive" } } });
  const release = task({ state: "awaiting_ship", waitingOnYou: true, gate: { requested: { gate: "ship_approval" } } });
  const ship = task({ state: "awaiting_ship", waitingOnYou: true });
  const review = task({ state: "awaiting_ship", waitingOnYou: true, route: "review" });
  const tests = task({ state: "awaiting_test_check", waitingOnYou: true });
  const memory = task({ state: "reviewing_memory", waitingOnYou: true });
  assert.deepEqual([plan, split, archive, release, ship, review, tests, memory].map(bulkKind), ["plan", "split", null, "release", "ship", null, null, null]);
  const targets = bulkTargets([plan, split, archive, release, ship, review, tests], NOW);
  assert.equal(targets.length, 4);
  assert.equal(bulkWords(targets), "1 plan, 1 split, 1 release, 1 ship");
  assert.equal(bulkWords([]), "");
});

test("the digest groups what changed since the mark, by group and newest first", () => {
  const tasks = [
    task({ id: "old-closed", state: "closed", updatedAt: "2026-11-12T08:30:00Z" }),
    task({ id: "new-closed", state: "closed", updatedAt: "2026-11-12T11:00:00Z" }),
    task({ id: "newer-gate", state: "awaiting_approval", waitingOnYou: true, updatedAt: "2026-11-12T11:30:00Z" }),
    task({ id: "new-gate", state: "awaiting_approval", waitingOnYou: true, updatedAt: "2026-11-12T10:30:00Z" }),
    task({ id: "shipped", state: "awaiting_ship", waitingOnYou: true, updatedAt: "2026-11-12T10:00:00Z" }),
    task({ id: "esc", state: "escalated", updatedAt: "2026-11-12T10:10:00Z" }),
    task({ id: "working", state: "implementing", running: true, updatedAt: "2026-11-12T11:59:00Z" }),
  ];
  const since = Date.parse("2026-11-12T09:00:00Z");
  const out = digestEntries(tasks, since).map((e) => `${e.group}:${e.task.id}`);
  assert.deepEqual(out, ["shipped:shipped", "escalated:esc", "needs_you:newer-gate", "needs_you:new-gate", "closed:new-closed"]);
  assert.equal(digestEntries(tasks, null).length, 6, "a first run shows everything with a group");
  assert.equal(digestEntries([], since).length, 0);
  assert.ok(isNew(tasks[1], since) && !isNew(tasks[0], since) && !isNew(tasks[1], null));
  assert.equal(digestGroupOf(task({ state: "implementing" })), null);
  assert.equal(digestGroupOf(task({ state: "archived" })), "closed");
});

test("a ticket's link is its PR, then its source, then its Jira issue", () => {
  const a = task({ id: "a", gate: { requested: { prUrl: "https://gh/pr/1" } }, source: { url: "https://gh/issue/2" } });
  assert.equal(ticketLink(a, [{ task: { id: "a" }, url: "https://gh/pr/9" }]), "https://gh/pr/9");
  assert.equal(ticketLink(a, []), "https://gh/pr/1");
  assert.equal(ticketLink(task({ source: { permalink: "https://slack/x" } })), "https://slack/x");
  assert.equal(ticketLink(task({ jira: { key: "A-1", url: "https://j/A-1" } })), "https://j/A-1");
  assert.equal(ticketLink(task()), null);
});

const M = {
  tasks: { created: 8, closed: 7, open: 1, waitingOnYou: 0, running: 0, queued: 0 },
  cycleTimeMs: { task: { median: 131388, p90: 194611596 }, perStage: { implementing: { median: 46878, p90: 446123, runs: 24 }, triage: { median: 90000, p90: 90000, runs: 1 } } },
  gates: { answered: 27, withinSla: 0.777, waitMs: { awaiting_approval: { median: 31711, p90: 1 } } },
  firstPassRate: { verifying: 0, ci_watch: 1, implementing: 0 },
  escalations: { rate: 0.14, topReasons: [{ reason: "deliver failed\u001b[2J", count: 6 }] },
  retries: { perTask: { median: 0, p90: 0 } },
  cost: { totalUsd: 31.07, perTaskUsd: { median: 1.08, p90: 11 }, byStage: { implementing: 17.9 } },
  queue: { depth: 0, slots: { max: 4, active: 0 }, utilisation: 0.25 },
};

test("the floor's rows read every number, and a missing window or field is a dash", () => {
  const rows = floorRows(M, null);
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(by["Tasks closed"].d7, "7");
  assert.equal(by["Tasks closed"].d30, "–");
  assert.match(by["Gates answered"].d7, /27 · 78% in SLA/);
  assert.match(by["Escalation rate"].d7, /14% · deliver failed .2J ×6/);
  assert.ok(!by["Escalation rate"].d7.includes("\u001b"));
  assert.match(by.Cost.d7, /\$31\.07/);
  // A machine from before a field: still a row, never a throw.
  const bare = floorRows({ tasks: { created: 1, closed: 0, open: 1, waitingOnYou: 0, running: 0, queued: 0 } }, {});
  assert.equal(bare.length, rows.length);
  assert.equal(bare.find((r) => r.label === "Cost").d7, "–");
  assert.equal(span(131388), "2m 11s");
  assert.equal(span(null), "–");
  assert.equal(span(194611596), "2d 6h");
});

test("stages sort slowest first, engines join the month's spend and a cap reads over", () => {
  assert.deepEqual(stageRows(M).map((s) => s.stage), ["triage", "implementing"]);
  assert.deepEqual(stageRows(null), []);
  const rows = engineRows(
    { byEngine: [{ engine: "claude:opus", stageRuns: 10, firstPassRate: 1 }, { engine: null, stageRuns: 5 }] },
    [{ id: "claude:opus", spentThisMonthUsd: 21, budgetUsd: 20 }, { id: "codex:sol", spentThisMonthUsd: 0, budgetUsd: null }, { id: "claude:haiku", spentThisMonthUsd: 3, budgetUsd: null }, "junk", null],
  );
  assert.deepEqual(rows.map((r) => r.name), ["claude:opus", "(none)", "claude:haiku"]);
  assert.equal(rows[0].over, true);
  assert.equal(rows[2].over, false);
  assert.deepEqual(engineRows(null, null), []);
});

test("pending bases, latched credentials and paused tickets", () => {
  assert.deepEqual(pendingBases([{ repo: "/r/a", image: { pendingBase: "python:3.13-slim" } }, { repo: "/r/b", image: {} }, { repo: "/r/c" }]), [{ repo: "/r/a", base: "python:3.13-slim" }]);
  assert.deepEqual(pendingBases(null), []);
  assert.equal(latchedWords("codex"), "codex");
  assert.equal(latchedWords({ credential: "claude", until: "2026-11-12T14:30:00Z" }), "claude until 14:30 UTC");
  assert.equal(latchedWords({}), "credential");
});

test("backlog texts are flattened and a refusal names what the item waits for", () => {
  assert.equal(plain("bad\u001b[31mred\ntitle"), "bad [31mred title");
  assert.deepEqual(sourceLines({ sources: [{ kind: "github", repo: "o/a", number: 3 }, { type: "slack" }, { kind: "jira", key: "P-1" }, { nothing: 1 }, null] }), ["GitHub o/a#3", "Slack thread", "Jira P-1", "unknown source", "unknown source"]);
  assert.equal(refusalText({ message: "this item waits", blockedBy: [{ id: "c1", state: "in review" }] }), "this item waits: c1 (in review)");
  assert.equal(refusalText({ message: "nope" }), "nope");
  assert.equal(refusalText(null), "request failed");
});

test("ticket keys are one path segment", () => {
  assert.equal(encodeKey("PAY-12"), "PAY-12");
  assert.equal(encodeKey("o/a#3"), "o%2Fa%233");
  assert.equal(encodeKey("../x"), "..%2Fx");
});

const TICKET = {
  key: "PAY-12", canonical: { title: "Refund fails", links: { blocks: ["PAY-30"], duplicates: [] } }, status: "assessed",
  assessments: [{ outcome: "workable", priority: "P1", size: "M", blastRadius: "low", score: 0.8, recommendation: { action: "do_now", reason: "worth it" }, subScores: { who: { value: 2, confidence: 0.9 } } }],
  drafts: [{ id: "PAY-12:assessment", kind: "assessment", status: "waiting", text: "Assessed: P1.", hash: "abcd" }, { id: "PAY-12:decline", kind: "decline", status: "posted", text: "x", hash: "h" }],
  clocks: { overdue: ["acknowledge"] }, cardId: null,
};
const SPLIT = {
  key: "PAY-13", canonical: { title: "Big" }, status: "split_proposed", splitTarget: "PAY",
  drafts: [{ id: "d", kind: "split", status: "waiting", text: "1. A", hash: "h", children: [{ title: "Part A", goal: "do A", acceptance_criteria: ["A works"], est_loc: 800, depends_on: [], order: 1 }, { title: "Part B", goal: "do B", acceptance_criteria: [], est_loc: 1200, depends_on: [1], order: 2 }] }],
};

test("a ticket's line, detail and actions follow the TUI's conditions", () => {
  assert.equal(scoreLine(TICKET), "P1 M low 0.80 do now");
  assert.equal(scoreLine({ key: "A" }), null);
  assert.deepEqual(ticketDetail(TICKET), ["who: 2 (confidence 0.90)", "recommended: do now (worth it)", "linked: PAY-30"]);
  assert.equal(waitingDrafts(TICKET).length, 1);
  assert.deepEqual(ticketActions(TICKET).map((a) => a.id), ["approve", "edit", "ignore", "card", "backlog"]);
  assert.deepEqual(ticketActions({ ...TICKET, cardId: "c1" }).map((a) => a.id), ["approve", "edit", "ignore", "backlog"]);
  assert.deepEqual(ticketActions({ key: "X", canonical: {}, drafts: [{ status: "posted" }] }).map((a) => a.id), ["card"], "no draft, not assessed");
  const lines = splitLines(SPLIT, SPLIT.drafts[0]);
  assert.equal(lines[0], "Approving creates 2 tickets in PAY");
  assert.ok(lines.includes("1. Part A, about 800 lines") && lines.includes("2. Part B, about 1200 lines, after 1") && lines.includes("   - A works"));
  assert.equal(ticketActions(SPLIT)[0].label, "Approve the split");
});

// ---- drawing ----

const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};

const calls = [];
function app(over = {}) {
  const states = {};
  const reads = over.reads ?? {};
  return {
    machine: { base: "http://127.0.0.1:4318", approver: "me", get: async (p) => (reads[p.split("?")[0]] ?? []), post: async () => ({}), health: async () => ({ slots: { max: 4, active: 1, draining: false, latched: [] } }), call: async () => ({}) },
    tasks: [], loaded: true, error: null, link: "live", page: "inbox", query: "", prs: { inbox: null, all: null }, busy: new Set(), flash: null,
    state: (id) => (states[id] ??= {}), say() {}, go() {}, select() {}, act() {}, openUrl() {},
    dialog: (...a) => calls.push(["dialog", ...a]), confirm: (...a) => calls.push(["confirm", ...a]), run() {},
    ...over,
  };
}
const cx = { notify() {}, spawn() {}, timer: { every() {}, after() {} } };
const page = (id) => PAGES.find((p) => p.id === id);
const WORK = [
  task({ id: "a", state: "awaiting_approval", waitingOnYou: true, gate: { requested: { brief: "x" } } }),
  task({ id: "b", state: "awaiting_ship", waitingOnYou: true, gate: { requested: { gate: "ship_approval", prUrl: "https://gh/pr/1" } } }),
  task({ id: "c", state: "awaiting_answers", waitingOnYou: true, gate: { requested: { questions: ["q"] } } }),
  task({ id: "d", state: "escalated", reason: "env_broken" }),
  task({ id: "e", state: "paused_rate_limit" }),
  task({ id: "f", state: "implementing", running: true, updatedAt: "2026-01-01T00:00:00Z" }),
  task({ id: "g", state: "closed", title: undefined, repoPath: undefined, updatedAt: undefined }),
  task({ id: "h", state: "awaiting_approval", waitingOnYou: true, gate: undefined, jira: { key: "P-1" } }),
];

test("the pages are registered in order with their commands", () => {
  const ids = PAGES.map((p) => p.id);
  const mine = ["inbox", "digest", "floor", "backlog", "tickets"];
  assert.deepEqual(ids.filter((id) => mine.includes(id)), mine);
  for (const verb of ["inbox", "digest", "floor", "backlog", "tickets", "drain", "resume", "slots"]) assert.equal(typeof COMMANDS[verb], "function", verb);
  assert.equal(typeof DIALOGS.luna_many.submit, "function");
  assert.equal(typeof DIALOGS.ticket_edit.submit, "function");
});

test("the inbox draws every split, empty, offline and loading", () => {
  const a = app({ tasks: WORK });
  const words = texts(page("inbox").render(a, t)).join(" | ");
  assert.match(words, /need/);
  assert.match(words, /Approve all \(3\)/);
  for (const split of ["approve", "review", "failed", "stale", "all"]) {
    a.state("inbox").split = split;
    page("inbox").render(a, t);
  }
  assert.deepEqual(page("inbox").badge(a), { n: inboxCounts(WORK).all, tone: "blocked" });
  assert.match(texts(page("inbox").render(app(), t)).join(" | "), /Nothing needs you/);
  assert.match(texts(page("inbox").render(app({ loaded: false, link: "offline", error: "no machine" }), t)).join(" | "), /no machine/);
  page("inbox").render(app({ loaded: false }), t);
  page("inbox").render(app({ tasks: undefined }), t);
  assert.equal(page("inbox").badge(app()), null);
});

test("the inbox's keys move, switch splits, approve all and open", () => {
  const seen = [];
  const a = app({ tasks: WORK, go: (p) => seen.push(["go", p]), select: (id) => seen.push(["select", id]), act: (tk, id) => seen.push(["act", id]) });
  page("inbox").render(a, t);
  const key = (k) => page("inbox").key(a, { key: k }, cx);
  assert.ok(key("j") && key("k") && key("l") && key("h"));
  assert.equal(key("z"), false);
  assert.ok(key("enter"));
  assert.deepEqual(seen.slice(0, 2).map((s) => s[0]), ["go", "select"]);
  assert.ok(key("a"));
  assert.equal(seen.at(-1)[0], "act");
  calls.length = 0;
  assert.ok(key("A"));
  assert.equal(calls[0][1].kind, "luna_many");
  assert.equal(calls[0][1].calls.length, 3);
  assert.deepEqual(calls[0][1].calls[0].body, { decision: "approved", approver: "me" });
  // Nothing to approve together: no dialog, a note.
  calls.length = 0;
  const b = app({ tasks: [WORK[2]] });
  page("inbox").render(b, t);
  assert.ok(page("inbox").key(b, { key: "A" }, cx));
  assert.equal(calls.length, 0);
});

test("the digest draws groups, a first run, nothing new, and keeps its mark", () => {
  const a = app({ tasks: WORK, page: "digest" });
  const words = texts(page("digest").render(a, t)).join(" | ");
  assert.match(words, /Digest|first time/);
  assert.match(words, /NEEDS YOU/);
  page("digest").badge(a);
  a.state("digest").since = Date.now() + 1000;
  assert.match(texts(page("digest").render(a, t)).join(" | "), /Nothing changed/);
  a.state("digest").since = 0;
  page("digest").render(a, t);
  page("digest").render(app({ tasks: undefined, loaded: false, page: "digest" }), t);
  page("digest").render(app({ prs: { inbox: { prs: [{ task: { id: "b" }, url: "https://gh/pr/2" }] }, all: null }, tasks: WORK }), t);
});

test("the floor draws the pool, numbers, bases, alerts, errors and empty windows", () => {
  const a = app({ tasks: WORK, page: "floor" });
  const st = a.state("floor");
  assert.match(texts(page("floor").render(a, t)).join(" | "), /Reading the pool|Reading the numbers/);
  st.health = { slots: { max: 4, active: 1, draining: true, latched: ["codex", { credential: "claude", until: "2026-11-12T14:30:00Z" }] } };
  st.m7 = { ...M, byRepo: [{ repo: "/w/shop", tasks: { created: 2, closed: 1 }, escalationRate: 1, firstPassVerifying: null, costUsd: 25.7 }] };
  st.m30 = { ...M, byRepo: [{ repo: "/w/shop", costUsd: 30 }, { repo: "/w/other", tasks: {}, costUsd: 1 }] };
  st.engineMetrics = { byEngine: [{ engine: "claude:opus", stageRuns: 3, firstPassRate: 1, escalations: 0, rateLimited: 0, meanTurns: 30 }] };
  st.engines = [{ id: "claude:opus", spentThisMonthUsd: 21, budgetUsd: 20 }];
  st.repos = [{ repo: "/r/fresh", image: { pendingBase: "python:3.13-slim" } }];
  st.alerts = [{ scope: "engine", engine: "claude:opus", pct: 90, spentUsd: 18, limitUsd: 20, at: Date.now() }];
  const words = texts(page("floor").render(a, t)).join(" | ");
  assert.match(words, /Carry on/);
  assert.match(words, /Resume 1 paused/);
  assert.match(words, /python:3\.13-slim/);
  assert.match(words, /\$21\.00 \/ \$20\.00/);
  assert.match(words, /BUDGET ALERTS/);
  st.health = { slots: { max: 1 } };
  st.m30 = null;
  st.m7 = { tasks: { created: 0, closed: 0, open: 0, waitingOnYou: 0, running: 0, queued: 0 } };
  st.engines = null;
  st.engineMetrics = null;
  st.repos = null;
  page("floor").render(a, t);
  st.errors = { "7d": "metrics answered 500" };
  st.m7 = null;
  assert.match(texts(page("floor").render(a, t)).join(" | "), /metrics answered 500/);
  assert.equal(page("floor").badge(a).n, 1);
});

test("the floor's controls ask first and its stream events update it", () => {
  const a = app({ tasks: WORK });
  const st = a.state("floor");
  st.health = { slots: { max: 3, draining: false } };
  calls.length = 0;
  COMMANDS.drain(a, "", cx);
  COMMANDS.slots(a, "5", cx);
  COMMANDS.slots(a, "x", cx);
  COMMANDS.resume(a, "paused", cx);
  COMMANDS.resume(a, "", cx);
  assert.equal(calls[0][1].call.path, "/drain");
  assert.deepEqual(calls[1][1].call, { method: "PATCH", path: "/slots", body: { max: 5 } });
  assert.equal(calls[2][1].kind, "luna_many");
  assert.equal(calls[3][1].call.path, "/resume");
  const f = page("floor");
  assert.equal(f.onMessage(a, { event: "task.metrics", data: { metrics: { tasks: { created: 9 } } } }, cx), true);
  assert.equal(st.m7.tasks.created, 9);
  assert.equal(f.onMessage(a, { event: "budget.alert", data: { alert: { scope: "day", pct: 80, spentUsd: 8, limitUsd: 10 } } }, cx), true);
  assert.equal(st.alerts.length, 1);
  assert.equal(f.onMessage(a, { event: "slack.items", data: {} }, cx), false);
  assert.equal(f.onMessage(a, { event: "task.metrics", data: null }, cx), true);
});

test("the backlog draws ranked items, blocked ones, empty and an error", () => {
  const a = app({ page: "backlog" });
  const st = a.state("backlog");
  assert.match(texts(page("backlog").render(a, t)).join(" | "), /Reading the backlog/);
  st.items = [
    { id: "1", title: "Fix the webhook\u001b[2J", text: "It drops events", repo: "o/api", size: "M", demand: 2, score: 1.0416, stale: true, addedAt: "2026-11-05T00:00:00Z", sources: [{ kind: "github", repo: "o/api", number: 3 }], dependsOn: ["x"] },
    { id: "2", title: "Wait", size: "S", demand: 1, score: 0.4, stale: false, addedAt: "x", schedulable: false, blockedBy: [{ id: "c1", kind: "card", state: "in review" }] },
    { id: "3" },
  ];
  const words = texts(page("backlog").render(a, t)).join(" | ");
  assert.match(words, /1\.04/);
  assert.match(words, /blocked by 1/);
  assert.match(words, /waits for card c1 \(in review\)/);
  assert.match(words, /GitHub o\/api#3/);
  assert.ok(!words.includes("\u001b"));
  st.items = [];
  assert.match(texts(page("backlog").render(a, t)).join(" | "), /The backlog is empty/);
  st.items = null;
  st.error = "machine unreachable";
  assert.match(texts(page("backlog").render(a, t)).join(" | "), /machine unreachable/);
  assert.equal(page("backlog").badge(app()), null);
});

test("the tickets page draws drafts, a split, no drafts, empty and an error, and asks before posting", () => {
  const a = app({ page: "tickets" });
  const st = a.state("tickets");
  assert.match(texts(page("tickets").render(a, t)).join(" | "), /Reading the tickets/);
  st.items = [TICKET, SPLIT, { key: "o/r#4", canonical: {}, drafts: [{ status: "posted" }], cardId: "c1", clocks: null }, { key: "BARE" }];
  st.selected = "PAY-12";
  let words = texts(page("tickets").render(a, t)).join(" | ");
  assert.match(words, /P1 M low 0\.80 do now/);
  assert.match(words, /1 draft waiting/);
  assert.match(words, /overdue: acknowledge/);
  assert.match(words, /Post my text/);
  st.selected = "PAY-13";
  words = texts(page("tickets").render(a, t)).join(" | ");
  assert.match(words, /Approving creates 2 tickets in PAY/);
  assert.match(words, /Approve the split/);
  for (const key of ["o/r#4", "BARE"]) {
    st.selected = key;
    page("tickets").render(a, t);
  }
  st.items = [];
  assert.match(texts(page("tickets").render(a, t)).join(" | "), /holds no ticket/);
  st.items = null;
  st.error = "tickets answered 502";
  assert.match(texts(page("tickets").render(a, t)).join(" | "), /tickets answered 502/);
  assert.equal(page("tickets").badge(app()), null);
});

test("every dialog the pages register draws and submits", async () => {
  const sent = [];
  const d = { app: null };
  const dlgApp = { machine: { call: async (...a) => sent.push(["call", ...a]), post: async (...a) => sent.push(["post", ...a]) }, send: async (_cx, f) => f(), fail: (_cx, m) => sent.push(["fail", m]), text: { value: () => "  hello " } };
  const many = { kind: "luna_many", body: "Sure?", calls: [{ path: "/x" }, { method: "PATCH", path: "/y", body: { a: 1 } }] };
  assert.ok(DIALOGS.luna_many.body(dlgApp, t, many).length);
  assert.equal(DIALOGS.luna_many.primary(dlgApp, many).kind, "primary");
  await DIALOGS.luna_many.submit(dlgApp, cx, many);
  assert.deepEqual(sent.map((s) => s[2]), ["/x", "/y"]);
  const failing = { ...dlgApp, machine: { call: async () => { throw new Error("409 no"); } } };
  await assert.rejects(() => DIALOGS.luna_many.submit(failing, cx, { ...many, done: "Approved" }), /Approved 0 of 2; 2 refused: 409 no/);
  const edit = { kind: "ticket_edit", ticketKey: "o/r#4", draft: "dr", hash: "hh", original: "orig" };
  assert.ok(DIALOGS.ticket_edit.body(dlgApp, t, edit).length);
  sent.length = 0;
  await DIALOGS.ticket_edit.submit(dlgApp, cx, edit);
  assert.deepEqual(sent[0], ["post", "/tickets/o%2Fr%234/edit", { draft: "dr", hash: "hh", text: "hello" }]);
  sent.length = 0;
  await DIALOGS.ticket_edit.submit({ ...dlgApp, text: { value: () => " " } }, cx, edit);
  assert.equal(sent[0][0], "fail");
  void d;
});
