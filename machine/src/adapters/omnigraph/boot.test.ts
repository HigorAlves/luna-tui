import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { brainAtBoot } from "./boot.ts";

async function tokensFile(content: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "brain-tokens-")), "brain-tokens.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}
const all = { owner: "SECRET-owner", "luna-facts": "SECRET-facts", "luna-memories": "SECRET-memories", "luna-reader": "SECRET-reader" };

describe("brainAtBoot", () => {
  it("is off, with one line saying why, when no address is set", async () => {
    const { brain, line } = brainAtBoot({ url: null, tokensPath: "/nowhere" });
    expect(brain.enabled).toBe(false);
    expect(line).toContain("MACHINE_BRAIN_URL");
  });

  it("is off when the tokens file is missing, and names the file but no token", async () => {
    const { brain, line } = brainAtBoot({ url: "http://127.0.0.1:1", tokensPath: "/nowhere/brain-tokens.json" });
    expect(brain.enabled).toBe(false);
    expect(line).toContain("/nowhere/brain-tokens.json");
  });

  it("is off when a luna token is missing or empty, without printing any token value", async () => {
    for (const missing of ["luna-facts", "luna-memories", "luna-reader"]) {
      const { brain, line } = brainAtBoot({ url: "http://127.0.0.1:1", tokensPath: await tokensFile({ ...all, [missing]: undefined }) });
      expect(brain.enabled).toBe(false);
      expect(line).toContain(missing);
      expect(line).not.toContain("SECRET");
    }
    const empty = brainAtBoot({ url: "http://127.0.0.1:1", tokensPath: await tokensFile({ ...all, "luna-reader": "" }) });
    expect(empty.brain.enabled).toBe(false);
    expect(empty.line).not.toContain("SECRET");
  });

  it("is off for a file that is not JSON, without printing its content", async () => {
    const { brain, line } = brainAtBoot({ url: "http://127.0.0.1:1", tokensPath: await tokensFile("SECRET-not-json") });
    expect(brain.enabled).toBe(false);
    expect(line).not.toContain("SECRET");
  });

  it("is on with the three luna tokens, and the line carries no token", async () => {
    const { brain, line } = brainAtBoot({ url: "http://127.0.0.1:1", tokensPath: await tokensFile(all) });
    expect(brain.enabled).toBe(true);
    expect(line).toContain("http://127.0.0.1:1");
    expect(line).not.toContain("SECRET");
  });
});
