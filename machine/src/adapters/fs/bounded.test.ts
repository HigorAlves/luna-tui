import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { copyRegularFile, readRegularFile } from "./bounded.ts";

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "bounded-")));

describe("a file the host reads from a container's folder", () => {
  it("reads a regular file as text", async () => {
    const d = dir();
    writeFileSync(join(d, "result.json"), '{"ok":true}');
    expect(await readRegularFile(join(d, "result.json"), 1000)).toBe('{"ok":true}');
  });

  it("keeps the error of a file that is not there", async () => {
    await expect(readRegularFile(join(dir(), "nope"), 1000)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is refused at once, never waited on, when it is a FIFO", async () => {
    const d = dir();
    execFileSync("mkfifo", [join(d, "result.json")]);
    const started = Date.now();
    await expect(readRegularFile(join(d, "result.json"), 1000)).rejects.toThrow(/regular file/);
    await expect(copyRegularFile(join(d, "result.json"), join(d, "copy"))).rejects.toThrow(/regular file/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(existsSync(join(d, "copy"))).toBe(false);
  }, 10_000);

  it("is refused when it is a link, or over the cap", async () => {
    const d = dir();
    writeFileSync(join(d, "real"), "x".repeat(50));
    symlinkSync(join(d, "real"), join(d, "link"));
    await expect(readRegularFile(join(d, "link"), 1000)).rejects.toThrow(/regular file|link/);
    await expect(readRegularFile(join(d, "real"), 10)).rejects.toThrow(/over the 10 byte cap/);
  });

  it("copies a regular file byte for byte", async () => {
    const d = dir();
    writeFileSync(join(d, "a.bin"), Buffer.from([0, 1, 2, 255]));
    await copyRegularFile(join(d, "a.bin"), join(d, "b.bin"));
    expect([...readFileSync(join(d, "b.bin"))]).toEqual([0, 1, 2, 255]);
  });
});
