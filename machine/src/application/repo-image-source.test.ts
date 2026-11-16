import { posix } from "node:path";
import { DEFAULT_MACHINE_POLICY, type MachinePolicy } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { repoImageSource } from "./repo-image-source.ts";

const policyOf = (base: string | null, bounds?: { image: string[]; egress: string[] }) => async () => ({ factory: { sandbox: { image: { base } } }, ...(bounds ? { bounds } : {}) });
const files = (map: Record<string, string>) => async (path: string) => map[path] ?? null;
const machine = (images: Partial<MachinePolicy["images"]> = {}): MachinePolicy => ({ ...DEFAULT_MACHINE_POLICY, images: { ...DEFAULT_MACHINE_POLICY.images, ...images } });

describe("the repository's image source", () => {
  it("reads the devcontainer image from the user's checkout when luna.yaml names no base", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine(), read: files({ "/repo/.devcontainer/devcontainer.json": '{ // c\n "image": "node:22",\n "containerEnv": {"A":"1"},\n}' }) });
    expect(await source.for("/repo")).toMatchObject({ base: "node:22", origin: "devcontainer", containerEnv: { A: "1" } });
  });

  it("falls back to .devcontainer.json at the root", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine(), read: files({ "/repo/.devcontainer.json": '{"image":"go:1"}' }) });
    expect(await source.for("/repo")).toMatchObject({ base: "go:1", origin: "devcontainer" });
  });

  it("lets luna.yaml's base win over the devcontainer image", async () => {
    const source = repoImageSource({ policies: { for: policyOf("python:3.13") }, machinePolicy: machine(), read: files({ "/repo/.devcontainer.json": '{"image":"go:1"}' }) });
    expect(await source.for("/repo")).toMatchObject({ base: "python:3.13", origin: "luna.yaml" });
  });

  it("reads nothing when the machine's policy turns the devcontainer off", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine({ devcontainer: "deny" }), read: files({ "/repo/.devcontainer.json": '{"image":"go:1","containerEnv":{"A":"1"}}' }) });
    expect(await source.for("/repo")).toEqual({ base: null, origin: null, containerEnv: {}, notes: [], bounds: [], dockerfile: null });
  });

  it("refuses the devcontainer image when the policy refuses a repo's base, and says so", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine({ repo_base: "deny" }), read: files({ "/repo/.devcontainer.json": '{"image":"go:1"}' }) });
    const got = await source.for("/repo");
    expect(got.base).toBeNull();
    expect(got.bounds[0]).toContain("images.repo_base: deny");
  });

  it("lists what it does not apply", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine(), read: files({ "/repo/.devcontainer.json": '{"features":{}}' }) });
    const got = await source.for("/repo");
    expect(got.base).toBeNull();
    expect(got.notes.some((n) => n.includes("features: not applied"))).toBe(true);
  });

  describe("build.dockerfile", () => {
    const inside = async (repo: string, rel: string) => {
      const norm = posix.normalize(rel);
      return norm === ".." || norm.startsWith("../") ? { ok: false as const, reason: "the path leaves the repository (through .. or a link)" } : { ok: true as const, abs: `${repo}/${norm}`, rel: norm };
    };
    const dc = (extra = "") => `{"build":{"dockerfile":"Dockerfile"${extra}}}`;
    const make = (map: Record<string, string>, over: { luna?: string | null; m?: Partial<MachinePolicy["images"]> } = {}) =>
      repoImageSource({ policies: { for: policyOf(over.luna ?? null) }, machinePolicy: machine(over.m), read: files(map), inside });

    it("reads the Dockerfile beside devcontainer.json, the context defaulting to that folder", async () => {
      const got = await make({ "/repo/.devcontainer/devcontainer.json": dc(',"args":{"B":"2","A":"1"}'), "/repo/.devcontainer/Dockerfile": "FROM debian:12\n" }).for("/repo");
      expect(got.base).toBeNull();
      expect(got.dockerfile).toMatchObject({ path: ".devcontainer/Dockerfile", contextRel: ".devcontainer", context: "/repo/.devcontainer", args: { A: "1", B: "2" }, text: "FROM debian:12\n" });
      expect(got.dockerfile!.key).toMatch(/^dockerfile=sha256:[0-9a-f]{64}$/);
    });

    it("takes build.context relative to devcontainer.json", async () => {
      const got = await make({ "/repo/.devcontainer/devcontainer.json": dc(',"context":".."'), "/repo/.devcontainer/Dockerfile": "FROM x\n" }).for("/repo");
      expect(got.dockerfile).toMatchObject({ contextRel: ".", path: ".devcontainer/Dockerfile" });
    });

    it("gives a new key when the Dockerfile changes", async () => {
      const a = await make({ "/repo/.devcontainer.json": dc(), "/repo/Dockerfile": "FROM a\n" }).for("/repo");
      const b = await make({ "/repo/.devcontainer.json": dc(), "/repo/Dockerfile": "FROM b\n" }).for("/repo");
      expect(a.dockerfile!.key).not.toBe(b.dockerfile!.key);
    });

    it("lets luna.yaml's base and the devcontainer image win, with a note", async () => {
      const luna = await make({ "/repo/.devcontainer.json": dc(), "/repo/Dockerfile": "FROM a\n" }, { luna: "python:3.13" }).for("/repo");
      expect(luna).toMatchObject({ base: "python:3.13", dockerfile: null });
      expect(luna.notes.some((n) => n.includes("build.dockerfile: not applied") && n.includes("sandbox.image.base"))).toBe(true);
      const both = await make({ "/repo/.devcontainer.json": '{"image":"go:1","build":{"dockerfile":"Dockerfile"}}', "/repo/Dockerfile": "FROM a\n" }).for("/repo");
      expect(both).toMatchObject({ base: "go:1", dockerfile: null });
      expect(both.notes.some((n) => n.includes("build.dockerfile: not applied") && n.includes("devcontainer image"))).toBe(true);
    });

    it("is refused by images.repo_base: deny, and off with images.devcontainer: deny", async () => {
      const f = { "/repo/.devcontainer.json": dc(), "/repo/Dockerfile": "FROM a\n" };
      const denied = await make(f, { m: { repo_base: "deny" } }).for("/repo");
      expect(denied.dockerfile).toBeNull();
      expect(denied.bounds[0]).toContain("images.repo_base: deny");
      expect((await make(f, { m: { devcontainer: "deny" } }).for("/repo")).dockerfile).toBeNull();
    });

    it("refuses a context that leaves the checkout", async () => {
      const got = await make({ "/repo/.devcontainer/devcontainer.json": dc(',"context":"../.."'), "/repo/.devcontainer/Dockerfile": "FROM x\n" }).for("/repo");
      expect(got.dockerfile).toBeNull();
      expect(got.notes.some((n) => n.includes("build.dockerfile: not applied") && n.includes("leaves the repository"))).toBe(true);
    });

    it("says so when the Dockerfile cannot be read", async () => {
      const got = await make({ "/repo/.devcontainer.json": dc() }).for("/repo");
      expect(got.dockerfile).toBeNull();
      expect(got.notes.some((n) => n.includes("build.dockerfile: not applied") && n.includes("could not be read"))).toBe(true);
    });
  });

  it("says a file that does not parse gives nothing", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine(), read: files({ "/repo/.devcontainer.json": "{ nope" }) });
    const got = await source.for("/repo");
    expect(got.base).toBeNull();
    expect(got.notes[0]).toContain("not applied");
  });
});
