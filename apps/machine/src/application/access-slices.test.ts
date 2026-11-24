import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComplianceDraft } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessSnapshot } from "../domain/access-review.ts";
import { accessSlicesWriter } from "./access-review.ts";
import { WikiError, type Wiki } from "./wiki.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "access-slices-"));
});

const pendingFile = (period: string) => join(stateDir, "compliance", "access", "acme", `${period}.json`);
const signedFile = () => join(stateDir, "compliance", "access", "acme", "signed.json");

const snapshot: AccessSnapshot = {
  org: "acme",
  period: "2026-Q4",
  takenAt: "2026-11-16T12:00:00.000Z",
  members: [{ login: "ann", role: "admin", active: true }],
  outsideCollaborators: [],
  invitations: [],
  repos: [
    { slug: "acme/api", admins: ["bob"], directCollaborators: [], bypassActors: [], adminsEnforced: true },
    { slug: "acme/web", admins: [], directCollaborators: [], bypassActors: "unknown", adminsEnforced: false },
  ],
};
const draft = { kind: "access_review", period: "2026-Q4", title: "Access review, acme, 2026-Q4" } as ComplianceDraft;
const target = { kind: "access_slices" as const, org: "acme", period: "2026-Q4" };

const keep = () => {
  mkdirSync(join(stateDir, "compliance", "access", "acme"), { recursive: true });
  writeFileSync(pendingFile("2026-Q4"), JSON.stringify(snapshot));
};

/** A wiki that records each write, and refuses a repo named in `fail` with that reason. */
const wikiOf = (fail: Record<string, string> = {}) => {
  const writes: Array<{ slug: string; path: string; text: string; message: string }> = [];
  const wiki: Wiki = {
    readPages: async () => [],
    writePages: async (slug, pages, message) => {
      if (fail[slug]) throw new WikiError(fail[slug]!);
      writes.push({ slug, path: pages[0]!.path, text: pages[0]!.text, message });
      return { sha: "s" };
    },
  };
  return { wiki, writes };
};

describe("accessSlicesWriter", () => {
  it("writes each repo's part to its own wiki, then keeps the snapshot as the signed one", async () => {
    keep();
    const { wiki, writes } = wikiOf();
    await accessSlicesWriter({ wiki, stateDir })(draft, target);
    expect(writes.map((w) => [w.slug, w.path, w.message])).toEqual([
      ["acme/api", "Compliance/Access-Reviews/2026-Q4.md", "Access review 2026-Q4"],
      ["acme/web", "Compliance/Access-Reviews/2026-Q4.md", "Access review 2026-Q4"],
    ]);
    expect(writes[0]!.text).toContain("# Access review: acme/api, 2026-Q4");
    expect(writes[0]!.text).toContain("Compliance/Access-Reviews/acme-2026-Q4.md");
    expect(JSON.parse(readFileSync(signedFile(), "utf8"))).toEqual(snapshot);
  });

  it("skips a repo with no wiki yet, says so, and still signs", async () => {
    keep();
    const log = vi.fn();
    const { wiki, writes } = wikiOf({ "acme/api": "the wiki of acme/api does not exist yet: open the repo's Wiki tab on GitHub and create the first page" });
    await accessSlicesWriter({ wiki, stateDir, log })(draft, target);
    expect(writes.map((w) => w.slug)).toEqual(["acme/web"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("acme/api"));
    expect(JSON.parse(readFileSync(signedFile(), "utf8"))).toEqual(snapshot);
  });

  it("throws on any other wiki error and signs nothing", async () => {
    keep();
    const { wiki } = wikiOf({ "acme/web": "push rejected" });
    await expect(accessSlicesWriter({ wiki, stateDir })(draft, target)).rejects.toThrow("push rejected");
    expect(() => readFileSync(signedFile(), "utf8")).toThrow();
  });

  it("is safe to repeat, and refuses when the pending snapshot is gone", async () => {
    keep();
    const { wiki } = wikiOf();
    const write = accessSlicesWriter({ wiki, stateDir });
    await write(draft, target);
    await write(draft, target);
    expect(JSON.parse(readFileSync(signedFile(), "utf8"))).toEqual(snapshot);
    await expect(write(draft, { ...target, period: "2026-Q3" })).rejects.toThrow(/no access snapshot for acme 2026-Q3/);
  });
});
