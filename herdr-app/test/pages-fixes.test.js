// The side pages' fixes: their keys (the TUI's, with Shift+A and cmd ignored), the Inbox badge,
// the Floor's additions, the Slack relation body, the 1500-character cap, the run() cx rule and
// the alerts (each once, seeded at start-up).
import assert from "node:assert/strict";
import { test } from "node:test";

import { calls, theme } from "./host/stub.js";
import "../luna/features.js";
import { DIALOGS, PAGES } from "../luna/registry.js";
import { relationBody, relationChoices } from "../luna/integrations-model.js";
import { floorRows, graphLine, imageLine, inboxBadgeCount, inboxSplitOf, latchedWords, slackMetricRows } from "../luna/views-model.js";
import { economyActions } from "../luna/page-economy.js";
import { loadFloor } from "../luna/page-floor.js";
import { EDIT_MAX } from "../luna/page-tickets.js";
import { ticketKeyAction } from "../luna/page-inbox.js";
import { linkNotice, prNotice, scan, slackNotice, taskNotices } from "../luna/alerts.js";

const t = theme();
const page = (id) => PAGES.find((p) => p.id === id);
const ev = (key, modifiers = {}) => ({ key, modifiers });
const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const task = (over = {}) => ({ id: `id-${Math.random().toString(16).slice(2, 10)}`, title: "A task", state: "implementing", column: "Build", route: "feature", repoPath: "/w/shop", waitingOnYou: false, running: false, queued: false, updatedAt: iso(NOW - 60000), seq: 1, criteria: [], ...over });
const gate = (over = {}) => task({ state: "awaiting_approval", waitingOnYou: true, ...over });

function fake(over = {}, states = {}) {
  const log = [];
  const cx = { notify() {}, spawn: (f) => f(cx), timer: { every() {}, after() {} }, tag: "handler" };
  const app = {
    log,
    machine: { get: async (p) => (log.push(["get", p]), []), post: async (...a) => (log.push(["post", ...a]), {}), patch: async (...a) => (log.push(["patch", ...a]), {}), health: async () => ({ slots: { max: 2, active: 0, latched: [{ owner: "claude", until: "2026-11-12T14:30:00Z" }] } }), call: async () => ({}) },
    tasks: [], busy: new Set(), flash: null, width: 1400, query: "", selected: null, page: "inbox", loaded: true, link: "live",
    state: (id) => (states[id] ??= {}),
    say: (m, tone) => log.push(["say", m, tone]),
    go: (p) => log.push(["go", p]),
    select: (id) => log.push(["select", id]),
    openUrl: (u) => log.push(["open", u]),
    dialog: (spec) => log.push(["dialog", spec]),
    confirm: (spec) => log.push(["confirm", spec]),
    act: (task, id) => log.push(["act", task.id, id]),
    run: (cx0, key, done, call) => {
      log.push(["run", key, done]);
      return call({ ...cx0, tag: "task" });
    },
    trackInput: (s) => (log.push(["track"]), s),
    ...over,
  };
  return { app, cx, log };
}

// ---- Inbox: keys and badge ----

test("Inbox: Shift+A approves all, cmd/ctrl+A and cmd+a do nothing, plain a runs the row's action", () => {
  const plan = gate({ id: "plan" });
  const { app, cx, log } = fake({ tasks: [plan] });
  const p = page("inbox");
  p.render(app, t);
  assert.equal(p.key(app, ev("a", { shift: true }), cx), true);
  assert.equal(log.filter((l) => l[0] === "dialog" && l[1].kind === "luna_many").length, 1, "Shift+A reaches Approve all");
  log.length = 0;
  assert.equal(p.key(app, ev("a", { platform: true }), cx), false, "cmd+a is not the row action");
  assert.equal(p.key(app, ev("a", { control: true }), cx), false);
  assert.equal(p.key(app, ev("A", { alt: true }), cx), false);
  assert.deepEqual(log, []);
  assert.equal(p.key(app, ev("a"), cx), true);
  assert.deepEqual(log[0], ["act", "plan", "approve"]);
});

test("Inbox: the TUI's ticket keys map to the actions with the TUI's conditions", () => {
  const { app } = fake();
  const plan = gate();
  const esc = task({ state: "escalated" });
  const running = task({ running: true });
  const release = task({ state: "awaiting_ship", waitingOnYou: true, gate: { requested: { gate: "ship_approval" } } });
  assert.deepEqual(ticketKeyAction(app, "a", plan), { id: "approve" });
  assert.deepEqual(ticketKeyAction(app, "r", plan), { id: "send_back" });
  assert.deepEqual(ticketKeyAction(app, "N", plan), { id: "reject" });
  assert.deepEqual(ticketKeyAction(app, "N", release), { id: "reject_release" });
  assert.deepEqual(ticketKeyAction(app, "S", release), { id: "approve" });
  assert.deepEqual(ticketKeyAction(app, "X", running), { id: "abort" });
  assert.match(ticketKeyAction(app, "X", plan).say, /nothing is running/);
  assert.deepEqual(ticketKeyAction(app, "C", esc), { id: "escalation_reason" });
  assert.match(ticketKeyAction(app, "C", plan).say, /only an escalation/);
  assert.deepEqual(ticketKeyAction(app, "Z", plan), { id: "archive" });
  assert.deepEqual(ticketKeyAction(app, "e", plan), { id: "edit_ticket" });
  assert.deepEqual(ticketKeyAction(app, "f", running), { id: "watch" });
  assert.deepEqual(ticketKeyAction(app, "R", plan), { id: "set_repo" });
  assert.match(ticketKeyAction(app, "o", plan).say, /no linked issue/);
  assert.deepEqual(ticketKeyAction(app, "o", task({ source: { url: "https://x/1" } })), { id: "open_issue" });
  const gaps = gate({ gate: { requested: { coverageReport: { gaps: [{ id: "c1" }] } } } });
  assert.equal(ticketKeyAction(app, "u", gaps).dialog.kind, "excuse");
  assert.equal(ticketKeyAction(app, "z", plan), null);
});

test("Inbox: j/k, h/l and 1-5 move, esc and q go back, enter opens the ticket", () => {
  const { app, cx, log } = fake({ tasks: [gate({ id: "a1" }), gate({ id: "a2" }), task({ id: "f1", state: "escalated" })] });
  const p = page("inbox");
  p.render(app, t);
  const st = app.state("inbox");
  p.key(app, ev("j"), cx);
  assert.equal(st.cursor, 1);
  p.key(app, ev("k"), cx);
  assert.equal(st.cursor, 0);
  p.key(app, ev("l"), cx);
  assert.equal(st.split, "review");
  p.key(app, ev("3"), cx);
  assert.equal(st.split, "failed");
  p.key(app, ev("5"), cx);
  assert.equal(st.split, "all");
  p.key(app, ev("h"), cx);
  assert.equal(st.split, "stale");
  p.render(app, t);
  st.split = "approve";
  p.render(app, t);
  assert.equal(p.key(app, ev("enter"), cx), true);
  assert.deepEqual(log.slice(-2), [["go", "board"], ["select", "a1"]]);
  assert.equal(p.key(app, ev("q"), cx), true);
  assert.deepEqual(log.at(-1), ["go", "board"]);
  assert.equal(p.key(app, ev("x"), cx), false);
});

test("Inbox: the badge is the board's waiting-on-you count and Approve all hides at zero", () => {
  const watched = task({ state: "awaiting_ship", waitingOnYou: false });
  const retro = task({ state: "reviewing_memory", waitingOnYou: false });
  const stale = task({ running: true, updatedAt: iso(NOW - 3 * 3600000) });
  const paused = task({ state: "paused_rate_limit" });
  const mine = [gate(), gate(), task({ state: "escalated" })];
  assert.equal(inboxSplitOf(watched, NOW), null, "a PR the machine only watches is not yours");
  assert.equal(inboxSplitOf(retro, NOW), null);
  assert.equal(inboxBadgeCount([watched, retro, stale, paused, ...mine], NOW), 3);
  const { app } = fake({ tasks: [watched, retro, stale, paused, ...mine] });
  assert.deepEqual(page("inbox").badge(app), { n: 3, tone: "blocked" });
  assert.match(texts(page("inbox").render(app, t)).join("|"), /Approve all \(2\)/);
  const none = fake({ tasks: [watched, paused, stale] }).app;
  assert.equal(page("inbox").badge(none), null);
  assert.ok(!texts(page("inbox").render(none, t)).join("|").includes("Approve all"));
});

// ---- the other pages' keys ----

test("Digest: j/k, enter, o and esc", () => {
  const a = gate({ id: "g1", source: { url: "https://x/1" } });
  const b = task({ id: "g2", state: "closed" });
  const { app, cx, log } = fake({ tasks: [a, b], page: "digest" });
  const p = page("digest");
  p.render(app, t);
  assert.equal(p.key(app, ev("o"), cx), true);
  assert.deepEqual(log.at(-1), ["open", "https://x/1"]);
  assert.equal(p.key(app, ev("o", { platform: true }), cx), false);
  p.key(app, ev("j"), cx);
  p.key(app, ev("enter"), cx);
  assert.deepEqual(log.slice(-2), [["go", "board"], ["select", "g2"]]);
  assert.equal(p.key(app, ev("escape"), cx), true);
});

test("Backlog: p promote, b bump, d decline asks, R refreshes; the cx a call gets is the task's own", async () => {
  const { app, cx, log } = fake({ page: "backlog" });
  const st = app.state("backlog");
  st.items = [{ id: "b1", title: "One" }, { id: "b2", title: "Two" }];
  const p = page("backlog");
  p.render(app, t);
  let seen = null;
  app.machine.get = async (path) => (log.push(["get", path]), st.items);
  const loadCx = [];
  const real = app.run;
  app.run = (c, key, done, call) => {
    real(c, key, done, async (c2) => {
      seen = c2.tag;
      loadCx.push(c2);
      return call(c2);
    });
  };
  p.key(app, ev("j"), cx);
  assert.equal(p.key(app, ev("p"), cx), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen, "task", "promote reads the list again with the task's cx, not the handler's");
  assert.deepEqual(log.find((l) => l[0] === "post"), ["post", "/backlog/b2/promote"]);
  p.key(app, ev("b"), cx);
  assert.deepEqual(log.filter((l) => l[0] === "post").at(-1), ["post", "/backlog/b2/bump"]);
  p.key(app, ev("d"), cx);
  assert.equal(log.at(-1)[0], "confirm");
  assert.equal(log.at(-1)[1].call.path, "/backlog/b2/decline");
  assert.equal(p.key(app, ev("p", { control: true }), cx), false);
});

test("Tickets: a e x c s act on the ticket under the cursor", () => {
  const ticket = { key: "PAY-1", canonical: { title: "Refund" }, status: "assessed", assessments: [{ outcome: "workable", priority: "P1" }], drafts: [{ id: "PAY-1:a", kind: "assessment", status: "waiting", text: "hi", hash: "h" }] };
  const { app, cx, log } = fake({ page: "tickets" });
  app.state("tickets").items = [ticket];
  const p = page("tickets");
  p.render(app, t);
  p.key(app, ev("a"), cx);
  assert.equal(log.at(-1)[0], "confirm");
  p.key(app, ev("e"), cx);
  assert.equal(log.at(-1)[1].kind, "ticket_edit");
  p.key(app, ev("x"), cx);
  assert.deepEqual(log.filter((l) => l[0] === "post").at(-1), ["post", "/tickets/PAY-1/ignore", { draft: "PAY-1:a" }]);
  p.key(app, ev("c"), cx);
  assert.equal(log.filter((l) => l[0] === "post").at(-1)[1], "/tickets/PAY-1/card");
  p.key(app, ev("s"), cx);
  assert.equal(log.filter((l) => l[0] === "post").at(-1)[1], "/tickets/PAY-1/backlog");
});

test("Tickets: Post my text refuses past 1500 characters", () => {
  const sent = [];
  const d = { ticketKey: "PAY-1", draft: "d", hash: "h" };
  const mk = (text) => ({ text: { value: () => text }, machine: { post: async (...a) => sent.push(a) }, send: async (_cx, f) => f(), fail: (_cx, m) => sent.push(["fail", m]) });
  DIALOGS.ticket_edit.submit(mk("x".repeat(EDIT_MAX + 1)), {}, d);
  assert.match(sent[0][1], /1501 characters, at most 1500/);
  DIALOGS.ticket_edit.submit(mk("x".repeat(EDIT_MAX)), {}, d);
  assert.equal(sent[1][0], "/tickets/PAY-1/edit");
});

test("Economy follows the selected card's repo, and its keys ask first", async () => {
  const { app, cx, log } = fake({ page: "economy", tasks: [task({ id: "t1", repoPath: "/w/a" }), task({ id: "t2", repoPath: "/w/b" })], selected: "t2" });
  const p = page("economy");
  p.enter(app, cx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(app.state("economy").repo, "/w/b");
  assert.ok(log.some((l) => l[0] === "get" && l[1] === "/economy?repo=%2Fw%2Fb"));
  const s = app.state("economy");
  s.data = { facts: [{ id: "f1", state: "active", text: "x", source: "s", family: "f" }] };
  p.render(app, t);
  assert.equal(p.key(app, ev("j"), cx), true);
  const row = { kind: "fact", fact: s.data.facts[0] };
  assert.equal(typeof economyActions(app, s.data, row).drop, "function");
  p.key(app, ev("d"), cx);
  assert.match(s.ask?.text ?? "", /Drop this fact/);
  p.key(app, ev("I"), cx);
  assert.match(s.ask.text, /Fold the runs/);
  assert.equal(p.key(app, ev("r"), cx), true);
  assert.match(log.at(-1)[1], /^r: /);
});

test("Slack: the item keys, splits, Watches keys, and the picker swallows keys", () => {
  const item = { id: "i1", split: "needs_reply", triage: { priority: "P1" }, text: "hello", channel: { name: "ops", kind: "channel" }, author: { name: "ann" }, ts: iso(NOW - 3600000), permalink: "https://s/1", conversation: { shortlist: [] } };
  const snap = { items: [item, { ...item, id: "i2", split: "fyi" }], watches: [{ id: "w1", kind: "keyword", value: "x", enabled: true, builtin: false }, { id: "w2", kind: "broadcast", value: "@here", enabled: true, builtin: true }] };
  const { app, cx, log } = fake({ page: "slack" });
  const s = app.state("slack");
  s.snap = snap;
  const p = page("slack");
  p.render(app, t);
  p.key(app, ev("j"), cx);
  assert.equal(s.sel, "i1");
  p.key(app, ev("o"), cx);
  assert.deepEqual(log.at(-1), ["open", "https://s/1"]);
  p.key(app, ev("r"), cx);
  assert.equal(log.at(-1)[1].kind, "slack_reply");
  p.key(app, ev("N"), cx);
  assert.match(log.at(-1)[1], /^N: \(only while waiting on them\)$/);
  p.key(app, ev("!"), cx);
  assert.deepEqual(log.filter((l) => l[0] === "patch").at(-1), ["patch", "/slack/items/i1", { priority: "P0" }]);
  p.key(app, ev("L"), cx);
  assert.equal(s.pick?.kind, "relation");
  p.key(app, ev("escape"), cx);
  assert.equal(s.pick, null);
  p.key(app, ev("2"), cx);
  assert.equal(s.split, "waiting_on_them");
  p.key(app, ev("6"), cx);
  assert.equal(s.split, "done");
  s.pick = { kind: "snooze", id: "i1" };
  assert.equal(p.key(app, ev("1"), cx), true);
  assert.equal(s.split, "done", "a number does not change the split under the picker");
  p.key(app, ev("escape"), cx);
  assert.equal(s.pick, null);
  p.key(app, ev("W"), cx);
  assert.equal(s.view, "watches");
  p.render(app, t);
  p.key(app, ev("space"), cx);
  assert.deepEqual(log.filter((l) => l[0] === "patch").at(-1), ["patch", "/slack/watches/w1", { enabled: false }]);
  p.key(app, ev("e"), cx);
  assert.deepEqual(log.filter((l) => l[0] === "patch").at(-1), ["patch", "/slack/watches/w1", { priority: "P0" }]);
  p.key(app, ev("d"), cx);
  assert.equal(log.at(-1)[1].call.method, "DELETE");
  p.key(app, ev("j"), cx);
  p.key(app, ev("d"), cx);
  assert.match(log.at(-1)[1], /built-in/);
  p.key(app, ev("n"), cx);
  assert.equal(log.at(-1)[1].kind, "slack_watch");
  p.key(app, ev("escape"), cx);
  assert.equal(s.view, "inbox");
});

test("Slack: a new candidate or none sends no target key; a card or backlog item sends its id", () => {
  const choices = relationChoices({ conversation: { shortlist: [{ id: "b1", kind: "backlog", title: "x" }, { id: "t1", kind: "card", title: "y" }] } });
  assert.deepEqual(choices.map(relationBody), [
    { relation: "related_to_backlog", target: "b1" },
    { relation: "related_to_in_progress", target: "t1" },
    { relation: "new_candidate" },
    { relation: "none" },
  ]);
  for (const b of choices.slice(-2).map(relationBody)) assert.ok(!("target" in b));
});

test("Jira: the search input is tracked and its state is not the configured flag's", () => {
  const { app, cx, log } = fake({ page: "jira" });
  const p = page("jira");
  p.enter(app, cx);
  assert.ok(log.some((l) => l[0] === "track"), "trackInput is called for the search input");
  const states = Object.keys(app.state("jira-page"));
  assert.ok(states.includes("input"));
  assert.equal(app.state("jira").input, undefined, "actions.js's key stays its own");
  p.key(app, ev("q"), cx);
  assert.deepEqual(log.at(-1), ["go", "board"]);
});

// ---- Floor ----

const M7 = {
  since: iso(NOW), tasks: { created: 3, closed: 2, open: 4, waitingOnYou: 1, running: 1, queued: 0 },
  gates: { answered: 5, withinSla: 0.8, waitMs: { awaiting_approval: { median: 60000 }, awaiting_ship: { median: 120000 } } },
  byRepo: [{ repo: "/w/shop", tasks: { closed: 2, created: 3, open: 4, waitingOnYou: 1 }, escalationRate: 0.1, firstPassVerifying: 0.5, costUsd: 3 }],
};

test("Floor: a wait row for every gate state, the Slack block, image and graph lines, the latch by owner", () => {
  const rows = floorRows(M7, null).map((r) => r.label);
  assert.ok(rows.includes("Wait approval (median)") && rows.includes("Wait ship (median)"));
  const sm = slackMetricRows(
    { items: { P0: 1, P1: 4 }, replied: { P0: 1, P1: 2 }, withinHour: 2, withinSla: { P0: 1, P1: 1 }, sla: { P0: 600, P1: 1800, P2: 3600, P3: 3600 }, timeToReply: { P0: { median: 600, p90: 600 } } },
    { items: { P0: 2 }, replied: {} },
  );
  assert.deepEqual(sm[0], ["P0", "1 / 2", "1 / 0", "1 · 100%", "10m 00s / 10m 00s"]);
  assert.equal(sm.at(-1)[1], "10m/30m/1h/1h");
  assert.deepEqual(slackMetricRows(null, null), []);
  const h = { repo: "/w/shop", image: { inUse: "luna:x", base: "python:3", builtAt: iso(NOW - 3600000), lastFailure: "boom" }, graph: { on: true, commit: "abcdef123456", behind: 3, building: true } };
  assert.match(imageLine(h, NOW), /image: own on python:3 \(luna:x\) · built 1h 0m ago · build failed: boom/);
  assert.match(graphLine(h, NOW), /graph: abcdef1 · 3 behind · building/);
  assert.equal(graphLine({ graph: { on: false } }), "graph: off");
  assert.equal(latchedWords({ owner: "claude", until: "2026-11-12T14:30:00Z" }), "claude until 14:30 UTC");
});

test("Floor: tab focuses a repo and reads its numbers; the page draws the Slack block and per-repo needs-you", async () => {
  const reads = {};
  const { app, cx, log } = fake({ page: "floor" });
  app.machine.get = async (p) => {
    log.push(["get", p]);
    if (p.startsWith("/metrics?since=7d&groupBy=repo")) return M7;
    if (p.startsWith("/slack/metrics")) return { items: { P0: 1 }, replied: {}, sla: { P0: 600 } };
    if (p === "/repos") return [{ repo: "/w/shop", image: { inUse: "x" }, graph: { on: false } }, { repo: "/w/idle", image: { inUse: "x" }, graph: { on: false } }];
    return reads[p] ?? (p.startsWith("/metrics") ? { ...M7, byRepo: [] } : []);
  };
  loadFloor(app, cx);
  await new Promise((r) => setTimeout(r, 10));
  const st = app.state("floor");
  const p = page("floor");
  p.key(app, ev("tab"), cx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(st.focus, 1);
  assert.ok(log.some((l) => l[0] === "get" && l[1] === "/metrics?since=7d&repo=%2Fw%2Fshop"));
  assert.ok(log.some((l) => l[0] === "get" && l[1] === "/metrics?since=7d&groupBy=engine&repo=%2Fw%2Fshop"));
  const words = texts(p.render(app, t)).join("|");
  assert.match(words, /Floor · shop/);
  assert.match(words, /slack \(7 \/ 30 days\)/i);
  assert.match(words, /Needs you/);
  assert.match(words, /graph: off/);
  p.key(app, ev("shift-tab"), cx);
  assert.equal(st.focus, 0);
  p.key(app, ev("A"), cx);
  assert.match(log.at(-1)[1], /no base image/);
  st.repos = [{ repo: "/w/shop", image: { pendingBase: "py:3" } }];
  p.key(app, ev("A"), cx);
  assert.equal(log.at(-1)[1].call.path, "/repos/base/approve");
});

// ---- Alerts ----

const withSla = (task, sla) => ({ ...task, sla });

test("alerts: nothing at start-up, then each change once", () => {
  const waiting = gate({ id: "w" });
  const running = task({ id: "r", running: true });
  const app = { loaded: true, link: "live", tasks: [waiting, running], prs: { inbox: { prs: [{ repo: "o/a", number: 1, title: "t", split: "mine" }] } } };
  const st = {};
  assert.deepEqual(scan(app, st, { event: "ready", data: {} }), [], "the first message only seeds");
  assert.deepEqual(scan(app, st, { event: "task.updated", data: { task: waiting } }), [], "a ticket already waiting is not news");
  const into = { ...running, state: "awaiting_approval", waitingOnYou: true, running: false };
  const n1 = scan(app, st, { event: "task.updated", data: { task: into } });
  assert.equal(n1.length, 1);
  assert.equal(n1[0].title, "Needs you");
  assert.deepEqual(scan(app, st, { event: "task.updated", data: { task: into } }), [], "once");
  const esc = { ...into, state: "escalated", waitingOnYou: false, reason: "plan_wrong" };
  const n2 = scan(app, st, { event: "task.updated", data: { task: esc } });
  assert.equal(n2[0].title, "Escalated", "a move from a gate to escalated is Escalated, not Waiting on you");
  assert.match(n2[0].body, /the plan is wrong/);
  const paused = { ...esc, state: "paused_rate_limit", reason: null };
  assert.equal(scan(app, st, { event: "task.updated", data: { task: paused } })[0].title, "Paused on a usage limit");
  // SLA clocks flip once
  const late = withSla(task({ id: "r" }), { gate: { overdue: true, targetSecs: 3600 }, stage: { overdue: true, stage: "implementing" } });
  const titles = scan(app, st, { event: "task.updated", data: { task: late } }).map((n) => n.title);
  assert.deepEqual(titles, ["Gate overdue", "Stage over SLA"]);
  assert.deepEqual(scan(app, st, { event: "task.updated", data: { task: late } }), []);
  // Jira moved
  const ev1 = { taskId: "w", kind: "jira.moved", payload: { key: "PLAT-1", status: "Done" }, at: "t1" };
  app.tasks = [waiting];
  const j = scan(app, st, { event: "task.event", data: { event: ev1 } });
  assert.equal(j[0].body, `PLAT-1 moved to Done while #${waiting.id.slice(0, 8)} waits`);
  assert.deepEqual(scan(app, st, { event: "task.event", data: { event: ev1 } }), []);
  // PRs
  const prs = [{ repo: "o/a", number: 1, title: "t", split: "ci_failed" }, { repo: "o/b", number: 2, title: "u", split: "review_requested" }, { repo: "o/c", number: 3, title: "v", split: "ci_running" }];
  const pn = scan(app, st, { event: "github.prs", data: { snapshot: { prs } } }).map((n) => n.title);
  assert.deepEqual(pn, ["CI failed", "Review requested"]);
  assert.deepEqual(scan(app, st, { event: "github.prs", data: { snapshot: { prs } } }), []);
  assert.equal(prNotice("ci_failed", prs[0]), null);
  // budget
  assert.equal(scan(app, st, { event: "budget.alert", data: { alert: { engine: "claude:opus", pct: 90 } } }).length, 1);
  assert.equal(scan(app, st, { event: "budget.alert", data: { alert: { engine: "claude:opus", pct: 90 } } }).length, 0);
});

test("alerts: Slack seeds from the first snapshot, then Reopened, Overdue and P0/P1 into Needs reply", () => {
  const item = (id, over = {}) => ({ id, split: "fyi", triage: { priority: "P1", summary: "deploy" }, channel: { name: "ops", kind: "channel" }, author: { name: "ann" }, text: "t", ...over });
  const app = { loaded: true, link: "live", tasks: [], prs: {} };
  const st = {};
  scan(app, st, { event: "ready", data: {} });
  const first = scan(app, st, { event: "slack.items", data: { snapshot: { items: [item("a", { split: "needs_reply" })] } } });
  assert.deepEqual(first, [], "what the first snapshot holds is not news");
  const snap = (items, quiet = false) => ({ event: "slack.items", data: { snapshot: { items, quiet } } });
  assert.deepEqual(scan(app, st, snap([item("a", { split: "needs_reply" })])), []);
  const n = scan(app, st, snap([item("a", { split: "needs_reply" }), item("b", { split: "decide" }), item("c", { split: "needs_reply", triage: { priority: "P2" } })]));
  assert.deepEqual(n.map((x) => x.title), ["Decide"]);
  assert.equal(n[0].body, "#ops @ann: deploy");
  assert.equal(scan(app, st, snap([item("a", { split: "needs_reply", overdue: true })]))[0].title, "Overdue");
  assert.equal(scan(app, st, snap([item("a", { split: "needs_reply", overdue: true, reopenedAt: "2026-11-12T10:00:00Z" })]))[0].title, "Reopened");
  assert.equal(scan(app, st, snap([item("a", { split: "needs_reply", overdue: true, reopenedAt: "2026-11-12T10:00:00Z" })])).length, 0);
  assert.equal(slackNotice(undefined, item("q", { split: "needs_reply" }), true), null, "quiet hours hold a P1");
  assert.equal(slackNotice(undefined, item("q", { split: "needs_reply", triage: { priority: "P0" } }), true).title, "Needs reply");
});

test("alerts: the link going away and coming back, and nothing before the board has loaded", () => {
  assert.equal(linkNotice("live", { link: "offline", error: "refused" }).title, "Machine offline");
  assert.equal(linkNotice("offline", { link: "polling" }).title, "Machine back");
  assert.equal(linkNotice("live", { link: "polling" }), null);
  assert.equal(linkNotice(null, { link: "offline" }), null);
  assert.deepEqual(scan({ loaded: false, tasks: [] }, {}, { event: "task.updated", data: { task: gate() } }), []);
  assert.equal(taskNotices(undefined, gate()).notices[0].title, "Needs you");
});

test("alerts: the hidden page posts a Herdr notification with a click action, once", () => {
  const p = page("luna-alerts");
  assert.equal(p.hidden, true);
  const waiting = task({ id: "z", running: true });
  const { app, cx } = fake({ tasks: [waiting], page: "board" });
  calls.length = 0;
  p.onMessage(app, { event: "ready", data: {} }, cx);
  const into = { ...waiting, state: "awaiting_approval", waitingOnYou: true, running: false };
  p.onMessage(app, { event: "task.updated", data: { task: into } }, cx);
  p.onMessage(app, { event: "task.updated", data: { task: into } }, cx);
  const posted = calls.filter((c) => c[0] === "notify");
  assert.equal(posted.length, 1);
  assert.equal(posted[0][1].title, "Needs you");
  assert.deepEqual(posted[0][1].action, { name: "luna.focus" });
});
