import { describe, expect, it } from "vitest";

import { RepoImageError, type ImageDocker, repoImages } from "./repo-images.ts";

const MACHINE = "hardness-runner:dev";
const digest = `sha256:${"b".repeat(64)}`;

function fakeDocker(over: Partial<ImageDocker> = {}) {
  const calls: string[] = [];
  const have = new Set<string>();
  const docker: ImageDocker = {
    layerKey: async () => "layer-1",
    checkBase: async (base, _signal?: AbortSignal) => (calls.push(`check ${base}`), { ok: true, digest }),
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
const approveAll = { isApproved: async () => true };
const make = (image: { base?: string | null } | undefined, docker: ImageDocker, approvals: { isApproved(repoPath: string, base: string): Promise<boolean> } = approveAll, extra: { now?: () => number } = {}) =>
  repoImages({ machineImage: MACHINE, imageOf: async () => image, slugOf: (p) => `slug-${p}`, docker, approvals, onEvent: (e) => events.push(e), ...extra });

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
    let clock = 0;
    const images = make({ base: "debian:12" }, docker, approveAll, { now: () => clock });
    const err = await images.ensure("/r").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoImageError);
    const reason = (err as RepoImageError).reason;
    expect(reason).toContain("real reason");
    expect(reason).not.toMatch(/[<>\n]/);
    expect(reason.length).toBeLessThan(1200);
    expect(JSON.stringify(events)).toContain("real reason");
    clock += 11 * 60_000;
    expect((await images.ensure("/r")).image).toMatch(/^hardness-runner-/);
  });

  it("reports each step as an event for the card that needed it: started, built, refused, failed", async () => {
    events.length = 0;
    const { docker } = fakeDocker();
    await make({ base: "debian:12" }, docker).ensure("/r", undefined, "card-1");
    expect(events).toMatchObject([
      { taskId: "card-1", repoPath: "/r", kind: "image.build_started", base: "debian:12" },
      { taskId: "card-1", kind: "image.built", base: "debian:12", image: expect.stringMatching(/^hardness-runner-/) },
    ]);
    events.length = 0;
    await make({ base: "alpine:3" }, fakeDocker({ checkBase: async () => ({ ok: false, reason: "no git" }) }).docker).ensure("/r", undefined, "card-2");
    expect(events).toMatchObject([{ taskId: "card-2", kind: "image.refused", reason: "no git" }]);
    events.length = 0;
    await make({ base: "debian:12" }, fakeDocker({ build: async () => ({ ok: false, log: "bad" }) }).docker).ensure("/r", undefined, "card-3").catch(() => undefined);
    expect(events.map((e) => (e as { kind: string }).kind)).toEqual(["image.build_started", "image.build_failed"]);
  });

  it("keeps what it knows of a repository's image for the board: its tag, when it was built, the last failure", async () => {
    const { docker } = fakeDocker();
    const images = make({ base: "debian:12" }, docker);
    expect(images.status("/r")).toBeNull();
    const { image } = await images.ensure("/r");
    expect(images.status("/r")).toMatchObject({ image, builtAt: expect.stringMatching(/^\d{4}-/), lastFailure: null });
    const failing = make({ base: "debian:13" }, fakeDocker({ build: async () => ({ ok: false, log: "no space left" }) }).docker);
    await failing.ensure("/f").catch(() => undefined);
    expect(failing.status("/f")).toMatchObject({ lastFailure: expect.stringContaining("no space left") });
  });

  it("never pulls or builds a base nobody approved for the repository, runs on the machine's image, and says once that it is waiting", async () => {
    events.length = 0;
    const { docker, calls } = fakeDocker();
    const approved = new Set<string>();
    const images = make({ base: "attacker/x:1" }, docker, { isApproved: async (r, b) => approved.has(`${r}|${b}`) });
    expect((await images.ensure("/r", undefined, "c1")).image).toBe(MACHINE);
    expect((await images.ensure("/r", undefined, "c2")).image).toBe(MACHINE);
    expect(calls).toEqual([]);
    expect(events.filter((e) => (e as { kind: string }).kind === "image.base_pending")).toHaveLength(1);
    expect(await images.pending("/r")).toBe("attacker/x:1");
    approved.add("/r|attacker/x:1");
    expect(await images.pending("/r")).toBeNull();
    expect((await images.ensure("/r")).image).toMatch(/^hardness-runner-slug-/);
    expect(calls.some((c) => c.startsWith("build"))).toBe(true);
  });

  it("needs a new approval when the reference changes", async () => {
    const { docker, calls } = fakeDocker();
    const approved = new Set(["/r|debian:12"]);
    const isApproved = async (r: string, b: string) => approved.has(`${r}|${b}`);
    expect((await make({ base: "debian:12" }, docker, { isApproved }).ensure("/r")).image).toMatch(/^hardness-runner-slug/);
    calls.length = 0;
    expect((await make({ base: "debian:13" }, docker, { isApproved }).ensure("/r")).image).toBe(MACHINE);
    expect(calls).toEqual([]);
  });

  it("does not pull again for a base that just failed or was refused, until the memory runs out or the repository is approved again", async () => {
    let clock = 0;
    const { docker, calls } = fakeDocker({ checkBase: async (b) => (calls.push(`check ${b}`), { ok: false, reason: "unreachable registry" }) });
    const images = make({ base: "debian:12" }, docker, approveAll, { now: () => clock });
    await images.ensure("/r");
    await images.ensure("/r");
    await images.ensure("/r");
    expect(calls).toEqual(["check debian:12"]);
    clock += 11 * 60_000;
    await images.ensure("/r");
    expect(calls).toHaveLength(2);
    images.approved("/r");
    await images.ensure("/r");
    expect(calls).toHaveLength(3);
    const fail = fakeDocker({ build: async () => ({ ok: false, log: "bad" }) });
    const f = make({ base: "debian:12" }, fail.docker);
    await f.ensure("/r").catch(() => undefined);
    const again = await f.ensure("/r").catch((e: unknown) => e);
    expect(again).toBeInstanceOf(RepoImageError);
    expect(fail.calls.filter((c) => c.startsWith("check"))).toHaveLength(1);
  });

  it("stops waiting when the caller is aborted, and passes the signal to the check", async () => {
    let seen: AbortSignal | undefined;
    const { docker } = fakeDocker({ checkBase: (_b, signal) => ((seen = signal), new Promise(() => {})) });
    const ctl = new AbortController();
    const waiting = make({ base: "debian:12" }, docker).ensure("/r", ctl.signal).catch((e: unknown) => e);
    setTimeout(() => ctl.abort(), 10);
    const err = (await waiting) as Error;
    expect(err.name).toBe("AbortError");
    expect(seen).toBeDefined();
  });

  it("does not hold one repository's slow base up behind another's", async () => {
    const { docker } = fakeDocker({ checkBase: (b) => (b === "slow:1" ? new Promise(() => {}) : Promise.resolve({ ok: true as const, digest })) });
    const imageOf = async (r: string) => ({ base: r === "/a" ? "slow:1" : "fast:1" });
    const images = repoImages({ machineImage: MACHINE, imageOf, slugOf: (p) => `slug${p.replace("/", "-")}`, docker, approvals: approveAll });
    void images.ensure("/a").catch(() => undefined);
    const b = await Promise.race([images.ensure("/b"), new Promise<"late">((r) => setTimeout(() => r("late"), 500))]);
    expect(b).not.toBe("late");
  });
});
