import { describe, expect, it } from "vitest";

import { type ContextDeps, contextSetup, correctionsOf, uniqueRepoForProject } from "./context-setup.ts";

const card = (over: Record<string, unknown> = {}) => ({
  title: "Checkout fails",
  description: "pay button does nothing",
  repoPath: null as string | null,
  source: null as any,
  card: null as any,
  ...over,
});

const deps = (over: Partial<ContextDeps> = {}): ContextDeps => ({
  resolveRepo: async (slug) => (slug === "o/a" ? "/repos/a" : null),
  channelRepo: () => null,
  projectRepo: async () => null,
  configProject: async () => null,
  owners: async () => [],
  history: async () => [],
  ...over,
});

describe("context setup is a script", () => {
  it("keeps a repository the card already has, over everything else", async () => {
    const out = await contextSetup(deps(), card({ repoPath: "/mine", source: { kind: "github", repo: "o/a", number: 1, url: "u" } }));
    expect(out.repoPath).toBe("/mine");
    expect(out.repoFrom).toBe("card");
  });

  it("resolves the repository in order: the hint, the channel or project, the map", async () => {
    const github = { kind: "github", repo: "o/a", number: 1, url: "u" };
    const slack = { kind: "slack", channel: "C1", ts: "1", permalink: "https://x/1" };
    const jira = { kind: "jira", key: "PAY-3", url: "https://x/PAY-3", issueType: null };
    const d = deps({ channelRepo: (c) => (c === "C1" ? "/by-channel" : null), projectRepo: async (p) => (p === "PAY" ? "/by-project" : null) });
    expect(await contextSetup(d, card({ card: { links: { repo: "o/a" }, sources: [slack] } as any, source: slack }))).toMatchObject({ repoPath: "/repos/a", repoFrom: "hint" });
    expect(await contextSetup(d, card({ source: slack }))).toMatchObject({ repoPath: "/by-channel", repoFrom: "config" });
    expect(await contextSetup(d, card({ source: jira }))).toMatchObject({ repoPath: "/by-project", repoFrom: "config" });
    expect(await contextSetup(d, card({ source: github }))).toMatchObject({ repoPath: "/repos/a", repoFrom: "map" });
    expect(await contextSetup(d, card())).toMatchObject({ repoPath: null, repoFrom: null });
  });

  it("takes the project from the Jira source, else luna.yaml, else none", async () => {
    const jira = { kind: "jira", key: "PAY-3", url: "https://x/PAY-3", issueType: null };
    expect((await contextSetup(deps(), card({ source: jira }))).project).toBe("PAY");
    expect((await contextSetup(deps({ configProject: async () => "OPS" }), card({ repoPath: "/r" }))).project).toBe("OPS");
    expect((await contextSetup(deps(), card())).project).toBeNull();
    expect((await contextSetup(deps(), card({ card: { project: "KEEP" } as any }))).project).toBe("KEEP");
  });

  it("asks CODEOWNERS for the owners and bounds them", async () => {
    const owners = Array.from({ length: 40 }, (_, i) => `@team-${i}`);
    const out = await contextSetup(deps({ owners: async (repoPath, text) => (repoPath === "/mine" && text.includes("Checkout") ? owners : []) }), card({ repoPath: "/mine" }));
    expect(out.owners).toHaveLength(20);
  });

  it("fetches history through the ports for every source, bounded to fifty flat entries, and survives a port that throws", async () => {
    const a = { kind: "slack", channel: "C1", ts: "1", permalink: "https://x/1" };
    const b = { kind: "jira", key: "PAY-3", url: "https://x/PAY-3", issueType: null };
    const d = deps({
      history: async (source) => {
        if (source.kind === "jira") throw new Error("down");
        return Array.from({ length: 70 }, (_, i) => ({ author: "u", text: `m${i}\n- list` }));
      },
    });
    const out = await contextSetup(d, card({ source: a, card: { sources: [a, b] } as any }));
    expect(out.history).toHaveLength(50);
    expect(out.history[0]!.text).not.toContain("\n");
  });
});

describe("the repository a Jira project names", () => {
  const projectOf = async (repo: string) => ({ "/a": "PAY", "/b": "OPS", "/c": "PAY", "/d": null })[repo] ?? null;
  it("is the one known repository whose luna.yaml names the project", async () => {
    expect(await uniqueRepoForProject("OPS", ["/a", "/b", "/d"], projectOf)).toBe("/b");
  });
  it("is none when two repositories name it, or none does", async () => {
    expect(await uniqueRepoForProject("PAY", ["/a", "/b", "/c"], projectOf)).toBeNull();
    expect(await uniqueRepoForProject("NOPE", ["/a"], projectOf)).toBeNull();
    expect(await uniqueRepoForProject("PAY", ["/a", "/a"], projectOf)).toBe("/a");
  });
});

describe("what a person changes is kept against what was resolved", () => {
  it("names each changed field", () => {
    expect(correctionsOf({ repoPath: "/a", project: "PAY" }, { repoPath: "/b", project: "PAY" })).toEqual([{ field: "repoPath", resolved: "/a", chosen: "/b" }]);
    expect(correctionsOf({ repoPath: null, project: null }, { repoPath: null, project: "OPS" })).toEqual([{ field: "project", resolved: null, chosen: "OPS" }]);
    expect(correctionsOf({ repoPath: "/a", project: null }, { repoPath: "/a", project: null })).toEqual([]);
  });
});
