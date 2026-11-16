import { afterEach, describe, expect, it } from "vitest";

import { refusal } from "./guard.ts";

const PARENT = { writable: true, branch: "task/t1", branchPrefix: "task/", commands: ["git log", "git add", "git commit"], workRoot: "/work", outRoot: "/out", roots: { scratch: "/scratch" }, web: false };
const saved = process.env.LUNA_EVE_GUARD;
afterEach(() => (saved === undefined ? delete process.env.LUNA_EVE_GUARD : (process.env.LUNA_EVE_GUARD = saved)));

describe("refusal", () => {
  it("narrows the stage's policy for a native subagent: its own commands, nothing to write", () => {
    process.env.LUNA_EVE_GUARD = JSON.stringify(PARENT);
    expect(refusal("exec", { command: "git commit -m x" })).toBeNull();
    const helper = { writable: false, commands: ["git log"] };
    expect(refusal("exec", { command: "git commit -m x" }, helper)).not.toBeNull();
    expect(refusal("exec", { command: "git log --oneline" }, helper)).toBeNull();
    expect(refusal("write", { path: "/work/a.txt" }, helper)).not.toBeNull();
  });
});
