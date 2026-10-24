// Shared pieces of the golden task and the golden matrix: fixtures, throwaway repos,
// the HTTP driver, and the grader. Pure grading lives in `grade` so it can be unit tested.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MACHINE_URL = process.env.HARDNESS_MACHINE_URL ?? "http://127.0.0.1:4317";
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

/** Stages whose runs are agent packs: a real run reports usage, a stub run does not. */
export const AGENT_STAGES = ["triage", "test_design", "implementing"];
/** Stages every graded run has to have passed. */
export const CORE_STAGES = ["triage", "test_design", "implementing", "verifying"];
export const MAX_DIFF_LINES = 300;
const SHIPPED = ["awaiting_ship", "shipping", "reviewing_memory", "closed"];

const started = Date.now();
export const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
export const log = (msg) => console.log(`[${elapsed()}] ${msg}`);

export function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const GIT_IDENT = ["-c", "user.name=Golden Task", "-c", "user.email=golden@hardness.local", "-c", "commit.gpgsign=false"];
const git = (cwd, ...args) => sh("git", [...GIT_IDENT, ...args], cwd);

// ---------- fixtures ----------

export function listFixtures() {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FIXTURES_DIR, d.name, ".golden", "tickets.json")))
    .map((d) => d.name)
    .sort();
}

/** `{ name, dir, test, install, tickets }` for one fixture; `test` is the command that grades it. */
export function loadFixture(name) {
  const dir = join(FIXTURES_DIR, name);
  const spec = JSON.parse(readFileSync(join(dir, ".golden", "tickets.json"), "utf8"));
  const test = spec.test ?? (existsSync(join(dir, "go.mod")) ? ["go", "test", "./..."] : ["npm", "test"]);
  return { name, dir, test, install: spec.install ?? null, tickets: spec.tickets };
}

/** A throwaway git repo seeded from the fixture (never including `.golden/`). Returns `{ dir, seed }`. */
export function setupRepo(fixture, ticket) {
  const dir = mkdtempSync(join(tmpdir(), "hardness-golden-"));
  cpSync(fixture.dir, dir, {
    recursive: true,
    filter: (src) => !/[\\/](\.golden|node_modules)([\\/]|$)/.test(src),
  });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed: base fixture");
  for (const patch of ticket.seed ?? []) git(dir, "apply", join(fixture.dir, ".golden", patch));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", `seed: ${ticket.id} ticket`);
  return { dir, seed: git(dir, "rev-parse", "HEAD") };
}

/** Copies the ticket's hidden acceptance tests into `dir`, if it has any. */
export function overlayAccept(fixture, ticket, dir) {
  if (ticket.accept) cpSync(join(fixture.dir, ".golden", ticket.accept), dir, { recursive: true });
}

/** Runs the fixture's own test command in `dir`; true when it exits 0. */
export function runFixtureTests(fixture, dir) {
  try {
    if (fixture.install) sh(fixture.install[0], fixture.install.slice(1), dir);
    sh(fixture.test[0], fixture.test.slice(1), dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Proves a ticket is red with its seed (plus hidden tests) and green with the reference
 * patch. Returns `{ red, green }`, both booleans meaning "behaved as expected".
 */
export function selftestTicket(fixture, ticket) {
  const { dir } = setupRepo(fixture, ticket);
  try {
    overlayAccept(fixture, ticket, dir);
    const red = !runFixtureTests(fixture, dir);
    git(dir, "apply", join(fixture.dir, ".golden", ticket.fix));
    const green = runFixtureTests(fixture, dir);
    return { red, green };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- HTTP ----------

export async function api(path, opts = {}) {
  const res = await fetch(`${MACHINE_URL}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...opts.headers },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export async function ensureMachine() {
  try {
    await api("/health");
  } catch {
    throw new Error(`machine is not reachable at ${MACHINE_URL} - start it with "pnpm dev" first`);
  }
}

/** Polls `/tasks/:id` until its state is in `targets`; fails fast on `escalated` unless it is a target. */
export async function waitFor(id, targets, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const { task } = await api(`/tasks/${id}`);
    if (task.state !== last) {
      log(`  state -> ${task.state}`);
      last = task.state;
    }
    if (targets.includes(task.state)) return task;
    if (task.state === "escalated" && !targets.includes("escalated")) {
      throw new Error(`task escalated: ${task.reason}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for one of [${targets.join(", ")}], last state ${last}`);
}

export const decide = (id, decision, reason) =>
  api(`/tasks/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, reason }) });

/**
 * Creates the task and walks it through the gates. Resolves with the task as it stood when
 * it reached ship (`awaiting_ship`, then approved) or escalated; never throws on escalation.
 */
export async function drive(ticket, repoPath) {
  const { id } = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: ticket.title, description: ticket.description, criteria: ticket.criteria, repoPath }),
  });
  log(`created task ${id}`);
  await api(`/tasks/${id}/start`, { method: "POST" });
  log("moved to intake");
  await api(`/tasks/${id}/start`, { method: "POST" });
  log("started");

  await waitFor(id, ["awaiting_approval"], 10 * 60_000);
  log("triage done, approving the plan");
  await decide(id, "approved");

  await waitFor(id, ["awaiting_test_check"], 60_000);
  log("test design done, approving the tests");
  await decide(id, "approved");

  // The delivering stage pushes and opens a draft PR. A fixture with no remote escalates
  // there, before evidence and ship, so both outcomes end the wait.
  const task = await waitFor(id, ["awaiting_ship", "escalated"], 20 * 60_000);
  if (task.state === "awaiting_ship") {
    log("implementer, verify, e2e, deliver, ci and evidence all passed, approving ship");
    await decide(id, "approved");
    const after = await waitFor(id, ["reviewing_memory", "escalated", "closed"], 60_000);
    if (after.state === "reviewing_memory") {
      log("approving the memory review");
      await decide(id, "approved");
      await waitFor(id, ["closed"], 30_000);
    }
  }
  return { id, task };
}

// ---------- grading ----------

/** Sum of insertions and deletions in `git diff --shortstat` output. */
export function parseShortstat(text) {
  const n = (re) => Number(re.exec(text)?.[1] ?? 0);
  return n(/(\d+) insertion/) + n(/(\d+) deletion/);
}

export function passRate(runs) {
  return runs.length === 0 ? 0 : runs.filter((r) => r.result === "pass").length / runs.length;
}

/**
 * Grades one run from the task detail (`GET /tasks/:id`). Checks: suite green, every
 * stage on the path passed, no stub ran, evidence verdict pass|skipped, cost under the
 * ceiling, diff within budget.
 */
export function grade({ detail, testPassed, diffLines, ceilingUsd, expectNoRemote }) {
  const { task, stageRuns, approvals } = detail;
  const failures = [];
  const lastRun = (stage) => stageRuns.filter((r) => r.stage === stage).at(-1);

  // A run with no remote escalates at delivering; that is the expected end of the path.
  const expectedEscalation =
    expectNoRemote && task.state === "escalated" && stageRuns.at(-1)?.stage === "delivering";
  const reachedEnd = SHIPPED.includes(task.state) || expectedEscalation;

  let stages = true;
  if (!reachedEnd) {
    stages = false;
    failures.push(
      task.state === "escalated" ? `escalated: ${task.reason ?? "no reason given"}` : `ended in ${task.state}`,
    );
  }
  for (const stage of CORE_STAGES) {
    if (!stageRuns.some((r) => r.stage === stage && r.status === "passed")) {
      stages = false;
      failures.push(`stage ${stage} never passed`);
    }
  }
  for (const stage of new Set(stageRuns.map((r) => r.stage))) {
    if (expectedEscalation && stage === "delivering") continue;
    if (lastRun(stage).status !== "passed" && CORE_STAGES.indexOf(stage) === -1) {
      stages = false;
      failures.push(`stage ${stage} ended ${lastRun(stage).status}`);
    }
  }

  const stubbed = stageRuns.filter(
    (r) => AGENT_STAGES.includes(r.stage) && r.status === "passed" && (r.costUsd == null || r.turns == null),
  );
  const stubFree = stubbed.length === 0;
  if (!stubFree) failures.push(`stub ran: ${[...new Set(stubbed.map((r) => r.stage))].join(", ")}`);

  const ship = approvals.find((a) => a.kind === "awaiting_ship");
  const verdict = ship?.requested?.evidence?.verdict ?? null;
  const evidence = ship ? verdict === "pass" || verdict === "skipped" : expectedEscalation;
  if (!evidence) failures.push(ship ? `evidence verdict ${verdict}` : "no ship approval");

  const costUsd = stageRuns.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const cost = costUsd <= ceilingUsd;
  if (!cost) failures.push(`cost $${costUsd.toFixed(2)} over $${ceilingUsd}`);

  const size = diffLines <= MAX_DIFF_LINES;
  if (!size) failures.push(`diff ${diffLines} lines over ${MAX_DIFF_LINES}`);

  if (!testPassed) failures.push("fixture tests fail in the worktree");

  const checks = { suite: testPassed, stages, stubFree, evidence, cost, size };
  return { result: Object.values(checks).every(Boolean) ? "pass" : "fail", checks, failures, costUsd, verdict };
}

// ---------- matrix ----------

/** Drives and grades one fixture x ticket. Never throws; an error becomes a failed run. */
export async function runTicket(fixture, ticket, { ceilingUsd, expectNoRemote }) {
  const t0 = Date.now();
  const entry = { fixture: fixture.name, ticket: ticket.id, result: "fail", costUsd: 0, seconds: 0, checks: null, failures: [] };
  const { dir: repoPath, seed } = setupRepo(fixture, ticket);
  let worktreePath = null;
  try {
    log(`${fixture.name}/${ticket.id}: repo at ${repoPath}`);
    const { id } = await drive(ticket, repoPath);
    const detail = await api(`/tasks/${id}`);
    entry.taskId = id;
    entry.metrics = await api("/metrics?since=1d").catch(() => null);
    worktreePath = detail.task.worktreePath;
    let testPassed = false;
    let diffLines = 0;
    if (worktreePath) {
      overlayAccept(fixture, ticket, worktreePath);
      testPassed = runFixtureTests(fixture, worktreePath);
      diffLines = parseShortstat(git(worktreePath, "diff", "--shortstat", `${seed}..HEAD`));
    }
    const graded = grade({ detail, testPassed, diffLines, ceilingUsd, expectNoRemote });
    if (!worktreePath) graded.failures.push("no worktree: the implementer never ran");
    Object.assign(entry, graded, { diffLines, result: worktreePath ? graded.result : "fail" });
  } catch (error) {
    entry.failures.push(error.message);
  } finally {
    entry.seconds = Math.round((Date.now() - t0) / 1000);
    if (worktreePath) rmSync(dirname(worktreePath), { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
  return entry;
}

export function formatTable(runs) {
  const rows = [["fixture", "ticket", "result", "cost", "time"]].concat(
    runs.map((r) => [r.fixture, r.ticket, r.result, `$${r.costUsd.toFixed(2)}`, `${r.seconds}s`]),
  );
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}
