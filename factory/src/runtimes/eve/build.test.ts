import { PACKS } from "@hardness/contracts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compileAndBuild, evePacks } from "./build.ts";
import { appName } from "./compile.ts";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("evePacks", () => {
  it("builds an eve agent only for a pack whose engines allow eve, and for each helper on an eve engine that a stage on another runtime reaches", () => {
    // triage's reply-drafter is a native subagent of its own app on eve; verifying's second opinion is Codex's under Claude's stage.
    expect(evePacks().map(appName).sort()).toEqual(["chat_triage", "decide", "decompose", "plan", "slack_triage", "triage", "verifying", "verifying--second-opinion", "video_qa"]);
    expect(evePacks(["triage", "implementing"]).map((p) => p.id)).toEqual(["triage"]);
    expect(evePacks(["verifying--second-opinion"])).toEqual([expect.objectContaining({ id: "verifying", agent: "second-opinion", writable: false })]);
  });
});

describe("compileAndBuild", () => {
  it("builds triage with its reply-drafter as a native subagent behind the workflow delegate tool", () => {
    // Inside the factory, as the real ones are, so the build resolves eve from its node_modules.
    const outDir = mkdtempSync(join(FACTORY_ROOT, ".eve-agents-test-"));
    try {
      const app = compileAndBuild(PACKS.triage, { factoryRoot: FACTORY_ROOT, outDir });
      expect(existsSync(join(app, ".output", "server", "index.mjs"))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 240_000);
});
