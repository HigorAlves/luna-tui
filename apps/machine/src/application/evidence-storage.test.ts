import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fakeGitHub } from "../test/github.ts";
import { releaseAssetStorage } from "../adapters/evidence-storage/release-asset.ts";
import { localEvidenceStorage } from "../adapters/evidence-storage/local.ts";
import { evidenceRetentionDays } from "./evidence-store.ts";
import { localStorage } from "./evidence-storage.ts";

describe("the local storage", () => {
  it("uploads nothing and has nothing, in the port's fallback and as an adapter", async () => {
    for (const storage of [localStorage(), localEvidenceStorage()]) {
      expect(await storage.put({ slug: "o/a", name: "n", path: "/x", contentType: "image/png" })).toBeNull();
      expect(await storage.has("o/a", "https://x.example/a")).toBe(false);
    }
  });
});

describe("the release-asset storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "rel-"));
  const file = join(dir, "a.png");
  writeFileSync(file, "png");
  const gh = (assets: { id: number; name: string; url: string }[] = []) =>
    fakeGitHub({
      ensureRelease: async () => ({ id: 5, url: "u" }),
      releaseAssets: async () => assets,
      uploadReleaseAsset: async (_s, _r, name) => {
        const url = `https://github.com/o/a/releases/download/luna-evidence/${name}`;
        assets.push({ id: assets.length + 1, name, url });
        return { url };
      },
    });

  it("puts a file on the draft pre-release luna-evidence, reads it through the bounded reader, and says whether a url is still listed", async () => {
    const g = gh();
    const storage = releaseAssetStorage(g);
    const put = await storage.put({ slug: "o/a", name: "n.png", path: file, contentType: "image/png" });
    expect(g.ensureRelease).toHaveBeenCalledWith("o/a", "luna-evidence", { name: "Luna evidence", prerelease: true });
    expect(g.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "n.png", Buffer.from("png"), "image/png");
    expect(await storage.has("o/a", put!.url)).toBe(true);
    expect(await storage.has("o/a", "https://github.com/o/a/releases/download/luna-evidence/gone.png")).toBe(false);
  });

  it("uses the bytes it is given instead of the file, and an asset of the same name is reused", async () => {
    const g = gh([{ id: 1, name: "same.png", url: "https://github.com/o/a/releases/download/luna-evidence/same.png" }]);
    const storage = releaseAssetStorage(g);
    expect((await storage.put({ slug: "o/a", name: "same.png", path: file, contentType: "image/png" }))!.url).toContain("same.png");
    expect(g.uploadReleaseAsset).not.toHaveBeenCalled();
    await storage.put({ slug: "o/a", name: "other.txt", path: file, contentType: "text/plain", data: Buffer.from("redacted") });
    expect(g.uploadReleaseAsset).toHaveBeenCalledWith("o/a", 5, "other.txt", Buffer.from("redacted"), "text/plain");
  });

  it("refuses a file that is a link", async () => {
    const { symlinkSync } = await import("node:fs");
    const link = join(dir, "link.png");
    symlinkSync(file, link);
    await expect(releaseAssetStorage(gh()).put({ slug: "o/a", name: "l.png", path: link, contentType: "image/png" })).rejects.toThrow(/regular file/);
  });
});

describe("evidenceRetentionDays", () => {
  it("is the repository's evidence.retention_days, else 180, and never the machine's", () => {
    expect(evidenceRetentionDays(null)).toBe(180);
    expect(evidenceRetentionDays({ factory: { evidence: { retention_days: 30 } } } as never)).toBe(30);
    expect(evidenceRetentionDays({ factory: { evidence: { retention_days: 0 } } } as never)).toBe(0);
  });
});
