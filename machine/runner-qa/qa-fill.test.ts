import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "qa-fill-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const secret = ["qa", "login", "s".repeat(10)].join("-");
// A stand-in for agent-browser: records its arguments to a file and echoes them back, as a tool that prints what it typed would.
const driver = join(dir, "driver.sh");
writeFileSync(driver, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\necho "typed: $3"\nexit "\${DRIVER_EXIT:-0}"\n`);
chmodSync(driver, 0o755);
const helper = join(import.meta.dirname, "qa-fill.mjs");
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [helper, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", QA_FILL_DRIVER: driver, LUNA_QA_CREDENTIALS: "QA_PASSWORD", QA_PASSWORD: secret, ...env } });

describe("qa-fill", () => {
  it("fills the field from the variable it is told by name, and never prints the value", () => {
    const out = run(["#password", "QA_PASSWORD"]);
    expect(out.status).toBe(0);
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toEqual(["fill", "#password", secret]);
    expect(out.stdout + out.stderr).not.toContain(secret);
    expect(out.stdout).toContain("filled #password from QA_PASSWORD");
    expect(out.stdout).toContain("[secret:QA_PASSWORD]");
  });

  it("passes the tool's failure on, still without the value", () => {
    const out = run(["#password", "QA_PASSWORD"], { DRIVER_EXIT: "3" });
    expect(out.status).toBe(3);
    expect(out.stdout + out.stderr).not.toContain(secret);
  });

  it("refuses a variable that is not one of the machine's QA credentials, such as the engine's own key", () => {
    const out = run(["#password", "ANTHROPIC_API_KEY"], { ANTHROPIC_API_KEY: secret });
    expect(out.status).not.toBe(0);
    expect(out.stdout + out.stderr).not.toContain(secret);
    expect(out.stderr).toMatch(/not a QA credential/);
  });

  it("refuses an unset variable, a name that is not upper snake case, and a selector that is empty, long or has a line break", () => {
    expect(run(["#p", "QA_PASSWORD"], { QA_PASSWORD: "" }).status).not.toBe(0);
    expect(run(["#p", "qa_password"]).status).not.toBe(0);
    expect(run(["", "QA_PASSWORD"]).status).not.toBe(0);
    expect(run(["x".repeat(400), "QA_PASSWORD"]).status).not.toBe(0);
    expect(run(["#p\n#q", "QA_PASSWORD"]).status).not.toBe(0);
    expect(run(["#p"]).status).not.toBe(0);
  });
});
