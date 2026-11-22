import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "qa-axe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// A stand-in for the browser: a module that returns axe's raw result for the URL, as the real driver would after injecting axe. It echoes the tags it was
// given into `help`, so a test can see which rule set the helper asked for, and fails for a URL that holds "down".
const driver = join(dir, "driver.mjs");
writeFileSync(
  driver,
  `export default async (url, options) => {
  if (url.includes("down")) throw new Error("net::ERR_CONNECTION_REFUSED");
  return { violations: [{ id: "color-contrast", impact: "serious", tags: ["wcag2aa", "wcag143"], help: options.tags.join(","), nodes: [{ target: ["button.pay"], failureSummary: "2.9:1" + "x".repeat(300), html: "<button>secret</button>" }] }] };
};\n`,
);
const helper = join(import.meta.dirname, "qa-axe.mjs");
const run = (args: string[]) => spawnSync(process.execPath, [helper, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", QA_AXE_DRIVER: driver, QA_AXE_OUT_ROOT: dir } });
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("qa-axe", () => {
  it("writes axe's violations as JSON under the evidence folder and prints one line each", () => {
    const out = run(["--url", "http://luna-app:4000/checkout", "--out", join(dir, "axe-checkout-default.json")]);
    expect(out.status).toBe(0);
    expect(read("axe-checkout-default.json")).toEqual({
      url: "http://luna-app:4000/checkout",
      level: "AA",
      violations: [{ id: "color-contrast", impact: "serious", tags: ["wcag2aa", "wcag143"], nodes: [{ target: ["button.pay"], failureSummary: `2.9:1${"x".repeat(195)}` }] }],
    });
    expect(out.stdout).toContain("serious color-contrast button.pay");
  });

  it("asks axe for WCAG 2.2 A and AA, and for AAA as well on --level AAA", () => {
    // The stand-in never reports the tags; the shaped report drops `help`, so read them off the driver's own record instead.
    const tagsFile = join(dir, "tags.json");
    const spy = join(dir, "spy.mjs");
    writeFileSync(spy, `import { writeFileSync } from "node:fs";\nexport default async (url, options) => { writeFileSync(${JSON.stringify(tagsFile)}, JSON.stringify(options.tags)); return { violations: [] }; };\n`);
    const withSpy = (args: string[]) => spawnSync(process.execPath, [helper, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", QA_AXE_DRIVER: spy, QA_AXE_OUT_ROOT: dir } });
    expect(withSpy(["--url", "http://x/", "--out", join(dir, "aa.json")]).status).toBe(0);
    expect(JSON.parse(readFileSync(tagsFile, "utf8"))).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    expect(withSpy(["--url", "http://x/", "--level", "AAA", "--out", join(dir, "aaa.json")]).status).toBe(0);
    expect(JSON.parse(readFileSync(tagsFile, "utf8"))).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "wcag2aaa"]);
    expect(read("aaa.json").level).toBe("AAA");
    expect(run(["--url", "http://x/", "--level", "B", "--out", join(dir, "b.json")]).status).toBe(2);
  });

  it("refuses an output path outside the evidence folder, and a URL that is not http, https or file", () => {
    expect(run(["--url", "http://x/", "--out", "/etc/passwd"]).status).toBe(2);
    expect(run(["--url", "http://x/", "--out", join(dir, "..", "escaped.json")]).status).toBe(2);
    expect(run(["--url", "javascript:alert(1)", "--out", join(dir, "a.json")]).status).toBe(2);
    expect(existsSync(join(dir, "a.json"))).toBe(false);
    expect(run(["--url", "file:///work/index.html", "--out", join(dir, "file.json")]).status).toBe(0);
    expect(run(["--out", join(dir, "n.json")]).status).toBe(2);
  });

  it("exits 1 when the page cannot load, and writes nothing", () => {
    const out = run(["--url", "http://down:4000/", "--out", join(dir, "down.json")]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("ERR_CONNECTION_REFUSED");
    expect(existsSync(join(dir, "down.json"))).toBe(false);
  });

  it("prints where axe.min.js is, for a script that injects it itself", () => {
    const out = spawnSync(process.execPath, [helper, "--inject"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", QA_AXE_SCRIPT: "/opt/luna/lib/node_modules/axe-core/axe.min.js" } });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("/opt/luna/lib/node_modules/axe-core/axe.min.js");
  });

  it("keeps axe pinned in the QA image, and installs the helper beside qa-fill", () => {
    const dockerfile = readFileSync(join(import.meta.dirname, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG AXE_CORE_VERSION=4.14.0");
    expect(dockerfile).toContain('"axe-core@${AXE_CORE_VERSION}"');
    expect(dockerfile).toContain("ENV QA_AXE_SCRIPT=/opt/luna/lib/node_modules/axe-core/axe.min.js");
    expect(dockerfile).toContain("COPY qa-axe.mjs /usr/local/bin/qa-axe");
    expect(dockerfile).toMatch(/chmod 0755 \/usr\/local\/bin\/qa-fill \/usr\/local\/bin\/qa-axe|chmod 0755 \/usr\/local\/bin\/qa-axe/);
  });
});
