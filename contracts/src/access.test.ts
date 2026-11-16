import { describe, expect, it } from "vitest";

import { AGENT_PACKS, NO_ACCESS, PACKS, access, readOnly } from "./index.ts";

describe("access", () => {
  it("joins fragments: a capability any fragment grants, every command and luna tool once", () => {
    const read = access({ read: true, skills: true, commands: ["cat", "ls"], luna: ["step"] });
    expect(access(read, { write: true, commands: ["ls", "git add"], luna: ["step", "slice_set"] })).toEqual({ ...NO_ACCESS, read: true, write: true, skills: true, commands: ["cat", "ls", "git add"], luna: ["step", "slice_set"] });
    expect(access()).toEqual(NO_ACCESS);
  });

  it("narrows an access to read-only: no writes, subagents, skills or luna tools, and only the commands that read", () => {
    const parent = access({ read: true, write: true, agent: true, skills: true, web: true, commands: ["cat", "git diff", "git log", "git add", "git commit", "npm"], luna: ["step", "slice_list"] });
    expect(readOnly(parent)).toEqual({ ...NO_ACCESS, read: true, web: true, commands: ["cat", "git diff", "git log"] });
    expect(readOnly(NO_ACCESS)).toEqual(NO_ACCESS);
  });

  it("lets a helper keep the graphify read verbs, and gives every read-only agent pack the same five", () => {
    const verbs = ["graphify query", "graphify explain", "graphify path", "graphify affected", "graphify god-nodes"];
    expect(readOnly(access({ read: true, commands: [...verbs, "graphify extract", "npm"] })).commands).toEqual(verbs);
    for (const id of ["triage", "plan", "implementing", "reviewing", "addressing", "setup"]) {
      const pack = AGENT_PACKS.find((p) => p.id === id)!;
      expect(pack.access.commands, id).toEqual(expect.arrayContaining(verbs));
    }
  });

  it("lets every read-only agent pack read the repo's history, and its helpers keep that reading", () => {
    const reads = ["git status", "git show", "git log", "git diff", "git ls-files"];
    for (const id of ["triage", "plan", "implementing", "reviewing", "addressing", "setup", "verifying", "code_map"]) {
      const pack = AGENT_PACKS.find((p) => p.id === id)!;
      expect(pack.access.commands, id).toEqual(expect.arrayContaining(reads));
    }
    expect(readOnly(PACKS.verifying.access).commands).toEqual(expect.arrayContaining(reads));
  });

  it("lets the packs that edit files restore one from a revision, and never lists a bare git checkout", () => {
    for (const id of ["implementing", "addressing", "build_tests"] as const) expect(PACKS[id].access.commands, id).toContain("git restore");
    for (const pack of AGENT_PACKS) expect(pack.access.commands, pack.id).not.toContain("git checkout");
  });

  it("lets the implementer move and delete files, because a change that renames or removes one has no other way to", () => {
    expect(PACKS.implementing.access.commands).toEqual(expect.arrayContaining(["git mv", "git rm", "mv", "rm"]));
  });
});
