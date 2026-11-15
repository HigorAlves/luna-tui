// Lane E: the ticket inspector's state sections (Now, Stopped, Result), the Build and Verify
// reports, the plan gate's machine flags, the origin and stack facts, the tab bar and Engines.
// Fixtures copy the shapes of a live finished card (GET /tasks/:id) with null and missing fields.
import assert from "node:assert/strict";
import { test } from "node:test";

import { theme } from "./host/stub.js";
import "../luna/features.js";
import { inspector } from "../luna/inspector.js";
import { TABS } from "../luna/registry.js";
import { engineRows, routePacks } from "../luna/detail-model.js";
import {
  approvalRuleView, buildProgressView, buildReportView, coverageView, defaultTab, findingLevel, heldText, isResult, isRunning, isStopped, machineFlags, mergedEvent,
  openGaps, originRows, resultView, riskOverrideLine, stackRows, stoppedView, verifyReportView,
} from "../luna/detail-sections.js";

const t = theme();
const NOW = Date.parse("2026-11-12T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};

const task = (over = {}) => ({
  id: "tid", title: "Rewrite runbooks", state: "implementing", column: "Build", route: "feature", repoPath: "/w/shop", branch: "task/x", worktreePath: "/w/wt",
  waitingOnYou: false, running: true, queued: false, updatedAt: iso(NOW), seq: 1, criteria: ["logs in"], spentUsd: 1.5, description: "Do it", reason: null, jira: null,
  source: null, sla: null, stages: {}, retries: { total: 0 }, sources: [], reporter: null, ...over,
});

const buildProgress = {
  scenarios: [{ id: "S19", state: "green" }, { id: "S20", state: "red" }, { id: "S21", state: "red" }],
  budget: { iterations: 3, tokens: 215848, minutes: 6, limits: { max_iterations: 15, max_tokens: 2000000, max_minutes: 90 } },
  lastCheckpoint: { sha: "5fb529980bbbf7c56346783fe0ddceff740a2dae", follows: "green", at: "2026-11-07T23:22:44.000Z" },
};

const buildReport = {
  branch: "task/a45864f8-part-3", base: "main", headSha: "a68072a2b2548878b24ffaf9d03a1058f181bb01", diffSummary: { added: 140, removed: 48, files: ["docs/a.md", "docs/b.md"] }, tests: [],
  runs: [{ attempt: 1, outcome: "escalated", engine: "claude:sonnet", durationMs: 206893 }, { attempt: 2, outcome: "pass", engine: "claude:opus", durationMs: 1242436 }],
  tokens: 1748999, minutes: 67.5, scopeCheck: { clean: false, issues: [{ severity: "should_fix", text: "undeclared file x.md" }] },
  iterations: [{ kind: "red", ref: "slice 6", sha: null }, { kind: "green", ref: "slice 6", sha: "86ad651" }, { kind: "red", ref: "slice 7", sha: null }],
  summary: { what: "Three runbooks rewritten.", why: "Docs follow the STE rules.", files: [{ path: "docs/a.md", reason: "STE rewrite", in_code_map: true }] },
  limits: { max_iterations: 15, max_tokens: 2000000, max_minutes: 90 }, testsStep: { status: "skipped", why: "docs_only" },
  sweep: { status: "skipped", ran: [], note: "no check covers the change, so the regression sweep had nothing to run" },
};

const verifyReport = {
  prNumber: 221, headSha: "a68072a2b2548878b24ffaf9d03a1058f181bb01", tests: { passed: 22, total: 22 }, coverageDelta: null, e2e: { verdict: "pass", scenarios: [], rows: [{ scenario: "S1", title: "logs in", result: "pass", seen: "the page", artifacts: ["a.png"] }, { scenario: "S2", title: "logs out", result: "partial" }] },
  envReproduction: "matched", overrides: [], review: { engine: "codex:sol", family: "codex" }, mutation: null, ciClass: null, rounds: { verify: 0, e2e: 1, ci: 0 },
  findings: [
    { path: "docs/a.md", line: 16, severity: "blocker", title: "Unnamed passive", criterion_ref: "C1", resolution: { status: "fixed", by: "implementer" } },
    { path: "docs/b.md", line: 5, severity: "bug", title: "Open one", resolution: null },
    { severity: "style", title: "A nit" },
  ],
};

const planGate = (over = {}) => ({
  kind: "awaiting_approval", decision: null, response: null,
  requested: {
    risk: { level: "high", machine: "high", reason: "touches auth" }, riskRaised: "its origin was scored high", flagged: ["size unsure", "coverage", "plan", "map stale"], planIssues: ["step 2 names a file outside the code map"],
    verdicts: { coverage: "flag", plan: "ask", risk: "proceed" }, approvers: ["ana"], approvalRule: { needed: 3, outside: "skipped", text: "Needs 3 approvers. No CODEOWNERS rule matches." },
    coverageReport: { bar: 0.85, per: [{ id: "C1" }, { id: "C2" }, { id: "C3" }], gaps: ["C2", "C3"], untestable: ["C3"], open: [], thin: [], score: 0.5 },
    map: { stale: true, behind: 12, confidence: 0.4 }, plan: { acceptance_criteria: [{ id: "C1", text: "logs in" }, { id: "C2", text: "logs out" }, { id: "C3", text: "looks nice" }] },
    overrides: { risk: { level: "low", reason: "small", applied: false } },
    ...over,
  },
});

const finished = () => ({
  task: {}, approvals: [{ ...planGate(), decision: "approved", response: { approvers: ["ana", "bo"], approver: "bo" } }],
  stageRuns: [{ id: "r1", stage: "implementing", attempt: 1, status: "passed", engine: "claude:sonnet", startedAt: iso(NOW - 9e4), endedAt: iso(NOW - 6e4) }],
  events: [{ kind: "ship.merged", payload: { by: "person", mergedSha: "50550f151f94f0ae", number: 221 }, at: iso(NOW) }, { kind: "task.closed", payload: {}, at: iso(NOW) }],
  artifacts: [{ id: "a1", path: "/x/y.md", stageRunId: "r1" }], reports: { build: buildReport, verify: verifyReport }, buildProgress: null,
  ship: { pr: { number: 221, url: "https://github.com/o/r/pull/221" }, ready: true, checklist: [{ id: "ci", ok: true, detail: "ok" }], autoMerge: { allowed: false, reason: "a person merges it" }, review: { required: false, by: null }, fixRounds: 0, queued: false, lastEvent: { class: "parent_merged", at: iso(NOW) } },
});

const app = (over = {}) => {
  const states = { inspector: { opened: { tid: true } } };
  return {
    machine: { get: async () => [], patch: async () => ({}) }, tasks: [], loaded: true, page: "board", selected: "tid", tab: "details", details: {}, diffs: {}, prs: { inbox: null, all: null },
    busy: new Set(), width: 1400, search: {}, select() {}, act() {}, setTab() {}, openUrl() {}, dialog() {}, state: (id) => (states[id] ??= {}), loadDiff() {}, ...over,
  };
};
const draw = (a) => texts(inspector(a, t, 420)).join(" | ");
const show = (tk, detail, tab, over = {}) => draw(app({ tab, tasks: [tk], details: detail === undefined ? {} : { tid: detail }, ...over }));

// ---- which tab opens, which tabs show ----

test("a ticket opens on the page of its state, and Now, Stopped, Result show only where they apply", () => {
  assert.equal(defaultTab(task()), "now");
  assert.equal(defaultTab(task({ state: "escalated", running: false })), "stopped");
  assert.equal(defaultTab(task({ state: "awaiting_approval", running: false, waitingOnYou: true })), "plan");
  assert.equal(defaultTab(task({ state: "awaiting_test_check", running: false })), "tests");
  assert.equal(defaultTab(task({ state: "closed", running: false })), "result");
  assert.equal(defaultTab(task({ state: "awaiting_answers", running: false, waitingOnYou: true })), "details");
  assert.equal(defaultTab(task({ state: "draft", running: false })), "details");
  assert.ok(isRunning(task({ state: "ci_watch", running: false })) && !isRunning(task({ state: "closed" })));
  assert.ok(isStopped(task({ state: "paused_rate_limit" })) && isResult(task({ state: "reviewing_memory" })));
  const ids = (tk, d) => TABS.filter((x) => !x.when || x.when(app(), tk, d)).map((x) => x.id);
  assert.ok(ids(task(), undefined).includes("now") && !ids(task(), undefined).includes("stopped") && !ids(task(), undefined).includes("result"));
  assert.ok(ids(task({ state: "escalated", running: false }), undefined).includes("stopped"));
  assert.ok(ids(task({ state: "closed", running: false }), finished()).includes("reports"));
  assert.ok(!ids(task({ state: "closed", running: false }), { reports: null }).includes("reports"));
});

test("the first look at a ticket switches the default tab once, and a person's pick stays", () => {
  const tk = task({ state: "escalated", running: false });
  const a = app({ tab: "details", tasks: [tk], details: {} });
  a.state("inspector").opened = {};
  const first = draw(a);
  assert.equal(a.tab, "stopped");
  assert.match(first, /Stopped/);
  a.tab = "details";
  draw(a);
  assert.equal(a.tab, "details", "it does not take the tab back");
  const hidden = app({ tab: "now", tasks: [task({ state: "closed", running: false })], details: {} });
  assert.ok(draw(hidden), "a tab that does not apply falls back to the first shown one");
});

test("every tab is listed and reachable: the bar wraps instead of scrolling", () => {
  const words = show(task({ state: "closed", running: false }), finished(), "details");
  for (const label of ["Result", "Overview", "Plan", "Tests", "Reports", "Runs", "Changes", "Evidence", "PR", "Engines", "Activity"]) assert.ok(words.includes(label), `tab ${label} is in the bar`);
});

// ---- Now ----

test("Now: scenarios red and green, the budget against its limits, the checkpoint", () => {
  const v = buildProgressView({ buildProgress });
  assert.equal(v.green, 1);
  assert.deepEqual(v.budget.map((b) => b.text), ["3 of 15", "215,848 of 2,000,000", "6 of 90"]);
  assert.equal(v.checkpoint, "5fb5299 after a green scenario");
  assert.ok(v.budget[0].pct > 0 && v.budget[0].pct < 1);
  assert.equal(buildProgressView({}), null);
  assert.equal(buildProgressView({ buildProgress: { budget: { iterations: 1, tokens: null, minutes: 1, limits: {} } } }).budget[1].text, "not counted");
  const d = { ...finished(), buildProgress, stageRuns: [{ stage: "implementing", attempt: 2, status: "running", engine: "claude:sonnet" }], events: [{ kind: "stage.step", payload: {}, at: iso(NOW) }] };
  const words = show(task(), d, "now");
  assert.match(words, /Building #2 · on claude:sonnet/);
  assert.match(words, /1 of 3 green/);
  assert.match(words, /S20/);
  assert.match(words, /215,848 of 2,000,000/);
  assert.match(words, /5fb5299 after a green scenario/);
  assert.match(show(task(), undefined, "now"), /Reading…/);
  assert.match(show(task(), { ...d, buildProgress: null }, "now"), /no build progress/);
  assert.match(show(task({ state: "ci_watch", running: false }), { events: null, stageRuns: null }, "now"), /Nothing yet/);
});

// ---- Stopped ----

test("Stopped: the reason, how sure, the agent's word, a correction, the summary and the output", () => {
  const words = (r) => String(r).replaceAll("_", " ");
  const gate = { kind: "escalated", decision: null, requested: { escalationDecision: { reason: "plan_wrong", confidence: 0.82, source: "decision", agentReason: "too_complex" }, summary: "It could not build.", outputTail: "FAIL x\nboom", keptSandbox: { path: "/tmp/sb", until: "tomorrow" } } };
  const d = { approvals: [gate], events: [{ kind: "escalation.corrected", payload: { to: "other" }, at: iso(NOW) }], stageRuns: [] };
  const v = stoppedView(task({ reason: "the plan names a missing file" }), d, words);
  assert.deepEqual([v.label, v.sentence, v.how, v.agentSaid, v.corrected, v.tail, v.sandbox.path], ["plan wrong", "the plan names a missing file", ["82% sure", "judged by the escalation check"], "too complex", "other", "FAIL x\nboom", "/tmp/sb"]);
  const tk = task({ state: "escalated", running: false, reason: "the plan names a missing file" });
  const text = show(tk, d, "stopped");
  for (const m of [/✗ escalated · the plan is wrong/, /the plan names a missing file/, /82% sure/, /the agent said: too complex for this engine/, /corrected to: it needs a person/, /Summary/, /boom/, /\/tmp\/sb until tomorrow/]) assert.match(text, m);
  const failedRun = { approvals: [], stageRuns: [{ id: "r", stage: "verifying", attempt: 1, status: "failed" }], events: [{ kind: "stage.finished", payload: { stage: "verifying", attempt: 1, error: "container died" } }] };
  assert.equal(stoppedView(task(), failedRun, words).tail, "container died");
  assert.match(show(task({ state: "failed", running: false }), { approvals: null, events: null, stageRuns: null }, "stopped"), /recorded no reason/);
  assert.match(show(task({ state: "aborted", running: false }), undefined, "stopped"), /Reading…/);
});

// ---- Result ----

test("Result: the release question, the summary, open findings by level, the evidence count", () => {
  const ship = { kind: "awaiting_ship", decision: null, requested: { question: "safe to release?", risk: "high", checklist: [{ id: "ci", ok: true, detail: "CI is green" }, { id: "owners", ok: false }] } };
  const d = { ...finished(), approvals: [ship], events: [], task: {} };
  const tk = task({ state: "awaiting_ship", running: false, evidence: { diffSummary: { what: "Three runbooks.", why: "STE." } } });
  const v = resultView(tk, d);
  assert.equal(v.release.high, true);
  assert.deepEqual(v.release.checklist.map((c) => [c.ok, c.text]), [[true, "CI is green"], [false, "owners"]]);
  assert.deepEqual(v.findings.map((g) => [g.id, g.items.length]), [["blocker", 1], ["nit", 1]]);
  assert.equal(v.artifacts, 1);
  const text = show(tk, d, "result");
  for (const m of [/release owner: safe to release/, /CI is green/, /Why/, /STE\./, /Open findings/, /1 blocker · 1 nit/, /docs\/b\.md:5/, /1 file/]) assert.match(text, m);
  assert.match(show(task({ state: "closed", running: false }), { reports: null, approvals: [], artifacts: null }, "result"), /No summary was recorded/);
  assert.equal(findingLevel({ severity: "weird" }), "should_fix");
});

// ---- the reports ----

test("the Build Report and the Verify Report read as rows and draw on real and sparse shapes", () => {
  const b = buildReportView({ reports: { build: buildReport } });
  assert.deepEqual([b.head, b.iterations, b.scenarios, b.tokens, b.minutes], ["a68072a", "3 of 15", "1 green of 2", "1,748,999 of 2,000,000", "67.5 of 90"]);
  assert.equal(b.testsStep.note, "docs only");
  assert.equal(b.scope.clean, false);
  const v = verifyReportView({ reports: { verify: verifyReport } });
  assert.deepEqual([v.pr, v.tests, v.rounds, v.review, v.e2e.rows.length, v.findings.length], [221, "22 of 22 pass", "verify 0 · e2e 1 · ci 0", "codex:sol (codex family)", 2, 3]);
  assert.equal(v.findings[0].resolution, "fixed");
  assert.equal(buildReportView({}), null);
  assert.equal(verifyReportView({ reports: { verify: null } }), null);
  const text = show(task({ state: "closed", running: false }), finished(), "reports");
  for (const m of [/Build report/, /1,748,999 of 2,000,000/, /Tests first/, /Sweep/, /Scope check/, /undeclared file x\.md/, /Verify report/, /PR #221/, /22 of 22 pass/, /Browser run/, /logs in/, /Unnamed passive/, /fixed/]) assert.match(text, m);
  const sparse = { reports: { build: { branch: null }, verify: { e2e: { verdict: null, rows: null, scenarios: null }, findings: [null, { title: "x" }], tests: {}, overrides: ["one"], mutation: { score: 0.8 } } } };
  assert.match(show(task({ state: "closed", running: false }), sparse, "reports"), /No scenario was run in a browser/);
  assert.ok(!TABS.find((x) => x.id === "reports").when(app(), task(), { reports: {} }), "no report, no tab");
});

// ---- the plan gate's machine flags ----

test("machine flags: issues, uncovered, excused, risk raised and overridden, a stale map, flagged checks, each once", () => {
  const crit = [{ id: "C1", text: "logs in" }, { id: "C2", text: "logs out" }, { id: "C3", text: "looks nice" }];
  const flags = machineFlags(planGate(), crit);
  assert.deepEqual(flags, [
    "plan: step 2 names a file outside the code map",
    "coverage: C2 has no scenario: logs out",
    "coverage: C3 excused as untestable: looks nice",
    "risk raised: its origin was scored high",
    "you set low, below the machine's high: kept as ground truth (small); approvers and Ship read high",
    "the code map's graph is 12 commits behind the default branch",
    "size unsure",
  ], "a bare check name goes when a finding of that check says more");
  assert.deepEqual(machineFlags({ requested: { verdicts: { coverage: "flag", plan: "ask" } } }, []), ["coverage check flagged", "plan check is unsure"]);
  assert.deepEqual(openGaps(planGate()), ["C2"], "an excused criterion is not a gap");
  assert.deepEqual(machineFlags(null, []), []);
  assert.deepEqual(machineFlags({ requested: { flagged: ["triage.priority"], planIssues: null, coverageReport: { gaps: [{ id: "C9" }] } } }, []), ["coverage: C9 has no scenario", "triage priority flagged"]);
  assert.equal(riskOverrideLine({ requested: { overrides: { risk: { level: "high", applied: true, reason: "r" } } } }), "you set high: applied (r)");
  assert.deepEqual(coverageView(planGate()).untestable, ["C3"]);
  assert.equal(coverageView({ requested: {} }), null);
});

test("the approval rule: first, next and last of N approvers, with the names so far", () => {
  const rule = (n, names, risk = "high") => approvalRuleView({ requested: { risk: { level: risk }, approvalRule: n ? { needed: n, text: "Needs." } : undefined, approvers: names } });
  assert.equal(rule(2, []).position, "first of two approvers");
  assert.equal(rule(3, ["ana"]).position, "next of 3 approvers");
  assert.equal(rule(2, ["ana"]).position, "last of two approvers");
  assert.equal(rule(3, ["ana"]).line, "1 of 3 (ana)");
  assert.equal(rule(undefined, [], "high").needed, 2);
  assert.equal(rule(undefined, [], "low").position, null);
  assert.equal(approvalRuleView({ requested: {}, response: { approver: "bo" } }).line, "approved by bo");
  assert.equal(approvalRuleView(null).needed, 1);
});

test("the gate panel and the Plan tab show the flags, the rule and the names so far", () => {
  const gate = planGate();
  const tk = task({ state: "awaiting_approval", running: false, waitingOnYou: true, gate: { requested: gate.requested } });
  const panel = show(tk, undefined, "details");
  for (const m of [/The machine flagged/, /size unsure/, /risk raised: its origin was scored high/, /Needs 3 approvers/, /next of 3 approvers · 1 of 3 \(ana\)/, /1 criteria no test covers/]) assert.match(panel, m);
  assert.doesNotMatch(panel, /2 criteria no test covers/);
  const plan = show(tk, { approvals: [gate], stageRuns: [], events: [] }, "plan");
  for (const m of [/The machine flagged/, /coverage: flag/, /plan: ask/, /bar 85%/, /excused as untestable: C3/, /Risk raised: its origin was scored high/, /Approvers/, /next of 3 approvers/, /12 commits behind/]) assert.match(plan, m);
  const bare = task({ state: "awaiting_approval", running: false, waitingOnYou: true, gate: { requested: {} } });
  assert.ok(show(bare, { approvals: [{ kind: "awaiting_approval", requested: null }] }, "plan"));
});

// ---- origin and stack ----

test("Overview lists the sources, reporter, merged into, related, split part, depends on, stacked on, risk floor and the held reason", () => {
  const tk = task({
    state: "draft", running: false, sources: [{ kind: "github", repo: "o/r", number: 4 }, { type: "slack" }, { kind: "jira", key: "P-1" }, {}, null], reporter: { name: "Ana", channel: "slack" }, followers: ["U2"], owners: ["@team"],
    attachments: [{ name: "trace.txt" }], merged: [{ id: "11111111-2222-3333" }], mergedInto: "99999999-aaaa", related: ["aaaaaaaa-1", "bbbbbbbb-2"],
    splitFrom: "aaaaaaaa-0000", splitPart: { n: 2, of: 3 }, dependsOn: ["bbbbbbbb-0000"], base: { card: "cccccccc-0000", branch: "task/x" }, riskFloor: "high", startWhenReady: true, splitInto: ["dddddddd-1", "gone"],
  });
  const list = [{ id: "aaaaaaaa-0000", title: "Origin" }, { id: "dddddddd-1", title: "Kid", splitPart: { n: 1, of: 2 }, state: "draft" }];
  const rows = originRows(tk);
  assert.deepEqual(rows.slice(0, 4), [["Source", "GitHub o/r#4"], ["Source", "slack"], ["Source", "Jira P-1"], ["Source", "unknown source"]]);
  assert.ok(rows.some(([k, v]) => k === "Reporter" && v === "Ana (slack)") && rows.some(([k, v]) => k === "Merged into" && v === "99999999") && rows.some(([k, v]) => k === "Related" && v === "aaaaaaaa, bbbbbbbb"));
  const held = { events: [{ kind: "card.held", payload: { text: "held by\nCI" } }] };
  assert.equal(heldText(held), "held by\nCI");
  assert.equal(heldText({ events: [...held.events, { kind: "card.released", payload: {} }] }), null);
  assert.deepEqual(stackRows(tk, held, list), ["Part 2 of 3 of aaaaaaaa Origin", "Depends on bbbbbbbb", "Stacked on cccccccc (task/x)", "Risk floor high (its origin's: a part is never lower)", "held by CI", "Split into dddddddd part 1/2 Kid", "Split into gone"]);
  assert.deepEqual(stackRows(task(), null, null), []);
  const text = show(tk, held, "details", { tasks: [tk, ...list] });
  for (const m of [/GitHub o\/r#4/, /Ana \(slack\)/, /Merged into/, /99999999/, /Related/, /Part 2 of 3/, /Depends on/, /Stacked on/, /Risk floor high/, /held by CI/]) assert.match(text, m);
  assert.ok(show(task({ sources: null, reporter: "x", followers: null, related: null, splitPart: { n: 1 }, splitFrom: "z" }), undefined, "details"));
});

// ---- the fixes ----

test("Tests: a long criterion draws whole in a header that can shrink, and a finished card says verifying reported no verdicts", () => {
  const long = "docs/runbooks/calibrate-decisions.md and the others are in Simplified Technical English; no prose sentence is over 25 words ".repeat(3);
  const gate = { kind: "awaiting_approval", decision: "approved", requested: { plan: { acceptance_criteria: [{ id: "C1", text: long }] }, cases: [{ id: "S1", title: "case one", criterion: "C1" }] } };
  const d = { approvals: [gate], stageRuns: [], events: [] };
  const done = show(task({ state: "closed", running: false }), d, "tests");
  assert.match(done, /verifying reported no verdicts/);
  assert.ok(done.includes(`C1  ${long}`), "the whole text is handed over; the header truncates it on screen");
  assert.match(show(task(), d, "tests"), /verifying has not judged them yet/);
});

test("PR: a merged PR says Merged, with who and the sha, and no merge advice", () => {
  const tk = task({ state: "closed", running: false });
  const text = show(tk, finished(), "pr");
  assert.match(text, /Merged/);
  assert.match(text, /by person · 50550f1/);
  assert.doesNotMatch(text, /Watching/);
  assert.doesNotMatch(text, /a person merges it/);
  const open = { ...finished(), events: [] };
  assert.match(show(task({ state: "awaiting_ship", running: false }), open, "pr"), /Watching/);
  assert.equal(mergedEvent({ events: [] }), null);
  assert.equal(mergedEvent({}), null);
});

test("Engines: only the stages the route runs, no Change once the ticket ended, one set of words", () => {
  const packs = [
    { id: "triage", kind: "agent", states: ["triage"], engines: { default: "claude:opus", allowed: ["claude:opus"] } },
    { id: "build_tests", kind: "agent", states: ["implementing"], engines: { default: "claude:sonnet", allowed: ["claude:sonnet"] } },
    { id: "reviewing", kind: "agent", states: ["reviewing"], engines: { default: "codex:sol", allowed: ["codex:sol"] } },
    { id: "addressing", kind: "agent", states: ["addressing"], engines: { default: "claude:sonnet", allowed: ["claude:sonnet"] } },
    { id: "evidence", kind: "script", states: ["evidence"], engines: { default: "x", allowed: ["x"] } },
  ];
  assert.deepEqual(routePacks(task(), null, packs).map((p) => p.id), ["triage", "build_tests"]);
  assert.deepEqual(routePacks(task({ route: "review" }), null, packs).map((p) => p.id), ["reviewing"]);
  assert.deepEqual(routePacks(task({ route: "review", stages: { addressing: "claude:sonnet" } }), null, packs).map((p) => p.id), ["reviewing", "addressing"], "one the ticket set stays visible");
  assert.deepEqual(routePacks(task({ route: "weird" }), null, packs).length, 4, "an unknown route hides nothing");
  assert.equal(engineRows(task({ state: "closed" }), null, packs, [])[0].locked, true);
  assert.equal(engineRows(task(), null, packs, [])[0].locked, false);
  const open = app({ tab: "engines", tasks: [task()], details: { tid: finished() } });
  Object.assign(open.state("engines"), { packs, engines: [] });
  const live = draw(open);
  assert.match(live, /Triage/);
  assert.match(live, /Tests first/);
  assert.doesNotMatch(live, /Reviewing the PR|reviewing/);
  assert.match(live, /\bChange\b/);
  const over = app({ tab: "engines", tasks: [task({ state: "closed", running: false })], details: { tid: finished() } });
  Object.assign(over.state("engines"), { packs, engines: [] });
  const ended = draw(over);
  assert.doesNotMatch(ended, /\bChange\b/);
  assert.match(ended, /This ticket is over/);
});

test("every new section draws on a missing, a null-filled and a not-yet-read ticket", () => {
  const nulls = { approvals: null, stageRuns: null, events: null, artifacts: null, reports: { build: {}, verify: {} }, buildProgress: {}, ship: null };
  for (const tk of [task(), task({ state: "escalated", running: false }), task({ state: "closed", running: false }), task({ state: "awaiting_ship", running: false })]) {
    for (const id of ["now", "stopped", "result", "reports", "plan", "pr", "details"]) {
      for (const d of [undefined, {}, nulls, finished()]) assert.ok(show(tk, d, id) !== undefined, `${tk.state} ${id}`);
    }
  }
});
