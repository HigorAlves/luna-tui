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

  it("gives reviewing a security reviewer it can dispatch, read-only, and addressing a reply drafter", () => {
    const review = agentDefinitions(PACKS.reviewing, ROLES, "claude-opus-5-5");
    expect(Object.keys(review)).toEqual(["pr-reviewer", "security-reviewer", "migration-reviewer", "iac-reviewer"]);
    expect(review["pr-reviewer"]!.tools).toBeUndefined();
    expect(review["pr-reviewer"]!.model).toBe("claude-opus-5-5");
    expect(review["pr-reviewer"]!.description).toMatch(/pull request/);
    const security = review["security-reviewer"]!;
    expect(security.model).toBe("claude-opus-5-5");
    expect(security.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    expect(security.tools).not.toEqual(expect.arrayContaining(["Write"]));
    expect(security.skills).toEqual(["luna-factory:review-contract"]);
    expect(security.prompt).toMatch(/exploit/i);

    const address = agentDefinitions(PACKS.addressing, ROLES, "claude-sonnet-5-5");
    expect(Object.keys(address)).toEqual(["code-fixer", "reply-drafter"]);
    const drafter = address["reply-drafter"]!;
    expect(drafter.model).toBe("claude-haiku-5-5");
    expect(drafter.tools).not.toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    expect(drafter.prompt).toMatch(/ACTION/);
  });

  it("gives reviewing and verifying a read-only migration and infrastructure reviewer, and names both with their globs in the prompts", () => {
    for (const [pack, prompt, role] of [["reviewing", "reviewing.md", "pr-reviewer"], ["verifying", "verifying.md", "verifier"]] as const) {
      const defs = agentDefinitions(PACKS[pack], ROLES, "claude-opus-5-5");
      for (const helper of ["migration-reviewer", "iac-reviewer"]) {
        expect(defs[helper]!.model, `${pack}: ${helper}`).toBe("claude-sonnet-5-5");
        expect(defs[helper]!.tools).toEqual(["Read", "Glob", "Grep"]);
      }
      for (const file of [join(ROOT, "prompts", prompt), join(ROLES, role, "role.md")].filter((f) => pack === "verifying" || f.endsWith(prompt))) {
        const text = readFileSync(file, "utf8");
        for (const needle of ["`migration-reviewer`", "`iac-reviewer`", "`**/migrations/**`", "`*.sql`", "`**/prisma/schema.prisma`", "`*.tf`", "`**/k8s/**`", "`Dockerfile*`", "`docker-compose*.y*ml`", "AWSTemplateFormatVersion"]) expect(text, `${file}: ${needle}`).toContain(needle);
      }
    }
    expect(defsFor("migration-reviewer")).toMatch(/CONCURRENTLY[\s\S]*GDPR Art\. 5\(1\)\(e\)/);
    expect(defsFor("iac-reviewer")).toMatch(/0\.0\.0\.0\/0[\s\S]*SOC2 CC6\.6/);
  });

  it("a pack without helpers defines only its own role", () => {
    expect(Object.keys(agentDefinitions(PACKS.implementing, ROLES, "claude-sonnet-5-5"))).toEqual(["implementer"]);
  });
});
