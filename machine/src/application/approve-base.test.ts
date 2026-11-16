import { describe, expect, it } from "vitest";

import { approveRepoBase } from "./approve-base.ts";
import type { RepoImageSourceOf } from "./repo-image-source.ts";

const KEY = `dockerfile=sha256:${"f".repeat(64)}`;
const none: RepoImageSourceOf = { base: null, origin: null, containerEnv: {}, notes: [], bounds: [], dockerfile: null };
const withDockerfile: RepoImageSourceOf = { ...none, dockerfile: { path: "Dockerfile", context: "/r", contextRel: ".", args: {}, text: "FROM x\n", key: KEY } };

function make(source: RepoImageSourceOf, over: { known?: string[]; refusal?: string | null } = {}) {
  const approved: Array<[string, string]> = [];
  let forgot = 0;
  const approve = (repo: string, base: string) =>
    approveRepoBase({
      knownRepos: async () => over.known ?? ["/r"],
      policyOf: async () => ({ bounds: { image: over.refusal ? [over.refusal] : [] } }),
      sourceOf: async () => source,
      approvals: { approve: async (r, b) => void approved.push([r, b]) },
      approved: () => void forgot++,
    }, repo, base);
  return { approve, approved, forgot: () => forgot };
}

describe("approving what a repository builds its image from", () => {
  it("approves the base luna.yaml or the devcontainer names now, and no other reference", async () => {
    const t = make({ ...none, base: "debian:12", origin: "luna.yaml" });
    expect(await t.approve("/r", "debian:12")).toEqual({ ok: true });
    expect(await t.approve("/r", "debian:13")).toMatchObject({ ok: false, reason: expect.stringContaining("not the base") });
    expect(t.approved).toEqual([["/r", "debian:12"]]);
    expect(t.forgot()).toBe(1);
  });

  it("approves a Dockerfile key only when it is the key computed from the checkout now", async () => {
    const t = make(withDockerfile);
    expect(await t.approve("/r", KEY)).toEqual({ ok: true });
    expect(t.approved).toEqual([["/r", KEY]]);
    const stale = `dockerfile=sha256:${"0".repeat(64)}`;
    expect(await t.approve("/r", stale)).toMatchObject({ ok: false, reason: expect.stringContaining("not the Dockerfile") });
    expect(t.approved).toHaveLength(1);
  });

  it("refuses a Dockerfile key when the checkout has no Dockerfile to build, or a base wins", async () => {
    expect(await make(none).approve("/r", KEY)).toMatchObject({ ok: false });
    expect(await make({ ...withDockerfile, dockerfile: null, base: "go:1", origin: "devcontainer" }).approve("/r", KEY)).toMatchObject({ ok: false });
  });

  it("refuses a repository the machine does not know, and what the machine's policy refuses", async () => {
    expect(await make(withDockerfile, { known: [] }).approve("/r", KEY)).toMatchObject({ ok: false, reason: expect.stringContaining("does not know") });
    expect(await make(withDockerfile, { refusal: "images.repo_base: deny" }).approve("/r", KEY)).toEqual({ ok: false, reason: "images.repo_base: deny" });
    expect(await make({ ...withDockerfile, bounds: ["devcontainer.json build.dockerfile is refused (images.repo_base: deny)"] }).approve("/r", KEY)).toMatchObject({ ok: false });
  });
});
