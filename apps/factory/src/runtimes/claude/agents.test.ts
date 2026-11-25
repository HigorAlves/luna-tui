import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_PACKS, PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { agentDefinitions } from "./agents.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROLES = join(ROOT, "roles");
const defsFor = (role: string) => readFileSync(join(ROLES, role, "role.md"), "utf8");

describe("agent definitions", () => {
  it("has a skill folder for every skill a pack names", () => {
    for (const pack of AGENT_PACKS) {
      for (const skill of pack.skills) expect(existsSync(join(ROOT, "plugin", "skills", skill, "SKILL.md")), `${pack.id}: ${skill}`).toBe(true);
    }
  });

  it("gives reviewing no subagents, review_security its own read-only role, and addressing a reply drafter", () => {
    const review = agentDefinitions(PACKS.reviewing, ROLES, "claude-opus-5-5");
    expect(Object.keys(review)).toEqual(["pr-reviewer"]);
    expect(review["pr-reviewer"]!.tools).toBeUndefined();
    expect(review["pr-reviewer"]!.model).toBe("claude-opus-5-5");
    expect(review["pr-reviewer"]!.description).toMatch(/pull request/);
    const pass = agentDefinitions(PACKS.review_security, ROLES, "claude-sonnet-5-5");
    expect(Object.keys(pass)).toEqual(["security-reviewer"]);
    const security = pass["security-reviewer"]!;
    expect(security.model).toBe("claude-sonnet-5-5");
    expect(security.prompt).toMatch(/exploit/i);

    const address = agentDefinitions(PACKS.addressing, ROLES, "claude-sonnet-5-5");
    expect(Object.keys(address)).toEqual(["code-fixer", "reply-drafter"]);
    const drafter = address["reply-drafter"]!;
    expect(drafter.model).toBe("claude-haiku-5-5");
    expect(drafter.tools).not.toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    expect(drafter.prompt).toMatch(/ACTION/);
  });

  it("gives verifying a read-only migration and infrastructure reviewer, and names both with their globs in its prompts; reviewing no longer dispatches them", () => {
    const defs = agentDefinitions(PACKS.verifying, ROLES, "claude-opus-5-5");
    for (const helper of ["migration-reviewer", "iac-reviewer"]) {
      expect(defs[helper]!.model, helper).toBe("claude-sonnet-5-5");
      expect(defs[helper]!.tools).toEqual(["Read", "Glob", "Grep"]);
    }
    for (const file of [join(ROOT, "prompts", "verifying.md"), join(ROLES, "verifier", "role.md")]) {
      const text = readFileSync(file, "utf8");
      for (const needle of ["`migration-reviewer`", "`iac-reviewer`", "`**/migrations/**`", "`*.sql`", "`**/prisma/schema.prisma`", "`*.tf`", "`**/k8s/**`", "`Dockerfile*`", "`docker-compose*.y*ml`", "AWSTemplateFormatVersion"]) expect(text, `${file}: ${needle}`).toContain(needle);
    }
    const reviewing = readFileSync(join(ROOT, "prompts", "reviewing.md"), "utf8");
    expect(reviewing).not.toContain("Agent tool");
    expect(reviewing).toContain("on every review");
    expect(defsFor("migration-reviewer")).toMatch(/CONCURRENTLY[\s\S]*GDPR Art\. 5\(1\)\(e\)/);
    expect(defsFor("iac-reviewer")).toMatch(/0\.0\.0\.0\/0[\s\S]*SOC2 CC6\.6/);
  });

  it("a pack without helpers defines only its own role", () => {
    expect(Object.keys(agentDefinitions(PACKS.implementing, ROLES, "claude-sonnet-5-5"))).toEqual(["implementer"]);
  });

  it("never defines the implementer's writable ui-designer as a subagent: it runs as its own pack, in its own container", () => {
    expect(PACKS.implementing.helpers.map((h) => h.role)).toContain("ui-designer");
    expect(Object.keys(agentDefinitions(PACKS.implementing, ROLES, "claude-sonnet-5-5"))).not.toContain("ui-designer");
    expect(Object.keys(agentDefinitions(PACKS.ui_design, ROLES, "claude-sonnet-5-5"))).toEqual(["ui-designer"]);
  });
});
