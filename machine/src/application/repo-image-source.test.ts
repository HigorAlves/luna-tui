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
    expect(await source.for("/repo")).toEqual({ base: null, origin: null, containerEnv: {}, notes: [], bounds: [] });
  });

  it("refuses the devcontainer image when the policy refuses a repo's base, and says so", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine({ repo_base: "deny" }), read: files({ "/repo/.devcontainer.json": '{"image":"go:1"}' }) });
    const got = await source.for("/repo");
    expect(got.base).toBeNull();
    expect(got.bounds[0]).toContain("images.repo_base: deny");
  });

  it("lists what it does not apply, and why a Dockerfile build waits", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine(), read: files({ "/repo/.devcontainer.json": '{"build":{"dockerfile":"Dockerfile"},"features":{}}' }) });
    const got = await source.for("/repo");
    expect(got.base).toBeNull();
    expect(got.notes.some((n) => n.includes("features: not applied"))).toBe(true);
    expect(got.notes.some((n) => n.includes("build.dockerfile: not applied"))).toBe(true);
  });

  it("says a file that does not parse gives nothing", async () => {
    const source = repoImageSource({ policies: { for: policyOf(null) }, machinePolicy: machine(), read: files({ "/repo/.devcontainer.json": "{ nope" }) });
    const got = await source.for("/repo");
    expect(got.base).toBeNull();
    expect(got.notes[0]).toContain("not applied");
  });
});
