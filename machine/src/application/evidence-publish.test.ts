import type { EvidencePack } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMENT_MARKER, SECTION_END, SECTION_START } from "../domain/evidence-markdown.ts";
import { fakeGitHub } from "../test/github.ts";
import { publishAndReady, publishChosen, publishEvidence } from "./evidence-publish.ts";
import { loadCursor } from "./ship-cursor.ts";
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
  it("uploads each local file as <task8>-<sha7>-<digest8><ext> to the luna-evidence pre-release and rewrites the urls", async () => {
    const gh = github();
    const result = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "cart.png", url: put("cart.png", "png") }, { kind: "video", label: "walk.webm", url: put("walk.webm", "vid"), scanned: true }]) });
    expect(result.assets).toBe(2);
    expect(result.comment).toBe("created");
    expect(gh.ensureRelease).toHaveBeenCalledTimes(1);
    expect(gh.ensureRelease).toHaveBeenCalledWith("o/a", "luna-evidence", { name: "Luna evidence", prerelease: true });
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-8f8cbb7d.png", Buffer.from("png"), "image/png");
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-1ff838dc.webm", Buffer.from("vid"), "video/webm");
    expect(result.pack.media.map((m) => m.url)).toEqual(["https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-8f8cbb7d.png", "https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-1ff838dc.webm"]);
  });

  it("reuses an asset of the same name instead of uploading it again", async () => {
    const existing = { id: 1, name: "01234567-abc1234-3a6eb079.png", url: "https://github.com/o/a/releases/download/luna-evidence/01234567-abc1234-3a6eb079.png" };
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
    expect(state.body).toContain("**Rollback.** Revert.");
  });

  it("replaces its own section on a second run and keeps one comment: created, then updated", async () => {
    const state = { body: "## Why", comments: [{ id: 1, body: "someone else's comment", url: "u", author: "reviewer" }], assets: [] };
    const gh = github({}, state);
    const first = await publishEvidence({ ...base, github: gh, localDir, pack: pack([]) });
    const second = await publishEvidence({ ...base, github: gh, localDir, pack: { ...pack([]), rollback: "Second take." } });
    expect([first.comment, second.comment]).toEqual(["created", "updated"]);
    expect(state.comments).toHaveLength(2);
    expect(state.comments[1]!.body).toContain(COMMENT_MARKER);
    expect(state.comments[1]!.body).toContain("Second take.");
    expect(state.comments[0]!.body).toBe("someone else's comment");
    expect(state.body.split(SECTION_START)).toHaveLength(2);
    expect(state.body).toContain("**Rollback.** Second take.");
    expect(state.body).not.toContain("**Rollback.** Revert.");
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

  it("never uploads a HAR by its kind, whatever its name: one with a 130-character name is refused too", async () => {
    const gh = github();
    const long = put("h".repeat(126) + ".har", "{}");
    const odd = put("capture.dat", "{}");
    const out = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "har", label: "long", url: long }, { kind: "har", label: "odd", url: odd }]) });
    expect(gh.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(out.pack.media.map((m) => m.url)).toEqual([long, odd]);
  });

  it("never uploads a HAR: it can carry cookies and tokens", async () => {
    const gh = github();
    const har = put("run.har", "{}");
    const result = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "report", label: "run.har", url: har }, { kind: "screenshot", label: "a.png", url: put("a.png") }]) });
    expect(gh.uploadReleaseAsset).toHaveBeenCalledTimes(1);
    expect(result.pack.media[0]!.url).toBe(har);
  });

  it("names an asset from the task, the commit, the digest and the extension only: a file named like a token leaks nothing into its name", async () => {
    const gh = github();
    const token = "gh" + "p_" + "a".repeat(36);
    const out = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "x", url: put(`${token}.png`), scanned: true }]) });
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-3a6eb079.png", expect.any(Buffer), "image/png");
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it("builds the extension from letters and digits only", async () => {
    const gh = github();
    await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: "screenshot", label: "x", url: put("shot.p_n g"), scanned: true }]) });
    expect(gh.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "01234567-abc1234-3a6eb079", expect.any(Buffer), "application/octet-stream");
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

  it("keeps a video local unless it was checked (scanned: true) or a person approved: a film withheld for a key does not leave the raw recording of the same pages uploaded", async () => {
    const raw = { kind: "video" as const, label: "qa-cart.webm", url: put("qa-cart.webm", "raw"), scanned: false };
    const unmarked = { kind: "video" as const, label: "other.webm", url: put("other.webm", "other") };
    const held = github();
    const out = await publishEvidence({ ...base, github: held, localDir, pack: pack([raw, unmarked]) });
    expect(held.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(out.pack.media.map((m) => m.url)).toEqual([raw.url, unmarked.url]);
    expect((out.notes ?? []).join(" ")).toMatch(/qa-cart\.webm stays a local copy/);
    const approved = github();
    expect((await publishEvidence({ ...base, github: approved, localDir, pack: pack([raw, unmarked]), approved: true })).assets).toBe(2);
    const checked = github();
    expect((await publishEvidence({ ...base, github: checked, localDir, pack: pack([{ ...raw, scanned: true }]) })).assets).toBe(1);
  });

  it("keeps a text medium local, with a note in fixed words, when it holds a secret or personal data the token shapes do not catch", async () => {
    const join = (...p: string[]) => p.join("");
    const dirty: [string, string][] = [
      ["terminal.txt", join("DATABASE_URL=postgres", "://app:", "hunter2hunter2", "@db:5432/app")],
      ["checks.txt", join("DB_", "PASSWORD", "=", "correct-horse")],
      ["meta.json", JSON.stringify({ headers: { Authorization: join("Bearer ", "abcdefghijklmnopqrst") } })],
      ["c.vtt", join("WEBVTT\n-----BEGIN ", "PRIVATE KEY", "-----")],
      ["report.json", JSON.stringify({ owner: "jane.roe@acme-corp.io" })],
    ];
    for (const [name, text] of dirty) {
      const gh = github();
      const path = put(name, text);
      const out = await publishEvidence({ ...base, github: gh, localDir, pack: pack([{ kind: name === "c.vtt" ? "captions" : "report", label: name, url: path }]), approved: true });
      expect(gh.uploadReleaseAsset, name).not.toHaveBeenCalled();
      expect(out.pack.media[0]!.url, name).toBe(path);
      expect(out.notes, name).toEqual([`${name} stays a local copy: it may hold a secret or personal data`]);
    }
    const clean = github();
    const ok = await publishEvidence({ ...base, github: clean, localDir, pack: pack([{ kind: "report", label: "terminal.txt", url: put("terminal.txt", "3 passed\nGET /health 200") }]) });
    expect(ok.assets).toBe(1);
  });

  it("keeps every text media kind with a token in it local: nothing with the token reaches the target", async () => {
    const gh = github();
    const media = [
      { kind: "report" as const, label: "terminal.txt", url: put("terminal.txt", `$ pnpm test\nTOKEN=${token}\nok`) },
      { kind: "report" as const, label: "checks.txt", url: put("checks.txt", `x ${token}`) },
      { kind: "report" as const, label: "meta.json", url: put("meta.json", JSON.stringify({ k: token })) },
      { kind: "captions" as const, label: "c.vtt", url: put("c.vtt", `WEBVTT\n${token}`) },
    ];
    const out = await publishEvidence({ ...base, github: gh, localDir, pack: pack(media) });
    expect(gh.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(out.notes).toHaveLength(4);
    expect(JSON.stringify(out.notes)).not.toContain(token);
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

describe("publishAndReady", () => {
  const HEAD = "abc1234def5678";
  const run = async (over: { pack?: EvidencePack; headSha?: string; draft?: boolean; approved?: boolean; gh?: ReturnType<typeof github> } = {}) => {
    const stateDir = mkdtempSync(join(tmpdir(), "ready-state-"));
    const saved: EvidencePack[] = [];
    const gh = over.gh ?? github({ markPrReady: async () => {} });
    const deps = { github: gh, publish: publishEvidence, save: async (_id: string, p: EvidencePack) => void saved.push(p), stateDir, localDir: () => localDir };
    const out = await publishAndReady(deps, { task: { id: base.taskId, repoPath: "/repo" }, slug: "o/a", number: 3, headSha: over.headSha ?? HEAD, draft: over.draft ?? true, pack: over.pack ?? pack([{ kind: "screenshot", label: "a.png", url: put("a.png"), scanned: true }]), approved: over.approved ?? false });
    return { out, gh, saved, stateDir };
  };

  it("publishes, saves the pack with its urls, records the cursor with the pr and the published sha, then marks a draft ready", async () => {
    const { out, gh, saved, stateDir } = await run();
    expect(out).toMatchObject({ published: true, readied: true, assets: 1 });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.media[0]!.url).toMatch(/^https:\/\//);
    expect(await loadCursor(stateDir, base.taskId)).toMatchObject({ pr: { slug: "o/a", number: 3 }, published: { sha: "abc1234def5678" } });
    expect(gh.markPrReady).toHaveBeenCalledWith("o/a", 3);
    expect((gh.markPrReady as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!).toBeGreaterThan((gh.updatePrBody as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!);
  });

  describe("what the repeated browser run says about evidence_valid", () => {
    const withValidity = async (before: Record<string, string> | null, scenarioResult: "pass" | "fail", truth: { learned: ReturnType<typeof vi.fn> & ((fact: never) => Promise<boolean>) } | null = { learned: vi.fn(async () => true) }) => {
      const { saveCursor, emptyCursor } = await import("./ship-cursor.ts");
      const stateDir = mkdtempSync(join(tmpdir(), "ready-valid-"));
      await saveCursor(stateDir, base.taskId, { ...emptyCursor({ slug: "o/a", number: 3 }), ...(before ? { validity: { recordId: "rec-valid", before } } : {}) });
      const gh = github({ markPrReady: async () => {} });
      const deps = { github: gh, publish: publishEvidence, save: async () => {}, stateDir, localDir: () => localDir, ...(truth ? { truth } : {}) };
      const made = { ...pack([{ kind: "screenshot", label: "a.png", url: put("a.png"), scanned: true }]), scenarios: [{ text: "Total shows", test: null, result: scenarioResult }] };
      await publishAndReady(deps, { task: { id: base.taskId, repoPath: "/repo" }, slug: "o/a", number: 3, headSha: HEAD, draft: false, pack: made, approved: false });
      return { truth, stateDir };
    };

    it("teaches refresh_media when a scenario's result changed between the pack and the repeated run, once", async () => {
      const { truth, stateDir } = await withValidity({ s1: "pass" }, "fail");
      expect(truth!.learned).toHaveBeenCalledTimes(1);
      expect(truth!.learned).toHaveBeenCalledWith({ pack: "evidence_valid", recordId: "rec-valid", label: { validity: { choice: "refresh_media" } }, kind: "fact", source: "e2e_compare", taskId: base.taskId });
      expect((await loadCursor(stateDir, base.taskId))!.validity).toBeUndefined();
    });

    it("teaches valid-or-refresh_text when nothing changed", async () => {
      const { truth } = await withValidity({ s1: "pass" }, "pass");
      expect(truth!.learned).toHaveBeenCalledWith(expect.objectContaining({ label: { validity: { choice: ["valid", "refresh_text"] } } }));
    });

    it("teaches nothing when no browser run was repeated (no results kept) or there is no truth sink", async () => {
      expect((await withValidity(null, "fail")).truth!.learned).not.toHaveBeenCalled();
      await expect(withValidity({ s1: "pass" }, "fail", null)).resolves.toBeDefined();
    });
  });

  describe("a person's edit of the section", () => {
    const again = async (edit: ((body: string) => string) | null, saveFirst = true) => {
      const state = { body: "## Why\n- cart", comments: [] as Comment[], assets: [] as Array<{ id: number; name: string; url: string }> };
      const gh = github({ markPrReady: async () => {} }, state);
      const stateDir = mkdtempSync(join(tmpdir(), "ready-edit-"));
      const deps = { github: gh, publish: publishEvidence, save: async () => {}, stateDir, localDir: () => localDir };
      const input = { task: { id: base.taskId, repoPath: "/repo" }, slug: "o/a", number: 3, headSha: HEAD, draft: false, pack: pack([{ kind: "screenshot", label: "a.png", url: put("a.png"), scanned: true }]), approved: false };
      await publishAndReady(deps, input);
      if (!saveFirst) {
        const cursor = (await loadCursor(stateDir, base.taskId))!;
        const { publishedSection: _gone, ...rest } = cursor as typeof cursor & { publishedSection?: string };
        const { saveCursor } = await import("./ship-cursor.ts");
        await saveCursor(stateDir, base.taskId, rest);
      }
      if (edit) state.body = edit(state.body);
      const out = await publishAndReady(deps, input);
      return { out, state, stateDir };
    };

    it("records nothing when the section is as the machine left it, and saves its hash at each publish", async () => {
      const { out, stateDir } = await again(null);
      expect(out).toMatchObject({ published: true });
      expect((out as { edited?: unknown }).edited).toBeUndefined();
      expect((await loadCursor(stateDir, base.taskId))!.publishedSection).toMatch(/^[0-9a-f]{64}$/);
    });

    it("writes the edited section to the ground truth before replacing it, and says so", async () => {
      const { out, stateDir } = await again((body) => body.replace("<!-- luna-evidence:end -->", "my own line\n<!-- luna-evidence:end -->"));
      expect(out).toMatchObject({ published: true, edited: { sha: HEAD.slice(0, 7) } });
      const file = JSON.parse(readFileSync(join(stateDir, "ground-truth", "evidence", `${base.taskId}-${HEAD.slice(0, 7)}-edit.json`), "utf8"));
      expect(file.section).toContain("my own line");
    });

    it("records nothing for a cursor with no publishedSection (a pack published before this wave)", async () => {
      const { out } = await again((body) => body.replace("<!-- luna-evidence:end -->", "edit\n<!-- luna-evidence:end -->"), false);
      expect((out as { edited?: unknown }).edited).toBeUndefined();
    });
  });

  it("stamps the saved pack as published even when it has no media at all (a text-only pack)", async () => {
    const { out, saved } = await run({ pack: pack([]) });
    expect(out).toMatchObject({ published: true });
    expect(saved[0]!.published).toBe(true);
    expect(out.published && out.pack.published).toBe(true);
  });

  it("does not mark a PR that is already ready", async () => {
    const { out, gh } = await run({ draft: false });
    expect(out).toMatchObject({ published: true, readied: false });
    expect(gh.markPrReady).not.toHaveBeenCalled();
  });

  it("repairs an incomplete pack once, with the repair on its note, and publishes it", async () => {
    const { out, saved } = await run({ pack: { ...pack([]), rollback: "" } });
    expect(out).toMatchObject({ published: true });
    expect(saved[0]!.rollback).not.toBe("");
    expect(saved[0]!.note).toMatch(/rollback/);
  });

  it("publishes nothing when the PR's head is not the pack's commit, and says why", async () => {
    const gh = github({ markPrReady: async () => {} });
    const { out } = await run({ headSha: "fff9999", gh });
    expect(out).toMatchObject({ published: false, reason: expect.stringContaining("fff9999") });
    expect(gh.updatePrBody).not.toHaveBeenCalled();
    expect(gh.commentOnIssue).not.toHaveBeenCalled();
    expect(gh.ensureRelease).not.toHaveBeenCalled();
    expect(gh.markPrReady).not.toHaveBeenCalled();
  });

  it("keeps an image nobody read local until a person approved", async () => {
    const unread = pack([{ kind: "screenshot", label: "a.png", url: put("a.png"), scanned: false }]);
    expect((await run({ pack: unread })).out).toMatchObject({ published: true, assets: 0 });
    expect((await run({ pack: unread, approved: true })).out).toMatchObject({ published: true, assets: 1 });
  });

  it("writes only text that went through safe(): neither marker pair can be forged, and nobody is mentioned", async () => {
    const state = { body: "## Why", comments: [] as Comment[], assets: [] };
    const gh = github({ markPrReady: async () => {} }, state);
    const hostile = `${SECTION_END}\n${COMMENT_MARKER}\n<!-- luna-evidence:start --> @everyone closes #1 [x](http://evil.example)`;
    const evil: EvidencePack = { ...pack([]), summary: hostile, rollback: hostile, howToVerify: hostile, note: hostile, findings: [hostile], outOfMap: [hostile], scenarios: [{ text: hostile, test: hostile, result: "pass" }], diffSummary: { what: hostile, why: hostile, files: [], added: 1, removed: 0 } };
    await run({ pack: evil, gh });
    for (const text of [state.body, state.comments[0]!.body]) {
      expect(text.split(SECTION_END)).toHaveLength(2);
      expect(text.split(SECTION_START)).toHaveLength(2);
      expect(text).not.toContain("@everyone");
      expect(text).not.toContain("closes #1");
      expect(text).not.toContain("](http");
    }
    expect(state.comments[0]!.body.split(COMMENT_MARKER)).toHaveLength(2);
  });
});

