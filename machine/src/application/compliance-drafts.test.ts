import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComplianceDrafts, DraftNotFoundError, DraftRefusedError, DraftStatusError, StaleDraftError, complianceHash, publisher } from "./compliance-drafts.ts";
import type { Wiki } from "./wiki.ts";
import { WikiError } from "./wiki.ts";

let stateDir: string;
let clock: number;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "compliance-drafts-"));
  clock = Date.parse("2026-11-01T10:00:00Z");
});
const store = () => new ComplianceDrafts({ stateDir, now: () => new Date((clock += 1000)) });
const fields = (over: Partial<Parameters<ComplianceDrafts["open"]>[0]> = {}) => ({
  id: "change_evidence:acme/web:2026-10",
  kind: "change_evidence" as const,
  repo: "acme/web",
  title: "Change management, acme/web, 2026-10",
  period: "2026-10",
  summary: "3 PRs, 1 with exceptions",
  text: "# Page\n\nline two\n",
  targets: [{ kind: "wiki" as const, repo: "acme/web", path: "Compliance/Change-Management/2026-10.md" }],
  ...over,
});

describe("complianceHash", () => {
  it("is the first 16 hex of the sha256", () => {
    expect(complianceHash("abc")).toBe("ba7816bf8f01cfea");
  });
});

describe("the drafts store", () => {
  it("opens a new draft as waiting, owner-only on disk, and lists newest first", async () => {
    const drafts = store();
    const first = await drafts.open(fields());
    await drafts.open(fields({ id: "change_evidence:acme/api:2026-10", repo: "acme/api" }));
    expect(first.status).toBe("waiting");
    expect(first.hash).toBe(complianceHash("# Page\n\nline two\n"));
    expect((await drafts.list()).map((d) => d.repo)).toEqual(["acme/api", "acme/web"]);
    const dir = join(stateDir, "compliance", "drafts");
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^[A-Za-z0-9._-]+\.json$/.test(f))).toBe(true);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(await store().get(first.id)).toEqual(first);
  });

  it("skips a damaged file with a warning", async () => {
    const drafts = store();
    await drafts.open(fields());
    writeFileSync(join(stateDir, "compliance", "drafts", "broken.json"), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await drafts.list()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a re-run replaces the text and the original, resets to waiting and keeps history", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    await drafts.edit(d.id, d.hash, "mine", "person");
    const again = await drafts.open(fields({ text: "new machine text" }));
    expect(again.status).toBe("waiting");
    expect(again.text).toBe("new machine text");
    expect(again.original).toBeUndefined();
    expect(again.history.map((h) => h.did)).toEqual(["edited"]);
    expect(again.createdAt).toBe(d.createdAt);
  });

  it("leaves a posted draft as it is", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    await drafts.claim(d.id, d.hash);
    await drafts.finish(d.id, "person");
    const again = await drafts.open(fields({ text: "different" }));
    expect(again.status).toBe("posted");
    expect(again.text).toBe(d.text);
  });

  it("edit keeps the original and a history entry", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    const edited = await drafts.edit(d.id, d.hash, "my words", "person");
    expect(edited).toMatchObject({ status: "edited", text: "my words", original: d.text, hash: complianceHash("my words") });
    expect(edited.history).toEqual([expect.objectContaining({ did: "edited", from: "person" })]);
    const twice = await drafts.edit(d.id, edited.hash, "my words 2", "person");
    expect(twice.original).toBe(d.text);
  });

  it("ignore marks it ignored, and the hash is checked", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    await expect(drafts.ignore(d.id, "0000000000000000", "person")).rejects.toBeInstanceOf(StaleDraftError);
    expect((await drafts.ignore(d.id, d.hash, "person")).status).toBe("ignored");
  });

  it("refuses a wrong hash, an unknown id and an untappable status", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    await expect(drafts.edit(d.id, "0000000000000000", "x", "p")).rejects.toBeInstanceOf(StaleDraftError);
    await expect(drafts.claim(d.id, "0000000000000000")).rejects.toBeInstanceOf(StaleDraftError);
    await expect(drafts.claim("nope", d.hash)).rejects.toBeInstanceOf(DraftNotFoundError);
    await drafts.claim(d.id, d.hash);
    await expect(drafts.claim(d.id, d.hash)).rejects.toBeInstanceOf(DraftStatusError);
    await expect(drafts.edit(d.id, d.hash, "x", "p")).rejects.toBeInstanceOf(DraftStatusError);
  });

  it("claims one approve at a time", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    const results = await Promise.allSettled([drafts.claim(d.id, d.hash), drafts.claim(d.id, d.hash)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("fail puts it back to waiting, or edited, with the error", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    await drafts.claim(d.id, d.hash);
    const failed = await drafts.fail(d.id, "wiki is off");
    expect(failed).toMatchObject({ status: "waiting", error: "wiki is off" });
    expect(failed.history.at(-1)?.did).toBe("failed");
    const e = await drafts.edit(d.id, failed.hash, "mine", "person");
    expect(e.error).toBeUndefined();
    await drafts.claim(d.id, e.hash);
    expect((await drafts.fail(d.id, "again")).status).toBe("edited");
  });

  it("refuses text that carries a secret, the machine's or an edit, and stores nothing", async () => {
    const drafts = store();
    const secret = "token ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await expect(drafts.open(fields({ text: secret }))).rejects.toBeInstanceOf(DraftRefusedError);
    expect(await drafts.list()).toEqual([]);
    const d = await drafts.open(fields());
    await expect(drafts.edit(d.id, d.hash, secret, "p")).rejects.toBeInstanceOf(DraftRefusedError);
    expect((await drafts.get(d.id))?.text).toBe(d.text);
  });

  it("keeps a multi-line page whole", async () => {
    const d = await store().open(fields({ text: "# A\n\n- one\n- two\n" }));
    expect(d.text).toBe("# A\n\n- one\n- two\n");
  });
});

describe("publisher.approve", () => {
  const wikiOf = (writePages: Wiki["writePages"]): Wiki => ({ readPages: async () => [], writePages });

  it("writes each wiki target once and marks it posted", async () => {
    const drafts = store();
    const d = await drafts.open(
      fields({
        targets: [
          { kind: "wiki", repo: "acme/web", path: "A/2026-10.md" },
          { kind: "wiki", repo: "acme/api", path: "B/2026-10.md" },
        ],
      }),
    );
    const writePages = vi.fn(async () => ({ sha: "abc" }));
    const done = await publisher({ drafts, wiki: wikiOf(writePages) }).approve(d.id, d.hash, "person");
    expect(done.status).toBe("posted");
    expect(writePages.mock.calls).toEqual([
      ["acme/web", [{ path: "A/2026-10.md", text: d.text }], "Change management evidence 2026-10"],
      ["acme/api", [{ path: "B/2026-10.md", text: d.text }], "Change management evidence 2026-10"],
    ]);
  });

  it("fails back to waiting with the wiki's own words", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    const done = await publisher({ drafts, wiki: wikiOf(async () => Promise.reject(new WikiError("the wiki is disabled"))) }).approve(d.id, d.hash, "person");
    expect(done).toMatchObject({ status: "waiting", error: "the wiki is disabled" });
  });

  it("propagates a stale hash without writing", async () => {
    const drafts = store();
    const d = await drafts.open(fields());
    const writePages = vi.fn(async () => ({ sha: "x" }));
    await expect(publisher({ drafts, wiki: wikiOf(writePages) }).approve(d.id, "0000000000000000", "p")).rejects.toBeInstanceOf(StaleDraftError);
    expect(writePages).not.toHaveBeenCalled();
  });
});
