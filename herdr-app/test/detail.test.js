// The inspector's detail tabs: pure helpers as plain functions, and every tab drawn with the host
// stand-in on realistic and on empty or null fields.
import assert from "node:assert/strict";
import { test } from "node:test";

import { theme } from "./host/stub.js";
import "../luna/features.js";
import { inspector } from "../luna/inspector.js";
import { DIALOGS, TABS } from "../luna/registry.js";
import {
  artifactGroups, clockLabel, criteriaRows, dueDay, engineChoices, engineRows, jiraSummary, parsePatch, planCriteria, planHistory,
  pickedRun, prFor, runError, runTook, slaParts, testCases, testGroups, worktreeFile,
} from "../luna/detail-model.js";

const t = theme();
const NOW = Date.parse("2026-11-12T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

const plan = (over = {}) => ({
  kind: "awaiting_approval", decision: "approved", decidedAt: "2026-11-12T10:05:00Z", reason: null, response: { approver: "ana" },
  requested: {
    brief: "Do **it**", risk: { level: "medium", reason: "touches auth" }, size: { estLoc: 90 }, assumptions: ["A1"], rollback: "revert",
    plan: { goal: "g", rollback: "revert the PR", migration: "none", out_of_scope: ["x"], acceptance_criteria: [{ id: "C1", text: "logs in" }, { id: "C2", text: "logs out" }], steps: [{ id: "P1", title: "Add route", est_loc: 40, files: ["a.ts"], new_files: ["b.ts"], done_when: ["it works"] }] },
    cases: [
      { id: "S1", title: "logs in ok", type: "happy", layer: "unit", criterion: "C1" },
      { id: "S2", title: "logs in bad", type: "failure", layer: "integration", criterion: "logs in" },
      { id: "S3", title: "orphan", type: "edge", layer: "e2e", criterion: "nothing" },
    ],
    coverageReport: { gaps: ["C2"] }, map: { note: "n", confidence: 0.8, stale: true, components: ["web"], files: [{ path: "a.ts", role: "route" }] },
    revisions: [{ at: "2026-11-12T10:01:00Z", by: "me", after: { brief: "x", criteria: [] } }],
    ...over,
  },
});

const detail = (over = {}) => ({
  task: {},
  approvals: [
    { kind: "awaiting_approval", decision: "sent_back", decidedAt: "2026-11-12T09:00:00Z", reason: "split it", requested: {} },
    plan(),
    { kind: "reviewing_memory", decision: "approved", requested: { rules: { markdown: "```diff\n+x\n```" }, error: null } },
  ],
  stageRuns: [
    { id: "r1", stage: "triage", attempt: 1, status: "passed", costUsd: 0.1, turns: 3, engine: "claude:opus", startedAt: iso(NOW - 120000), endedAt: iso(NOW - 60000), cases: null },
    { id: "r2", stage: "verifying", attempt: 1, status: "failed", costUsd: null, turns: null, engine: null, startedAt: iso(NOW - 50000), endedAt: null, cases: [{ title: "logs in ok", ok: true }, { title: "logs in bad", ok: false }] },
  ],
  events: [{ kind: "stage.finished", payload: { stage: "verifying", attempt: 1, detail: { error: "boom" } }, at: iso(NOW) }],
  artifacts: [{ id: "a1", stageRunId: "r2", kind: "rules", path: "/x/y/rules.md", label: "rules.md" }, { id: "a2", stageRunId: "gone", kind: "log", path: "/x/log.txt" }],
  ship: { pr: { number: 7, url: "https://github.com/o/r/pull/7" }, ready: false, checklist: [{ id: "ci", ok: false, detail: "red" }], autoMerge: { allowed: false, reason: "needs review" }, review: { required: true, by: "bob" }, fixRounds: 2, queued: false, lastEvent: { class: "ci_failed", at: iso(NOW) } },
  ...over,
});

test("criteria rows join the plan, the cases and verifying's verdicts", () => {
  const rows = criteriaRows({ criteria: ["extra"] }, detail());
  assert.deepEqual(rows.map((r) => [r.id, r.planned, r.cases]), [["C1", true, 2], ["C2", true, 0], ["", false, 0]]);
  assert.deepEqual(rows[0].verify, { ok: 1, total: 2 });
  assert.equal(rows[1].verify, null);
  assert.deepEqual(criteriaRows({ criteria: ["a"] }, null).map((r) => [r.text, r.planned]), [["a", null]]);
  assert.deepEqual(criteriaRows({}, {}), []);
});

test("plan criteria fall back to the listed ones, numbered", () => {
  assert.deepEqual(planCriteria({ requested: { criteria: ["x", "y"] } }, {}), [{ id: "C1", text: "x" }, { id: "C2", text: "y" }]);
  assert.deepEqual(planCriteria(null, { criteria: ["z"] }), [{ id: "C1", text: "z" }]);
});

test("test cases group under the criterion they name, by id or text", () => {
  const cases = testCases(detail());
  assert.equal(cases.length, 3);
  assert.equal(cases[0].result, true);
  assert.equal(cases[1].result, false);
  assert.equal(cases[2].result, null);
  const groups = testGroups({}, detail());
  assert.deepEqual(groups.map((g) => [g.id, g.cases.length]), [["C1", 2], ["C2", 0], ["", 1]]);
  assert.deepEqual(testGroups({}, null), []);
});

test("clocks read against their target and the tone follows overdue and warn", () => {
  const due = iso(NOW + 30 * 60000);
  assert.equal(clockLabel({ dueAt: due, targetSecs: 3600 }, NOW), "30m of 1h");
  assert.match(clockLabel({ dueAt: iso(NOW - 40 * 60000), targetSecs: 3600, overdue: true }, NOW), /^overdue 40m/);
  assert.equal(clockLabel({}, NOW), null);
  const parts = slaParts({ gate: { dueAt: iso(NOW - 1000), overdue: true, targetSecs: 60 }, stage: { dueAt: due, targetSecs: 3600, stage: "implementing", warn: true }, jiraDue: { dueAt: iso(NOW + 86400000) } }, NOW);
  assert.deepEqual(parts.map((p) => p.tone), ["error", "blocked", null]);
  assert.match(parts[1].text, /^stage implementing/);
  assert.equal(parts[2].text, "jira due tomorrow");
  assert.deepEqual(slaParts(null), []);
  assert.equal(dueDay(iso(NOW), NOW), "today");
  assert.equal(jiraSummary({ key: "P-1", status: "Doing", priority: "High" }, NOW), "P-1 · Doing · High");
  assert.equal(jiraSummary(null), null);
});

test("the plan history lists edits, send-backs with their reason, and the approval with who", () => {
  const h = planHistory(detail());
  assert.deepEqual(h.map((x) => x.text), ["sent back · split it", "me edited brief, criteria", "approved by ana"]);
  assert.deepEqual(planHistory({}), []);
});

test("runs: the latest is picked unless one is named, errors come from the finish event", () => {
  const d = detail();
  assert.equal(pickedRun(d, null).id, "r2");
  assert.equal(pickedRun(d, "r1").id, "r1");
  assert.equal(pickedRun(d, "nope").id, "r2");
  assert.equal(pickedRun({}, null), null);
  assert.equal(runError(d, d.stageRuns[1]), "boom");
  assert.equal(runError(d, d.stageRuns[0]), null);
  assert.equal(runTook(d.stageRuns[0], NOW), "1m");
  assert.equal(runTook({}, NOW), null);
});

test("artifacts group by run, the ones with no run last", () => {
  const g = artifactGroups(detail());
  assert.deepEqual(g.map((x) => [x.run?.id ?? null, x.files.length]), [["r2", 1], [null, 1]]);
  assert.deepEqual(artifactGroups({}), []);
});

test("a PR row matches by the task's branch in the inbox, then all repos", () => {
  const row = { headRef: "task/x", number: 1 };
  assert.equal(prFor({ branch: "task/x" }, { inbox: null, all: { prs: [row] } }), row);
  assert.equal(prFor({ branch: null }, { inbox: { prs: [row] } }), null);
  assert.equal(prFor({ branch: "other" }, { inbox: { prs: [row] } }), null);
});

test("engines: rows show the task's engine, else the default, and where it ran", () => {
  const packs = [
    { id: "triage", kind: "agent", engines: { default: "claude:opus", allowed: ["claude:opus", "codex:sol", "openai:sol"] }, states: ["triage"] },
    { id: "script", kind: "script", engines: { default: "x", allowed: [] }, states: ["ci"] },
    { id: "idle", kind: "agent", engines: { default: "x", allowed: ["x"] }, states: [] },
  ];
  const engines = [{ id: "claude:opus", available: true, modelId: "m" }, { id: "codex:sol", available: false, reason: "no login" }];
  const rows = engineRows({ stages: { triage: "codex:sol" } }, detail(), packs, engines);
  assert.deepEqual(rows.map((r) => [r.pack, r.engine, r.ran, r.off]), [["triage", "codex:sol", "claude:opus", "no credential here"]]);
  assert.equal(engineRows({}, null, packs, null)[0].engine, "default: claude:opus");
  const choices = engineChoices(packs[0], engines);
  assert.deepEqual(choices.map((c) => c.engine), [null, "claude:opus", "codex:sol", "openai:sol"]);
  assert.deepEqual(choices.map((c) => c.off), [null, null, "no login", "unknown to this machine"]);
  assert.deepEqual(engineRows({}, {}, null, null), []);
});

test("a patch becomes rows with line numbers from the hunk headers", () => {
  const rows = parsePatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn\n ctx\n-old\n+new\n+more\n\\ No newline\n");
  assert.deepEqual(rows.map((r) => r.kind), ["meta", "meta", "meta", "hunk", "ctx", "del", "add", "add", "meta"]);
  assert.deepEqual([rows[4].old, rows[4].new], [3, 3]);
  assert.deepEqual([rows[5].old, rows[5].new], [4, null]);
  assert.deepEqual([rows[7].old, rows[7].new], [null, 5]);
  assert.deepEqual(parsePatch(""), []);
  assert.deepEqual(parsePatch(null), []);
  assert.equal(worktreeFile({ worktreePath: "/w/" }, "a/b.ts"), "/w/a/b.ts");
  assert.equal(worktreeFile({}, "a"), null);
});

// ---- drawing ----

const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};

const task = (over = {}) => ({
  id: "tid", title: "A task", state: "implementing", column: "Build", route: "feature", repoPath: "/w/shop", branch: "task/x", worktreePath: "/w/wt",
  waitingOnYou: false, running: true, queued: false, updatedAt: iso(NOW), seq: 1, criteria: ["logs in", "logs out"], spentUsd: 1.5, description: "Do it",
  reason: "env_broken", jira: { key: "P-1", status: "Doing", url: "https://j/P-1" }, source: { kind: "github", issue: 4 }, retries: { verify: 1, e2e: 0, ci: 2, total: 3 },
  sla: { gate: { dueAt: iso(NOW - 5000), overdue: true, targetSecs: 60 }, stage: { dueAt: iso(NOW + 60000), targetSecs: 3600, stage: "implementing", warn: true } },
  stages: { triage: "codex:sol" },
  evidence: { format: "captures", published: true, risk: "low", summary: "Works", results: { unit: { passed: 3, total: 4 }, e2e: { verdict: "pass" } }, scenarios: [{ text: "s", result: "pass" }, { text: "t", result: "not_run" }], findingsDetail: [{ id: "F1", title: "bug", severity: "blocker", resolution: "fixed" }], media: [{ label: "clip", url: "https://v/x.mp4", localPath: "/m/x.mp4" }, { label: "bare" }], video: { verdict: "ship" }, howToVerify: "run it", rollback: "revert" },
  ...over,
});

const app = (over = {}) => {
  const states = {};
  return {
    machine: { base: "x", approver: null, diff: async () => ({ patch: "" }), get: async () => [], patch: async () => ({}) },
    tasks: [], loaded: true, page: "board", selected: "tid", tab: "details", details: {}, diffs: {}, prs: { inbox: null, all: null }, busy: new Set(), flash: null,
    width: 1400, boardWidth: 1100, search: {}, select() {}, act() {}, setTab() {}, openUrl() {}, dialog() {},
    state: (id) => (states[id] ??= {}), loadDiff() {}, ...over,
  };
};

const prRow = { repo: "o/r", number: 7, title: "t", url: "https://x", headRef: "task/x", isDraft: false, reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 1, checks: { state: "failure", passed: 1, total: 2, failed: [{ name: "ci" }], all: [{ name: "lint", state: "success", url: "https://c" }, { name: "ci", state: "failure" }] }, task: { id: "tid", title: "PR #7: t", state: "ci_watch" } };

const FIXTURES = {
  full: { task: task(), detail: detail(), diff: { base: "main", files: [{ path: "a.ts", status: "M", added: 1, removed: 2 }, { path: "b.ts", status: "A", added: 3, removed: 0 }] }, prs: { inbox: { prs: [prRow] }, all: null } },
  empty: { task: task({ criteria: [], description: "", reason: null, jira: null, source: null, sla: null, stages: {}, evidence: null, retries: null, spentUsd: null, branch: null, worktreePath: null, repoPath: null }), detail: { task: {}, approvals: [], stageRuns: [], events: [], artifacts: [], ship: null }, diff: { base: "main", files: [] }, prs: { inbox: null, all: null } },
  nulls: { task: task({ criteria: null, evidence: { media: null, scenarios: null, results: null, findings: null }, sla: {}, stages: null, jira: { key: "P-2" } }), detail: { approvals: [{ kind: "awaiting_approval", requested: null }, { kind: "reviewing_memory", requested: { rules: null } }], stageRuns: [{ stage: "x" }], events: null, artifacts: [{ path: "p" }], reports: null }, diff: { error: "No workspace on disk: nothing to diff." }, prs: { inbox: { prs: null }, all: null } },
  reading: { task: task({ evidence: null }), detail: undefined, diff: undefined, prs: { inbox: null, all: null } },
  setup: { task: task({ state: "awaiting_setup", gate: { requested: { kind: "setup", yaml: "a: 1", proof: { ok: true } } } }), detail: detail(), diff: { base: "main", files: [] }, prs: {} },
  proofString: { task: task({ gate: { requested: { proof: "text" } } }), detail: detail({ ship: null }), diff: undefined, prs: { inbox: null, all: null } },
};

test("every tab draws on a full, an empty, a null-filled and a not-yet-read ticket", () => {
  const ids = ["details", "plan", "tests", "runs", "changes", "evidence", "pr", "engines", "activity"];
  for (const id of ids) assert.ok(TABS.some((x) => x.id === id), `tab ${id} is registered`);
  for (const [name, f] of Object.entries(FIXTURES)) {
    for (const id of ids) {
      const a = app({ tab: id, tasks: [f.task], details: f.detail === undefined ? {} : { tid: f.detail }, diffs: f.diff ? { tid: f.diff } : {}, prs: f.prs });
      a.state("engines").packs = [{ id: "triage", kind: "agent", engines: { default: "claude:opus", allowed: ["claude:opus"] }, states: ["triage"] }];
      a.state("engines").engines = null;
      assert.ok(inspector(a, t, 420), `${name} on ${id}`);
    }
  }
});

test("the tabs say what the ticket holds", () => {
  const f = FIXTURES.full;
  const show = (id, over = {}) => texts(inspector(app({ tab: id, tasks: [f.task], details: { tid: f.detail }, diffs: { tid: f.diff }, prs: f.prs, ...over }), t, 420)).join(" | ");
  const overview = show("details");
  assert.match(overview, /logs in/);
  assert.match(overview, /1\/2 pass/);
  assert.match(overview, /2 cases/);
  assert.match(overview, /gate overdue/);
  assert.match(overview, /stage implementing/);
  assert.match(overview, /Memory review: the rules/);
  assert.match(show("plan"), /sent back · split it/);
  assert.match(show("plan"), /Approved by ana/);
  assert.match(show("plan"), /Add route/);
  assert.match(show("tests"), /logs in ok/);
  assert.match(show("runs"), /boom/);
  assert.match(show("evidence"), /Video verdict: ship/);
  assert.match(show("evidence"), /rules\.md/);
  const pr = show("pr");
  assert.match(pr, /o\/r#7/);
  assert.match(pr, /lint/);
  assert.match(pr, /2 fix rounds|2/);
  assert.match(show("changes"), /a\.ts/);
  assert.match(texts(inspector(app({ tab: "changes", tasks: [task({ id: "none" })], selected: "none", details: {}, diffs: { none: { base: "main", files: [] } } }), t, 420)).join(" "), /No changes against main/);
  assert.match(texts(inspector(app({ tab: "tests", tasks: [FIXTURES.empty.task], details: { tid: FIXTURES.empty.detail } }), t, 420)).join(" "), /No test cases yet/);
});

test("the Changes tab loads a patch on a click and draws rows", async () => {
  const f = FIXTURES.full;
  const a = app({ tab: "changes", tasks: [f.task], details: { tid: f.detail }, diffs: { tid: f.diff } });
  a.machine.diff = async (id, file) => ({ patch: `@@ -1 +1 @@\n-a\n+b\n`, truncated: true, file });
  const st = a.state("changes");
  Object.assign((st.tid = {}), { file: "a.ts", loading: false, patch: "@@ -1,2 +1,2 @@\n ctx\n-a\n+b\n", shown: 400, truncated: true });
  const words = texts(inspector(a, t, 420)).join(" | ");
  assert.match(words, /Open file/);
  assert.match(words, /512 KB/);
  Object.assign(st.tid, { loading: true });
  assert.match(texts(inspector(a, t, 420)).join(" "), /Reading the patch/);
  Object.assign(st.tid, { loading: false, patch: "", error: null });
  assert.match(texts(inspector(a, t, 420)).join(" "), /No patch for this file/);
});

test("the engine picker dims an engine with no credential and refuses nothing it cannot send", () => {
  const d = { kind: "engine", taskId: "tid", pack: "triage", current: null, ran: true, choices: engineChoices({ engines: { default: "claude:opus", allowed: ["claude:opus", "openai:sol"] } }, [{ id: "claude:opus", available: true }, { id: "openai:sol", available: false, reason: "no key" }]) };
  const calls = [];
  const a = { machine: { patch: async (...x) => calls.push(x) }, send: () => {} };
  const body = DIALOGS.engine.body(a, t, d);
  const words = body.flatMap((e) => texts(e)).join(" | ");
  assert.match(words, /no key/);
  assert.match(words, /already ran/);
  assert.equal(DIALOGS.engine.primary(), null);
});
