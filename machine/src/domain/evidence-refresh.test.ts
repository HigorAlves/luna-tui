import type { EvidencePack } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { refreshPackText } from "./evidence-refresh.ts";

const NEW = "e".repeat(40);
const pack = (over: Partial<EvidencePack> = {}): EvidencePack => ({
  summary: "Old summary. Fixed after review: renamed x.",
  format: "captures",
  scenarios: [{ text: "exports", test: "t", result: "pass" }],
  findings: ["a finding"],
  outOfMap: [],
  risk: "low",
  rollback: "Revert.",
  howToVerify: "open it",
  commitSha: "a".repeat(40),
  media: [{ kind: "screenshot", label: "a.png", url: "https://x/a.png" }],
  video: null,
  at: "2026-11-04T00:00:00.000Z",
  revision: 2,
  diffSummary: { what: "Adds a CSV export", why: "customers asked", files: ["src/a.ts"], added: 10, removed: 1 },
  source: { e2eRunId: "r1", scenariosKey: "k", stepsSha: null },
  ...over,
});
const facts = { sha: NEW, fix: { scope: "in_place" as const, summary: "renamed x to rows", at: "2026-11-05T00:00:00.000Z" }, delta: [{ id: "f1", title: "unused var", severity: "low", resolution: "fixed" }], diff: { added: 14, removed: 3, files: ["src/a.ts", "src/b.ts"] }, now: "2026-11-05T01:00:00.000Z" };

describe("refreshPackText", () => {
  it("rebuilds the text at the new head and leaves media, format, scenarios results and source alone", () => {
    const before = pack();
    const out = refreshPackText(before, facts);
    expect(out).toMatchObject({ commitSha: NEW, revision: 3, at: facts.now, format: "captures", media: before.media, video: null, scenarios: before.scenarios, source: before.source });
    expect(out.fixes).toEqual([{ sha: NEW, scope: "in_place", summary: "renamed x to rows", at: facts.fix.at }]);
    expect(out.diffSummary).toEqual({ what: "Adds a CSV export", why: "customers asked", files: ["src/a.ts", "src/b.ts"], added: 14, removed: 3 });
  });
  it("writes the summary again from diffSummary.what and the number of fixes, with no old 'Fixed after review' sentence", () => {
    const out = refreshPackText(pack(), facts);
    expect(out.summary).not.toContain("Fixed after review");
    expect(out.summary).toContain("Adds a CSV export");
    expect(out.summary).toContain("1 fix after review.");
  });
  it("without a diffSummary the stored summary loses its old sentence", () => {
    const out = refreshPackText(pack({ diffSummary: undefined, summary: "Old summary. Fixed after review: renamed x." }), facts);
    expect(out.summary.startsWith("Old summary.")).toBe(true);
    expect(out.summary).not.toContain("renamed x.");
  });
  it("adds the delta review's findings with their resolution, without duplicating", () => {
    const out = refreshPackText(pack({ findingsDetail: [{ id: "f0", title: "old", severity: "low", resolution: null }] }), facts);
    expect(out.findingsDetail?.map((f) => f.id)).toEqual(["f0", "f1"]);
    expect(out.findings).toContain("unused var");
  });
  it("keeps 20 fixes at most and never calls a model (pure)", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ sha: String(i), scope: "in_place" as const, summary: "s", at: "t" }));
    expect(refreshPackText(pack({ fixes: many }), facts).fixes).toHaveLength(20);
    expect(refreshPackText(pack({ fixes: many }), facts).fixes!.at(-1)!.sha).toBe(NEW);
  });
});
