// The Slack, Economy and Jira pages: their pure rules, and every page and dialog drawn with the
// host stand-in on realistic data and on the states that go wrong (not configured, errors,
// empty lists, fields the machine leaves out).
import assert from "node:assert/strict";
import { test } from "node:test";

import { theme } from "./host/stub.js";
import "../luna/features.js";
import { COMMANDS, DIALOGS, PAGES } from "../luna/registry.js";
import * as m from "../luna/integrations-model.js";
import { slackPage } from "../luna/page-slack.js";
import { economyPage } from "../luna/page-economy.js";
import { jiraPage } from "../luna/page-jira.js";

const t = theme();
const NOW = Date.parse("2026-11-12T12:00:00Z");
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

const item = (id, split, priority, minAgo, over = {}) => ({
  id, kind: "mention", split, ts: iso(minAgo), text: `message ${id}`, matched: ["me"], count: 1, replies: 0, overdue: false, dueAt: null,
  channel: { id: "C1", name: "luna-tui", kind: "channel" }, author: { id: "U1", name: "Ana" }, permalink: `https://x.slack.com/${id}`, linked: {},
  triage: priority ? { priority, category: "request", expectsReply: true, summary: `summary ${id}`, why: "asked directly", draft: "On it.", refs: [{ kind: "pr", ref: "o/r#1" }], deadline: null, overridden: false } : null,
  ...over,
});

const ITEMS = [
  item("a", "needs_reply", "P2", 50),
  item("b", "needs_reply", "P0", 30),
  item("c", "needs_reply", "P1", 90, { overdue: true, dueAt: iso(40) }),
  item("d", "decide", "P1", 10, { draft: { id: "d1", hash: "h1", kind: "reply", text: "Draft text", expiresAt: new Date(NOW + 7200000).toISOString() }, conversation: { classification: { kind: "request", confidence: 0.8, by: "model", verdict: "ask", total: 7, knockOut: "outage", scores: { who: { score: 3, confidence: 0.9 } } }, relation: { type: "none" }, shortlist: [{ id: "t1", kind: "backlog", title: "Fix login", otherSource: { kind: "jira", key: "PLAT-1" } }], redactions: 2 } }),
  item("e", "fyi", "P3", 5),
  item("f", "waiting_on_them", "P2", 120, { linked: { taskId: "task-1", pr: { repo: "o/r", number: 4, split: "review_requested" } } }),
  item("g", "snoozed", null, 200, { reopenedAt: iso(1), channel: { id: "D1", name: "", kind: "dm" } }),
  item("h", "done", "P1", 300, { overdue: true, channel: { id: "G1", name: "x", kind: "mpim" } }),
  { id: "bare", split: "fyi", ts: iso(1) },
];
const WATCHES = [
  { id: "w1", kind: "broadcast", value: "here", label: "@here", channels: [], enabled: true, builtin: true, priority: null },
  { id: "w2", kind: "keyword", value: "deploy", label: "deploy", channels: ["C1"], enabled: false, builtin: false, priority: "P1" },
  { id: "w3", kind: "usergroup", value: "S1", label: "@platform", enabled: true },
];
const SNAP = { items: ITEMS, watches: WATCHES, polledAt: iso(2), error: null, socket: "connected", sla: { P0: 600, P1: 1800, P2: 3600, P3: 3600 } };

const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};

function app(over = {}, states = {}) {
  const store = states;
  return {
    machine: { get: async () => ({}), post: async () => ({}), patch: async () => ({}), del: async () => null },
    tasks: [{ id: "task-1", title: "Fix it", repoPath: "/w/luna-tui", jira: { key: "PLAT-9", status: "Open", url: "https://j/PLAT-9", blocked: { wanted: "Done", why: "no transition" } } }, { id: "task-2", title: "Bare", repoPath: "/w/shop" }],
    busy: new Set(), flash: null, width: 1400, query: "", selected: null, page: "slack",
    state: (id) => (store[id] ??= {}), say() {}, run() {}, go() {}, select() {}, openUrl() {}, dialog() {}, confirm() {},
    ...over,
  };
}

// ---- pure rules ----

test("the splits come in the TUI's order and count", () => {
  const needs = m.slackItems(ITEMS, "needs_reply").map((i) => i.id);
  assert.deepEqual(needs, ["c", "b", "a"], "the overdue first, then P0, then P2");
  assert.deepEqual(m.slackItems(ITEMS, "fyi").map((i) => i.id), ["bare", "e"], "the others newest first");
  const c = m.slackCounts(ITEMS);
  assert.equal(c.needs_reply, 3);
  assert.equal(c.done, 1);
  assert.equal(m.overdueCount(ITEMS), 1, "the overdue item in Done does not count");
  assert.deepEqual(m.slackBadge(SNAP), { n: 3, tone: "error" });
  assert.deepEqual(m.slackBadge({ items: [item("z", "needs_reply", "P2", 1)] }), { n: 1, tone: null });
  assert.equal(m.slackBadge({ items: [] }), null);
  assert.equal(m.slackBadge(null), null);
});

test("priority steps, blockers and the snooze times", () => {
  assert.equal(m.priorityStep("P1", true), "P0");
  assert.equal(m.priorityStep("P0", true), null);
  assert.equal(m.priorityStep("P3", false), null);
  assert.equal(m.priorityStep("P1", false), "P2");
  assert.equal(m.priorityStep(undefined, true), null);
  assert.equal(m.blocker(item("x", "needs_reply", "P0", 1), "up"), "already P0");
  assert.equal(m.blocker(item("x", "needs_reply", null, 1), "down"), "not triaged yet");
  assert.equal(m.blocker(item("x", "needs_reply", "P1", 1), "nudge"), "only while waiting on them");
  assert.equal(m.blocker(item("x", "waiting_on_them", "P1", 1), "nudge"), null);
  assert.equal(m.blocker(item("x", "needs_reply", "P1", 1), "kind"), "not assessed yet");
  assert.equal(m.blocker(item("x", "done", "P1", 1, { linked: { taskId: "t" } }), "task"), "already a ticket");
  const now = Date.parse("2026-11-12T12:00:00Z") / 1000; // a Thursday
  assert.equal(m.snoozeUntil(0, now, 0), now + 3600);
  assert.equal(m.snoozeUntil(1, now, 0), now + 10800);
  assert.equal(new Date(m.snoozeUntil(2, now, 0) * 1000).toISOString(), "2026-11-13T09:00:00.000Z");
  assert.equal(new Date(m.snoozeUntil(3, now, 0) * 1000).toISOString(), "2026-11-16T09:00:00.000Z");
  assert.equal(new Date(m.snoozeUntil(3, now, 3600) * 1000).toISOString(), "2026-11-16T08:00:00.000Z", "9:00 local, a zone east of UTC");
  const monday = Date.parse("2026-11-16T12:00:00Z") / 1000;
  assert.equal(new Date(m.snoozeUntil(3, monday, 0) * 1000).toISOString(), "2026-11-23T09:00:00.000Z", "a Monday snoozes to the next one");
});

test("due words, reply and relation bodies", () => {
  const soon = item("s", "needs_reply", "P1", 1, { dueAt: new Date(NOW + 180000).toISOString() });
  assert.equal(m.dueLabel(soon, NOW), "due in 3m");
  assert.ok(m.dueSoon(soon, NOW));
  assert.equal(m.dueLabel(item("o", "needs_reply", "P1", 1, { overdue: true, dueAt: iso(40) }), NOW), "overdue 40m");
  assert.equal(m.dueLabel({}, NOW), null);
  assert.deepEqual(m.replyBody("hi", false, { id: "d", hash: "h" }), { text: "hi", nudge: false, draftId: "d", draftHash: "h" });
  assert.deepEqual(m.replyBody("hi", true, null), { text: "hi", nudge: true });
  assert.equal(m.itemPath("C0123:1730.0001", "/reply"), "/slack/items/C0123%3A1730.0001/reply");
  assert.deepEqual(m.doneBody("bad_draft"), { done: true, reason: "bad_draft" });
  assert.deepEqual(m.doneBody(null), { done: true });
  const d = ITEMS.find((i) => i.id === "d");
  assert.equal(m.draftText(d), "Draft text");
  assert.deepEqual(m.draftRef(d), { id: "d1", hash: "h1" });
  assert.equal(m.draftText(ITEMS[0]), "On it.");
  const choices = m.relationChoices(d);
  assert.equal(choices[0].relation, "related_to_backlog");
  assert.equal(choices[0].target, "t1");
  assert.match(choices[0].label, /from jira PLAT-1/);
  assert.deepEqual(choices.slice(-2).map((c) => c.relation), ["new_candidate", "none"]);
  assert.equal(m.relationChoices({}).length, 2);
  const lines = m.conversationLines(d, NOW).map(([n]) => n);
  assert.deepEqual(lines, ["kind", "scores", "knock-out", "asks you", "relation", "cut", "waiting"]);
  assert.equal(m.slaTargets({ P0: 600, P1: 1800, P2: 0 }), "10m/30m/-/-");
});

test("watches: kinds, completions, bodies, scope and the floor cycle", () => {
  assert.deepEqual(m.watchKindOf("@plat"), { kind: "usergroup", text: "plat" });
  assert.deepEqual(m.watchKindOf("#eng"), { kind: "channel", text: "eng" });
  assert.deepEqual(m.watchKindOf("deploy"), { kind: "keyword", text: "deploy" });
  const catalog = { groups: [{ id: "S1", handle: "platform", name: "Platform team" }, { id: "S2", label: "design" }], channels: [{ id: "C1", name: "eng", kind: "channel" }, { id: "C2", name: "luna" }] };
  assert.deepEqual(m.watchMatches("@plat", catalog).map((o) => o.id), ["S1"]);
  assert.deepEqual(m.watchMatches("@", catalog).map((o) => o.label), ["platform", "design"]);
  assert.deepEqual(m.watchMatches("#lu", catalog).map((o) => o.id), ["C2"]);
  assert.deepEqual(m.watchMatches("word", catalog), []);
  assert.deepEqual(m.watchMatches("@x", {}), []);
  assert.deepEqual(m.watchInput("deploy", [], 0).body, { kind: "keyword", value: "deploy", label: "deploy" });
  assert.deepEqual(m.watchInput("@plat", m.watchMatches("@plat", catalog)).body, { kind: "usergroup", value: "S1", label: "@platform" });
  assert.deepEqual(m.watchInput("#eng", m.watchMatches("#eng", catalog)).body, { kind: "channel", value: "C1", label: "#eng" });
  assert.match(m.watchInput("#zz", [], 0).error, /No channel matches/);
  assert.match(m.watchInput("  ", [], 0).error, /Type/);
  assert.equal(m.watchScope(WATCHES[1]), "P1 · in C1");
  assert.equal(m.watchScope(WATCHES[2]), "as mention");
  assert.equal(m.watchScope(WATCHES[0]), "");
  assert.deepEqual([null, "P0", "P1", "P2"].map(m.nextFloor), ["P0", "P1", "P2", null]);
});

test("the setup notices say what the machine says", () => {
  assert.equal(m.slackSetup(SNAP, null), null);
  assert.match(m.slackSetup(null, "no machine answers").body, /no machine/);
  assert.equal(m.slackSetup({ items: [], error: "invalid_auth", socket: "off" }, null).title, "Slack says");
  assert.match(m.slackSetup({ items: [], socket: "off", polledAt: null, error: null }, null).title, /not set up/);
  assert.match(m.slackSetup({ items: [], socket: "connected", polledAt: iso(1), scope: "opted_in", optedIn: 0 }, null).title, /No conversation/);
  assert.equal(m.slackSetup(null, null), null);
  assert.equal(m.guessRepo("luna-tui", [{ repoPath: "/w/luna-tui" }, { repoPath: "/w/shop" }]), "/w/luna-tui");
  assert.equal(m.guessRepo("random", [{ repoPath: "/w/shop" }]), null);
  assert.equal(m.guessRepo("", []), null);
});

const ECO = {
  envelopes: { build: { samples: 9, envelope: 12345.6 }, plan: { samples: 2, envelope: null } },
  guard: [{ action: "stopped", calls: 40, cause: "loop", at: iso(5), runId: "r1", pack: "build" }, { action: "warned", calls: 20, at: iso(50), runId: "r2", pack: "plan", failure: "x\ny" }],
  cost: { exec: 1000, overhead: 100, overheadShare: 0.0909, overheadUnpriced: 2 },
  facts: [{ id: "f1", family: "tooling", source: "run", state: "candidate", text: "uses pnpm", confirmations: 2 }, { id: "f2", family: "tooling", source: "run", state: "active", text: "tests: vitest\nrun" }, { id: "f3", state: "dropped", text: "gone" }],
  tools: { build: { mask: ["web"], proposal: [{ unit: "luna:foo", unusedRuns: 7, cards: 3 }] } },
};

test("the economy rows, their rules and the cost lines", () => {
  const rows = m.economyRows(ECO);
  assert.deepEqual(rows.map((r) => r.kind), ["fact", "fact", "fact", "masked", "proposed", "guard", "guard"]);
  assert.equal(rows[0].fact.id, "f2", "active facts first");
  assert.equal(rows[0].text, "tests: vitest run", "a stranger's text is one line");
  assert.ok(m.canDrop(rows[0]) && m.canDrop(rows[1]) && !m.canDrop(rows[2]) && !m.canDrop(rows[3]));
  assert.equal(rows[5].guard.action, "stopped", "the newest guard event first");
  assert.deepEqual(m.proposedUnits(ECO, "build"), ["luna:foo"]);
  assert.deepEqual(m.proposedUnits({}, "build"), []);
  const cost = m.costLines(ECO).join(" | ");
  assert.match(cost, /exec 1000 · overhead 100/);
  assert.match(cost, /overhead share 9\.1%/);
  assert.match(cost, /2 overhead runs had no token count/);
  assert.match(cost, /plan: learning \(2 samples\)/);
  assert.deepEqual(m.economyRows({}), []);
  assert.deepEqual(m.economyRows(null), []);
  assert.deepEqual(m.economyRepos([{ repoPath: "/b" }, { repoPath: "/a" }, {}], [{ repo: "/c" }, { repo: "/a" }, "nope", null]), ["/a", "/b", "/c"]);
  assert.equal(m.repoName("/w/shop/"), "shop");
});

test("the Jira summary, keys and hits", () => {
  assert.equal(m.jiraSummary(null, true).configured, false);
  assert.equal(m.jiraSummary(null, false, "refused").tone, "error");
  assert.equal(m.jiraSummary(null, false, null).configured, null);
  assert.equal(m.jiraSummary({ configured: false }, false, null).configured, false);
  const ok = m.jiraSummary({ configured: true, site: "acme.atlassian.net", tokenExpiresAt: new Date(NOW + 5 * 86400000).toISOString() }, false, null, NOW);
  assert.equal(ok.text, "acme.atlassian.net · token expires in 5d");
  assert.equal(ok.tone, "blocked", "a token inside two weeks is a warning");
  assert.equal(m.jiraSummary({ configured: true, site: "s", error: "401" }, false, null, NOW).tone, "error");
  assert.equal(m.jiraSummary({ configured: true }, false, null, NOW).text, "connected");
  assert.ok(m.isJiraKey("PLAT-7") && !m.isJiraKey("plat-7") && !m.isJiraKey("two words"));
  assert.deepEqual(m.hit({ key: "A-1" }), { key: "A-1", summary: "", status: null, issueType: null, url: "" });
  assert.equal(m.hit(null).key, "");
});

// ---- drawing ----

test("the three pages are registered with their commands", () => {
  for (const id of ["slack", "economy", "jira"]) {
    assert.ok(PAGES.find((p) => p.id === id), id);
    assert.equal(typeof COMMANDS[id], "function");
  }
  let went = null;
  COMMANDS.slack(app({ go: (p) => (went = p) }), "", {});
  assert.equal(went, "slack");
  assert.equal(PAGES.find((p) => p.id === "slack").badge(app({}, { slack: { snap: SNAP } })).tone, "error");
});

test("the Slack page draws every split, an open item, each picker, the watches and the failures", () => {
  for (const [split] of m.SLACK_SPLITS) {
    for (const sel of [null, ...ITEMS.filter((i) => i.split === split).map((i) => i.id)]) {
      const el = slackPage(app({}, { slack: { snap: SNAP, split, sel } }), t);
      assert.ok(el, `${split} ${sel}`);
    }
  }
  const words = texts(slackPage(app({}, { slack: { snap: SNAP, split: "decide", sel: "d" } }), t)).join(" | ");
  assert.match(words, /Draft waiting for you/);
  assert.match(words, /asks you/);
  assert.match(words, /Reply/);
  const overdue = texts(slackPage(app({}, { slack: { snap: SNAP, split: "needs_reply" } }), t)).join(" | ");
  assert.match(overdue, /overdue/);
  assert.match(overdue, /1 overdue/);
  for (const kind of ["snooze", "dismiss", "kind", "relation"]) {
    slackPage(app({}, { slack: { snap: SNAP, split: "decide", sel: "d", pick: { kind, id: "d" } } }), t);
  }
  slackPage(app({}, { slack: { snap: SNAP, view: "watches" } }), t);
  assert.match(texts(slackPage(app({}, { slack: { snap: SNAP, view: "watches" } }), t)).join(" | "), /built in/);
  slackPage(app({}, { slack: { snap: { ...SNAP, watches: [] }, view: "watches" } }), t);
  slackPage(app({ width: 700 }, { slack: { snap: SNAP, sel: "a" } }), t);
  slackPage(app({ query: "summary b" }, { slack: { snap: SNAP } }), t);
  // not set up, refused, empty, loading
  assert.match(texts(slackPage(app({}, { slack: { snap: { items: [], watches: [], socket: "off", polledAt: null, error: null } } }), t)).join(" | "), /make integrations/);
  assert.match(texts(slackPage(app({}, { slack: { snap: { items: [], error: "invalid_auth", socket: "off", polledAt: iso(1) } } }), t)).join(" | "), /invalid_auth/);
  assert.match(texts(slackPage(app({}, { slack: { error: "no machine answers" } }), t)).join(" | "), /no machine answers/);
  slackPage(app({}, { slack: { snap: { items: [], watches: [], socket: "connected", polledAt: iso(1), scope: "opted_in", optedIn: 0 } } }), t);
  slackPage(app({}, { slack: {} }), t);
  slackPage(app({}, { slack: { snap: {} } }), t);
  slackPage(app({ busy: new Set(["slack-a"]), flash: { text: "x", tone: "error" } }, { slack: { snap: SNAP, sel: "a", polling: true } }), t);
});

test("the Slack dialogs draw, fill and refuse as they should", async () => {
  const cx = { spawn: (f) => f({ notify() {} }), timer: { after() {} }, notify() {} };
  const calls = [];
  const d = (extra = {}) => ({ ...extra, machine: { get: async () => [{ id: "S1", handle: "platform" }], post: async (p, b) => (calls.push([p, b]), { id: "task-9" }) }, sent: null, error: null });
  // reply
  const reply = DIALOGS.slack_reply;
  const spec = { itemId: "C1:1.2", text: "On it.", draft: { id: "d1", hash: "h1" }, context: ["Ana: hi"], nudge: false };
  const a = d();
  a.send = (_cx, call) => call().then((r) => (a.sent = r));
  a.fail = (_cx, msg) => (a.error = msg);
  reply.init(a, cx, spec);
  assert.ok(reply.body(a, t, spec).length > 2);
  assert.equal(reply.primary(a, spec).label, "Post as me");
  a.reply = { value: () => "  " };
  reply.submit(a, cx, spec);
  assert.equal(a.error, "Nothing to send.");
  a.reply = { value: () => "On it." };
  await reply.submit(a, cx, spec);
  assert.deepEqual(calls[0], ["/slack/items/C1%3A1.2/reply", { text: "On it.", nudge: false, draftId: "d1", draftHash: "h1" }]);
  // refused without the user token: the dialog says how to fix it
  a.machine.post = async () => Promise.reject(Object.assign(new Error("409"), { code: "no_token" }));
  a.send = (_cx, call) => call().catch((e) => (a.error = e.message));
  await reply.submit(a, cx, spec);
  assert.match(a.error, /MACHINE_SLACK_USER_TOKEN/);
  // ticket
  const task = DIALOGS.slack_task;
  const tspec = { itemId: "C1:1.2", title: "Fix", repo: "/w/luna-tui", repos: ["/w/luna-tui", "/w/shop"] };
  const b = d();
  b.send = (_cx, call) => call().then((r) => (b.sent = r));
  b.fail = (_cx, msg) => (b.error = msg);
  task.init(b, cx, tspec);
  b.ticketTitle = { value: () => "Fix it" };
  assert.ok(task.body(b, t, tspec).length > 3);
  await task.submit(b, cx, tspec);
  assert.deepEqual(calls.at(-1), ["/slack/items/C1%3A1.2/task", { title: "Fix it", repoPath: "/w/luna-tui" }]);
  assert.deepEqual(b.sent, { select: "task-9" });
  b.ticketTitle = { value: () => "" };
  task.submit(b, cx, tspec);
  assert.equal(b.error, "Give it a title.");
  // watch
  const w = DIALOGS.slack_watch;
  const c = d();
  c.send = (_cx, call) => call().then((r) => (c.sent = r));
  c.fail = (_cx, msg) => (c.error = msg);
  w.init(c, cx, {});
  await new Promise((r) => setTimeout(r, 0));
  for (const q of ["", "@plat", "#nothing", "word"]) {
    c.watchQuery = { value: () => q };
    assert.ok(Array.isArray(w.body(c, t, {})), q);
  }
  c.watchQuery = { value: () => "@plat" };
  await w.submit(c, cx, {});
  assert.deepEqual(calls.at(-1), ["/slack/watches", { kind: "usergroup", value: "S1", label: "@platform" }]);
  c.watchQuery = { value: () => "#zz" };
  w.submit(c, cx, {});
  assert.match(c.error, /No channel matches/);
  c.catalog = { groups: null, channels: null };
  w.body(c, t, {});
});

test("the Economy page draws facts, tools, guard and every failure", () => {
  const rows = m.economyRows(ECO);
  for (const r of [null, ...rows]) economyPage(app({ page: "economy" }, { economy: { repo: "/w/shop", data: ECO, sel: r?.id ?? null } }), t);
  const words = texts(economyPage(app({}, { economy: { repo: "/w/shop", data: ECO, sel: rows.find((r) => r.kind === "proposed").id } }), t)).join(" | ");
  assert.match(words, /Approve build's mask/);
  assert.match(words, /Restore the tool/);
  assert.match(words, /overhead share/);
  const ask = { text: "Drop it?", label: "Drop", danger: true, run() {} };
  economyPage(app({}, { economy: { repo: "/w/shop", data: ECO, ask } }), t);
  assert.match(texts(economyPage(app({}, { economy: { repo: "/w/shop", off: true } }), t)).join(" | "), /economy is off/i);
  economyPage(app({}, { economy: { repo: "/w/shop", error: "unknown repo" } }), t);
  economyPage(app({}, { economy: { repo: "/w/shop", data: {} } }), t);
  economyPage(app({}, { economy: { repo: "/w/shop" } }), t);
  economyPage(app({ tasks: [] }, { economy: {} }), t);
  economyPage(app({ width: 700 }, { economy: { repo: "/w/shop", data: ECO } }), t);
});

test("the Jira page draws search, a selected ticket, and not-configured, absent and failing states", () => {
  const hits = [{ key: "PLAT-1", summary: "Fix login", status: "In Progress", issueType: "Bug", url: "https://j/PLAT-1" }, { key: "PLAT-2" }];
  const ok = { status: { configured: true, site: "acme.atlassian.net", tokenExpiresAt: null, error: null }, hits, q: "login", input: {} };
  assert.match(texts(jiraPage(app({ selected: "task-2" }, { jira: ok }), t)).join(" | "), /Link to the ticket/);
  assert.match(texts(jiraPage(app({ selected: "task-1" }, { jira: ok }), t)).join(" | "), /Unlink/);
  assert.match(texts(jiraPage(app({ selected: "task-1" }, { jira: { ...ok, hits: [{ ...hits[0], key: "PLAT-9" }] } }), t)).join(" | "), /linked/);
  jiraPage(app({}, { jira: ok }), t);
  jiraPage(app({ selected: "task-2" }, { jira: { ...ok, q: "PLAT-7", hits: [] } }), t);
  jiraPage(app({ selected: "task-2" }, { jira: { ...ok, ask: { text: "Create?", label: "Create", run() {} } } }), t);
  jiraPage(app({}, { jira: { ...ok, hits: [], q: "zzzz" } }), t);
  jiraPage(app({}, { jira: { ...ok, searchError: "502", hits: [] } }), t);
  jiraPage(app({}, { jira: { ...ok, hits: [], q: "" } }), t);
  jiraPage(app({}, { jira: { ...ok, input: undefined } }), t);
  assert.match(texts(jiraPage(app({}, { jira: { status: { configured: false } } }), t)).join(" | "), /make integrations/);
  assert.match(texts(jiraPage(app({}, { jira: { absent: true } }), t)).join(" | "), /not set up/);
  assert.match(texts(jiraPage(app({}, { jira: { error: "no machine answers" } }), t)).join(" | "), /no machine answers/);
  jiraPage(app({}, { jira: {} }), t);
  jiraPage(app({ tasks: undefined }, { jira: ok }), t);
});
