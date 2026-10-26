#!/usr/bin/env node
// Live concurrency check: two tasks contend for one slot (MACHINE_MAX_CONCURRENT=1) at
// the real Triage stage, against the real running machine — not pipeline.test.ts's
// in-process stub runner. (Can't use stub agents here: since Verifier became unconditionally
// real, a stub implementer run has no worktree to verify, so it escalates in the verify
// retry loop almost instantly — too fast a window to reliably observe queuing. Triage is
// real but needs a worktree and just reads the repo, giving an observable multi-second
// window with a real credential, same requirement as golden-abort.mjs / golden-retry.mjs.)
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

function setupRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `hardness-concurrency-${suffix}-`));
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
      log(`  ${id.slice(0, 8)} state -> ${task.state} (queued: ${task.queued})`);
      last = task.state;
    }
    if (targets.includes(task.state)) return task;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for [${targets.join(", ")}], last state ${last}`);
}

async function create(suffix) {
  const repoPath = setupRepo(suffix);
  const { id } = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: `concurrency check ${suffix}`, repoPath }),
  });
  return { id, repoPath };
}

async function main() {
  try {
    await api("/health");
  } catch {
    throw new Error(`machine not reachable at ${MACHINE_URL} — start it with a real credential and MACHINE_MAX_CONCURRENT=1 pnpm dev`);
  }

  log("creating two tasks in intake");
  const a = await create("a");
  const b = await create("b");

  log("starting both triage runs back to back — only one slot available");
  const startA = api(`/tasks/${a.id}/start`, { method: "POST" });
  const startB = api(`/tasks/${b.id}/start`, { method: "POST" });
  await Promise.all([startA, startB]);

  // With MACHINE_MAX_CONCURRENT=1 and a real triage run taking several seconds, there's
  // a comfortable window where exactly one of the two should show queued:true.
  await new Promise((r) => setTimeout(r, 500));
  const [stateA, stateB] = await Promise.all([api(`/tasks/${a.id}`), api(`/tasks/${b.id}`)]);
  const queuedCount = [stateA.task.queued, stateB.task.queued].filter(Boolean).length;
  if (queuedCount !== 1) {
    throw new Error(`expected exactly one task queued while the other runs triage, got ${queuedCount}`);
  }
  log("confirmed exactly one task queued while the other held the slot");

  await waitFor(a.id, ["awaiting_approval"], 10 * 60_000);
  await waitFor(b.id, ["awaiting_approval"], 10 * 60_000);
  log("both reached awaiting_approval — queue promotion worked");

  for (const { id, repoPath } of [a, b]) {
    const { task } = await api(`/tasks/${id}`);
    if (task.worktreePath) rmSync(dirname(task.worktreePath), { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    await api(`/tasks/${id}`, { method: "DELETE" });
  }
  log(`golden concurrency check passed in ${elapsed()}`);
}

main().catch((error) => {
  console.error(`\n[${elapsed()}] golden concurrency FAILED: ${error.message}`);
  process.exit(1);
});
