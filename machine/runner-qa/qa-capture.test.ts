import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { capture } from "./qa-capture-lib.mjs";

const dir = mkdtempSync(join(tmpdir(), "qa-capture-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const out = join(dir, "parity");
const row = (i: number) => ({ selector: `#b${i}`, text: "Pay", color: "rgb(26, 115, 232)", background: "rgba(0, 0, 0, 0)", fontFamily: "Inter", fontSize: "16px", fontWeight: "600", lineHeight: "24px", letterSpacing: "normal", padding: "8px 16px", margin: "0px", gap: "normal", borderRadius: "8px", rect: { x: 0, y: 0, w: 100, h: 40 } });
// A stand-in for agent-browser: logs each call's first words, writes a PNG on `screenshot`, prints ROWS style rows on `eval`.
const driver = join(dir, "driver.sh");
writeFileSync(
  driver,
  `#!/bin/sh
echo "$1 $2 $3 $4" >> "${dir}/calls.txt"
case "$1" in
  screenshot) node -e 'require("fs").writeFileSync(process.argv[1], Buffer.from("89504e470d0a1a0a", "hex"))' "$2" ;;
  eval) node -e 'const r=${JSON.stringify(row(0))};console.log(JSON.stringify(Array.from({length:Number(process.env.ROWS||2)},(_,i)=>({...r,selector:"#b"+i}))))' ;;
esac
exit "\${DRIVER_EXIT:-0}"
`,
);
chmodSync(driver, 0o755);
const cli = join(import.meta.dirname, "qa-capture.mjs");
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", QA_CAPTURE_DRIVER: driver, QA_PARITY_DIR: out, ...env } });

beforeEach(() => {
  rmSync(out, { recursive: true, force: true });
  rmSync(join(dir, "calls.txt"), { force: true });
});

describe("qa-capture", () => {
  // The settle is an in-page wait through the driver: agent-browser 0.39.2 stalls ~10 s on a screenshot that follows a viewport change after an idle gap.
  it("captures a scenario's state at the frame's viewport: settle, screenshot, computed styles and a log line", () => {
    const r = run(["S1", "desktop", "default", "1440", "900"]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(["set viewport", expect.stringMatching(/^eval /), expect.stringMatching(/^screenshot /), expect.stringMatching(/^eval /)]);
    expect(readFileSync(join(out, "S1", "desktop-default.png")).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(JSON.parse(readFileSync(join(out, "S1", "desktop-default.styles.json"), "utf8"))).toHaveLength(2);
    const logged = readFileSync(join(out, "captures.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(logged).toEqual([expect.objectContaining({ scenario: "S1", viewport: "desktop", state: "default", width: 1440, height: 900, elements: 2 })]);
    expect(r.stdout).toContain("captured S1 desktop default: 2 elements");
  });

  it("keeps at most 300 elements", () => {
    expect(run(["S1", "desktop", "hover", "1440", "900"], { ROWS: "500" }).status).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "S1", "desktop-hover.styles.json"), "utf8"))).toHaveLength(300);
  });

  it.each([
    [["../x", "desktop", "default", "1440", "900"]],
    [["S1", "Desk Top", "default", "1440", "900"]],
    [["S1", "desktop", "pressed", "1440", "900"]],
    [["S1", "desktop", "default", "99999", "900"]],
    [["S1", "desktop"]],
  ])("refuses %j and writes nothing", (args) => {
    expect(run(args).status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it("passes the driver's failure on and writes no styles", () => {
    expect(run(["S1", "desktop", "default", "1440", "900"], { DRIVER_EXIT: "3" }).status).toBe(3);
    expect(existsSync(join(out, "S1", "desktop-default.styles.json"))).toBe(false);
  });
});

describe("capture() for a Playwright script", () => {
  it("writes the same files from a page", async () => {
    const calls: string[] = [];
    const page = {
      setViewportSize: async (s: { width: number; height: number }) => void calls.push(`viewport ${s.width}x${s.height}`),
      screenshot: async ({ path }: { path: string }) => (calls.push("screenshot"), writeFileSync(path, Buffer.from("89504e470d0a1a0a", "hex"))),
      evaluate: async () => (calls.push("evaluate"), [row(0)]),
    };
    const done = await capture(page, { scenario: "S2", viewport: "mobile", state: "error", width: 390, height: 844 }, { dir: out });
    expect(done.elements).toBe(1);
    expect(calls).toEqual(["viewport 390x844", "screenshot", "evaluate"]);
    expect(existsSync(join(out, "S2", "mobile-error.png"))).toBe(true);
  });
});
