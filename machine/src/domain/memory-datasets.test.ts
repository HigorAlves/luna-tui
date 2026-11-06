import { describe, expect, it } from "vitest";

import { datasetFor, datasetsFor } from "./memory-datasets.ts";

const repo = "luna-tui-1a2b3c4d";
const known = [
  `${repo}:github`,
  `${repo}:slack:C123`,
  `${repo}:slack:C999`,
  `${repo}:jira:LUNA`,
  `${repo}:tui`,
  `${repo}:docs`,
  `code:${repo}`,
  "other-9f9f9f9f:github",
  "other-9f9f9f9f:docs",
  "code:other-9f9f9f9f",
  "company",
];

describe("datasetFor", () => {
  it("names one dataset per repository and source", () => {
    expect(datasetFor(repo, { kind: "github", ref: "o/r#1" })).toBe(`${repo}:github`);
    expect(datasetFor(repo, { kind: "slack", ref: "C123" })).toBe(`${repo}:slack:C123`);
    expect(datasetFor(repo, { kind: "jira", ref: "LUNA" })).toBe(`${repo}:jira:LUNA`);
    expect(datasetFor(repo, { kind: "tui", ref: null })).toBe(`${repo}:tui`);
    expect(datasetFor(repo, { kind: "doc", ref: "docs/a.md" })).toBe(`${repo}:docs`);
    expect(datasetFor(repo, { kind: "code", ref: null })).toBe(`code:${repo}`);
  });

  it("puts a document with no repository in the company dataset", () => {
    expect(datasetFor(null, { kind: "doc", ref: "handbook.pdf" })).toBe("company");
  });

  it("keeps names Cognee accepts: no dots or spaces in a channel or project", () => {
    expect(datasetFor(repo, { kind: "jira", ref: "MY PROJ.v2" })).toBe(`${repo}:jira:MY-PROJ-v2`);
  });

  it("refuses a card item with no repository", () => {
    expect(() => datasetFor(null, { kind: "github", ref: null })).toThrow();
  });
});

describe("datasetsFor", () => {
  it("lets a GitHub card see only GitHub items, the docs, the code and the company folder", () => {
    expect(datasetsFor({ kind: "card", repo, source: { kind: "github", ref: null }, publicPost: false }, known).sort()).toEqual([`${repo}:docs`, `${repo}:github`, `code:${repo}`, "company"].sort());
  });

  it("never gives the company folder to a pack whose answer is posted in public", () => {
    expect(datasetsFor({ kind: "card", repo, source: { kind: "github", ref: null }, publicPost: true }, known)).not.toContain("company");
  });

  it("lets a Slack card see its own channel and not another one", () => {
    const seen = datasetsFor({ kind: "card", repo, source: { kind: "slack", ref: "C123" }, publicPost: false }, known);
    expect(seen).toContain(`${repo}:slack:C123`);
    expect(seen).not.toContain(`${repo}:slack:C999`);
    expect(seen).not.toContain(`${repo}:github`);
  });

  it("lets a TUI card see everything of its repository and nothing of another", () => {
    const seen = datasetsFor({ kind: "card", repo, source: { kind: "tui", ref: null }, publicPost: false }, known);
    expect(seen.sort()).toEqual(known.filter((d) => d.startsWith(`${repo}:`) || d === `code:${repo}` || d === "company").sort());
  });

  it("lets the operator see every dataset when no repository is named", () => {
    expect(datasetsFor({ kind: "operator", repo: null }, known).sort()).toEqual([...known].sort());
  });

  it("lets a Slack question see that channel's items, the repository's docs and code, and the company folder", () => {
    expect(datasetsFor({ kind: "slack", repo, channel: "C123" }, known).sort()).toEqual([`${repo}:slack:C123`, `${repo}:docs`, `code:${repo}`, "company"].sort());
  });

  it("names no dataset Cognee does not hold", () => {
    expect(datasetsFor({ kind: "card", repo: "absent-00000000", source: { kind: "github", ref: null }, publicPost: false }, known)).toEqual(["company"]);
  });
});
