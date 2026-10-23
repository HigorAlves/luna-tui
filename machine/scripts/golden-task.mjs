#!/usr/bin/env node
// The golden task. Drives a small fixture repo through the whole pipeline graph via the
// machine's HTTP API, the same way a person would through the board.
// Run after `pnpm dev` (and, for a real implementer run, with a credential and the
// runner image built): `pnpm golden`.
//
// Modes:
//   (none)                       the single golden run: fixtures/golden-task, its bug ticket.
//   --matrix                     every fixture x ticket, graded; exit 1 under --threshold.
//     --only <fixture>           restrict the matrix to one fixture.
//     --ceiling-usd <n>          per-run cost ceiling (default 5).
//     --threshold <r>            minimum pass rate (default 0.8).
//     --expect-no-remote[=false] fixtures have no git remote, so escalating at `delivering`
//                                is the expected end of the path (default true).
//     --out <file>               result file (default golden-result.json).
//   --selftest                   no machine needed: each ticket must be red with its seed
//                                and green with its reference patch.
//
// The single run is the regression check for the whole graph: any change that breaks a
// transition, a gate, or the implementer's commit should break this script.
import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import {
  api,
  drive,
  elapsed,
  ensureMachine,
  formatTable,
  listFixtures,
  loadFixture,
  log,
  passRate,
  runFixtureTests,
  runTicket,
  selftestTicket,
  setupRepo,
} from "./golden-lib.mjs";

const { values: flags } = parseArgs({
  options: {
    matrix: { type: "boolean", default: false },
    selftest: { type: "boolean", default: false },
    only: { type: "string" },
    "ceiling-usd": { type: "string", default: "5" },
    threshold: { type: "string", default: "0.8" },
    "expect-no-remote": { type: "string", default: "true" },
    out: { type: "string", default: "golden-result.json" },
  },
});

function selectedFixtures() {
  const known = listFixtures();
  const names = flags.only ? [flags.only] : known;
  for (const name of names) if (!known.includes(name)) throw new Error(`unknown fixture "${name}" (have: ${known.join(", ")})`);
  return names.map(loadFixture);
}

function selftest() {
  let bad = 0;
  for (const fixture of selectedFixtures()) {
    for (const ticket of fixture.tickets) {
      const { red, green } = selftestTicket(fixture, ticket);
      const ok = red && green;
      if (!ok) bad++;
      console.log(`${ok ? "ok  " : "FAIL"} ${fixture.name}/${ticket.id}: seed ${red ? "red" : "NOT red"}, patch ${green ? "green" : "NOT green"}`);
    }
  }
  if (bad > 0) throw new Error(`${bad} fixture ticket(s) failed self-validation`);
}

async function matrix() {
  const ceilingUsd = Number(flags["ceiling-usd"]);
  const threshold = Number(flags.threshold);
  const expectNoRemote = flags["expect-no-remote"] !== "false";
  const fixtures = selectedFixtures();
  await ensureMachine();

  const runs = [];
  for (const fixture of fixtures) {
    for (const ticket of fixture.tickets) {
      const run = await runTicket(fixture, ticket, { ceilingUsd, expectNoRemote });
      log(`${fixture.name}/${ticket.id}: ${run.result}${run.failures.length ? ` (${run.failures.join("; ")})` : ""}`);
      runs.push(run);
    }
  }

  const rate = passRate(runs);
  console.log(`\n${formatTable(runs)}\n\npass rate ${(rate * 100).toFixed(0)}% (threshold ${(threshold * 100).toFixed(0)}%)`);
  writeFileSync(flags.out, `${JSON.stringify({ schema: 1, ceilingUsd, expectNoRemote, runs, passRate: rate }, null, 2)}\n`);
  log(`wrote ${flags.out}`);
  if (rate < threshold) throw new Error(`pass rate ${rate.toFixed(2)} is under ${threshold}`);
}

async function single() {
  await ensureMachine();
  const fixture = loadFixture("golden-task");
  const ticket = fixture.tickets.find((t) => t.id === "bug");
  const { dir: repoPath } = setupRepo(fixture, ticket);
  log(`fixture repo at ${repoPath}`);

  const { id, task } = await drive(ticket, repoPath);
  // This fixture has no git remote, so the delivering stage (push + draft PR) escalates
  // before evidence and ship. That is still a pass: the fix, the gates and the graph
  // up to delivery already happened.
  if (task.state === "escalated") {
    const detail = await api(`/tasks/${id}`);
    if (detail.stageRuns.at(-1)?.stage !== "delivering") throw new Error(`task escalated: ${task.reason}`);
    log(`delivering escalated as expected, no git remote on this throwaway fixture: ${task.reason}`);
  }

  const { task: final } = await api(`/tasks/${id}`);
  if (final.worktreePath) {
    log(`checking the implementer's fix in ${final.worktreePath}`);
    if (!runFixtureTests(fixture, final.worktreePath)) throw new Error("fixture tests fail against the implementer's commit");
    log("fixture's own tests pass against the implementer's commit");
  } else {
    log("no worktree (agents were off or a credential was missing): traversed the whole graph with stubs only");
  }

  // The worktree lives at `<worktreesDir>/<basename(repoPath)>/task-<name>`; since repoPath
  // is unique per run, its parent directory is ours alone to remove.
  if (final.worktreePath) rmSync(dirname(final.worktreePath), { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  log(`golden task passed in ${elapsed()}`);
}

const mode = flags.selftest ? selftest : flags.matrix ? matrix : single;
Promise.resolve()
  .then(mode)
  .catch((error) => {
    console.error(`\n[${elapsed()}] golden ${flags.selftest ? "selftest" : flags.matrix ? "matrix" : "task"} FAILED: ${error.message}`);
    process.exit(1);
  });
