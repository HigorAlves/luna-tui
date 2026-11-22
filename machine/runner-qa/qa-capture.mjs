#!/usr/bin/env node
// qa-capture <scenario> <viewport> <state> <width> <height>: captures the open page at a frame's viewport and state (RFC 0013, phase 3). Writes the screenshot, the
// computed styles and one line in captures.jsonl under /out/files/qa/parity (QA_PARITY_DIR overrides it), through agent-browser (QA_CAPTURE_DRIVER overrides the binary).
// Exit 0 on success, 2 on a bad argument (nothing written), and a failing driver's own exit code (no styles written).
// agent-browser commands used: `set viewport W H`, `screenshot <path>` (never --annotate: the reviewer compares pixels) and `eval --stdin` (the script on stdin, so its size and quotes never meet a shell), whose stdout is the value as pretty-printed JSON (probed on agent-browser 0.39.2), so the whole stdout is parsed.
import { spawnSync } from "node:child_process";

import { capture, checkArgs } from "./qa-capture-lib.mjs";

const [scenario, viewport, state, w, h, ...extra] = process.argv.slice(2);
const args = { scenario, viewport, state, width: /^\d+$/.test(w ?? "") ? Number(w) : NaN, height: /^\d+$/.test(h ?? "") ? Number(h) : NaN };
const bad = extra.length > 0 || h === undefined ? "usage: qa-capture <scenario> <viewport> <state> <width> <height>" : checkArgs(args);
if (bad) {
  process.stderr.write(`qa-capture: ${bad}\n`);
  process.exit(2);
}

const driver = process.env.QA_CAPTURE_DRIVER || "agent-browser";
class DriverFailure extends Error {
  constructor(status) {
    super(`the driver exited with ${status}`);
    this.status = status;
  }
}
const drive = (argv, input) => {
  const r = spawnSync(driver, argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  if (r.error || r.status !== 0) {
    process.stderr.write(r.stderr ?? "");
    throw new DriverFailure(r.status ?? 1);
  }
  return r.stdout;
};
const page = {
  setViewportSize: async ({ width, height }) => void drive(["set", "viewport", String(width), String(height)]),
  // The wait runs inside the page, through the driver: a plain sleep between `set viewport` and `screenshot` made the screenshot stall ~10 s on 0.39.2 (probed).
  waitForTimeout: async (ms) => void drive(["eval", "--stdin"], `new Promise((r) => setTimeout(r, ${Number(ms)}))`),
  screenshot: async ({ path }) => void drive(["screenshot", path]),
  evaluate: async (fn) => {
    return JSON.parse(drive(["eval", "--stdin"], `(${fn})()`).trim() || "[]");
  },
};

try {
  const { elements } = await capture(page, args, { dir: process.env.QA_PARITY_DIR || "/out/files/qa/parity" });
  process.stdout.write(`captured ${scenario} ${viewport} ${state}: ${elements} elements\n`);
} catch (error) {
  if (error instanceof DriverFailure) process.exit(error.status);
  process.stderr.write(`qa-capture: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
