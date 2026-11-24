import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insideRepo } from "./inside-repo.ts";

let root: string;
let repo: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inside-repo-"));
  repo = join(root, "repo");
  await mkdir(join(repo, ".devcontainer"), { recursive: true });
  await mkdir(join(root, "outside"));
  await writeFile(join(repo, ".devcontainer", "Dockerfile"), "FROM x\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("a path inside the repository's checkout", () => {
  it("resolves a folder and a file under the checkout to their real paths", async () => {
    expect(await insideRepo(repo, ".devcontainer")).toMatchObject({ ok: true, rel: ".devcontainer" });
    expect(await insideRepo(repo, ".devcontainer/Dockerfile")).toMatchObject({ ok: true, rel: ".devcontainer/Dockerfile" });
    expect(await insideRepo(repo, ".")).toMatchObject({ ok: true, rel: "." });
  });

  it("refuses a path that climbs out through ..", async () => {
    expect(await insideRepo(repo, "../outside")).toMatchObject({ ok: false });
    expect(await insideRepo(repo, ".devcontainer/../../outside")).toMatchObject({ ok: false });
  });

  it("refuses an absolute path", async () => {
    expect(await insideRepo(repo, join(root, "outside"))).toMatchObject({ ok: false });
  });

  it("refuses a symlink that leads out of the checkout, and accepts one that stays in", async () => {
    await symlink(join(root, "outside"), join(repo, "escape"));
    await symlink(join(repo, ".devcontainer"), join(repo, "inner"));
    expect(await insideRepo(repo, "escape")).toMatchObject({ ok: false });
    expect(await insideRepo(repo, "inner")).toMatchObject({ ok: true, rel: ".devcontainer" });
  });

  it("refuses a path that is not there", async () => {
    expect(await insideRepo(repo, "nope")).toMatchObject({ ok: false });
  });
});
