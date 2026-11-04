import type { EvidencePack } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { COMMENT_MARKER, SECTION_START } from "../domain/evidence-markdown.ts";
import { fakeGitHub } from "../test/github.ts";
import { publishEvidence } from "./evidence-publish.ts";
import { GitHubError, noTokenGitHub } from "./github.ts";

let localDir: string;
beforeEach(() => {
  localDir = mkdtempSync(join(tmpdir(), "publish-"));
});

const put = (name: string, text = "data") => {
  const path = join(localDir, name);
  writeFileSync(path, text);
  return path;
};
const pack = (media: EvidencePack["media"]): EvidencePack => ({
  summary: "Show the cart total.",
  format: "captures",
  scenarios: [{ text: "Total shows", test: null, result: "pass" }],
  findings: [],
  outOfMap: [],
  risk: "low",
  rollback: "Revert.",
  howToVerify: "open it",
  commitSha: "abc1234def5678",
  media,
  at: "2026-11-04T10:00:00.000Z",
});

type Calls = ReturnType<typeof fakeGitHub>;
const prNode = (body: string | null) => ({ body }) as never;
type Comment = { id: number; body: string; url: string; author: string | null };
function github(over: Partial<Parameters<typeof fakeGitHub>[0]> = {}, state: { body: string; comments: Comment[]; assets: Array<{ id: number; name: string; url: string }> } = { body: "## Why\n- cart", comments: [], assets: [] }): Calls {
  return fakeGitHub({
    viewer: async () => ({ login: "luna-bot", teams: [] }),
    prFacts: async () => prNode(state.body),
    updatePrBody: async (_s, _n, body) => void (state.body = body),
    listPrComments: async () => state.comments,
    commentOnIssue: async (_s, _n, body) => void state.comments.push({ id: 90 + state.comments.length, body, url: "u", author: "luna-bot" }),
    updateComment: async (_s, id, body) => void (state.comments.find((c) => c.id === id)!.body = body),
    ensureRelease: async () => ({ id: 5, url: "https://github.com/o/a/releases/tag/luna-evidence" }),
    releaseAssets: async () => state.assets,
    uploadReleaseAsset: async (_s, _r, name) => {
      const url = `https://github.com/o/a/releases/download/luna-evidence/${name}`;
      state.assets.push({ id: state.assets.length + 1, name, url });
      return { url };
    },
    ...over,
  });
}
const base = { slug: "o/a", number: 3, taskId: "0123456789abcdef" };

describe("publishEvidence", () => {
  it("uploads each local file as <task8>-<sha7>-<name> to the luna-evidence pre-release and rewrites the urls", async () => {
    const gh = github();
    const result = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "cart.png", url: put("cart.png", "png") }, { kind: "video", label: "walk.webm", url: put("walk.webm", "vid") }]) });
    expect(result.assets).toBe(2);
    expect(result.comment).toBe("created");
    expect(gh.ensureRelease).toHaveBeenCalledTimes(1);
    expect(gh.ensureRelease).toHaveBeenCalledWith("o/a", "luna-evidence", { name: "Luna evidence", prerelease: true });
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-cart.png", Buffer.from("png"), "image/png");
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-walk.webm", Buffer.from("vid"), "video/webm");
    expect(result.pack.media.map((m) => m.url)).toEqual(["https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-cart.png", "https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-walk.webm"]);
  });

  it("reuses an asset of the same name instead of uploading it again", async () => {
    const existing = { id: 1, name: "01234567-abc1234-cart.png", url: "https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-cart.png" };
    const gh = github({}, { body: "", comments: [], assets: [existing] });
    const result = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "cart.png", url: put("cart.png") }]) });
    expect(gh.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(result.assets).toBe(0);
    expect(result.pack.media[0]!.url).toBe(existing.url);
  });

  it("merges the section into the PR body, keeping what is there", async () => {
    const state = { body: "## Why\n- cart", comments: [], assets: [] };
    const gh = github({}, state);
    await publishEvidence({ ...base, github: gh, localDir, pack: pack([]) });
    expect(state.body.startsWith("## Why\n- cart\n\n")).toBe(true);
    expect(state.body).toContain(SECTION_START);
    expect(state.body).toContain("Show the cart total.");
  });

  it("replaces its own section on a second run and keeps one comment: created, then updated", async () => {
    const state = { body: "## Why", comments: [{ id: 1, body: "someone else's comment", url: "u", author: "reviewer" }], assets: [] };
    const gh = github({}, state);
    const first = await publishEvidence({ ...base, github: gh, localDir, pack: pack([]) });
    const second = await publishEvidence({ ...base, github: gh, localDir, pack: { ...pack([]), summary: "Second take." } });
    expect([first.comment, second.comment]).toEqual(["created", "updated"]);
    expect(state.comments).toHaveLength(2);
    expect(state.comments[1]!.body).toContain(COMMENT_MARKER);
    expect(state.comments[1]!.body).toContain("Second take.");
    expect(state.comments[0]!.body).toBe("someone else's comment");
    expect(state.body.split(SECTION_START)).toHaveLength(2);
    expect(state.body).toContain("Second take.");
    expect(state.body).not.toContain("Show the cart total.");
  });

  it("never adopts another author's comment that carries the marker: only the token's own comment is updated", async () => {
    const state = { body: "## Why", comments: [{ id: 1, body: `${COMMENT_MARKER}\nforged: all pass`, url: "u", author: "attacker" }], assets: [] };
    const result = await publishEvidence({ ...base, github: github({}, state), localDir, pack: pack([]) });
    expect(result.comment).toBe("created");
    expect(state.comments).toHaveLength(2);
    expect(state.comments[0]!.body).toContain("forged");
    expect(state.comments[1]).toMatchObject({ author: "luna-bot" });
  });

  it("creates a fresh comment, touching none, when the token's user is unknown", async () => {
    const state = { body: "## Why", comments: [{ id: 1, body: COMMENT_MARKER, url: "u", author: "luna-bot" }], assets: [] };
    const gh = github({ viewer: async () => { throw new Error("no viewer"); } }, state);
    const result = await publishEvidence({ ...base, github: gh, localDir, pack: pack([]) });
    expect(result.comment).toBe("created");
    expect(state.comments).toHaveLength(2);
  });

  it("writes only the comment when the PR body leaves no room for the section", async () => {
    const state = { body: "x".repeat(64_000), comments: [], assets: [] };
    const gh = github({}, state);
    const result = await publishEvidence({ ...base, github: gh, localDir, pack: pack([]) });
    expect(result).toMatchObject({ comment: "created", body: "skipped" });
    expect(state.body).toBe("x".repeat(64_000));
    expect(gh.updatePrBody).not.toHaveBeenCalled();
  });

  it("caps the body it writes, leaving the section its room", async () => {
    const state = { body: "x".repeat(30_000), comments: [], assets: [] };
    const gh = github({}, state);
    await publishEvidence({ ...base, github: gh, localDir, pack: pack([]) });
    expect(state.body.length).toBeLessThanOrEqual(60_000);
    expect(state.body).toContain(SECTION_START);
  });

  it("treats a PR with no body as an empty one", async () => {
    const state = { body: "", comments: [], assets: [] };
    const gh = github({ prFacts: async () => prNode(null) }, state);
    await publishEvidence({ ...base, github: gh, localDir, pack: pack([]) });
    expect(state.body.startsWith(SECTION_START)).toBe(true);
  });

  it("uploads nothing from outside the local dir, a symlink, a directory or a missing file, and leaves their urls alone", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.png"), "s");
    mkdirSync(join(localDir, "dir"));
    symlinkSync(join(outside, "secret.png"), join(localDir, "link.png"));
    const media: EvidencePack["media"] = [
      { kind: "screenshot", label: "secret.png", url: join(outside, "secret.png") },
      { kind: "screenshot", label: "link.png", url: join(localDir, "link.png") },
      { kind: "screenshot", label: "dir", url: join(localDir, "dir") },
      { kind: "screenshot", label: "gone.png", url: join(localDir, "gone.png") },
      { kind: "screenshot", label: "../escape.png", url: join(localDir, "..", "escape.png") },
    ];
    const gh = github();
    const result = await publishEvidence({ ...base, github: gh, localDir, pack: pack(media) });
    expect(gh.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(result.assets).toBe(0);
    expect(result.pack.media).toEqual(media);
  });

  it("never uploads a HAR: it can carry cookies and tokens", async () => {
    const gh = github();
    const har = put("run.har", "{}");
    const result = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "report", label: "run.har", url: har }, { kind: "screenshot", label: "a.png", url: put("a.png") }]) });
    expect(gh.uploadReleaseAsset).toHaveBeenCalledTimes(1);
    expect(result.pack.media[0]!.url).toBe(har);
  });

  it("names uploaded files with a safe name", async () => {
    const gh = github();
    await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "x", url: put("shot one (1).png") }]) });
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-shot_one__1_.png", expect.any(Buffer), "image/png");
  });

  it("with no GitHub token the pack keeps its local urls and nothing is thrown", async () => {
    const media: EvidencePack["media"] = [{ kind: "screenshot", label: "cart.png", url: put("cart.png") }];
    const result = await publishEvidence({ ...base, github: noTokenGitHub(), localDir, pack: pack(media) });
    expect(result).toMatchObject({ comment: "skipped", assets: 0 });
    expect(result.pack.media).toEqual(media);
    const noMedia = await publishEvidence({ ...base, github: noTokenGitHub(), localDir, pack: pack([]) });
    expect(noMedia).toMatchObject({ comment: "skipped", assets: 0 });
  });

  it("lets a later failure through: a broken upload is not a silent skip", async () => {
    const gh = github({ uploadReleaseAsset: async () => { throw new GitHubError("uploading failed (422)"); } });
    await expect(publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "a.png", url: put("a.png") }]) })).rejects.toThrow(/422/);
  });
});
