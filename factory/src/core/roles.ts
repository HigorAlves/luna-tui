// A role is a folder: factory/roles/<role>/role.md holds a frontmatter with the role's one-line
// description and, after it, the body the model gets as the role's prompt. The frontmatter is
// for the harness and never reaches the model.
import type { AgentRole } from "@hardness/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Role {
  description: string;
  body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/** A frontmatter value: a double-quoted string is read as JSON, anything else as written. */
const scalar = (raw: string): string => (raw.startsWith('"') && raw.endsWith('"') ? (JSON.parse(raw) as string) : raw);

/** The role's description and its body, the body byte for byte as it follows the frontmatter. */
export function readRole(rolesDir: string, role: AgentRole): Role {
  const text = readFileSync(join(rolesDir, role, "role.md"), "utf8");
  const head = FRONTMATTER.exec(text);
  if (!head) return { description: "", body: text };
  const fields = new Map(
    head[1]!
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), scalar(line.slice(line.indexOf(":") + 1).trim())]),
  );
  return { description: fields.get("description") ?? "", body: text.slice(head[0].length) };
}
