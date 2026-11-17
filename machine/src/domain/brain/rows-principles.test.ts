import { createHash } from "node:crypto";
import type { BrainNodeRow, BrainRow } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { principleRows } from "./rows-principles.ts";

const repo = { slug: "luna-tui-ab12", name: "luna-tui" };
const at = new Date("2026-11-10T09:00:00.000Z");
const nodes = (rows: BrainRow[]) => rows.filter((row): row is BrainNodeRow => "type" in row);
const principles = (rows: BrainRow[]) => nodes(rows).filter((row) => row.type === "Principle");
const hex = (statement: string) => createHash("sha256").update(statement).digest("hex").slice(0, 12);

const FILE = `# Project context

- Before any heading.

## Testing
- Write the failing test first. <!-- fact 12 -->
- Never mock the database,
  run it for real.

## Style
- Match the repo's idioms.
`;

describe("principleRows", () => {
  it("gives one active principle per rule, in its section, with the repository first and an edge after each", () => {
    const rows = principleRows(FILE, repo, { at, held: [] });
    expect(rows[0]).toEqual({ type: "Repo", data: { slug: "repo:luna-tui-ab12", name: "luna-tui" } });
    expect(principles(rows).map((row) => [row.data.statement, row.data.section, row.data.status])).toEqual([
      ["Before any heading.", "(no section)", "active"],
      ["Write the failing test first.", "Testing", "active"],
      ["Never mock the database, run it for real.", "Testing", "active"],
      ["Match the repo's idioms.", "Style", "active"],
    ]);
    const first = principles(rows)[1]!;
    expect(first.data).toEqual({ slug: `principle:luna-tui-ab12/${hex("Write the failing test first.")}`, statement: "Write the failing test first.", section: "Testing", status: "active", recorded_at: "2026-11-10T09:00:00.000Z" });
    const index = rows.indexOf(first);
    expect(rows[index + 1]).toEqual({ edge: "PrincipleOfRepo", from: first.data.slug, to: "repo:luna-tui-ab12" });
  });

  it("is one principle for a statement that is in the file twice, and skips an empty item", () => {
    const rows = principleRows("## A\n- Same.\n- Same.\n- <!-- only a comment -->\n-\n", repo, { at, held: [] });
    expect(principles(rows)).toHaveLength(1);
  });

  it("cuts a statement to 500 characters and a heading to 120", () => {
    const rows = principleRows(`## ${"h".repeat(200)}\n- ${"s".repeat(900)}\n`, repo, { at, held: [] });
    expect(String(principles(rows)[0]!.data.statement)).toHaveLength(500);
    expect(String(principles(rows)[0]!.data.section)).toHaveLength(120);
  });

  it("gives rows deeply equal to the held ones when nothing changed", () => {
    const later = new Date("2026-12-01T00:00:00.000Z");
    const first = principleRows(FILE, repo, { at, held: [] });
    const again = principleRows(FILE, repo, { at: later, held: principles(first) });
    expect(again).toEqual(first);
  });

  it("brings a rule that left the file back retired, as held, and a retired one that returned active", () => {
    const first = principleRows(FILE, repo, { at, held: [] });
    const gone = principleRows("## Style\n- Match the repo's idioms.\n", repo, { at: new Date("2026-12-01T00:00:00.000Z"), held: principles(first) });
    const retired = principles(gone).filter((row) => row.data.status === "retired");
    expect(retired).toHaveLength(3);
    expect(retired[0]).toEqual({ ...principles(first)[0]!, data: { ...principles(first)[0]!.data, status: "retired" } });
    expect(principles(gone).filter((row) => row.data.status === "active")).toHaveLength(1);
    const back = principleRows(FILE, repo, { at: new Date("2027-01-01T00:00:00.000Z"), held: principles(gone) });
    expect(principles(back).map((row) => row.data.status)).toEqual(["active", "active", "active", "active"]);
    expect(principles(back)).toEqual(principles(first));
  });

  it("gives no rows and retires nothing for a file it could not read", () => {
    const held = principles(principleRows(FILE, repo, { at, held: [] }));
    expect(principleRows(null, repo, { at, held })).toEqual([]);
  });
});
