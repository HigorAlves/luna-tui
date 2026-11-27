// A rebase that stops because git says a tracked file would be overwritten, with nothing in conflict (DISC-53: the card's workspace on Docker
// Desktop's file share, pick 9 of 24 refused over packages/domain/src/Evaluation/ports/index.ts, which no one had changed). The index is refreshed
// and the pick tried again; a second refusal names the files, so the merge round on a fresh clone answers it instead of a person.
import { describe, expect, it } from "vitest";

import { settleRebase, type GitExec } from "./worktree.ts";

const REFUSED = {
  code: 1,
  stdout: "",
  stderr: "error: Your local changes to the following files would be overwritten by merge:\n\tpackages/domain/src/Evaluation/ports/index.ts\nPlease commit your changes or stash them before you merge.\nAborting\nhint: Could not execute the todo command",
};

function runner(continues: Array<{ code: number; stdout: string; stderr: string }>): { run: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitExec = async (_command, args) => {
    const own = args.slice(args.findIndex((a) => a.startsWith("--work-tree=")) + 1);
    calls.push(own);
    if (own.includes("--continue")) return continues.shift() ?? { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const verbs = (calls: string[][]) => calls.map((c) => c.filter((a) => !a.startsWith("-c") && !a.includes("=")).slice(0, 2).join(" "));

describe("a rebase git stops over a file it says would be overwritten", () => {
  it("refreshes the index and tries the pick again, and carries on when it applies", async () => {
    const { run, calls } = runner([{ code: 0, stdout: "", stderr: "" }]);
    const result = await settleRebase(run, "/w", REFUSED, {});
    expect(result).toEqual({ ok: true, resolved: [] });
    const v = verbs(calls);
    expect(v.indexOf("update-index -q")).toBeGreaterThan(-1);
    expect(v.indexOf("update-index -q")).toBeLessThan(v.findIndex((x) => x.startsWith("rebase --continue")));
    expect(v).not.toContain("rebase --abort");
  });

  it("names the files when the pick is refused again, so the stage's merge round can answer it", async () => {
    const { run, calls } = runner([REFUSED]);
    const result = await settleRebase(run, "/w", REFUSED, {});
    expect(result).toMatchObject({ ok: false, conflicts: ["packages/domain/src/Evaluation/ports/index.ts"] });
    expect(verbs(calls)).toContain("rebase --abort");
    expect(verbs(calls).filter((x) => x.startsWith("rebase --continue"))).toHaveLength(1);
  });

  it("leaves any other stop as it was: aborted, nothing named", async () => {
    const { run } = runner([]);
    const result = await settleRebase(run, "/w", { code: 128, stdout: "", stderr: "fatal: invalid upstream 'origin/main'" }, {});
    expect(result).toMatchObject({ ok: false, conflicts: [] });
  });
});
