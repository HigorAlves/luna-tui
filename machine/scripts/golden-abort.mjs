#!/usr/bin/env node
// Live abort check: starts a real Implementer run and aborts it a few seconds in,
// confirming the task escalates cleanly and the worktree is reset — not just that
// pipeline.test.ts's stub double resolves the way we expect.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MACHINE_URL = process.env.HARDNESS_MACHINE_URL ?? "http://127.0.0.1:4317";
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "golden-task");

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

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hardness-abort-"));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const git = (...args) => sh("git", ["-c", "commit.gpgsign=false", ...args], dir);
  git("init", "-q");
  git("-c", "user.name=Golden", "-c", "user.email=golden@hardness.local", "add", "-A");
  git("-c", "user.name=Golden", "-c", "user.email=golden@hardness.local", "commit", "-q", "-m", "seed");
  return dir;
}

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
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for [${targets.join(", ")}], last state ${last}`);
}

async function main() {
  try {
    await api("/health");
  } catch {
    throw new Error(`machine not reachable at ${MACHINE_URL} — start it with a real credential and pnpm dev`);
  }

  const repoPath = setupRepo();
  const { id } = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "Cart totals show wrong price",
      description: "Fix formatPrice in src/cart.js so prices always show two decimals.",
      criteria: ["`npm test` passes"],
      repoPath,
    }),
  });
  await api(`/tasks/${id}/start`, { method: "POST" });
  await api(`/tasks/${id}/start`, { method: "POST" });
  await waitFor(id, ["awaiting_approval"], 10 * 60_000);
  await api(`/tasks/${id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approved" }) });
  await waitFor(id, ["awaiting_test_check"], 60_000);
  await api(`/tasks/${id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approved" }) });

  log("implementer starting; waiting a few seconds before aborting");
  await waitFor(id, ["implementing"], 60_000);
  await new Promise((r) => setTimeout(r, 5000));

  log("aborting");
  await api(`/tasks/${id}/abort`, { method: "POST" });
  const aborted = await waitFor(id, ["escalated"], 30_000);
  if (aborted.reason !== "aborted") throw new Error(`expected reason "aborted", got "${aborted.reason}"`);
  log(`escalated with reason "${aborted.reason}" as expected`);

  if (!aborted.worktreePath) throw new Error("expected a worktree to check after abort");
  const status = sh("git", ["status", "--porcelain"], aborted.worktreePath);
  if (status.trim() !== "") throw new Error(`expected a clean worktree after abort, got:\n${status}`);
  log("worktree is clean — resetWorktree() ran as expected");

  rmSync(dirname(aborted.worktreePath), { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  await api(`/tasks/${id}`, { method: "DELETE" });
  log(`golden abort check passed in ${elapsed()}`);
}

main().catch((error) => {
  console.error(`\n[${elapsed()}] golden abort FAILED: ${error.message}`);
  process.exit(1);
});
