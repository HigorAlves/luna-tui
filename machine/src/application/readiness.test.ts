import { describe, expect, it } from "vitest";
import { readinessProblems } from "./readiness.ts";

const ready = { githubToken: "t", identity: { name: "n", email: "e@x" }, stubReason: null };

describe("what keeps the machine from doing its job", () => {
  it("is nothing when it has a token, an identity and real stages", () => {
    expect(readinessProblems(ready)).toEqual([]);
  });

  it("names a missing GitHub token and how to start the machine with one", () => {
    const [problem, ...rest] = readinessProblems({ ...ready, githubToken: null });
    expect(rest).toEqual([]);
    expect(problem).toMatch(/GitHub token/);
    expect(problem).toMatch(/pnpm start/);
  });

  it("names a missing git identity, which every card's commits need", () => {
    const [problem, ...rest] = readinessProblems({ ...ready, identity: null });
    expect(rest).toEqual([]);
    expect(problem).toMatch(/git has no identity/);
    expect(problem).toMatch(/LUNA_GIT_NAME/);
  });

  it("names the reason the stages are stubs, but not when there is none (agents off on purpose)", () => {
    expect(readinessProblems({ ...ready, stubReason: "image hardness-runner:dev is missing (pnpm runner:build)" })).toEqual(["every stage is a stub: image hardness-runner:dev is missing (pnpm runner:build)"]);
    expect(readinessProblems({ ...ready, stubReason: null })).toEqual([]);
  });

  it("lists every problem at once", () => {
    expect(readinessProblems({ githubToken: null, identity: null, stubReason: "no Claude credential" })).toHaveLength(3);
  });
});
