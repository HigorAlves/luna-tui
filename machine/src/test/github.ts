// A fake GitHub port for tests: every method rejects as "unexpected" unless the test gives
// it an answer, and every call is recorded.
import { vi } from "vitest";

import { type GitHub, GitHubError } from "../application/github.ts";

type Methods = { [K in keyof GitHub]: GitHub[K] };

export type FakeGitHub = { [K in keyof GitHub]: ReturnType<typeof vi.fn<Methods[K]>> } & {
  /** Every call, as `[method, ...args]`. */
  calls: unknown[][];
};

const METHODS: Array<keyof GitHub> = [
  "viewer",
  "searchMyPrs",
  "prFacts",
  "prDiff",
  "prFiles",
  "prComments",
  "prThreads",
  "mergePr",
  "postReview",
  "replyToThread",
  "resolveThread",
  "threadResolved",
  "listReadyIssues",
  "commentOnIssue",
  "findPr",
  "openPr",
  "markPrReady",
  "prChecks",
  "failedRunLog",
  "rerunFailedJobs",
];

export function fakeGitHub(answers: Partial<{ [K in keyof GitHub]: Methods[K] }> = {}): FakeGitHub {
  const calls: unknown[][] = [];
  const fake = { calls } as unknown as FakeGitHub;
  for (const method of METHODS) {
    const given = answers[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    (fake as unknown as Record<string, unknown>)[method] = vi.fn(async (...args: unknown[]) => {
      calls.push([method, ...args]);
      if (!given) throw new GitHubError(`unexpected github.${method}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
      return given(...args);
    });
  }
  return fake;
}
