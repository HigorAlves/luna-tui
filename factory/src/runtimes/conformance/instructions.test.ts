// What each runtime says it gives the model besides the prompt: the fingerprint reads it, so it
// must be what the runtime really sends.
import { PACKS } from "@hardness/contracts";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readRole } from "../../core/roles.ts";
import { FACTORY_RULES } from "../../core/render.ts";
import { claude } from "../claude/run.ts";
import { agentFiles } from "../eve/compile.ts";
import { eve } from "../eve/run.ts";
import { jev } from "../jev/run.ts";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROLES = join(FACTORY_ROOT, "roles");

describe("runtime instructions", () => {
  it("Claude: the role and every helper as their definitions carry them, the appended rules, every skill named", () => {
    const pack = PACKS.reviewing;
    const given = claude.instructions(pack, FACTORY_ROOT);
    for (const role of [pack.agent!, ...pack.helpers]) expect(given.role).toContain(readRole(ROLES, role).body);
    expect(given.rules).toBe(FACTORY_RULES);
    expect(given.skills).toEqual(expect.arrayContaining(pack.skills));
    expect(given.skills).toContain("review-contract");
  });

  it("eve: what the compiled agent's instructions.md is made of, the eve addendum included", () => {
    const pack = PACKS.triage;
    const given = eve.instructions(pack, FACTORY_ROOT);
    const written = agentFiles(pack, { factoryRoot: FACTORY_ROOT, outDir: join(FACTORY_ROOT, ".eve-agents") })["agent/instructions.md"]!;
    expect(given.role).toContain(readFileSync(join(ROLES, "triage-planner", "eve.md"), "utf8").trimEnd());
    for (const part of [...given.role.split("\n").filter(Boolean), ...given.rules.split("\n")]) expect(written).toContain(part);
    expect(given.skills).toEqual(pack.skills);
  });

  it("Jev: nothing but the questions", () => {
    expect(jev.instructions(PACKS.issue_classify, FACTORY_ROOT)).toEqual({ role: "", rules: "", skills: [] });
  });
});
