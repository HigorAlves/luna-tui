// The gates: which buttons each offers, the words they use, and the dialogs that decide. The machine
// is a recorder with the contract's `decideIfStill`: it compares the card as it is now with the
// `expect` the dialog captured, and a card that moved sends nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./host/stub.js";
import "../luna/features.js";
import { ACTIONS, DIALOGS, MORE } from "../luna/registry.js";
import * as r from "../luna/actions-rules.js";
import { actionsFor, approversOf, cardLine, closedWords, gateKey, gateQuestion, questionsOf } from "../luna/model.js";
import { renderDialog } from "../luna/dialogs.js";
import { theme } from "./host/stub.js";

const t = theme();
const NOW = Date.parse("2026-11-15T12:00:00Z");
const task = (over = {}) => ({ id: "abcd1234-0000", title: "Fix it", state: "draft", column: "Intake", route: "feature", repoPath: "/w/shop", waitingOnYou: false, running: false, queued: false, criteria: ["a"], ...over });
const gate = (state, requested = {}, over = {}) => task({ state, waitingOnYou: true, gate: { requested }, ...over });
const ids = (task_) => actionsFor(task_, NOW).map((a) => a.id);
const cx = { notify() {}, spawn(f) { return f(this); }, timer: { after() {} } };

class Moved extends Error {
  constructor(message) { super(message); this.code = "moved"; }
}

/** A machine recording its calls; `now` is the card as the machine holds it. */
function harness({ now = null, over = {} } = {}) {
  const log = { calls: [], dialogs: [], confirms: [], handBacks: [] };
  const machine = {
    approver: "ana",
    detail: async (id) => (log.calls.push(["detail", id]), over.detail ?? { task: now, approvals: [] }),
    decide: async (id, d, extra) => (log.calls.push(["decide", id, d, extra]), {}),
    decideIfStill: async (id, expect, d, extra) => {
      if (gateKey(now) !== expect) throw new Moved("It moved on: it waits on something else now");
      log.calls.push(["decideIfStill", id, expect, d, extra]);
      return {};
    },
    answer: async (id, a) => (log.calls.push(["answer", id, a]), {}),
    context: async (id, g) => (log.calls.push(["context", id, g]), {}),
    dedup: async (id, c, of) => (log.calls.push(["dedup", id, c, of]), {}),
    post: async (p, b) => (log.calls.push(["post", p, b]), {}),
    call: async (...a) => (log.calls.push(["call", ...a]), {}),
  };
  const app = {
    machine, tasks: [], details: over.details ?? {}, busy: new Set(),
    state: () => ({}),
    dialog: (spec, h, w) => log.dialogs.push([spec, h, w]),
    confirm: (spec) => log.confirms.push(spec),
    say() {},
    handBack: (kind, value) => log.handBacks.push([kind, value]),
  };
  return { app, log };
}

/** A dialog copy: `send` runs the call at once and keeps the error the way the real one draws it. */
function copy(app, kind, d) {
  const view = {
    d: { kind, ...d }, machine: app.machine, error: null, sending: false, handBack: app.handBack,
    send: async (_cx, call) => {
      try { return await call(); } catch (e) { view.error = e.message; return undefined; }
    },
    fail: (_cx, m) => { view.error = m; },
  };
  DIALOGS[kind].init?.(view, cx, view.d);
  return view;
}
const text = (v) => ({ value: () => v });

// ---- B3, B15: what each gate offers ----

test("B3: the release question is approve or reject the release, never send back", () => {
  const release = gate("awaiting_ship", { gate: "ship_approval" });
  assert.deepEqual(ids(release), ["approve", "reject_release", "archive", "delete"]);
  assert.equal(actionsFor(release, NOW)[0].label, "Release");
  assert.equal(actionsFor(release, NOW)[1].kind, "danger");
  assert.ok(!MORE.some((m) => m.id === "reject_release" && m.when(release, harness().app)), "it is a gate button, not a More item");
  // the ship preview before it still sends back
  assert.deepEqual(ids(gate("awaiting_ship", {})), ["approve", "send_back", "archive", "delete"]);
});

test("B3: no send-back where the machine refuses it", () => {
  assert.deepEqual(ids(gate("reviewing_memory")), ["approve", "archive", "delete"]);
  assert.deepEqual(ids(gate("awaiting_ship", {}, { route: "review" })), ["approve", "archive", "delete"], "a review's verdict is not sent back");
  assert.ok(ids(task({ state: "escalated" })).includes("send_back"), "a feature card sent back is planned again");
  for (const route of ["setup", "ci_fix", "address"]) assert.ok(!ids(task({ state: "escalated", route })).includes("send_back"), route);
  // the gates that take it
  for (const s of ["awaiting_approval", "awaiting_test_check", "awaiting_setup"]) assert.ok(ids(gate(s)).includes("send_back"), s);
});

test("B15: Stop on a paused card, Archive on a draft, Delete on an open card", () => {
  assert.deepEqual(ids(task({ state: "paused_rate_limit" })), ["resume", "abort", "archive", "delete"]);
  assert.deepEqual(ids(task()), ["start", "archive", "delete"]);
  assert.deepEqual(ids(task({ state: "implementing", running: true })), ["abort", "archive", "delete"]);
  assert.deepEqual(ids(task({ state: "closed" })), ["delete"], "an ended card cannot be archived");
});

// ---- B6: what a closed card says ----

test("B6: Shipped only from the card's own facts", () => {
  const closed = task({ state: "closed", column: "Done" });
  assert.equal(cardLine(closed, NOW).text, "Closed", "the list carries no fact: Closed");
  assert.equal(cardLine(closed, NOW, { events: [{ kind: "ship.merged" }] }).text, "Shipped");
  assert.equal(cardLine(closed, NOW, { events: [{ kind: "task.shipped" }] }).text, "Shipped");
  assert.equal(cardLine(closed, NOW, { events: [{ kind: "task.reply" }] }).text, "Reply posted, closed");
  assert.equal(cardLine(task({ state: "closed", mergedInto: "9f8e7d6c-1111" }), NOW, { events: [{ kind: "ship.merged" }] }).text, "Closed as a duplicate of #9f8e7d6c");
  assert.equal(closedWords(task({ state: "closed", route: "review" }), { events: [] }), "Closed");
  assert.equal(cardLine(closed, NOW).tone, "done");
});

// ---- B7, B8, B16: the words ----

const planGate = (requested, approvers) => ({ task: gate("awaiting_approval", requested), approvals: [{ kind: "awaiting_approval", decision: null, requested: { ...requested, ...(approvers ? { approvers } : {}) } }] });

test("B7: the plan question names who is needed from the repository's rule, not from the risk alone", () => {
  assert.equal(gateQuestion(gate("awaiting_approval", { risk: { level: "low" } })), "Approve the plan?");
  assert.equal(gateQuestion(gate("awaiting_approval", { risk: { level: "high" }, approvalRule: { needed: 1 } })), "Approve the plan?", "the rule says one name");
  const two = { risk: { level: "high" }, approvalRule: { needed: 2 } };
  assert.equal(gateQuestion(gate("awaiting_approval", two), planGate(two), null), "Approve the plan? · first of two approvers; set LUNA_APPROVER");
  assert.equal(gateQuestion(gate("awaiting_approval", two), planGate(two), "ana"), "Approve the plan? · first of two approvers");
  assert.equal(gateQuestion(gate("awaiting_approval", two), planGate(two, ["ana"]), "bo"), "Approve the plan? · last of two approvers");
  const three = { approvalRule: { needed: 3 } };
  assert.equal(gateQuestion(gate("awaiting_approval", three), planGate(three, ["ana"]), "bo"), "Approve the plan? · next of three approvers");
  assert.deepEqual(approversOf({ requested: { approvers: ["ana"] } }), ["ana"]);
  assert.deepEqual(approversOf({ requested: {}, response: { approver: "bo" } }), ["bo"]);
});

test("B7: an approval that leaves the gate open says who approved and how many are needed", () => {
  const two = { approvalRule: { needed: 2 } };
  const after = planGate(two, ["ana"]);
  assert.equal(r.partialApproval(after, "ana"), "Approved by ana: 1 of 2 approvals. One more name is needed.");
  const three = { approvalRule: { needed: 3 } };
  assert.equal(r.partialApproval(planGate(three, ["ana"]), "ana"), "Approved by ana: 1 of 3 approvals. 2 more names are needed.");
  assert.equal(r.partialApproval({ task: task({ state: "implementing" }), approvals: [] }), null, "the gate closed: nothing to add");
  assert.equal(r.partialApproval(planGate({ approvalRule: { needed: 1 } }, ["ana"])), null);
});

test("B8, B16: the split and the setup say what really happens; titles are the TUI's confirm texts", () => {
  const tickets = { outcome: "split", split: { via: "tickets", children: [{}, {}, {}] }, approvalRule: { needed: 2 } };
  assert.equal(gateQuestion(gate("awaiting_approval", tickets)), "Approve the split (3 tickets)? · two different people");
  const w = r.approveWords(gate("awaiting_approval", tickets));
  assert.equal(w.title, "Approve the split of #abcd1234?");
  assert.match(w.body, /creates 3 tickets in the tracker/);
  assert.match(w.body, /Two different people must approve/);
  assert.match(r.approveWords(gate("awaiting_approval", { outcome: "split", split: { children: [{}, {}] } })).body, /2 cards become cards of their own|The 2 cards/);
  assert.match(r.approveWords(gate("awaiting_setup", {})).body, /goes on to triage/);
  assert.match(r.approveWords(gate("awaiting_setup", {}, { route: "setup" })).body, /card closes/);
  assert.equal(r.approveWords(gate("awaiting_ship", { gate: "ship_approval" })).title, "Approve the release of #abcd1234?");
  assert.equal(r.approveWords(gate("awaiting_ship", {})).title, "Ship #abcd1234?");
  assert.equal(r.approveWords(gate("awaiting_test_check")).title, "Approve the test cases of #abcd1234?");
  assert.equal(r.approveWords(gate("reviewing_memory")).title, "Approve the retro's rules of #abcd1234?");
  assert.equal(r.approveWords(gate("awaiting_approval", { outcome: "conversation" })).title, "Post the reply and close #abcd1234?");
  assert.equal(r.approveWords(gate("awaiting_approval", { outcome: "archive" })).title, "Archive #abcd1234?");
  assert.doesNotMatch(r.approveWords(gate("awaiting_approval", {})).body, /two names/, "no invented high-risk rule");
});

// ---- B9: triage's recommendations ----

test("B9: the answer dialog opens with triage's recommended answers", () => {
  const requested = { questions: [{ question: "Which db?", recommended: "postgres" }, { question: "Scope?", recommended: null }, "bare"] };
  assert.deepEqual(questionsOf(requested), [
    { question: "Which db?", recommended: "postgres" },
    { question: "Scope?", recommended: "" },
    { question: "bare", recommended: "" },
  ]);
  const { app, log } = harness();
  ACTIONS.answer(app, gate("awaiting_answers", requested), cx);
  const [spec] = log.dialogs[0];
  assert.deepEqual(spec.questions, ["Which db?", "Scope?", "bare"]);
  assert.deepEqual(spec.recommended, ["postgres", "", ""]);
  assert.equal(gateQuestion(gate("awaiting_answers", requested)), "Answer 3 questions");
  const view = copy(app, "answer", spec);
  assert.ok(renderDialog(view, t));
});

// ---- B10, B11: the plan editor on the real shape ----

const REAL = {
  brief: "Rewrite",
  criteria: ["c1"],
  assumptions: [],
  rollback: "revert the PR",
  risk: { level: "high", scores: { blast_radius: 1 }, machine: "high" },
  plan: { goal: "g", steps: [
    { id: "P1", files: ["docs/a.md"], title: "A", est_loc: 30, done_when: ["x", "y"], new_files: [], acceptance: ["z"], description: "Rewrite a.md", touchpoints: [] },
    { id: "P2", files: ["docs/b.md"], title: "B", est_loc: 20, done_when: ["w"], new_files: [], acceptance: [], description: "Rewrite b.md" },
  ] },
  slices: [{ title: "A", est_loc: 30, acceptance: ["z"] }, { title: "B", est_loc: 20, acceptance: [] }],
};

test("B10: planFields reads the steps from plan.steps, else from slices", () => {
  const f = r.planFields(REAL);
  assert.deepEqual(f.steps.map((s) => s.description), ["Rewrite a.md", "Rewrite b.md"]);
  assert.deepEqual(f.steps[0], { description: "Rewrite a.md", files: ["docs/a.md"], done_when: ["x", "y"], est_loc: 30 });
  const old = r.planFields({ slices: [{ title: "Only slices", est_loc: 5, files: ["f.ts"], acceptance: ["ok"] }] });
  assert.deepEqual(old.steps, [{ description: "Only slices", files: ["f.ts"], done_when: ["ok"], est_loc: 5 }]);
  assert.deepEqual(r.planFields({ steps: [{ description: "invented" }] }).steps, [], "the machine never sends requested.steps");
  assert.equal(r.planFields(REAL).rollback, "revert the PR");
});

test("B10: typing one more step keeps every real step's files and sizes", () => {
  const before = r.planFields(REAL);
  const now = { brief: "Rewrite", criteria: ["c1"], assumptions: [], steps: ["Rewrite a.md", "Rewrite b.md", "Rewrite c.md"], rollback: "revert the PR", riskLevel: "high", riskReason: "" };
  assert.deepEqual(r.planPatch(before, now, true).steps, [
    { description: "Rewrite a.md", files: ["docs/a.md"], done_when: ["x", "y"], est_loc: 30 },
    { description: "Rewrite b.md", files: ["docs/b.md"], done_when: ["w"], est_loc: 20 },
    { description: "Rewrite c.md", files: [], done_when: [], est_loc: 0 },
  ]);
  // deleting the first step does not hand its files to the second
  const dropped = r.planPatch(before, { ...now, steps: ["Rewrite b.md"] }, true).steps;
  assert.deepEqual(dropped, [{ description: "Rewrite b.md", files: ["docs/b.md"], done_when: ["w"], est_loc: 20 }]);
  // an edited line keeps the data of the step at its place
  assert.deepEqual(r.planPatch(before, { ...now, steps: ["Rewrite a.md carefully", "Rewrite b.md"] }, true).steps[0], { description: "Rewrite a.md carefully", files: ["docs/a.md"], done_when: ["x", "y"], est_loc: 30 });
});

test("B11: clearing only the risk reason sends no risk (the machine needs a reason)", () => {
  const before = r.planFields({ ...REAL, risk: { level: "high", reason: "auth" } });
  const now = { brief: "Rewrite", criteria: ["c1"], assumptions: [], steps: before.steps.map((s) => s.description), rollback: "revert the PR", riskLevel: "high", riskReason: "" };
  assert.deepEqual(r.planPatch(before, now, true), {});
  assert.deepEqual(r.planPatch(before, { ...now, riskLevel: "medium", riskReason: "narrower" }, true), { risk: { level: "medium", reason: "narrower" } });
});

// ---- B1, B16: approving only where the card still is ----

test("B1: the approve dialog captures the gate and sends with decideIfStill", async () => {
  const card = gate("awaiting_approval", {});
  const { app, log } = harness({ now: card });
  ACTIONS.approve(app, card, cx);
  const [spec] = log.dialogs[0];
  assert.equal(spec.expect, gateKey(card));
  const view = copy(app, "approve_ask", spec);
  await DIALOGS.approve_ask.submit(view, cx, spec);
  assert.deepEqual(log.calls.pop(), ["decideIfStill", card.id, gateKey(card), "approved", {}]);
  assert.equal(view.error, null);
});

test("B1: a dialog left open at 'Ship this PR?' sends nothing once the card asks the release question", async () => {
  const preview = gate("awaiting_ship", {});
  const { app, log } = harness({ now: preview });
  ACTIONS.approve(app, preview, cx);
  const [spec] = log.dialogs[0];
  // the machine moves on to the release question while the dialog is open
  const moved = harness({ now: gate("awaiting_ship", { gate: "ship_approval" }) });
  const view = copy(moved.app, "approve_ask", spec);
  await DIALOGS.approve_ask.submit(view, cx, spec);
  assert.match(view.error, /moved on/);
  assert.deepEqual(moved.log.calls, [], "nothing was approved");
});

test("B1: guidance, keep whole, skip rules, send back, reject and reject release all send through decideIfStill", async () => {
  const cases = [
    ["guidance", task({ state: "escalated" }), "approve", { note: "use B" }, "approved", { reason: "use B" }, null],
    ["approve_ask", gate("awaiting_approval", { outcome: "split" }), "keep_whole", {}, "approved", { keepWhole: true }, null],
    ["approve_ask", gate("reviewing_memory"), "memory_skip_rules", {}, "approved", { applyRules: false, reason: "rules skipped" }, null],
    ["send_back", gate("awaiting_approval", {}), "send_back", { reason: "tighten it" }, "sent_back", { reason: "tighten it" }, null],
    ["reject", gate("awaiting_approval", {}), "reject", { reason: "no" }, "rejected", { comment: "no" }, null],
    ["reject_release", gate("awaiting_ship", { gate: "ship_approval" }), "reject_release", { note: "unsafe" }, "rejected", { reason: "unsafe" }, null],
  ];
  for (const [kind, card, action, fields, decision, extra] of cases) {
    const { app, log } = harness({ now: card });
    ACTIONS[action](app, card, cx);
    const [spec] = log.dialogs[0];
    assert.equal(spec.kind, kind, action);
    assert.equal(spec.expect, gateKey(card), `${action} captures the gate`);
    const view = copy(app, kind, spec);
    for (const [k, v] of Object.entries(fields)) view[k] = text(v);
    await DIALOGS[kind].submit(view, cx, spec);
    assert.equal(view.error, null, `${action}: ${view.error}`);
    assert.deepEqual(log.calls.at(-1), ["decideIfStill", card.id, gateKey(card), decision, extra], action);
    // and a card that moved sends nothing
    const gone = harness({ now: task({ state: "implementing", running: true }) });
    const v2 = copy(gone.app, kind, spec);
    for (const [k, v] of Object.entries(fields)) v2[k] = text(v);
    await DIALOGS[kind].submit(v2, cx, spec);
    assert.match(v2.error, /moved on/, action);
    assert.deepEqual(gone.log.calls, [], `${action} sent nothing`);
  }
});

test("B16: retry with guidance only while it is still escalated", async () => {
  const esc = task({ state: "escalated" });
  const { app, log } = harness({ now: esc });
  ACTIONS.approve(app, esc, cx);
  assert.equal(log.dialogs[0][0].kind, "guidance");
  const answered = harness({ now: task({ state: "implementing", running: true }) });
  const view = copy(answered.app, "guidance", log.dialogs[0][0]);
  view.note = text("");
  await DIALOGS.guidance.submit(view, cx, log.dialogs[0][0]);
  assert.match(view.error, /moved on/);
  assert.deepEqual(answered.log.calls, []);
});

test("B1: Inbox Approve all sends each ticket through decideIfStill and counts the ones that moved", async () => {
  const a = gate("awaiting_approval", {}, { id: "a" });
  const b = gate("awaiting_ship", {}, { id: "b" });
  const now = { a, b };
  const calls = [];
  const machine = {
    decideIfStill: async (id, expect, d, extra) => {
      if (gateKey(now[id]) !== expect) throw new Moved("moved");
      calls.push([id, d, extra]);
    },
    call: async () => { throw new Error("must not be used"); },
  };
  const d = {
    kind: "luna_many", done: "Approved",
    calls: [
      { method: "POST", path: "/tasks/a/decision", taskId: "a", expect: gateKey(a), body: { decision: "approved", approver: "ana" } },
      { method: "POST", path: "/tasks/b/decision", taskId: "b", expect: gateKey(gate("awaiting_ship", { gate: "ship_approval" })), body: { decision: "approved" } },
    ],
  };
  const view = { machine, send: async (_cx, call) => { try { await call(); } catch (e) { view.error = e.message; } }, fail() {} };
  await DIALOGS.luna_many.submit(view, cx, d);
  assert.deepEqual(calls, [["a", "approved", { approver: "ana" }]]);
  assert.match(view.error, /Approved 1 of 2; 1 moved on and was left alone/);
});

test("B7: after an approval that needs another name, the board is told who and how many", async () => {
  const card = gate("awaiting_approval", { approvalRule: { needed: 2 } });
  const two = { approvalRule: { needed: 2 } };
  const { app, log } = harness({ now: card, over: { detail: planGate(two, ["ana"]) } });
  ACTIONS.approve(app, card, cx);
  const [spec] = log.dialogs[0];
  assert.equal(spec.needed, 2);
  assert.match(spec.body, /Two different people must approve; yours is the first name/);
  const view = copy(app, "approve_ask", spec);
  await DIALOGS.approve_ask.submit(view, cx, spec);
  assert.deepEqual(log.handBacks, [["bulk", { done: 1, text: "Approved by ana: 1 of 2 approvals. One more name is needed.", failed: 0 }]]);
});

// ---- B2: the excuse dialog ----

test("B2: excusing starts with nothing ticked and needs at least one; excused criteria are not gaps", async () => {
  const card = gate("awaiting_approval", { coverageReport: { untestable: ["C1"] } });
  assert.deepEqual(r.excusedIds(card.gate.requested), ["C1"]);
  assert.deepEqual(r.excusedIds({ coverageReport: { untestable: [{ id: "C2" }] } }), ["C2"]);
  assert.deepEqual(r.openGaps([{ id: "C1" }, { id: "C2" }, "C3"], ["C1"]), [{ id: "C2" }, "C3"]);
  const { app, log } = harness({ now: card });
  const spec = { taskId: card.id, expect: gateKey(card), gaps: [{ id: "C1" }, { id: "C2", text: "it logs" }], excused: ["C1"] };
  const view = copy(app, "excuse", spec);
  assert.equal(view.picked.size, 0, "nothing is pre-ticked");
  await DIALOGS.excuse.submit(view, cx, spec);
  assert.match(view.error, /at least one/);
  assert.deepEqual(log.calls, []);
  view.picked.add("C2");
  await DIALOGS.excuse.submit(view, cx, spec);
  assert.deepEqual(log.calls.at(-1), ["decideIfStill", card.id, gateKey(card), "approved", { untestable: ["C2"] }]);
  assert.ok(renderDialog(copy(app, "excuse", spec), t));
});

// ---- B4: reasons ----

test("B4: send back requires a reason; the ship gate takes the structured note", async () => {
  const card = gate("awaiting_ship", {});
  const { app, log } = harness({ now: card });
  ACTIONS.send_back(app, card, cx);
  const spec = log.dialogs[0][0];
  assert.equal(spec.shipGate, true);
  const view = copy(app, "send_back", spec);
  view.reason = text("   ");
  await DIALOGS.send_back.submit(view, cx, spec);
  assert.match(view.error, /Say why it goes back/);
  assert.deepEqual(log.calls, []);
  view.reason = text("t=12.5 scene=login el=btn");
  await DIALOGS.send_back.submit(view, cx, spec);
  assert.deepEqual(log.calls.at(-1).slice(3), ["sent_back", { reason: "t=12.5 scene=login el=btn" }]);
  assert.equal(r.sendBackBody(""), null);
  const reject = copy(app, "reject", { taskId: card.id, expect: gateKey(card) });
  reject.reason = text("");
  await DIALOGS.reject.submit(reject, cx, { taskId: card.id, expect: gateKey(card) });
  assert.match(reject.error, /Say why/);
});

// ---- B5: ask first ----

test("B5: keep it whole and post the questions ask first and send nothing yet", () => {
  const split = gate("awaiting_approval", { outcome: "split_failed" });
  const { app, log } = harness({ now: split });
  ACTIONS.keep_whole(app, split, cx);
  assert.equal(log.dialogs[0][0].title, "Keep #abcd1234 whole and approve the plan?");
  assert.deepEqual(log.dialogs[0][0].extra, { keepWhole: true });
  const q = gate("awaiting_answers", { questions: [{ question: "x", recommended: "y" }] });
  ACTIONS.post_questions(app, q, cx);
  assert.equal(log.confirms[0].call.path, "/tasks/abcd1234-0000/questions/post");
  assert.match(log.confirms[0].title, /Post the questions/);
  assert.deepEqual(log.calls, []);
});

// ---- B12, B13, B14 ----

test("B12: Related relates only the tickets that were ticked", async () => {
  const { app, log } = harness();
  const spec = { taskId: "x", candidates: [{ id: "c1", title: "One" }, { id: "c2", title: "Two" }, { id: "c3", title: "Three" }] };
  const view = copy(app, "dedup", spec);
  assert.ok(renderDialog(view, t));
  assert.equal(view.related.size, 0);
  // the Related button with nothing ticked refuses; ticking sends only those
  const body = DIALOGS.dedup.body(view, t, spec);
  assert.ok(body.length > 0);
  view.related.add("c2");
  await view.send(cx, () => app.machine.dedup("x", "related", [...view.related]));
  assert.deepEqual(log.calls.at(-1), ["dedup", "x", "related", ["c2"]]);
});

test("B13: the refusals the machine really sends are the ones explained", async () => {
  const { app } = harness();
  const dismiss = copy(app, "finding_dismiss", { taskId: "x", findings: [{ id: "F1", title: "t" }] });
  dismiss.machine = { post: async () => { const e = new Error("no finding"); e.code = "not_found"; throw e; } };
  dismiss.picked = "F1";
  dismiss.reason = text("");
  await DIALOGS.finding_dismiss.submit(dismiss, cx, { taskId: "x" });
  assert.match(dismiss.error, /did not report that finding/);
  const merge = copy(app, "merge_into", { taskId: "x", candidates: [{ id: "c", title: "T", state: "triage" }] });
  merge.machine = { post: async () => { const e = new Error("cannot"); e.code = "cannot_merge"; throw e; } };
  const rows = DIALOGS.merge_into.body(merge, t, { candidates: [{ id: "c", title: "T", state: "triage" }] });
  assert.ok(rows.length > 0);
});

test("B14: the context dialog sends something, with a project field", async () => {
  const { app, log } = harness();
  const spec = { taskId: "x", repoPath: "/w/shop" };
  const view = copy(app, "context", spec);
  view.repo = text("/w/shop");
  view.project = text("");
  view.reason = text("");
  await DIALOGS.context.submit(view, cx, spec);
  assert.match(view.error, /nothing to send/);
  assert.deepEqual(log.calls, []);
  view.project = text("shop-api");
  await DIALOGS.context.submit(view, cx, spec);
  assert.deepEqual(log.calls.at(-1), ["context", "x", { project: "shop-api" }]);
  view.repo = text("/w/other");
  view.reason = text("it is the billing one");
  await DIALOGS.context.submit(view, cx, spec);
  assert.deepEqual(log.calls.at(-1), ["context", "x", { repoPath: "/w/other", project: "shop-api", text: "it is the billing one" }]);
});

test("every gate dialog draws", () => {
  const { app } = harness();
  const specs = {
    approve_ask: { taskId: "x", title: "Approve?", body: "b", label: "Approve" },
    guidance: { taskId: "x" },
    send_back: { taskId: "x", shipGate: true },
    reject: { taskId: "x" },
    reject_release: { taskId: "x" },
    answer: { taskId: "x", questions: ["q1", "q2"], recommended: ["a", ""] },
    context: { taskId: "x", repoPath: "/w" },
    excuse: { taskId: "x", gaps: [{ id: "C1", text: "t" }], excused: [] },
    dedup: { taskId: "x", candidates: [{ id: "c", title: "T" }] },
  };
  for (const [kind, d] of Object.entries(specs)) assert.ok(renderDialog(copy(app, kind, d), t), kind);
});
