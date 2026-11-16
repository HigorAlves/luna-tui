import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRole } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { readRole } from "./roles.ts";

const ROLES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "roles");

describe("roles", () => {
  it("has a role folder with a description and a body for every role", () => {
    for (const role of AgentRole.options) {
      const { description, body } = readRole(ROLES, role);
      expect(description.length, role).toBeGreaterThan(20);
      expect(body.startsWith("---"), role).toBe(false);
      expect(body.length, role).toBeGreaterThan(200);
    }
  });

  it("names a revision for git shortlog: with none it reads stdin and the owners come back empty", () => {
    const prompt = readFileSync(join(ROLES, "..", "prompts", "code_map.md"), "utf8");
    for (const text of [readRole(ROLES, "code-mapper").body, prompt]) {
      expect(text).toContain("git shortlog -sn --since=6.months HEAD -- <files>");
      expect(text).not.toMatch(/shortlog[^`]*months -- /);
    }
  });

  it("gives the model the body as it follows the frontmatter, byte for byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-roles-"));
    mkdirSync(join(dir, "verifier"));
    writeFileSync(join(dir, "verifier", "role.md"), '---\ndescription: "Proves it: then reviews."\n---\nYou prove.\n\n---\nNot frontmatter.\n');
    expect(readRole(dir, "verifier")).toEqual({ description: "Proves it: then reviews.", body: "You prove.\n\n---\nNot frontmatter.\n" });
    writeFileSync(join(dir, "verifier", "role.md"), "---\ndescription: Plain text\n---\nBody\n");
    expect(readRole(dir, "verifier")).toEqual({ description: "Plain text", body: "Body\n" });
  });
});
