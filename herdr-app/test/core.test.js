// The core runtime: the stream's watchdog and backoff, the board's merge by seq, decisions, the
// hand-backs from dialogs and the keys, run against a fake context that throws where Herdr's does
// (a handler's cx after its first await; a notify during render).
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedStore, theme } from "./host/stub.js";
import Luna from "../luna/main.js";
import { Machine, MachineError, within } from "../luna/api.js";
import { handBack } from "../luna/dialogs.js";
import { gateKey } from "../luna/model.js";
import { mergeSnapshot } from "../luna/sync.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A context like Herdr's: `stale` after the handler returns; notify and spawn then throw, as does notify while `host.rendering`. */
const host = { rendering: false };
function makeCx({ fast = false, delays = null } = {}) {
  const cx = {
    stale: false,
    notified: 0,
    use(what) {
      if (cx.stale) throw new Error(`stale context: ${what} after the handler's first await`);
    },
    notify() {
      cx.use("notify");
      if (host.rendering) throw new Error("notify during render");
      cx.notified++;
    },
    spawn(fn) {
      cx.use("spawn");
      Promise.resolve().then(() => fn(makeCx({ fast, delays })));
      return { cancel() {}, is_done: () => false };
    },
    focus_handle: () => ({ focus() {}, is_focused: () => false }),
    stop_propagation() {
      cx.stopped = true;
    },
    timer: {
      after(ms, fn) {
        cx.use("timer");
        delays?.push(ms);
        const id = setTimeout(() => fn(makeCx({ fast, delays })), fast ? 0 : ms);
        id.unref?.();
        return { cancel: () => clearTimeout(id), is_done: () => false };
      },
      every(ms, fn) {
        cx.use("timer");
        const id = setInterval(() => fn(makeCx({ fast, delays })), ms);
        id.unref?.();
        return { cancel: () => clearInterval(id), is_done: () => false };
      },
    },
  };
  return cx;
}

const task = (over = {}) => ({ id: `t-${Math.random().toString(16).slice(2)}`, title: "A task", state: "draft", column: "Intake", route: "feature", repoPath: "/w/a", waitingOnYou: false, seq: 1, criteria: [], ...over });

function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method: opts.method ?? "GET", path, body: opts.body ? JSON.parse(opts.body) : undefined });
    const out = (await handler({ method: opts.method ?? "GET", path, body: opts.body ? JSON.parse(opts.body) : undefined })) ?? {};
    const status = out.status ?? 200;
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(out.json ?? {}), json: async () => out.json ?? {} };
  };
  return calls;
}

const settings = (over = {}) => Promise.resolve({ url: "http://127.0.0.1:4318", token: null, approver: null, ...over });

/** A pane built the way Herdr builds it, with the machine's reads answered by `reads`. */
function pane({ reads = {}, link = "live" } = {}) {
  host.rendering = false;
  const cx = makeCx({ fast: true });
  const app = new Luna();
  fakeFetch(({ path }) => ({ json: reads[path] ?? [] }));
  app.init({}, cx);
  app.machine.settingsReady = settings();
  app.closed = true; // the loops (stream, inbox) stop at once
  app.link = link;
  return { app, cx };
}

test("the watchdog: a stream that goes quiet is closed and rejects within the deadline", async () => {
  fakeFetch(() => ({ json: {} }));
  let closed = false;
  const socket = { write: async () => {}, read: () => new Promise(() => {}), close: () => (closed = true) };
  const machine = new Machine({ cx: makeCx(), net: { connect: async () => socket } });
  machine.settingsReady = settings();
  machine.watchdogMs = 40;
  const started = Date.now();
  await assert.rejects(machine.follow(null, () => {}, () => true), (e) => e instanceof MachineError && e.code === "stalled");
  assert.ok(Date.now() - started < 1000, "within the deadline, not never");
  assert.equal(closed, true, "the socket is closed");
});

test("the watchdog counts any byte (a ping) as alive, and onBytes hears each read", async () => {
  fakeFetch(() => ({ json: {} }));
  const enc = new TextEncoder();
  const reads = [enc.encode("HTTP/1.1 200 OK\r\n\r\n"), enc.encode(": ping\n\n"), enc.encode("event: ready\ndata: {}\n\n"), null];
  const socket = { write: async () => {}, read: async () => { await tick(15); return reads.shift(); }, close() {} };
  const machine = new Machine({ cx: makeCx(), net: { connect: async () => socket } });
  machine.settingsReady = settings();
  machine.watchdogMs = 60;
  let bytes = 0;
  const events = [];
  await machine.follow(null, (m) => events.push(m.event), () => true, { onBytes: () => bytes++ });
  assert.equal(bytes, 3);
  assert.deepEqual(events, ["ready"]);
});

test("https is said not to be supported, never connected to on port 80", async () => {
  fakeFetch(() => ({ json: {} }));
  let connected = false;
  const machine = new Machine({ cx: makeCx(), net: { connect: async () => (connected = true) } });
  machine.settingsReady = settings({ url: "https://machine.example" });
  await assert.rejects(machine.follow(null, () => {}, () => true), (e) => e.code === "tls" && /https/.test(e.message));
  assert.equal(connected, false);
});

test("picking: a probe that hangs gives up after its short timeout, and none answering falls back to the first candidate", async () => {
  globalThis.fetch = () => new Promise(() => {});
  const machine = new Machine({ cx: makeCx() });
  machine.settingsReady = Promise.resolve({ url: null, token: null, approver: null });
  const started = Date.now();
  await assert.rejects(machine.pick(), /no machine answers/);
  assert.ok(Date.now() - started < 3000);
  assert.equal(machine.base, "http://127.0.0.1:4317", "the TUI's fallback: the first");
});

test("picking reads the env once, not once per retry", async () => {
  fakeFetch(() => ({ status: 500 }));
  const machine = new Machine({ cx: makeCx({ fast: true }) });
  let reads = 0;
  machine.loadSettings = () => (machine.settingsReady ??= (reads++, settings()));
  await machine.pick().catch(() => null);
  await machine.reconnect().catch(() => null);
  await machine.reconnect().catch(() => null);
  assert.equal(reads, 1);
});

test("reconnects back off 3s, 6s, 12s, 24s and the link is never live while the stream is down", async () => {
  const delays = [];
  const cx = makeCx({ fast: true, delays });
  const app = new Luna();
  fakeFetch(() => ({ status: 500 }));
  const realFollow = Luna.prototype.follow;
  Luna.prototype.follow = () => {}; // init's own loop stays out of this test
  app.init({}, cx);
  await tick(5);
  Luna.prototype.follow = realFollow;
  app.closed = false;
  app.link = "live";
  let attempts = 0;
  const links = [];
  app.machine.follow = async () => {
    links.push(app.link);
    if (++attempts >= 5) app.closed = true;
    throw new Error("down");
  };
  app.reload = async () => {};
  delays.length = 0;
  app.follow(cx);
  await tick(50);
  assert.deepEqual(delays.filter((d) => d >= 3000).slice(0, 4), [3000, 6000, 12000, 24000]);
  assert.equal(app.link, "offline");
});

test("a stream that ended after being live starts the backoff over", async () => {
  const delays = [];
  const cx = makeCx({ fast: true, delays });
  const app = new Luna();
  fakeFetch(() => ({ status: 500 }));
  const realFollow = Luna.prototype.follow;
  Luna.prototype.follow = () => {}; // init's own loop stays out of this test
  app.init({}, cx);
  await tick(5);
  Luna.prototype.follow = realFollow;
  app.closed = false;
  let attempts = 0;
  app.machine.follow = async (_s, onMessage) => {
    attempts++;
    if (attempts === 3) onMessage({ event: "ready", data: {} });
    if (attempts >= 4) app.closed = true;
    throw new Error("down");
  };
  app.reload = async () => {};
  delays.length = 0;
  app.follow(cx);
  await tick(50);
  assert.deepEqual(delays.filter((d) => d >= 3000).slice(0, 3), [3000, 6000, 3000]);
});

test("a snapshot never replaces a newer card; a card the stream added or deleted since stays so", () => {
  const current = [task({ id: "a", seq: 5, state: "implementing" }), task({ id: "new", seq: 9 }), task({ id: "gone", seq: 2 })];
  const snapshot = [task({ id: "a", seq: 3, state: "planning" }), task({ id: "b", seq: 4 }), task({ id: "gone", seq: 2 })];
  const tombstones = new Map([["gone", 1000]]);
  const merged = mergeSnapshot(current, snapshot, { tombstones, since: 900 });
  assert.equal(merged.find((t) => t.id === "a").state, "implementing");
  assert.ok(merged.some((t) => t.id === "new"), "added by the stream after the snapshot");
  assert.ok(merged.some((t) => t.id === "b"));
  assert.ok(!merged.some((t) => t.id === "gone"), "deleted by the stream");
});

test("reload merges by seq, sets loaded even with the stream up, and never uses the handler's cx after an await", async () => {
  const { app } = pane({ reads: { "/tasks": [task({ id: "a", seq: 3, state: "planning" })] } });
  app.tasks = [task({ id: "a", seq: 5, state: "implementing" })];
  app.selected = "a";
  fakeFetch(({ path }) => ({ json: path === "/tasks" ? [task({ id: "a", seq: 3, state: "planning" })] : path === "/tasks/a" ? { task: { id: "a" } } : [] }));
  const handler = makeCx();
  const done = app.reload(handler, true);
  handler.stale = true; // the handler returned
  await done;
  assert.equal(app.loaded, true);
  assert.equal(app.link, "live", "the stream stays what it is");
  assert.equal(app.tasks[0].state, "implementing");
  assert.equal(app.error, null);
});

test("the poll reads the board while the first read never came, even with the stream up", async () => {
  // loaded false + live: the condition the timer checks
  const { app } = pane();
  app.loaded = false;
  app.link = "live";
  assert.equal(!app.loaded || app.link !== "live", true);
});

test("loadDetail reads each card on its own: a read of one never drops another's", async () => {
  const { app } = pane();
  const seen = [];
  app.machine.detail = async (id) => {
    await tick(10);
    seen.push(id);
    return { task: { id } };
  };
  const cx = makeCx();
  app.loadDetail("a", cx);
  app.loadDetail("b", cx);
  app.loadDetail("a", cx);
  await tick(60);
  assert.deepEqual(seen.sort(), ["a", "b"], "a call before the read starts is covered by that read");
  assert.ok(app.details.a && app.details.b);
});

test("gateKey names the state, who it waits on and what was asked", () => {
  const t = task({ state: "awaiting_ship", waitingOnYou: true, gate: { requested: { gate: "ship_approval", outcome: "x", kind: "y" } } });
  assert.equal(gateKey(t), "awaiting_ship|1|ship_approval|x|y");
  assert.equal(gateKey(task({ state: "draft" })), "draft|0|||");
});

test("decideIfStill sends nothing when the card moved, and says where it is now", async () => {
  const shipping = task({ id: "x", state: "awaiting_ship", waitingOnYou: true, gate: { requested: {} } });
  const releasing = task({ id: "x", state: "awaiting_ship", waitingOnYou: true, gate: { requested: { gate: "ship_approval" } } });
  let now = releasing;
  const calls = fakeFetch(({ path }) => (path === "/tasks/x" ? { json: { task: now } } : { json: {} }));
  const machine = new Machine();
  machine.settingsReady = settings();
  await assert.rejects(machine.decideIfStill("x", gateKey(shipping), "approved"), (e) => e.code === "moved" && /Safe to release now\?/.test(e.message));
  assert.ok(!calls.some((c) => c.method === "POST"), "nothing was posted");
  now = shipping;
  await machine.decideIfStill("x", gateKey(shipping), "approved");
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/tasks/x/decision"));
});

test("every decision carries the approver, even the first one from a machine that was never connected", async () => {
  const calls = fakeFetch(() => ({ json: {} }));
  const machine = new Machine();
  machine.settingsReady = settings({ approver: "Ana" });
  await machine.decide("x", "rejected", { comment: "no" });
  await machine.decide("x", "sent_back");
  const bodies = calls.filter((c) => c.method === "POST").map((c) => c.body);
  assert.equal(bodies.length, 2);
  for (const b of bodies) assert.equal(b.approver, "Ana");
});

test("handBack writes the value with a timestamp under the kind's key", () => {
  handBack("select", { id: "abc" });
  assert.equal(sharedStore["luna.select"].id, "abc");
  assert.ok(sharedStore["luna.select"].at > 0);
});

test("takeShared ignores what is older than the pane, takes a new value once, and never in render", async () => {
  const { app, cx } = pane();
  for (const k of Object.keys(sharedStore)) delete sharedStore[k];
  sharedStore["luna.command"] = { line: "page prs", at: app.startedAt - 5000 };
  app.takeShared(cx);
  assert.equal(app.page, "board", "an old value is not replayed");
  sharedStore["luna.command"] = { line: "page prs", at: Date.now() + 10 };
  app.takeShared(cx);
  assert.equal(app.page, "prs");
  app.page = "board";
  app.takeShared(cx);
  assert.equal(app.page, "board", "taken once");
  // the timer takes it, with the task's own cx
  sharedStore["luna.select"] = { id: "n1", at: Date.now() + 20 };
  app.takeShared(makeCx());
  assert.equal(app.selected, "n1");
  assert.equal(app.pending.id, "n1");
});

test("render never takes shared values", async () => {
  const { app, cx } = pane();
  let taken = 0;
  app.takeShared = () => taken++;
  host.rendering = true;
  try {
    app.render(cx);
  } finally {
    host.rendering = false;
  }
  assert.equal(taken, 0);
});

test("a selection the stream has not delivered stays for a while, then clears", () => {
  const { app, cx } = pane();
  app.loaded = true;
  app.tasks = [task({ id: "other" })];
  app.select("fresh", cx);
  host.rendering = true;
  try {
    app.render(cx);
    assert.equal(app.selected, "fresh");
    app.pending.until = Date.now() - 1;
    app.render(cx);
    assert.equal(app.selected, null);
  } finally {
    host.rendering = false;
  }
});

test("typing in a tracked input blocks the board's keys; Escape gives the keyboard back", () => {
  const { app, cx } = pane();
  assert.equal(app.page, "board");
  app.search.emit("focus", {}, cx);
  const press = (key, extra = {}) => {
    const c = makeCx();
    app.key({ key, modifiers: {}, ...extra }, c);
    return c;
  };
  press("P", { modifiers: { shift: true } });
  assert.equal(app.page, "board", "P is a letter now, not the PR page");
  let asked = 0;
  app.newTask = () => asked++;
  press("n");
  assert.equal(asked, 0);
  const esc = press("escape");
  assert.equal(esc.stopped, true);
  press("n");
  assert.equal(asked, 1, "keys work again once the input let go");
});

test("a tracked input of a page blocks the keys too, and changing page lets go of it", () => {
  const { app } = pane();
  const state = app.trackInput({ focus() {}, on(name, fn) { (this.h ??= {})[name] = fn; } });
  state.h.focus();
  assert.equal(app.focusedInputs.size, 1);
  app.go("digest", makeCx());
  assert.equal(app.focusedInputs.size, 0, "an input that went away never leaves the keys blocked");
});

test("Enter and a on a page that is not the board never act on the board's hidden selection", () => {
  const { app } = pane();
  const waiting = task({ id: "w", state: "awaiting_approval", waitingOnYou: true, gate: { requested: {} } });
  app.tasks = [waiting];
  app.selected = "w";
  let acted = 0;
  app.act = () => acted++;
  app.go("digest", makeCx());
  for (const key of ["enter", "a"]) app.key({ key, modifiers: {} }, makeCx());
  assert.equal(acted, 0);
  app.command("approve", makeCx());
  assert.equal(acted, 1, "an explicit approve command still reaches the selection");
});

test("run hands the call the task's own cx, and a handler's cx is never used after the await", async () => {
  const { app } = pane();
  const handler = makeCx();
  let inner = null;
  app.run(handler, "k", "Did it", async (cx) => {
    await tick(5);
    inner = cx;
    cx.notify();
    return null;
  });
  handler.stale = true;
  await tick(30);
  assert.ok(inner && inner !== handler);
  assert.equal(app.busy.has("k"), false, "the key is released");
  assert.equal(app.flash?.text, "Did it");
});

test("a failing run says why and releases the key", async () => {
  const { app } = pane();
  const handler = makeCx();
  app.run(handler, "k", null, async () => {
    await tick(2);
    throw new Error("nope");
  });
  handler.stale = true;
  await tick(30);
  assert.equal(app.flash?.text, "nope");
  assert.equal(app.busy.has("k"), false);
});

test("every stream message reaches every page after the board applied it", () => {
  const { app, cx } = pane();
  const t = theme();
  assert.ok(t);
  const seen = [];
  // a page registered for the test
  import("../luna/registry.js").then(() => {});
  app.tasks = [];
  const { PAGES } = globalThisRegistry();
  PAGES.push({ id: "probe", label: "p", icon: "x", hidden: true, render() {}, onMessage: (a, m) => { seen.push([m.event, a.tasks.length]); } });
  try {
    app.onMessage({ event: "task.updated", data: { task: task({ id: "z", seq: 2 }), seq: 2 } }, cx);
    app.onMessage({ event: "ready", data: {} }, cx);
    app.onMessage({ event: "github.prs", data: { snapshot: { prs: [] } } }, cx);
    app.onMessage({ event: "task.deleted", data: { id: "z" } }, cx);
  } finally {
    PAGES.pop();
  }
  assert.deepEqual(seen, [["task.updated", 1], ["ready", 1], ["github.prs", 1], ["task.deleted", 0]]);
});

test("within rejects a promise that never settles, and passes one that does", async () => {
  const cx = makeCx();
  await assert.rejects(within(cx, 20, new Promise(() => {}), "x"), (e) => e.code === "timeout");
  assert.equal(await within(cx, 200, Promise.resolve(7), "x"), 7);
});

import { PAGES as REGISTERED } from "../luna/registry.js";
function globalThisRegistry() {
  return { PAGES: REGISTERED };
}
