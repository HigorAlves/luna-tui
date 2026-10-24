import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { counterFilePath } from "../counter-path.mjs";
import { thing } from "../src/thing.js";

// Fails until the Verifier stage specifically (not an agent's own exploratory `npm test`
// while it's still implementing) has run it FLAKY_PASSES_AFTER times, then passes forever.
// HARDNESS_STAGE=verifying is set only by machine/src/application/stages/verify.ts; any other caller
// (the implementer checking its own work, you running this by hand) always just passes,
// so the counter reflects real Verifier attempts, not incidental test runs.
//
// The counter lives OUTSIDE the worktree, in the OS temp dir, keyed by the worktree's own
// path (stable across retries on the same task, unique per golden-retry.mjs run). It can't
// live inside the worktree: a real implementer agent, tidying up before reporting done, will
// reasonably `rm` an untracked file it doesn't recognize — this one did exactly that between
// retry attempts, which is what motivated moving it out here.
const counterFile = counterFilePath(import.meta.dirname);
const passAfter = Number(process.env.FLAKY_PASSES_AFTER ?? "999");
const underVerification = process.env.HARDNESS_STAGE === "verifying";

test("thing works", () => {
  if (!underVerification) {
    assert.equal(thing(), "ok");
    return;
  }
  let attempts = 0;
  try {
    attempts = Number(readFileSync(counterFile, "utf8"));
  } catch {
    // first run, file doesn't exist yet
  }
  attempts += 1;
  writeFileSync(counterFile, String(attempts));
  assert.ok(attempts >= passAfter, `attempt ${attempts}, needs ${passAfter}`);
  assert.equal(thing(), "ok");
});
