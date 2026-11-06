import type { EvidencePack } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { COMMENT_MARKER, SECTION_START } from "../domain/evidence-markdown.ts";
import { fakeGitHub } from "../test/github.ts";
import { publishChosen, publishEvidence } from "./evidence-publish.ts";
import { localStorage } from "./evidence-storage.ts";
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
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-8f8cbb7d-cart.png", Buffer.from("png"), "image/png");
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-1ff838dc-walk.webm", Buffer.from("vid"), "video/webm");
    expect(result.pack.media.map((m) => m.url)).toEqual(["https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-8f8cbb7d-cart.png", "https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-1ff838dc-walk.webm"]);
  });

  it("reuses an asset of the same name instead of uploading it again", async () => {
    const existing = { id: 1, name: "01234567-abc1234-3a6eb079-cart.png", url: "https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-3a6eb079-cart.png" };
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
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-3a6eb079-shot_one__1_.png", expect.any(Buffer), "image/png");
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

describe("publishEvidence: what may be uploaded", () => {
  const token = "gh" + "p_" + "a".repeat(36);
  const urlOf = (name: string) => `https://github.com/o/a/releases/download/luna-evidence/${name}`;

  it("names an asset with the hash of its content, so a file made again at the same commit is uploaded anew", async () => {
    const gh = github();
    const first = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "a.png", url: put("a.png", "one") }]) });
    const second = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "a.png", url: put("a.png", "two") }]) });
    expect(first.assets).toBe(1);
    expect(second.assets).toBe(1);
    expect(first.pack.media[0]!.url).not.toBe(second.pack.media[0]!.url);
  });

  it("keeps an image with scanned: false as a local copy unless a person approved the preview", async () => {
    const media = [{ kind: "screenshot" as const, label: "a.png", url: put("a.png", "x"), scanned: false }, { kind: "screenshot" as const, label: "b.png", url: put("b.png", "y"), scanned: true }];
    const held = github();
    const out = await publishEvidence({ ...base, github: held, localDir, pack: pack(media) });
    expect(out.assets).toBe(1);
    expect(out.pack.media[0]!.url).toBe(media[0]!.url);
    const approved = github();
    const open = await publishEvidence({ ...base, github: approved, localDir, pack: pack(media), approved: true });
    expect(open.assets).toBe(2);
  });

  it("passes every text media kind through redact: a token planted in a terminal capture is gone from what is uploaded", async () => {
    const gh = github();
    const media = [
      { kind: "report" as const, label: "terminal.txt", url: put("terminal.txt", `$ pnpm test\nTOKEN=${token}\nok`) },
      { kind: "report" as const, label: "checks.txt", url: put("checks.txt", `x ${token}`) },
      { kind: "report" as const, label: "meta.json", url: put("meta.json", JSON.stringify({ k: token })) },
      { kind: "captions" as const, label: "c.vtt", url: put("c.vtt", `WEBVTT\n${token}`) },
    ];
    await publishEvidence({ ...base, github: gh, localDir, pack: pack(media) });
    const sent = (gh.uploadReleaseAsset as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(sent).toHaveLength(4);
    for (const call of sent) {
      const text = (call[3] as Buffer).toString("utf8");
      expect(text).not.toContain(token);
      expect(text).toContain("[redacted]");
    }
  });

  it("does not publish a text file it cannot read within its cap", async () => {
    const gh = github();
    const big = put("terminal.txt", "x".repeat(2 * 1024 * 1024 + 1));
    const out = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "report", label: "terminal.txt", url: big }]) });
    expect(out.assets).toBe(0);
    expect(out.pack.media[0]!.url).toBe(big);
  });

  it("uses a returned url only when it is https with no whitespace, parenthesis or angle bracket, and falls back to the local copy with a note", async () => {
    for (const bad of ["http://x.example/a.png", "https://x.example/a b.png", "https://x.example/a).png", "https://x.example/<a>.png"]) {
      const gh = github({ uploadReleaseAsset: async () => ({ url: bad }) });
      const path = put("a.png");
      const out = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "a.png", url: path }]) });
      expect(out.pack.media[0]!.url, bad).toBe(path);
      expect((out.notes ?? []).join(" "), bad).toMatch(/local copy/);
    }
  });

  it("asks the target whether each url still resolves, and a url that does not goes back to the local copy", async () => {
    const gh = github({ uploadReleaseAsset: async (_s, _r, name) => ({ url: urlOf(name) }), releaseAssets: async () => [] });
    const path = put("a.png");
    const out = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "a.png", url: path }]) });
    expect(out.pack.media[0]!.url).toBe(path);
    expect((out.notes ?? []).join(" ")).toMatch(/does not resolve|local copy/);
  });

  it("uploads nothing with the local storage and leaves every entry a local copy", async () => {
    const gh = github();
    const path = put("a.png");
    const out = await publishEvidence({ ...base, github: gh, localDir, storage: localStorage(), pack: pack([{ kind: "screenshot", label: "a.png", url: path }]) });
    expect(gh.ensureRelease).not.toHaveBeenCalled();
    expect(out.assets).toBe(0);
    expect(out.pack.media[0]!.url).toBe(path);
  });
});

describe("publishChosen: the repository's evidence.storage picks the target", () => {
  it("local uploads nothing, release_asset uploads, and a card with no repository takes release_asset", async () => {
    const asked: (string | null)[] = [];
    const publish = publishChosen(async (repoPath) => (asked.push(repoPath), repoPath === "/local" ? "local" : "release_asset"));
    const path = put("a.png");
    const media = [{ kind: "screenshot" as const, label: "a.png", url: path }];
    const local = github();
    expect((await publish({ ...base, github: local, localDir, pack: pack(media), repoPath: "/local" })).assets).toBe(0);
    expect(local.ensureRelease).not.toHaveBeenCalled();
    const remote = github();
    expect((await publish({ ...base, github: remote, localDir, pack: pack(media), repoPath: "/remote" })).assets).toBe(1);
    expect((await publish({ ...base, github: github(), localDir, pack: pack(media) })).assets).toBe(1);
    expect(asked).toEqual(["/local", "/remote", null]);
  });
});

