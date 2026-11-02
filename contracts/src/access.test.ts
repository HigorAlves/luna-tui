import { describe, expect, it } from "vitest";

import { NO_ACCESS, access } from "./index.ts";

describe("access", () => {
  it("joins fragments: a capability any fragment grants, every command and luna tool once", () => {
    const read = access({ read: true, skills: true, commands: ["cat", "ls"], luna: ["step"] });
    expect(access(read, { write: true, commands: ["ls", "git add"], luna: ["step", "slice_set"] })).toEqual({ ...NO_ACCESS, read: true, write: true, skills: true, commands: ["cat", "ls", "git add"], luna: ["step", "slice_set"] });
    expect(access()).toEqual(NO_ACCESS);
  });
});
