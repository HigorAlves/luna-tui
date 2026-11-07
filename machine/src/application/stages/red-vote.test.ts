import type { CheckContext } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { RED_ASKINGS, type RedAnswer, voteRed } from "./red-vote.ts";

const check: CheckContext = { kind: "red", scenario: { id: "S2", title: "t" }, exists: true, output: "AssertionError" };
const no: RedAnswer = { verdict: "flag", problems: ["S: the test fails for a reason other than the missing behaviour"] };
const yes: RedAnswer = { verdict: "proceed", problems: [] };
const asking = (...answers: RedAnswer[]) => {
  let n = 0;
  const judge = async () => answers[Math.min(n++, answers.length - 1)]!;
  return { judge, calls: () => n };
};

describe("voteRed", () => {
  it("asks once when the first answer is clear", async () => {
    const j = asking(yes);
    expect(await voteRed(j.judge, check, null)).toMatchObject({ verdict: "proceed", problems: [] });
    expect(j.calls()).toBe(1);
  });
  it("lets one stray flag go: no, then yes, then yes is a proceed", async () => {
    const j = asking(no, yes, yes);
    const vote = await voteRed(j.judge, check, null);
    expect(vote.verdict).toBe("proceed");
    expect(vote.problems).toEqual([]);
    expect(vote.askings.map((a) => a.flagged)).toEqual([true, false, false]);
  });
  it("breaks a split with a third asking, as the S2 run did: no, yes, no", async () => {
    const j = asking(no, yes, no);
    const vote = await voteRed(j.judge, check, null);
    expect(j.calls()).toBe(RED_ASKINGS);
    expect(vote.verdict).toBe("flag");
    expect(vote.problems).toEqual(no.problems);
  });
  it("stands on two flags in a row, without a third asking", async () => {
    const j = asking(no, no, yes);
    expect((await voteRed(j.judge, check, null)).verdict).toBe("flag");
    expect(j.calls()).toBe(2);
  });
  it("a confident no that arrives as problems is a flag, whatever the verdict says", async () => {
    const j = asking({ verdict: "proceed", problems: ["x"] }, { verdict: "proceed", problems: ["x"] });
    expect((await voteRed(j.judge, check, null)).verdict).toBe("flag");
  });
  it("a skipped asking stays skipped", async () => {
    expect((await voteRed(asking({ verdict: "skipped", problems: [] }).judge, check, null)).verdict).toBe("skipped");
  });
});
