import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { CompanyDocs } from "./memory-company-docs.ts";

let root: string;
let docs: string;
let state: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "company-docs-"));
  docs = join(root, "handbook");
  state = join(root, "state");
  mkdirSync(join(docs, "hr"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const poller = (memory = fakeMemory(), dirs = [docs]) => new CompanyDocs({ memory, dirs, stateDir: state, log: () => {} });

describe("CompanyDocs", () => {
  it("sends md, txt and pdf with no repository and cognifies the company dataset", async () => {
    writeFileSync(join(docs, "policy.md"), "# policy");
    writeFileSync(join(docs, "hr", "leave.txt"), "leave");
    writeFileSync(join(docs, "deck.pdf"), "%PDF");
    writeFileSync(join(docs, "sheet.xlsx"), "x");
    const memory = fakeMemory();
    const report = await poller(memory).poll();
    expect(report).toMatchObject({ added: 3, changed: 0, removed: 0 });
    expect(report?.skipped).toEqual([{ path: "handbook/sheet.xlsx", reason: expect.stringContaining("type not read") }]);
    expect(memory.docs.map((d) => d.path).sort()).toEqual(["handbook/deck.pdf", "handbook/hr/leave.txt", "handbook/policy.md"]);
    expect(memory.docs.every((d) => d.repo === null)).toBe(true);
    expect(memory.items.every((i) => i.dataset.name === "company")).toBe(true);
    expect(memory.cognified).toEqual([["company"]]);
  });

  it("sends only changed files, retires deleted ones, and keeps its hashes across restarts", async () => {
    writeFileSync(join(docs, "a.md"), "one");
    writeFileSync(join(docs, "b.md"), "two");
    const memory = fakeMemory();
    await poller(memory).poll();
    writeFileSync(join(docs, "a.md"), "one, edited");
    rmSync(join(docs, "b.md"));
    const report = await poller(memory).poll(); // a new instance: the state is on disk
    expect(report).toMatchObject({ added: 0, changed: 1, removed: 1, unchanged: 0 });
    expect(memory.items.find((i) => i.source.ref === "handbook/b.md")?.status).toBe("retired");
    expect(await poller(memory).poll()).toMatchObject({ changed: 0, removed: 0, unchanged: 1 });
    expect(memory.cognified).toHaveLength(2);
  });

  it("never follows a link, and skips a file over the cap", async () => {
    writeFileSync(join(root, "secret.md"), "outside");
    symlinkSync(join(root, "secret.md"), join(docs, "link.md"));
    symlinkSync(root, join(docs, "dirlink"));
    const memory = fakeMemory();
    const report = await poller(memory).poll();
    expect(memory.docs).toEqual([]);
    expect(report?.skipped.map((s) => s.path).sort()).toEqual(["handbook/dirlink", "handbook/link.md"]);
  });

  it("leaves a folder's documents alone when the folder cannot be read", async () => {
    writeFileSync(join(docs, "a.md"), "one");
    const memory = fakeMemory();
    await poller(memory).poll();
    rmSync(docs, { recursive: true });
    const gone = poller(memory);
    const report = await gone.poll();
    expect(report?.removed).toBe(0);
    expect(report?.unreadable).toHaveLength(1);
    expect(gone.health().lastFailure).toContain("unreadable folder");
    expect(memory.items[0]?.status).toBe("active");
  });

  it("is idle with memory off or no folder", async () => {
    expect(await poller(fakeMemory(), []).poll()).toBeNull();
  });
});
