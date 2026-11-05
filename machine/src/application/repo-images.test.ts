import { describe, expect, it } from "vitest";

import { RepoImageError, type ImageDocker, repoImages } from "./repo-images.ts";

const MACHINE = "hardness-runner:dev";
const digest = `sha256:${"b".repeat(64)}`;

function fakeDocker(over: Partial<ImageDocker> = {}) {
  const calls: string[] = [];
  const have = new Set<string>();
  const docker: ImageDocker = {
    layerKey: async () => "layer-1",
    checkBase: async (base) => (calls.push(`check ${base}`), { ok: true, digest }),
    exists: async (tag) => have.has(tag),
    build: async (spec) => {
      calls.push(`build ${spec.tag} from ${spec.base}`);
      await new Promise((r) => setTimeout(r, 5));
      have.add(spec.tag);
      return { ok: true };
    },
    ...over,
  };
  return { docker, calls };
}
const events: unknown[] = [];
const make = (image: { base?: string | null } | undefined, docker: ImageDocker) =>
  repoImages({ machineImage: MACHINE, imageOf: async () => image, slugOf: (p) => `slug-${p}`, docker, onEvent: (e) => events.push(e) });

describe("the image a repository's stages run in", () => {
  it("is the machine's image when the repository names no base, and docker is never asked", async () => {
    const { docker, calls } = fakeDocker();
    expect((await make(undefined, docker).ensure("/r")).image).toBe(MACHINE);
    expect(calls).toEqual([]);
  });

  it("is the repository's own image, built once from its base and reused after", async () => {
    const { docker, calls } = fakeDocker();
    const images = make({ base: "python:3.13-slim" }, docker);
    const first = await images.ensure("/r");
    expect(first.image).toMatch(/^hardness-runner-slug-\/r:[0-9a-f]{16}$|^hardness-runner-slug-.*:[0-9a-f]{16}$/);
    expect((await images.ensure("/r")).image).toBe(first.image);
    expect(calls.filter((c) => c.startsWith("build"))).toHaveLength(1);
    expect(calls[0]).toBe("check python:3.13-slim");
  });

  it("builds one image at a time", async () => {
    let running = 0;
    let most = 0;
    const { docker } = fakeDocker({
      build: async () => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return { ok: true };
      },
    });
    const a = make({ base: "debian:12" }, docker);
    await Promise.all([a.ensure("/a"), a.ensure("/b"), a.ensure("/c")]);
    expect(most).toBe(1);
  });

  it("refuses a base that fails the check, says why, and the repository runs on the machine's image", async () => {
    events.length = 0;
    const { docker } = fakeDocker({ checkBase: async () => ({ ok: false, reason: "alpine is musl, not glibc" }) });
    expect((await make({ base: "alpine:3" }, docker).ensure("/r")).image).toBe(MACHINE);
    expect(JSON.stringify(events)).toContain("alpine is musl");
  });

  it("refuses a malformed base before docker hears of it", async () => {
    events.length = 0;
    const { docker, calls } = fakeDocker();
    expect((await make({ base: "--privileged" }, docker).ensure("/r")).image).toBe(MACHINE);
    expect(calls).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("fails with the tail of the build log, flattened and capped, and the next card tries again", async () => {
    events.length = 0;
    let n = 0;
    const log = `${"noise\n".repeat(500)}step 3 failed <b>@alice</b>\nreal reason`;
    const { docker, calls } = fakeDocker({ build: async (s) => (++n === 1 ? { ok: false, log } : (calls.push(`build ${s.tag}`), { ok: true })) });
    const images = make({ base: "debian:12" }, docker);
    const err = await images.ensure("/r").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoImageError);
    const reason = (err as RepoImageError).reason;
    expect(reason).toContain("real reason");
    expect(reason).not.toMatch(/[<>\n]/);
    expect(reason.length).toBeLessThan(1200);
    expect(JSON.stringify(events)).toContain("real reason");
    expect((await images.ensure("/r")).image).toMatch(/^hardness-runner-/);
  });

  it("remembers the image of a repository by its work folders' parent, for the checks runner", async () => {
    const { docker } = fakeDocker();
    const images = make({ base: "debian:12" }, docker);
    const { image } = await images.ensure("/r");
    expect(images.knownFor("slug-/r")).toBe(image);
    expect(images.knownFor("other")).toBeNull();
  });
});
