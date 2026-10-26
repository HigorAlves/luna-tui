#!/usr/bin/env node
// Live retry/escalation check for the real Verifier (needs the Verifier stage to exist).
// Runs two tasks against fixtures/golden-flaky: one passes on the 2nd verify attempt
// (retry path), one never passes (escalation path, LOOP_CAP=3 in engine/transition.ts).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { counterFilePath } from "../../fixtures/golden-flaky/counter-path.mjs";

const MACHINE_URL = process.env.HARDNESS_MACHINE_URL ?? "http://127.0.0.1:4317";
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "golden-flaky");

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (msg) => console.log(`[${elapsed()}] ${msg}`);

function sh(cmd, args, cwd, env) {
  return execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

/** `passAfter` bakes FLAKY_PASSES_AFTER into the fixture's own package.json test script,
 *  since the Verifier runs `npm test` as a plain subprocess with no env var threaded
 *  through from here. */
function setupRepo(passAfter) {
  const dir = mkdtempSync(join(tmpdir(), "hardness-flaky-"));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "golden-flaky-fixture",
      private: true,
      type: "module",
      scripts: { test: `FLAKY_PASSES_AFTER=${passAfter} node --test` },
    }),
  );
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
    if (task.state === "escalated" && !targets.includes("escalated")) {
      throw new Error(`task escalated: ${task.reason}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for [${targets.join(", ")}], last state ${last}`);
}

async function runToShip(passAfter) {
  const repoPath = setupRepo(passAfter);
  const { id } = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "Flaky check",
      description:
        "This is a pipeline test fixture, not a real bug. src/thing.js is already correct — do not change it. " +
        "The test may fail the first time you run it; that's expected and not something to fix. Just report done.",
      criteria: ["`npm test` eventually passes"],
      repoPath,
    }),
  });
  await api(`/tasks/${id}/start`, { method: "POST" });
  await api(`/tasks/${id}/start`, { method: "POST" });
  await waitFor(id, ["awaiting_approval"], 10 * 60_000);
  await api(`/tasks/${id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approved" }) });
  await waitFor(id, ["awaiting_test_check"], 60_000);
  await api(`/tasks/${id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approved" }) });
  return { id, repoPath };
}

async function main() {
  try {
    await api("/health");
  } catch {
    throw new Error(`machine not reachable at ${MACHINE_URL} — start it with a real credential and pnpm dev`);
  }

  log("case 1: fixture passes on the 2nd verify attempt (retry, not escalation)");
  const retry = await runToShip(2);
  // The throwaway fixture has no git remote, so a task that gets past verifying ends at
  // delivering with "deliver failed"; that is the far side of the retry path, not a failure.
  const after = await waitFor(retry.id, ["awaiting_ship", "escalated"], 20 * 60_000);
  if (after.state === "escalated" && after.reason !== "deliver failed") throw new Error(`task escalated: ${after.reason}`);
  const verifyRuns = (await api(`/tasks/${retry.id}`)).stageRuns.filter((r) => r.stage === "verifying");
  if (verifyRuns.length < 2) throw new Error(`expected at least 2 verify attempts, got ${verifyRuns.length}`);
  log(`passed after ${verifyRuns.length} verify attempt(s) — retry path confirmed`);

  log("case 2: fixture never passes (escalation after LOOP_CAP=3)");
  const escalate = await runToShip(999);
  const afterEscalate = await waitFor(escalate.id, ["escalated"], 20 * 60_000);
  if (!afterEscalate.reason?.includes("verify failed 3 times")) {
    throw new Error(`expected escalation reason to mention 3 verify failures, got "${afterEscalate.reason}"`);
  }
  log(`escalated with reason "${afterEscalate.reason}" — escalation path confirmed`);

  for (const { id, repoPath } of [retry, escalate]) {
    const { task } = await api(`/tasks/${id}`);
    if (task.worktreePath) {
      rmSync(counterFilePath(join(task.worktreePath, "test")), { force: true });
      rmSync(dirname(task.worktreePath), { recursive: true, force: true });
    }
    rmSync(repoPath, { recursive: true, force: true });
    await api(`/tasks/${id}`, { method: "DELETE" });
  }
  log(`golden retry/escalation check passed in ${elapsed()}`);
}

main().catch((error) => {
  console.error(`\n[${elapsed()}] golden retry FAILED: ${error.message}`);
  process.exit(1);
});
