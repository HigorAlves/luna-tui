import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { secretRedactor } from "../../domain/redact-secrets.ts";
import { redactFiles } from "./redact-files.ts";

const secret = ["fs", "pw", "C".repeat(10)].join("-");
const dir = mkdtempSync(join(tmpdir(), "redact-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("redactFiles", () => {
  it("rewrites the text files of a run's files folder that held a secret, by rename, and leaves the rest alone", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "steps.jsonl"), `{"typed":"${secret}"}\n`);
    writeFileSync(join(dir, "sub", "trace.har"), `{"h":"${secret}"}`);
    writeFileSync(join(dir, "clean.md"), "no secret here");
    writeFileSync(join(dir, "shot.png"), Buffer.from(secret));
    const before = statSync(join(dir, "clean.md")).ino;
    const changed = await redactFiles(dir, secretRedactor({ QA: secret }));
    expect(changed.sort()).toEqual(["steps.jsonl", "sub/trace.har"]);
    expect(readFileSync(join(dir, "steps.jsonl"), "utf8")).toBe('{"typed":"[secret:QA]"}\n');
    expect(readFileSync(join(dir, "sub", "trace.har"), "utf8")).toBe('{"h":"[secret:QA]"}');
    expect(statSync(join(dir, "clean.md")).ino).toBe(before);
    expect(readFileSync(join(dir, "shot.png")).toString()).toBe(secret);
  });

  it("follows no link: a link to a file outside the folder is neither read nor written", async () => {
    const outside = join(tmpdir(), `outside-${process.pid}.txt`);
    writeFileSync(outside, `keep ${secret}`);
    symlinkSync(outside, join(dir, "link.txt"));
    await redactFiles(dir, secretRedactor({ QA: secret }));
    expect(readFileSync(outside, "utf8")).toBe(`keep ${secret}`);
    rmSync(outside);
  });

  it("never writes through a link planted where the temporary would go: the host file stays, the redaction still lands", async () => {
    const folder = mkdtempSync(join(tmpdir(), "redact-plant-"));
    const target = join(tmpdir(), `zshenv-${process.pid}`);
    writeFileSync(target, "host startup file\n");
    writeFileSync(join(folder, "a.txt"), `echo owned ${secret}`);
    symlinkSync(target, join(folder, "a.txt.redacting"));
    const changed = await redactFiles(folder, secretRedactor({ QA: secret }));
    expect(readFileSync(target, "utf8")).toBe("host startup file\n");
    expect(changed).toEqual(["a.txt"]);
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("echo owned [secret:QA]");
    rmSync(target);
    rmSync(folder, { recursive: true, force: true });
  });

  it("does not walk into a linked folder or leave a temporary behind", async () => {
    const folder = mkdtempSync(join(tmpdir(), "redact-dir-"));
    const outside = mkdtempSync(join(tmpdir(), "redact-outside-"));
    writeFileSync(join(outside, "x.txt"), `keep ${secret}`);
    symlinkSync(outside, join(folder, "linked"));
    writeFileSync(join(folder, "b.txt"), secret);
    await redactFiles(folder, secretRedactor({ QA: secret }));
    expect(readFileSync(join(outside, "x.txt"), "utf8")).toBe(`keep ${secret}`);
    expect(readdirSync(folder).sort()).toEqual(["b.txt", "linked"]);
    rmSync(folder, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
