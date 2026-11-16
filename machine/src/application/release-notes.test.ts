import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComplianceDraft, ReleaseNotesContext } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComplianceDrafts, publisher } from "./compliance-drafts.ts";
import type { GitHub, MergedPr } from "./github.ts";
import { ReleaseNotes, githubReleaseWriter } from "./release-notes.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "release-notes-"));
});

const pr = (number: number, over: Partial<MergedPr> = {}): MergedPr => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  body: "",
  author: "ann",
  mergedBy: "ann",
  mergedAt: "2026-11-10T10:00:00Z",
  mergeSha: "m",
  baseRef: "main",
  headRef: "h",
  headSha: "h",
  closingIssues: [],
  reviews: [],
  ...over,
});

const NOW = new Date("2026-11-16T10:00:00Z");
function build(over: { prs?: MergedPr[]; latest?: { tag: string; publishedAt: string } | null; write?: (c: ReleaseNotesContext) => Promise<unknown> } = {}) {
  const mergedPrs = vi.fn(async (_slug: string, _since: string, _until: string) => over.prs ?? [pr(38), pr(39)]);
  const latestRelease = vi.fn(async (_slug: string) => (over.latest === undefined ? { tag: "v1.3.0", publishedAt: "2026-11-01T00:00:00Z" } : over.latest));
  const write = vi.fn(over.write ?? (async (_c: ReleaseNotesContext) => ({ highlights: ["CSV export"], sections: [{ heading: "Features", items: [{ text: "Export a report as CSV", prs: [38, 77] }] }], breaking: [] })));
  const drafts = new ComplianceDrafts({ stateDir });
  const notes = new ReleaseNotes({ github: { mergedPrs, latestRelease } as unknown as GitHub, drafts, write, now: () => NOW });
  return { notes, mergedPrs, latestRelease, write, drafts };
}

describe("release notes", () => {
  it("reads the PRs merged since the latest release, writes the notes and opens a draft aimed at the release", async () => {
    const { notes, mergedPrs, write } = build({ prs: [pr(38, { body: "Adds the button." }), pr(39)] });
    const draft = await notes.draft({ repo: "acme/web", tag: "v1.4.0" });
    expect(mergedPrs).toHaveBeenCalledWith("acme/web", "2026-11-01T00:00:00Z", NOW.toISOString());
    expect(write.mock.calls[0]![0]).toEqual({ repo: "acme/web", tag: "v1.4.0", since: "2026-11-01T00:00:00Z", prs: [{ number: 38, title: "Change 38", author: "ann", body: "Adds the button.", url: "https://github.com/acme/web/pull/38" }, { number: 39, title: "Change 39", author: "ann", body: "", url: "https://github.com/acme/web/pull/39" }] });
    expect(draft).toMatchObject({
      id: "release_notes:acme/web:v1.4.0",
      kind: "release_notes",
      repo: "acme/web",
      title: "Release notes, acme/web v1.4.0",
      period: null,
      summary: "2 PRs",
      status: "waiting",
      targets: [{ kind: "github_release", repo: "acme/web", tag: "v1.4.0" }],
    });
    expect(draft.text).toBe("## Highlights\n- CSV export\n\n## Features\n- Export a report as CSV (#38)\n");
  });

  it("starts at `since` when given, and thirty days back when the repo has no release", async () => {
    const given = build();
    await given.notes.draft({ repo: "acme/web", tag: "v1.4.0", since: "2026-10-20T00:00:00Z" });
    expect(given.mergedPrs.mock.calls[0]![1]).toBe("2026-10-20T00:00:00Z");
    expect(given.latestRelease).not.toHaveBeenCalled();
    const none = build({ latest: null });
    await none.notes.draft({ repo: "acme/web", tag: "v1.0.0" });
    expect(none.mergedPrs.mock.calls[0]![1]).toBe("2026-10-17T10:00:00.000Z");
  });

  it("caps a body at 2,000 characters and the list at the 200 newest PRs", async () => {
    const many = Array.from({ length: 210 }, (_, i) => pr(i + 1, { body: "x".repeat(3000) }));
    const { notes, write } = build({ prs: many });
    await notes.draft({ repo: "acme/web", tag: "v2.0.0" });
    const context = write.mock.calls[0]![0];
    expect(context.prs).toHaveLength(200);
    expect(context.prs[0]!.number).toBe(11);
    expect(context.prs[0]!.body).toHaveLength(2000);
  });

  it("opens no draft when the writer fails or answers badly, and a second run refreshes the same draft", async () => {
    const failing = build({ write: async () => Promise.reject(new Error("model down")) });
    await expect(failing.notes.draft({ repo: "acme/web", tag: "v1.4.0" })).rejects.toThrow("model down");
    expect(await failing.drafts.list()).toEqual([]);
    const bad = build({ write: async () => ({ sections: "none" }) });
    await expect(bad.notes.draft({ repo: "acme/web", tag: "v1.4.0" })).rejects.toThrow();
    const again = build();
    await again.notes.draft({ repo: "acme/web", tag: "v1.4.0" });
    await again.notes.draft({ repo: "acme/web", tag: "v1.4.0" });
    expect(await again.drafts.list()).toHaveLength(1);
  });
});

describe("the github_release writer", () => {
  it("makes sure the release exists, then sets its body to the approved text; a repeat sets it again", async () => {
    const ensureRelease = vi.fn(async (_slug: string, _tag: string, _release: { name: string; prerelease: boolean }) => ({ id: 11, url: "https://github.com/acme/web/releases/tag/v1.4.0" }));
    const updateReleaseBody = vi.fn(async (_slug: string, _id: number, _body: string) => {});
    const github = { ensureRelease, updateReleaseBody };
    const drafts = new ComplianceDrafts({ stateDir });
    const open = await drafts.open({ id: "release_notes:acme/web:v1.4.0", kind: "release_notes", repo: "acme/web", title: "Release notes", period: null, summary: "2 PRs", text: "## Fixes\n- A fix (#1)\n", targets: [{ kind: "github_release", repo: "acme/web", tag: "v1.4.0" }] });
    const publish = publisher({ drafts, wiki: { readPages: async () => [], writePages: async () => ({ sha: "s" }) }, handlers: { github_release: githubReleaseWriter(github) } });
    const done: ComplianceDraft = await publish.approve(open.id, open.hash, "board");
    expect(done.status).toBe("posted");
    expect(ensureRelease).toHaveBeenCalledWith("acme/web", "v1.4.0", { name: "v1.4.0", prerelease: false });
    expect(updateReleaseBody).toHaveBeenCalledWith("acme/web", 11, "## Fixes\n- A fix (#1)\n");
    await githubReleaseWriter(github)(done, { kind: "github_release", repo: "acme/web", tag: "v1.4.0" });
    expect(updateReleaseBody).toHaveBeenCalledTimes(2);
  });
});
