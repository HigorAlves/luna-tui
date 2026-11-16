import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChangeExceptionsContext } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangeEvidence, previousMonth } from "./change-evidence.ts";
import { ComplianceDrafts } from "./compliance-drafts.ts";
import { GitHubError, type Check, type GitHub, type MergedPr, type RuleBypass } from "./github.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "change-evidence-"));
});

const pr = (over: Partial<MergedPr> = {}): MergedPr => ({
  number: 1,
  title: "PLAT-1 add a thing",
  url: "https://github.com/acme/web/pull/1",
  body: "",
  author: "ann",
  mergedBy: "ann",
  mergedAt: "2026-10-05T10:00:00Z",
  mergeSha: "m1",
  baseRef: "main",
  headRef: "ann/thing",
  headSha: "h1",
  closingIssues: [],
  reviews: [{ author: "bob", state: "APPROVED", commitId: "h1", submittedAt: "2026-10-05T09:00:00Z" }],
  ...over,
});

interface Fakes {
  prs?: MergedPr[] | Record<string, MergedPr[] | Error>;
  bypasses?: RuleBypass[] | "unknown";
  checks?: Check[];
  explain?: (context: ChangeExceptionsContext) => Promise<unknown>;
  repos?: string[];
}
function build(fakes: Fakes = {}) {
  const mergedPrs = vi.fn(async (slug: string, _since: string, _until: string) => {
    const value = Array.isArray(fakes.prs) || fakes.prs === undefined ? (fakes.prs ?? []) : (fakes.prs[slug] ?? []);
    if (value instanceof Error) throw value;
    return value;
  });
  const ruleBypasses = vi.fn(async () => fakes.bypasses ?? []);
  const prChecks = vi.fn(async (_slug: string, _ref: string) => fakes.checks ?? [{ name: "ci", state: "SUCCESS", link: null }]);
  const github = { mergedPrs, ruleBypasses, prChecks } as unknown as GitHub;
  const drafts = new ComplianceDrafts({ stateDir });
  const log = vi.fn();
  const explain = vi.fn(fakes.explain ?? (async () => ({ explanations: [] })));
  const job = new ChangeEvidence({ github, drafts, explain, repos: async () => fakes.repos ?? ["acme/web"], stateDir, log, now: () => new Date("2026-11-03T08:00:00Z") });
  return { job, mergedPrs, ruleBypasses, prChecks, drafts, log, explain };
}

describe("previousMonth", () => {
  it("is the UTC month before, across a year", () => {
    expect(previousMonth(new Date("2026-11-03T08:00:00Z"))).toBe("2026-10");
    expect(previousMonth(new Date("2027-01-01T00:00:00Z"))).toBe("2026-12");
    expect(previousMonth(new Date("2026-03-31T23:59:59Z"))).toBe("2026-02");
  });
});

describe("buildMonth", () => {
  it("reads the UTC month, the bypasses once, the checks at the head, and opens the draft", async () => {
    const { job, mergedPrs, ruleBypasses, prChecks, drafts, explain } = build({ prs: [pr(), pr({ number: 2, headSha: null, mergeSha: "m2", title: "PLAT-2 more" }), pr({ number: 3, headSha: null, mergeSha: null, title: "PLAT-3" })] });
    const draft = await job.buildMonth("acme/web", "2026-10");
    expect(mergedPrs).toHaveBeenCalledWith("acme/web", "2026-10-01T00:00:00.000Z", "2026-10-31T23:59:59.999Z");
    expect(ruleBypasses).toHaveBeenCalledTimes(1);
    expect(prChecks.mock.calls.map((c) => c[1])).toEqual(["h1", "m2"]);
    expect(explain).not.toHaveBeenCalled();
    expect(draft).toMatchObject({
      id: "change_evidence:acme/web:2026-10",
      kind: "change_evidence",
      repo: "acme/web",
      title: "Change management, acme/web, 2026-10",
      period: "2026-10",
      status: "waiting",
      targets: [{ kind: "wiki", repo: "acme/web", path: "Compliance/Change-Management/2026-10.md" }],
    });
    expect(draft.summary).toBe("3 PRs, 0 with exceptions");
    expect(draft.text).toContain("# Change management evidence: acme/web, 2026-10");
    expect((await drafts.list())).toHaveLength(1);
  });

  it("finds the Jira key in the title, the body or the branch", async () => {
    const { job } = build({ prs: [pr({ title: "no key", body: "see ABC-12", number: 1 }), pr({ title: "no key", headRef: "feat/XYZ-9-x", number: 2 }), pr({ title: "no key", number: 3 })] });
    const draft = await job.buildMonth("acme/web", "2026-10");
    expect(draft.text).toMatch(/#1 no key.*\| ABC-12 \|/);
    expect(draft.text).toMatch(/#2 no key.*\| XYZ-9 \|/);
    expect(draft.summary).toBe("3 PRs, 1 with exceptions");
  });

  it("says when the bypasses could not be read", async () => {
    const { job } = build({ prs: [pr()], bypasses: "unknown" });
    expect((await job.buildMonth("acme/web", "2026-10")).text).toContain("Rule bypasses could not be read");
  });

  it("runs the explainer once for the exceptions and puts its text on the page, flattened", async () => {
    const long = "x".repeat(2500);
    const { job, explain } = build({
      prs: [pr({ number: 7, title: "hotfix", body: long, reviews: [] }), pr({ number: 8 })],
      explain: async () => ({
        explanations: [
          { pr: 7, kind: "no_independent_approval", text: "Urgent fix, see [the doc](https://x.test/d)\nsecond line", followUp: null },
          { pr: 7, kind: "no_ticket", text: "No ticket was linked.", followUp: "Ask the author" },
          { pr: 99, kind: "no_ticket", text: "not an exception we found", followUp: null },
        ],
      }),
    });
    const draft = await job.buildMonth("acme/web", "2026-10");
    expect(explain).toHaveBeenCalledTimes(1);
    const context = explain.mock.calls[0]![0];
    expect(context).toMatchObject({ repo: "acme/web", period: "2026-10", controls: ["SOC2 CC8.1", "HIPAA 164.308(a)(1)(ii)(D)"] });
    expect(context.exceptions).toHaveLength(1);
    expect(context.exceptions[0]).toMatchObject({ pr: 7, kinds: ["no_independent_approval", "no_ticket"], checks: "green", bypass: "no" });
    expect(context.exceptions[0]!.body).toHaveLength(2000);
    expect(draft.text).toMatch(/- no_independent_approval: Urgent fix, see the doc \(https.{0,2}:\/\/x\.test\/d\) second line\n/);
    expect(draft.text).toContain("- no_ticket: No ticket was linked.");
    expect(draft.text).not.toContain("not an exception we found");
  });

  it("never blocks the page when the explainer fails or answers badly", async () => {
    for (const explain of [async () => Promise.reject(new Error("agents are off")), async () => ({ explanations: [{ pr: "x" }] })]) {
      const { job } = build({ prs: [pr({ reviews: [] })], explain });
      const draft = await job.buildMonth("acme/web", "2026-10");
      expect(draft.summary).toBe("1 PRs, 1 with exceptions; the explainer failed");
      expect(draft.text).toContain("No explanation recorded.");
    }
  });
});

describe("tick", () => {
  const cursorFile = () => join(stateDir, "compliance", "evidence-cursor.json");

  it("builds the previous month for each repo, marks it done and does nothing on the next tick", async () => {
    const { job, mergedPrs } = build({ repos: ["acme/web", "acme/api"], prs: [pr()] });
    await job.tick(new Date("2026-11-03T08:00:00Z"));
    expect(mergedPrs.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["acme/web", "2026-10-01T00:00:00.000Z"],
      ["acme/api", "2026-10-01T00:00:00.000Z"],
    ]);
    expect(JSON.parse(readFileSync(cursorFile(), "utf8"))).toEqual({ schema: 1, done: { "acme/web": "2026-10", "acme/api": "2026-10" } });
    await job.tick(new Date("2026-11-04T08:00:00Z"));
    expect(mergedPrs).toHaveBeenCalledTimes(2);
    await job.tick(new Date("2026-12-01T00:00:00Z"));
    expect(mergedPrs).toHaveBeenCalledTimes(4);
  });

  it("logs a repo's failure, leaves it undone and goes on with the others", async () => {
    const { job, mergedPrs, log, drafts } = build({ repos: ["acme/web", "acme/api"], prs: { "acme/web": new GitHubError("no token"), "acme/api": [pr()] } });
    await job.tick(new Date("2026-11-03T08:00:00Z"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("acme/web");
    expect(log.mock.calls[0]![0]).toContain("no token");
    expect(JSON.parse(readFileSync(cursorFile(), "utf8")).done).toEqual({ "acme/api": "2026-10" });
    expect((await drafts.list()).map((d) => d.repo)).toEqual(["acme/api"]);
    await job.tick(new Date("2026-11-03T09:00:00Z"));
    expect(mergedPrs.mock.calls.filter((c) => c[0] === "acme/web")).toHaveLength(2);
    expect(mergedPrs.mock.calls.filter((c) => c[0] === "acme/api")).toHaveLength(1);
  });

  it("reads a damaged cursor as empty", async () => {
    mkdirSync(join(stateDir, "compliance"), { recursive: true });
    writeFileSync(cursorFile(), "{nope");
    const { job, mergedPrs } = build({ prs: [pr()] });
    await job.tick(new Date("2026-11-03T08:00:00Z"));
    expect(mergedPrs).toHaveBeenCalledTimes(1);
  });

  it("joins a tick that is running", async () => {
    const { job, mergedPrs } = build({ prs: [pr()] });
    const now = new Date("2026-11-03T08:00:00Z");
    await Promise.all([job.tick(now), job.tick(now)]);
    expect(mergedPrs).toHaveBeenCalledTimes(1);
  });
});
