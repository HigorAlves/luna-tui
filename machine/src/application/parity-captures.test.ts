import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectCaptures } from "./parity-captures.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const desktop = { name: "1440x900", width: 1440, height: 900 };
const plan = { targets: [{ scenario: "S1", frame: "12:34", viewport: desktop, state: "default" as const }, { scenario: "S1", frame: "12:34", viewport: desktop, state: "hover" as const }], uncited: [], notes: [] };
const style = { selector: "#pay", text: "Pay", color: "rgb(0, 0, 0)", background: "x", fontFamily: "Inter", fontSize: "16px", fontWeight: "600", lineHeight: "24px", letterSpacing: "normal", padding: "0", margin: "0", gap: "normal", borderRadius: "8px", rect: { x: 0, y: 0, w: 1, h: 1 } };
let root = "";
const setup = () => {
  root = mkdtempSync(join(tmpdir(), "parity-"));
  mkdirSync(join(root, "qa", "parity", "S1"), { recursive: true });
  return { qa: join(root, "qa"), out: join(root, "parity") };
};
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("collectCaptures", () => {
  it("copies a plain PNG and its styles into the machine's folder, named for the reviewer's mount", async () => {
    const { qa, out } = setup();
    writeFileSync(join(qa, "parity", "S1", "1440x900-default.png"), PNG);
    writeFileSync(join(qa, "parity", "S1", "1440x900-default.styles.json"), JSON.stringify([style]));
    const r = await collectCaptures(qa, plan, out);
    expect(r.captures).toEqual([{ scenario: "S1", frame: "12:34", viewport: "1440x900", state: "default", image: "/evidence/parity/S1/1440x900-default.png", styles: "/evidence/parity/S1/1440x900-default.styles.json", elements: 1 }]);
    expect(readFileSync(join(out, "S1", "1440x900-default.png"))).toEqual(PNG);
    expect(existsSync(join(out, "S1", "1440x900-default.styles.json"))).toBe(true);
    expect(r.missing.map((t) => t.state)).toEqual(["hover"]);
  });
  it("refuses a link, a file that is not a PNG and one over the cap", async () => {
    const { qa, out } = setup();
    writeFileSync(join(root, "elsewhere.png"), PNG);
    symlinkSync(join(root, "elsewhere.png"), join(qa, "parity", "S1", "1440x900-default.png"));
    writeFileSync(join(qa, "parity", "S1", "1440x900-hover.png"), "not a png");
    const r = await collectCaptures(qa, plan, out);
    expect(r.captures).toEqual([]);
    expect(r.missing).toHaveLength(2);
    expect(r.notes.join("\n")).toMatch(/S1\/1440x900-default.*not a regular file/);
    expect(r.notes.join("\n")).toMatch(/S1\/1440x900-hover.*not a PNG/);
    expect(existsSync(join(out, "S1", "1440x900-default.png"))).toBe(false);
    writeFileSync(join(qa, "parity", "S1", "1440x900-hover.png"), Buffer.concat([PNG, Buffer.alloc(64)]));
    const big = await collectCaptures(qa, plan, out, { maxBytes: 32 });
    expect(big.captures).toEqual([]);
    expect(big.notes.join("\n")).toMatch(/S1\/1440x900-hover.*over the 32 byte cap/);
  });
  it("keeps a capture whose styles are missing or do not parse, with styles null", async () => {
    const { qa, out } = setup();
    writeFileSync(join(qa, "parity", "S1", "1440x900-default.png"), PNG);
    writeFileSync(join(qa, "parity", "S1", "1440x900-default.styles.json"), "{oops");
    writeFileSync(join(qa, "parity", "S1", "1440x900-hover.png"), PNG);
    const r = await collectCaptures(qa, plan, out);
    expect(r.captures).toHaveLength(2);
    expect(r.captures.map((c) => [c.styles, c.elements])).toEqual([[null, 0], [null, 0]]);
    expect(existsSync(join(out, "S1", "1440x900-default.styles.json"))).toBe(false);
  });
});
