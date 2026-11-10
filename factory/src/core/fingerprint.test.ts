import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PACKS, resolveEngine } from "@hardness/contracts";
import { fileURLToPath } from "node:url";

import { claude } from "../runtimes/claude/run.ts";
import { eveRuntime } from "../runtimes/eve/run.ts";
import { type FingerprintInput, fingerprint, runInfo, sdkInfo } from "./fingerprint.ts";

const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
mkdirSync(join(skillsDir, "tdd", "references"), { recursive: true });
writeFileSync(join(skillsDir, "tdd", "SKILL.md"), "# TDD\nred, green, refactor\n");
writeFileSync(join(skillsDir, "tdd", "references", "loop.md"), "one test at a time\n");

const base: FingerprintInput = {
  template: "Fix {{task.title}}.",
  role: "You are the implementer.",
  rules: "Never push.",
  skills: ["tdd"],
  skillsDir,
  access: { read: true, write: true, web: false, agent: false, skills: true, commands: ["git add"], luna: ["step"] },
  answer: { type: "object", properties: { summary: { type: "string" } } },
};

describe("fingerprint", () => {
  it("is a sha256, the same for the same inputs whatever order an object's keys are in", () => {
    const print = fingerprint(base);
    expect(print).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint({ ...base, answer: { properties: { summary: { type: "string" } }, type: "object" } })).toBe(print);
  });

  it.each<[string, Partial<FingerprintInput>]>([
    ["the template", { template: "Fix it." }],
    ["the role", { role: "You are the verifier." }],
    ["the rules", { rules: "Never push, ever." }],
    ["the skills it loads", { skills: [] }],
    ["the access", { access: { ...base.access!, commands: ["git add", "git commit"] } }],
    ["the answer schema", { answer: { type: "object" } }],
  ])("changes with %s", (_what, change) => {
    expect(fingerprint({ ...base, ...change })).not.toBe(fingerprint(base));
  });

  it("changes with a mask, and is the same without one, or with one that removes nothing", () => {
    expect(fingerprint({ ...base, mask: null })).toBe(fingerprint(base));
    expect(fingerprint({ ...base, mask: '{"web":true}' })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, mask: '{"web":true}' })).not.toBe(fingerprint({ ...base, mask: '{"agent":true}' }));
  });

  it("changes with a skill's files, not only its name", () => {
    const before = fingerprint(base);
    writeFileSync(join(skillsDir, "tdd", "references", "loop.md"), "two tests at a time\n");
    expect(fingerprint(base)).not.toBe(before);
  });
});

describe("runInfo with a mask", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const pack = PACKS.triage;
  const info = (runtime: typeof claude, engine: string, mask?: { web?: boolean }) => runInfo(runtime, resolveEngine(engine as "claude:sonnet"), pack, "t", root, mask).fingerprint;

  it("differs on Claude only when a mask is applied, and a mask that removes nothing leaves it unchanged", () => {
    expect(info(claude, "claude:sonnet", { web: true })).not.toBe(info(claude, "claude:sonnet"));
    expect(info(claude, "claude:sonnet", {})).toBe(info(claude, "claude:sonnet"));
  });

  it("is unchanged on eve, which ignores the mask", () => {
    expect(info(eveRuntime(), "codex:luna", { web: true })).toBe(info(eveRuntime(), "codex:luna"));
  });
});

describe("sdkInfo", () => {
  it("reads an SDK's version from its own package.json", () => {
    expect(sdkInfo("eve")).toEqual({ name: "eve", version: "1.0.0-rc.1" });
    expect(sdkInfo("@anthropic-ai/claude-agent-sdk").version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("says unknown for a package it cannot find", () => {
    expect(sdkInfo("no-such-sdk")).toEqual({ name: "no-such-sdk", version: "unknown" });
  });
});
