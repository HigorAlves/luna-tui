import { describe, expect, it } from "vitest";

import { checkpointPush } from "./checkpoint.ts";

const sha = "a".repeat(40);
const ok = { code: 0, stdout: "", stderr: "" };
const bad = { code: 1, stdout: "", stderr: "network down" };

function setup(results: Array<typeof ok>) {
  const rows: Array<[string, Record<string, unknown>]> = [];
  const notes: string[] = [];
  const pushes: string[][] = [];
  let i = 0;
  const deps = {
    exec: async (_c: string, args: string[]) => (pushes.push(args), results[Math.min(i++, results.length - 1)]!),
    tip: async () => sha,
    emit: async (kind: string, payload: Record<string, unknown>) => void rows.push([kind, payload]),
    note: async (text: string) => void notes.push(text),
    sleep: async () => {},
  };
  return { deps, rows, notes, pushes };
}

describe("checkpointPush", () => {
  it("pushes the tip to the checkpoint ref and says it as a build.checkpoint row with the sha and what it follows", async () => {
    const s = setup([ok]);
    expect(await checkpointPush({ ...s.deps, branch: "task/x", cwd: "/w", follows: "red" })).toBe(sha);
    expect(s.pushes).toHaveLength(1);
    expect(s.pushes[0]!.join(" ")).toContain("refs/luna/wip/task/x");
    expect(s.rows).toEqual([["build.checkpoint", { sha, follows: "red" }]]);
  });

  it("tries again after two failures and pushes once more to land", async () => {
    const s = setup([bad, bad, ok]);
    await checkpointPush({ ...s.deps, branch: "task/x", cwd: "/w", follows: "green" });
    expect(s.pushes).toHaveLength(3);
    expect(s.rows).toEqual([["build.checkpoint", { sha, follows: "green" }]]);
    expect(s.notes).toEqual([]);
  });

  it("leaves a note, never throws and puts no row when every try fails", async () => {
    const s = setup([bad]);
    expect(await checkpointPush({ ...s.deps, branch: "task/x", cwd: "/w", follows: "green" })).toBeNull();
    expect(s.pushes).toHaveLength(4);
    expect(s.rows).toEqual([]);
    expect(s.notes[0]).toMatch(/checkpoint not pushed.*network down/);
  });

  it("does not push a tip that is already on the remote", async () => {
    const s = setup([ok]);
    await checkpointPush({ ...s.deps, branch: "task/x", cwd: "/w", follows: "green", alreadyPushed: sha });
    expect(s.pushes).toHaveLength(0);
  });
});
