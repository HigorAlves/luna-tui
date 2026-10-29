import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRole, PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { ROLE_DESCRIPTION, agentDefinitions } from "./agents.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(ROOT, "agents");

describe("agent definitions", () => {
  it("has a body file and a description for every role, and a skill folder for every skill a pack names", () => {
    for (const role of AgentRole.options) {
      expect(existsSync(join(AGENTS, `${role}.md`)), role).toBe(true);
      expect(ROLE_DESCRIPTION[role].length, role).toBeGreaterThan(20);
    }
    for (const pack of Object.values(PACKS)) {
      for (const skill of pack.skills) expect(existsSync(join(ROOT, "plugin", "skills", skill, "SKILL.md")), `${pack.id}: ${skill}`).toBe(true);
    }
  });

  it("gives reviewing a security reviewer it can dispatch, read-only, and addressing a reply drafter", () => {
    const review = agentDefinitions(PACKS.reviewing, AGENTS);
    expect(Object.keys(review)).toEqual(["pr-reviewer", "security-reviewer"]);
    expect(review["pr-reviewer"]!.tools).toBeUndefined();
    const security = review["security-reviewer"]!;
    expect(security.model).toBe("opus");
    expect(security.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    expect(security.tools).not.toEqual(expect.arrayContaining(["Write"]));
    expect(security.skills).toEqual(["luna-factory:review-contract"]);
    expect(security.prompt).toMatch(/exploit/i);

    const address = agentDefinitions(PACKS.addressing, AGENTS);
    expect(Object.keys(address)).toEqual(["code-fixer", "reply-drafter"]);
    const drafter = address["reply-drafter"]!;
    expect(drafter.model).toBe("haiku");
    expect(drafter.tools).not.toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    expect(drafter.prompt).toMatch(/ACTION/);
  });

  it("a pack without helpers defines only its own role", () => {
    expect(Object.keys(agentDefinitions(PACKS.implementing, AGENTS))).toEqual(["implementer"]);
  });
});
