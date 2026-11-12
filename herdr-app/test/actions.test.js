// The ticket actions: when each applies, the bodies they send, and every dialog they register drawn
// with the host stand-in. The machine is a recorder.
import assert from "node:assert/strict";
import { test } from "node:test";

import { calls, theme } from "./host/stub.js";
import "../luna/features.js";
import { ACTIONS, COMMANDS, DIALOGS, MORE, PAGES } from "../luna/registry.js";
import * as r from "../luna/actions-rules.js";
import { ensureJira } from "../luna/actions.js";
import { renderDialog } from "../luna/dialogs.js";

const t = theme();
const task = (over = {}) => ({ id: "abcd1234-0000", title: "Fix it", state: "draft", column: "Intake", route: "feature", repoPath: "/w/shop", waitingOnYou: false, running: false, queued: false, criteria: ["a"], ...over });
const approval = (kind, requested = {}, decision = null) => ({ kind, requested, decision });

function harness(over = {}) {
  const log = { calls: [], dialogs: [], confirms: [], said: [], opened: [], runs: [] };
  const machine = {
    approver: null,
    connect: async () => null,
    call: async (...a) => (log.calls.push(["call", ...a]), {}),
    get: async (p) => (log.calls.push(["get", p]), over.get?.(p) ?? []),
    post: async (p, b) => (log.calls.push(["post", p, b]), {}),
    patch: async (p, b) => (log.calls.push(["patch", p, b]), {}),
    del: async (p) => (log.calls.push(["del", p]), {}),
    decide: async (id, d, extra) => (log.calls.push(["decide", id, d, extra]), {}),
  };
  const states = {};
  const app = {
    machine, tasks: over.tasks ?? [], details: over.details ?? {}, prs: { inbox: null, all: null }, busy: new Set(),
    state: (id) => (states[id] ??= {}),
    dialog: (spec, h, w) => log.dialogs.push([spec, h, w]),
    confirm: (spec) => log.confirms.push(spec),
    say: (text, tone) => log.said.push([text, tone]),
    openUrl: (u) => log.opened.push(u),
    select() {}, go() {},
    run: (cx, key, done, call) => log.runs.push([key, done, call]),
  };
  return { app, log };
}

const cx = { notify() {}, spawn(f) { return f(this) }, timer: { after() {} } };
const visible = (task_, app) => MORE.filter((m) => m.when(task_, app)).map((m) => m.id);

test("ask once before approving; an escalated card retries with guidance", () => {
  const { app, log } = harness();
  ACTIONS.approve(app, task({ state: "awaiting_approval", waitingOnYou: true, gate: { requested: {} } }), cx);
  const [spec] = log.dialogs[0];
  assert.equal(spec.kind, "approve_ask");
  assert.equal(spec.title, "Approve the plan?");
  assert.match(spec.body, /Build starts/);
  ACTIONS.approve(app, task({ state: "escalated" }), cx);
  assert.equal(log.dialogs[1][0].kind, "guidance");
  ACTIONS.approve(app, task({ state: "awaiting_ship", route: "review", waitingOnYou: true }), cx);
  assert.match(log.dialogs[2][0].body, /GitHub/);
  assert.deepEqual(log.calls, [], "nothing is sent before the answer");
});

test("stopping asks first", () => {
  const { app, log } = harness();
  ACTIONS.abort(app, task({ running: true }), cx);
  assert.equal(log.confirms[0].call.path, "/tasks/abcd1234-0000/abort");
  assert.equal(log.confirms[0].danger, true);
});

test("the approve dialog sends the decision, retry sends the note as the reason, a rejection sends its comment", async () => {
  const { app, log } = harness();
  const dlg = (kind, d, over = {}) => {
    const view = { machine: app.machine, send: async (_cx, call) => call(), fail: (_cx, m) => (view.error = m), ...over };
    DIALOGS[kind].init?.(view, cx, d);
    return view;
  };
  const a = dlg("approve_ask", { taskId: "x" });
  await DIALOGS.approve_ask.submit(a, cx, { taskId: "x", extra: { applyRules: false, reason: "rules skipped" } });
  assert.deepEqual(log.calls.pop(), ["decide", "x", "approved", { applyRules: false, reason: "rules skipped" }]);

  const g = dlg("guidance", { taskId: "x" });
  g.note = { value: () => "  use the other API " };
  await DIALOGS.guidance.submit(g, cx, { taskId: "x" });
  assert.deepEqual(log.calls.pop(), ["decide", "x", "approved", { reason: "use the other API" }]);
  g.note = { value: () => "" };
  await DIALOGS.guidance.submit(g, cx, { taskId: "x" });
  assert.deepEqual(log.calls.pop(), ["decide", "x", "approved", { reason: null }]);

  const rj = dlg("reject_release", { taskId: "x" });
  rj.note = { value: () => "" };
  await DIALOGS.reject_release.submit(rj, cx, { taskId: "x" });
  assert.match(rj.error, /Say why/);
  assert.equal(log.calls.length, 0);
  rj.note = { value: () => "not yet" };
  await DIALOGS.reject_release.submit(rj, cx, { taskId: "x" });
  assert.deepEqual(log.calls.pop(), ["decide", "x", "rejected", { reason: "not yet" }]);
});

test("the release and the memory review offer their own buttons", () => {
  const { app } = harness();
  const release = task({ state: "awaiting_ship", waitingOnYou: true, gate: { requested: { gate: "ship_approval" } } });
  assert.ok(visible(release, app).includes("reject_release"));
  assert.ok(!visible(task({ state: "awaiting_ship", waitingOnYou: true, gate: { requested: {} } }), app).includes("reject_release"));
  assert.ok(visible(task({ state: "reviewing_memory", waitingOnYou: true }), app).includes("memory_skip_rules"));
  assert.ok(!visible(task({ state: "reviewing_memory", waitingOnYou: false }), app).includes("memory_skip_rules"));
  const { app: a2, log } = harness();
  ACTIONS.memory_skip_rules(a2, task({ state: "reviewing_memory" }), cx);
  assert.deepEqual(log.dialogs[0][0].extra, { applyRules: false, reason: "rules skipped" });
});

test("edit rules follow the TUI: plan, cases, record, escalation", () => {
  const plan = (decision = null, requested = { brief: "b", cases: [{ title: "c1", criterion: "C1" }] }) => ({ approvals: [approval("awaiting_approval", requested, decision)] });
  const open = task({ state: "awaiting_approval", waitingOnYou: true });
  assert.ok(r.canEditPlan(open, plan()));
  assert.ok(r.canEditPlanFully(open, plan()));
  assert.ok(!r.canEditPlan(open, plan(null, { outcome: "split" })), "a split has no plan");
  assert.ok(!r.canEditPlan(open, plan(null, { outcome: "archive" })));
  assert.ok(!r.canEditPlan(open, null), "detail not read yet");
  const check = task({ state: "awaiting_test_check" });
  const approved = plan("approved");
  assert.ok(r.canEditPlan(check, approved), "before anything is built the approved plan may still move");
  assert.ok(!r.canEditPlanFully(check, approved), "steps, risk and rollback are refused after approval");
  assert.ok(!r.canEditPlan(task({ state: "implementing" }), approved));
  assert.ok(r.canEditCases(open, plan()));
  assert.ok(!r.canEditCases(open, plan("approved")));
  assert.ok(!r.canEditCases(open, { approvals: [approval("awaiting_approval", { brief: "b" })] }), "no cases");
  assert.ok(r.canCorrectRecord(task({ state: "awaiting_answers", record: {} })));
  assert.ok(!r.canCorrectRecord(task({ state: "awaiting_answers" })), "no record yet");
  assert.ok(!r.canCorrectRecord(task({ state: "implementing", record: {} })));
  const { app } = harness();
  assert.ok(visible(task({ state: "escalated" }), app).includes("escalation_reason"));
  assert.ok(!visible(task({ state: "implementing" }), app).includes("escalation_reason"));
});

test("a plan edit sends only what changed", () => {
  const before = r.planFields({ brief: "old", criteria: ["a"], assumptions: [], steps: [{ description: "s1", files: ["x.ts"], done_when: ["ok"], est_loc: 40 }], rollback: "revert", risk: { level: "low", reason: "small" } });
  const same = { brief: "old", criteria: ["a"], assumptions: [], steps: ["s1"], rollback: "revert", riskLevel: "low", riskReason: "small" };
  assert.deepEqual(r.planPatch(before, same, true), {});
  assert.deepEqual(r.planPatch(before, { ...same, brief: "new", criteria: ["a", "b"] }, true), { brief: "new", criteria: ["a", "b"] });
  assert.deepEqual(r.planPatch(before, { ...same, steps: ["s1", "s2"] }, true).steps, [
    { description: "s1", files: ["x.ts"], done_when: ["ok"], est_loc: 40 },
    { description: "s2", files: [], done_when: [], est_loc: 0 },
  ]);
  assert.deepEqual(r.planPatch(before, { ...same, riskLevel: "high", riskReason: "auth" }, true), { risk: { level: "high", reason: "auth" } });
  assert.deepEqual(r.planPatch(before, { ...same, steps: ["z"], rollback: "x" }, false), {}, "not the whole plan: steps and rollback are left out");
});

test("the ticket and cases text round-trip the TUI's markdown", () => {
  const md = r.ticketMarkdown({ title: "T", description: "d1\nd2", criteria: ["a", "b"] });
  assert.deepEqual(r.parseTicket(md, "x"), { title: "T", description: "d1\nd2", criteria: ["a", "b"] });
  assert.equal(r.parseTicket("", "fallback").title, "fallback");
  const cases = [{ title: "logs in", criterion: "C1", approach: "open /login\ntype" }, { title: "free", criterion: null, approach: "" }];
  assert.deepEqual(r.parseCases(r.casesMarkdown(cases)), cases);
  assert.deepEqual(r.lines("- a\n\n b \n"), ["a", "b"]);
});

test("edit dialogs patch the right path with the right body", async () => {
  const { app, log } = harness();
  const dlg = (kind, d) => {
    const view = { machine: app.machine, send: async (_cx, call) => call(), fail: (_cx, m) => (view.error = m) };
    DIALOGS[kind].init(view, cx, d);
    return view;
  };
  const text = (v) => ({ value: () => v });
  const d = { taskId: "x", ticketTitle: "Old", description: "d", criteria: ["a"] };
  const v = dlg("edit_ticket", d);
  v.title = text("Old");
  v.description = text("d");
  v.criteria = text("a");
  await DIALOGS.edit_ticket.submit(v, cx, d);
  assert.equal(v.error, "Nothing changed.");
  v.title = text("New");
  v.criteria = text("a\nb");
  v.description = text("d");
  await DIALOGS.edit_ticket.submit(v, cx, d);
  assert.deepEqual(log.calls.pop(), ["patch", "/tasks/x", { title: "New", criteria: ["a", "b"] }]);

  const cd = { taskId: "x", cases: [{ title: "c1", criterion: "C1", approach: "" }] };
  const c = dlg("edit_cases", cd);
  c.text = text("");
  await DIALOGS.edit_cases.submit(c, cx, cd);
  assert.match(c.error, /at least one case/);
  c.text = text("## C1\n\n- c1\n- c2\n  by hand\n");
  await DIALOGS.edit_cases.submit(c, cx, cd);
  assert.deepEqual(log.calls.pop(), ["patch", "/tasks/x/cases", { cases: [{ title: "c1", criterion: "C1", approach: "" }, { title: "c2", criterion: "C1", approach: "by hand" }] }]);

  const rd = { taskId: "x", current: { kind: "bug", size: "M" } };
  const rec = dlg("edit_record", rd);
  rec.picks.size = "L";
  rec.picks.priority = "P1";
  await DIALOGS.edit_record.submit(rec, cx, rd);
  assert.deepEqual(log.calls.pop(), ["patch", "/tasks/x/record", { size: "L", priority: "P1" }]);

  const pd = { taskId: "x", full: false, plan: r.planFields({ brief: "b", criteria: ["a"] }) };
  const p = dlg("edit_plan", pd);
  p.brief = text("b2");
  p.criteria = text("a");
  p.assumptions = text("");
  await DIALOGS.edit_plan.submit(p, cx, pd);
  assert.deepEqual(log.calls.pop(), ["patch", "/tasks/x/plan", { brief: "b2" }]);
});

test("the escalation reasons are the machine's six", () => {
  assert.deepEqual(r.ESCALATION_REASONS.map(([id]) => id), ["plan_wrong", "env_broken", "flaky_tests", "too_complex", "undeclared_scope", "other"]);
  assert.equal(r.recordValue({ record: { urgencyDetail: { priority: "P2" }, size: "S" } }, "priority"), "P2");
});

test("setting the repo reads the known repos and explains has_worktree", async () => {
  const { app, log } = harness({ tasks: [task({ repoPath: "/w/other" })], get: () => [{ repo: "/w/a" }, { repo: "/w/b" }] });
  await ACTIONS.set_repo(app, task({ repoPath: null }), cx);
  const [spec] = log.dialogs[0];
  assert.deepEqual(spec.repos, ["/w/a", "/w/b", "/w/other"]);
  assert.deepEqual(log.calls[0], ["get", "/repos"]);
  const refuse = { ...app, machine: { ...app.machine, patch: async () => { throw Object.assign(new Error("raw"), { code: "has_worktree" }); } } };
  let sent;
  const view = { machine: refuse.machine, send: async (_cx, call) => { try { await call(); } catch (e) { sent = e.message; } }, fail() {} };
  DIALOGS.set_repo.init(view, cx, spec);
  assert.match(visibleText(DIALOGS.set_repo.body(view, t, spec)), /w\/a/);
  assert.equal(sent, undefined);
});

const flat = (el) => [el, ...(el.kids ?? []).flatMap(flat)];
const visibleText = (els) => els.flatMap(flat).flatMap((e) => e.words ?? []).join(" | ");

test("Jira is offered only when the machine says it is configured, and the answer is cached", async () => {
  const { app, log } = harness({ get: () => ({ configured: true, site: "x.atlassian.net" }) });
  const open = task();
  assert.ok(!visible(open, app).includes("jira_link"), "unknown until the status lands");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(visible(open, app).includes("jira_link"));
  assert.ok(visible(open, app).includes("jira_create"));
  assert.ok(!visible(task({ jira: { key: "P-1", url: "u" } }), app).includes("jira_link"), "linked: no second link");
  assert.ok(visible(task({ jira: { key: "P-1", url: "u" } }), app).includes("jira_unlink"));
  assert.ok(!visible(open, app).includes("jira_unlink"));
  assert.equal(log.calls.filter((c) => c[1] === "/jira/status").length, 1, "read once");
  const off = harness({ get: () => ({ configured: false }) });
  ensureJira(off.app);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!visible(open, off.app).includes("jira_link"));
  const missing = harness({ get: () => { throw Object.assign(new Error("404"), { status: 404 }); } });
  ensureJira(missing.app);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(missing.app.state("jira").loaded, true);
  assert.ok(!visible(open, missing.app).includes("jira_link"));
});

test("Jira dialogs send the key, the project and the type; unlinking asks first", async () => {
  const { app, log } = harness();
  const view = { machine: app.machine, send: async (_cx, call) => call(), fail() {} };
  const text = (v) => ({ value: () => v });
  DIALOGS.jira_create.init(view, cx, {});
  view.project = text("plat");
  view.issueType = text("Bug");
  await DIALOGS.jira_create.submit(view, cx, { taskId: "x" });
  assert.deepEqual(log.calls.pop(), ["post", "/tasks/x/jira/create", { project: "PLAT", issueType: "Bug" }]);
  view.project = text("");
  view.issueType = text("");
  await DIALOGS.jira_create.submit(view, cx, { taskId: "x" });
  assert.deepEqual(log.calls.pop(), ["post", "/tasks/x/jira/create", {}]);
  ACTIONS.jira_unlink(app, task({ jira: { key: "P-1" } }), cx);
  assert.deepEqual(log.confirms[0].call, { method: "DELETE", path: "/tasks/abcd1234-0000/jira" });
  assert.ok(r.looksLikeJiraKey("PLAT-123"));
  assert.ok(!r.looksLikeJiraKey("plat 12"));
});

test("findings: dismiss from Verify's open ones, add what it missed", async () => {
  const detail = { reports: { verify: { findings: [{ id: "F1", title: "t1", severity: "blocker" }, { id: "F2", title: "t2", resolution: { status: "fixed" } }] } } };
  const ship = task({ state: "awaiting_ship" });
  assert.deepEqual(r.openFindings(detail).map((f) => f.id), ["F1"]);
  assert.ok(r.canDismissFinding(ship, detail));
  assert.ok(!r.canDismissFinding(task({ state: "implementing" }), detail), "the machine answers 409 at any other state");
  assert.ok(!r.canDismissFinding(ship, { reports: { verify: { findings: [] } } }));
  assert.ok(r.canAddFinding(task({ state: "ci_watch" }), detail));
  assert.ok(!r.canAddFinding(task({ state: "triage" }), {}));
  const { app, log } = harness({ details: { [ship.id]: detail } });
  ACTIONS.finding_dismiss(app, ship, cx);
  assert.equal(log.dialogs[0][0].findings.length, 1);
  const view = { machine: app.machine, send: async (_cx, call) => call(), fail: (_cx, m) => (view.error = m) };
  const text = (v) => ({ value: () => v });
  DIALOGS.finding_dismiss.init(view, cx, log.dialogs[0][0]);
  assert.equal(view.picked, "F1", "one finding is picked for you");
  view.reason = text(" not a bug ");
  await DIALOGS.finding_dismiss.submit(view, cx, { taskId: "x" });
  assert.deepEqual(log.calls.pop(), ["post", "/tasks/x/findings/F1/dismiss", { reason: "not a bug" }]);
  view.reason = text("");
  await DIALOGS.finding_dismiss.submit(view, cx, { taskId: "x" });
  assert.deepEqual(log.calls.pop(), ["post", "/tasks/x/findings/F1/dismiss", {}]);
  assert.deepEqual(r.findingBody({ severity: "nit", title: " typo ", path: "a.ts", line: "12" }), { severity: "nit", title: "typo", path: "a.ts", line: 12 });
  assert.deepEqual(r.findingBody({ severity: "nit", title: "x", path: "", line: "3" }), { severity: "nit", title: "x" });
  const add = { machine: app.machine, send: async (_cx, call) => call(), fail: (_cx, m) => (add.error = m) };
  DIALOGS.finding_add.init(add, cx, {});
  add.title = text("");
  await DIALOGS.finding_add.submit(add, cx, { taskId: "x" });
  assert.match(add.error, /title/);
  add.title = text("Null deref");
  add.path = text("src/a.ts");
  add.line = text("");
  add.severity = "blocker";
  await DIALOGS.finding_add.submit(add, cx, { taskId: "x" });
  assert.deepEqual(log.calls.pop(), ["post", "/tasks/x/findings", { severity: "blocker", title: "Null deref", path: "src/a.ts" }]);
});

test("evidence feedback sends useful or not, with an optional note capped at 500", async () => {
  assert.deepEqual(r.feedbackBody(true, "  "), { useful: true });
  assert.equal(r.feedbackBody(false, "x".repeat(900)).note.length, 500);
  assert.ok(r.canGiveFeedback(task({ evidence: {} })));
  assert.ok(!r.canGiveFeedback(task()));
  const { app, log } = harness();
  const view = { machine: app.machine, send: async (_cx, call) => call(), fail() {} };
  DIALOGS.evidence_feedback.init(view, cx, {});
  view.note = { value: () => "no video" };
  await DIALOGS.evidence_feedback.submit(view, cx, { taskId: "x", useful: false });
  assert.deepEqual(log.calls.pop(), ["post", "/tasks/x/evidence/feedback", { useful: false, note: "no video" }]);
});

test("duplicates: close into another card, bring one back", () => {
  const { app, log } = harness({ tasks: [task({ id: "a" }), task({ id: "b", title: "PR #3: other", state: "closed" }), task({ id: "c", title: "Third" })] });
  ACTIONS.merge_into(app, app.tasks[0], cx);
  assert.deepEqual(log.dialogs[0][0].candidates.map((c) => c.id), ["c", "b"], "open cards first, never itself");
  assert.equal(log.dialogs[0][0].candidates[1].title, "other");
  assert.ok(r.canMerge(task()));
  assert.ok(!r.canMerge(task({ mergedInto: "z" })));
  assert.ok(!r.canMerge(task({ state: "closed" })));
  assert.ok(r.canUnmerge(task({ mergedInto: "z" })));
  assert.ok(!r.canUnmerge(task()));
  ACTIONS.unmerge(app, task({ mergedInto: "z" }), cx);
  assert.equal(log.confirms[0].call.path, "/tasks/abcd1234-0000/unmerge");
});

test("removing the worktree asks, then asks again before discarding unpushed commits", async () => {
  assert.ok(r.canRemoveWorktree(task({ worktreePath: "/w/t" })));
  assert.ok(!r.canRemoveWorktree(task({ worktreePath: "/w/t", running: true })), "a stage runs on it");
  assert.ok(!r.canRemoveWorktree(task()));
  const posts = [];
  let first = true;
  const machine = { post: async (p) => { posts.push(p); if (first) { first = false; throw Object.assign(new Error("3 commits"), { code: "unpushed_commits" }); } return {}; } };
  const view = { machine, send: async (_cx, call) => { try { await call(); } catch (e) { view.error = e.message; } }, fail() {} };
  DIALOGS.remove_worktree.init(view, cx, {});
  assert.equal(DIALOGS.remove_worktree.primary(view).label, "Remove");
  await DIALOGS.remove_worktree.submit(view, cx, { taskId: "x" });
  assert.match(view.error, /Remove anyway/);
  assert.equal(DIALOGS.remove_worktree.primary(view).label, "Remove anyway");
  await DIALOGS.remove_worktree.submit(view, cx, { taskId: "x" });
  assert.deepEqual(posts, ["/tasks/x/worktree/remove", "/tasks/x/worktree/remove?discard=true"]);
});

test("setting a repo up: the verb and the picker", async () => {
  const { app, log } = harness();
  COMMANDS.setup(app, "/w/shop/", cx);
  assert.equal(log.runs[0][0], "setup:/w/shop");
  await log.runs[0][2]();
  assert.deepEqual(log.calls.pop(), ["post", "/repos/setup", { repoPath: "/w/shop" }]);
  COMMANDS.setup(app, "", cx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(log.runs.length, 1, "the stand-in's picker is cancelled: nothing is sent");
  assert.ok(visible(task({ repoPath: null }), app).includes("setup_repo"));
  assert.ok(!visible(task({ state: "triage" }), app).includes("setup_repo"));
});

test("open the issue and the PR", () => {
  const { app, log } = harness({ details: { [task().id]: { ship: { pr: { url: "https://github.com/o/r/pull/9", number: 9 } } } } });
  assert.equal(r.issueLink(task({ source: { kind: "github", url: "https://github.com/o/r/issues/1" } })), "https://github.com/o/r/issues/1");
  assert.equal(r.issueLink(task({ jira: { key: "P-1", url: "https://j/P-1" } })), "https://j/P-1");
  assert.equal(r.issueLink(task()), null);
  ACTIONS.open_issue(app, task({ jira: { key: "P-1", url: "https://j/P-1" } }), cx);
  ACTIONS.open_pr(app, task(), cx);
  assert.deepEqual(log.opened, ["https://j/P-1", "https://github.com/o/r/pull/9"]);
  ACTIONS.open_pr(app, task({ id: "other" }), cx);
  assert.deepEqual(log.said.at(-1), ["No PR yet.", "error"]);
  assert.equal(r.prLink(task({ branch: "b" }), null, { prs: { inbox: { prs: [{ headRef: "b", url: "https://pr" }] } } }), "https://pr");
});

test("watching: the hidden page keeps the stage, and Watch opens a tab with the TUI's command", async () => {
  const { app, log } = harness();
  const watch = PAGES.find((p) => p.id === "luna-watch");
  assert.equal(watch.hidden, true);
  watch.onMessage(app, { event: "stage.started", data: { taskId: "abcd1234-0000", label: "#abcd1234 app · Fix", cwd: "/wt", container: "hardness-abc-triage" } }, cx);
  watch.onMessage(app, { event: "stage.started", data: { taskId: "abcd1234-0000", label: "#abcd1234 app · Fix", cwd: "/wt2", container: "hardness-abc-build" } }, cx);
  assert.equal(app.state("watch")["abcd1234-0000"].container, "hardness-abc-build", "the latest wins");
  assert.ok(visible(task({ running: true }), app).includes("watch"));
  assert.ok(!visible(task(), app).includes("watch"));
  calls.length = 0;
  await ACTIONS.watch(app, task({ running: true }), cx);
  assert.deepEqual(calls.at(-1), ["run", "tab.new", { name: "#abcd1234 app · Fix", argv: ["docker", "logs", "-f", "hardness-abc-build"], folder: "/wt2" }]);
  watch.onMessage(app, { event: "task.closed", data: { id: "abcd1234-0000" } }, cx);
  assert.equal(app.state("watch")["abcd1234-0000"], undefined);
  calls.length = 0;
  await ACTIONS.watch(app, task({ running: true }), cx);
  assert.equal(calls.length, 0, "no stage to watch: nothing opens");
  assert.match(log.said.at(-1)[0], /Nothing to watch/);
  app.state("watch").x = { label: "l", cwd: "/", container: "c1; rm -rf ~" };
  assert.match(r.watchTab(app.state("watch").x).error, /not a plain name/);
  assert.ok(r.validContainer("hardness-abc-triage"));
  assert.ok(!r.validContainer("-rf"));
});

test("every dialog this feature registers draws", () => {
  const specs = {
    approve_ask: { taskId: "x", title: "Approve the plan?", body: "Build starts.", label: "Approve" },
    guidance: { taskId: "x" },
    reject_release: { taskId: "x" },
    edit_ticket: { taskId: "x", ticketTitle: "T", description: "d", criteria: ["a"] },
    edit_plan: { taskId: "x", full: true, plan: r.planFields({ brief: "b", steps: [{ description: "s" }], risk: { level: "low", reason: "r" } }) },
    edit_cases: { taskId: "x", cases: [{ title: "c", criterion: "C1", approach: "" }] },
    edit_record: { taskId: "x", current: { kind: "bug" } },
    escalation_reason: { taskId: "x", current: "env_broken" },
    set_repo: { taskId: "x", current: "/w/a", repos: ["/w/a", "/w/b"] },
    jira_link: { taskId: "x" },
    jira_create: { taskId: "x" },
    finding_dismiss: { taskId: "x", findings: [{ id: "F1", title: "t", severity: "nit", path: "a.ts", line: 3 }] },
    finding_add: { taskId: "x" },
    evidence_feedback: { taskId: "x", useful: true },
    merge_into: { taskId: "x", candidates: [{ id: "c", title: "Other", state: "triage" }] },
    remove_worktree: { taskId: "x" },
  };
  for (const [kind, d] of Object.entries(specs)) {
    assert.ok(DIALOGS[kind], kind);
    const view = { d: { kind, ...d }, machine: {}, error: null, sending: false, send() {}, fail() {} };
    DIALOGS[kind].init?.(view, cx, view.d);
    assert.ok(renderDialog(view, t), kind);
  }
  const plain = { d: { kind: "edit_plan", taskId: "x", full: false, plan: r.planFields({}) }, machine: {}, send() {}, fail() {} };
  DIALOGS.edit_plan.init(plain, cx, plain.d);
  assert.ok(renderDialog(plain, t));
});
