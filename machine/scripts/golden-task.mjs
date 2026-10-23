#!/usr/bin/env node
// Phase 6: the golden task. Drives a small fixture repo through the whole pipeline
// graph via the machine's HTTP API, the same way a person would through the board.
// Run after `pnpm dev` (and, for a real implementer run, with a credential and the
// runner image built): `pnpm --filter @hardness/machine golden`.
//
// This is the regression check for the whole graph: any change that breaks a
// transition, a gate, or the implementer's commit should break this script.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MACHINE_URL = process.env.HARDNESS_MACHINE_URL ?? "http://127.0.0.1:4317";
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "golden-task");

const TICKET = {
  title: "Cart totals show wrong price",
  description:
    "formatPrice drops the second decimal digit for round dollar amounts, e.g. $1.00 shows as $1.0. " +
    "Fix formatPrice in src/cart.js so prices always show two decimals.",
  criteria: [
    'formatPrice(1234) returns "$12.34"',
    'formatPrice(100) returns "$1.00"',
    "`npm test` passes",
  ],
};

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (msg) => console.log(`[${elapsed()}] ${msg}`);

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function api(path, opts = {}) {
  const res = await fetch(`${MACHINE_URL}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...opts.headers },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** A throwaway git repo with the fixture's seeded bug, fresh for this run. */
function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hardness-golden-"));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const git = (...args) => sh("git", ["-c", "commit.gpgsign=false", ...args], dir);
  git("init", "-q");
  git("-c", "user.name=Golden Task", "-c", "user.email=golden@hardness.local", "add", "-A");
  git("-c", "user.name=Golden Task", "-c", "user.email=golden@hardness.local", "commit", "-q", "-m", "seed: known bug");
  return dir;
}

/** Polls `/tasks/:id` until its state is in `targets`, fails fast on `escalated`. */
async function waitFor(id, targets, timeoutMs) {
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

async function decide(id, decision, reason) {
  return api(`/tasks/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, reason }) });
}

async function main() {
  try {
    await api("/health");
  } catch {
    throw new Error(`machine is not reachable at ${MACHINE_URL} - start it with "pnpm dev" first`);
  }

  const repoPath = setupRepo();
  log(`fixture repo at ${repoPath}`);

  const { id } = await api("/tasks", { method: "POST", body: JSON.stringify({ ...TICKET, repoPath }) });
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

  const afterImplementer = await waitFor(id, ["awaiting_ship"], 20 * 60_000);
  log("implementer, verify, e2e, deliver, ci and evidence all passed, approving ship");
  await decide(id, "approved");

  // This fixture has no git remote, so shipping (a real `git push` + `gh pr create`) is
  // expected to escalate here, not reach reviewing_memory. That's still a pass: everything
  // this script actually verifies (the bug fix, the gates, the graph) already happened.
  const shipped = await waitFor(id, ["reviewing_memory", "escalated"], 60_000);
  if (shipped.state === "escalated") {
    log(`shipping escalated as expected, no git remote on this throwaway fixture: ${shipped.reason}`);
  } else {
    log("approving the memory review");
    await decide(id, "approved");
    await waitFor(id, ["closed"], 30_000);
    log("task closed");
  }

  if (afterImplementer.worktreePath) {
    log(`checking the implementer's fix in ${afterImplementer.worktreePath}`);
    sh("npm", ["test"], afterImplementer.worktreePath);
    log("fixture's own tests pass against the implementer's commit");
  } else {
    log("no worktree (agents were off or a credential was missing): traversed the whole graph with stubs only");
  }

  // The worktree lives at `<worktreesDir>/<basename(repoPath)>/task-<name>`; since repoPath
  // is unique per run, its parent directory is ours alone to remove.
  if (afterImplementer.worktreePath) rmSync(dirname(afterImplementer.worktreePath), { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  log(`golden task passed in ${elapsed()}`);
}

main().catch((error) => {
  console.error(`\n[${elapsed()}] golden task FAILED: ${error.message}`);
  process.exit(1);
});
