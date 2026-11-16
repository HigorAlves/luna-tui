import { DEFAULT_MACHINE_POLICY, FACTORY_DEFAULTS, MachinePolicySchema } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { boundSandbox, baseRefusal, sandboxSizeOf } from "./sandbox-bounds.ts";

const sandbox = (over: Partial<(typeof FACTORY_DEFAULTS)["sandbox"]> = {}) => ({ ...structuredClone(FACTORY_DEFAULTS.sandbox), ...over });
const policy = (input: unknown) => MachinePolicySchema.parse(input);

describe("boundSandbox", () => {
  it("changes nothing under the default policy", () => {
    const repo = sandbox({ cpu: 16, memory_gb: 64, egress: { allow: ["a.example.com", "*.b.example.com"], registries: "always" }, image: { base: "node:22" } });
    const out = boundSandbox(repo, DEFAULT_MACHINE_POLICY);
    expect(out.sandbox).toEqual(repo);
    expect(out.bounds).toEqual({ notes: [], egress: [], image: [], seccomp: null, runtime: { default: "runc", untrusted: "runc" }, maxPids: 1024, splitCache: true });
  });

  it("caps cpu and memory at the policy's maximums, with a note each", () => {
    const out = boundSandbox(sandbox({ cpu: 16, memory_gb: 64 }), policy({ limits: { max_cpu: 4, max_memory_gb: 8 } }));
    expect(out.sandbox).toMatchObject({ cpu: 4, memory_gb: 8 });
    expect(out.bounds.notes).toEqual([
      "sandbox.cpu 16 is capped at 4 by the machine's sandbox policy (limits.max_cpu)",
      "sandbox.memory_gb 64 is capped at 8 by the machine's sandbox policy (limits.max_memory_gb)",
    ]);
  });

  it("leaves a request within the maximum alone, with no note", () => {
    const out = boundSandbox(sandbox({ cpu: 2, memory_gb: 4 }), policy({ limits: { max_cpu: 4, max_memory_gb: 8 } }));
    expect(out.sandbox).toMatchObject({ cpu: 2, memory_gb: 4 });
    expect(out.bounds.notes).toEqual([]);
  });

  it("drops repo egress hosts matching egress.deny, naming each", () => {
    const repo = sandbox({ egress: { allow: ["files.pastebin.com", "pastebin.com", "ok.example.com", "*.pastebin.com:8443", "*.cdn.pastebin.com", "notpastebin.com"], registries: "always" } });
    const out = boundSandbox(repo, policy({ egress: { deny: ["*.pastebin.com", "pastebin.com"] } }));
    expect(out.sandbox.egress.allow).toEqual(["ok.example.com", "notpastebin.com"]);
    expect(out.bounds.egress).toHaveLength(4);
    expect(out.bounds.egress[0]).toBe('sandbox.egress.allow: "files.pastebin.com" dropped, it matches egress.deny "*.pastebin.com" in the machine\'s sandbox policy');
  });

  describe("a repo wildcard against a narrower deny", () => {
    const bound = (allow: string[], deny: string[]) => boundSandbox(sandbox({ egress: { allow, registries: "always" } }), policy({ egress: { deny } })).sandbox.egress.allow;
    it("drops a wildcard over a denied exact host", () => expect(bound(["*.githubusercontent.com", "ok.example.com"], ["gist.githubusercontent.com"])).toEqual(["ok.example.com"]));
    it("drops a wildcard over a denied exact host one level below", () => expect(bound(["*.example.com"], ["a.b.example.com"])).toEqual([]));
    it("drops a wildcard over a denied wildcard", () => expect(bound(["*.githubusercontent.com"], ["*.gist.githubusercontent.com"])).toEqual([]));
    it("drops a wildcard whose suffix is the denied host itself", () => expect(bound(["*.pastebin.com"], ["pastebin.com"])).toEqual([]));
    it("keeps a wildcard the deny does not sit under", () => expect(bound(["*.gist.example.com", "*.example.org"], ["example.com", "gist.example.org.evil.com"])).toEqual(["*.gist.example.com", "*.example.org"]));
    it("compares case-insensitively", () => expect(bound(["*.GitHubUserContent.com"], ["Gist.githubusercontent.COM"])).toEqual([]));
    it("ignores a trailing dot on the repo's entry", () => expect(bound(["*.githubusercontent.com.", "pastebin.com."], ["gist.githubusercontent.com", "pastebin.com"])).toEqual([]));
    it("ignores a port on either side", () => expect(bound(["*.githubusercontent.com:8443"], ["gist.githubusercontent.com"])).toEqual([]));
    it("ignores a port on the deny", () => expect(bound(["*.githubusercontent.com"], ["gist.githubusercontent.com:443"])).toEqual([]));
  });

  it("repo_hosts: deny drops every repo host, with one reason", () => {
    const out = boundSandbox(sandbox({ egress: { allow: ["a.example.com", "b.example.com"], registries: "install" } }), policy({ egress: { repo_hosts: "deny" } }));
    expect(out.sandbox.egress).toEqual({ allow: [], registries: "install" });
    expect(out.bounds.egress).toEqual(["sandbox.egress.allow: 2 hosts dropped, the machine's sandbox policy allows no repo hosts (egress.repo_hosts: deny)"]);
  });

  it("keeps at most max_repo_hosts, first listed first", () => {
    const out = boundSandbox(sandbox({ egress: { allow: ["a.example.com", "b.example.com", "c.example.com"], registries: "always" } }), policy({ egress: { max_repo_hosts: 2 } }));
    expect(out.sandbox.egress.allow).toEqual(["a.example.com", "b.example.com"]);
    expect(out.bounds.egress).toEqual(["sandbox.egress.allow: 1 host dropped past egress.max_repo_hosts 2 in the machine's sandbox policy"]);
  });

  it("images.repo_base: deny removes the base, with a reason", () => {
    const out = boundSandbox(sandbox({ image: { base: "node:22" } }), policy({ images: { repo_base: "deny" } }));
    expect(out.sandbox.image.base).toBeNull();
    expect(out.bounds.image).toEqual(['sandbox.image.base "node:22" is refused by the machine\'s sandbox policy (images.repo_base: deny); the machine\'s image runs']);
    expect(boundSandbox(sandbox(), policy({ images: { repo_base: "deny" } })).bounds.image).toEqual([]);
  });

  it("carries a seccomp profile path, not the word default", () => {
    expect(boundSandbox(sandbox(), policy({ seccomp: "/etc/luna/seccomp.json" })).bounds.seccomp).toBe("/etc/luna/seccomp.json");
    expect(boundSandbox(sandbox(), policy({ seccomp: "default" })).bounds.seccomp).toBeNull();
  });

  it("does not mutate its input", () => {
    const repo = sandbox({ cpu: 16 });
    boundSandbox(repo, policy({ limits: { max_cpu: 4 } }));
    expect(repo.cpu).toBe(16);
  });
});

describe("sandboxSizeOf", () => {
  const base = { notes: [], egress: [], image: [], seccomp: null, runtime: { default: "runc" as const, untrusted: "runc" as const }, maxPids: 1024, splitCache: true };
  it("is the bounded cpu and memory, plus the seccomp path when the policy names one", () => {
    const plain = { factory: { sandbox: sandbox({ cpu: 3, memory_gb: 6 }) } };
    expect(sandboxSizeOf(plain)).toEqual({ cpu: 3, memoryGb: 6, pids: 1024, cacheTrust: "trusted" });
    expect(sandboxSizeOf({ ...plain, bounds: { ...base, seccomp: "/p.json" } })).toEqual({ cpu: 3, memoryGb: 6, pids: 1024, cacheTrust: "trusted", seccomp: "/p.json" });
  });

  it("carries the policy's process limit, and the runtime and cache split of the card's trust", () => {
    const plain = { factory: { sandbox: sandbox({ cpu: 3, memory_gb: 6 }) } };
    const bounds = { ...base, maxPids: 256, runtime: { default: "runc" as const, untrusted: "runsc" as const } };
    expect(sandboxSizeOf({ ...plain, bounds })).toMatchObject({ pids: 256, cacheTrust: "trusted" });
    expect(sandboxSizeOf({ ...plain, bounds }).runtime).toBeUndefined();
    expect(sandboxSizeOf({ ...plain, bounds }, "untrusted")).toMatchObject({ pids: 256, runtime: "runsc", cacheTrust: "untrusted" });
    expect(sandboxSizeOf({ ...plain, bounds: { ...bounds, splitCache: false } }, "untrusted").cacheTrust).toBe("trusted");
    expect(sandboxSizeOf({ ...plain, bounds: { ...bounds, runtime: { default: "runsc", untrusted: "runc" } } }).runtime).toBe("runsc");
  });

  it("takes the process limit, the split and the runtimes from the machine policy", () => {
    const out = boundSandbox(sandbox(), policy({ limits: { max_pids: 200 }, cache: { split_by_trust: false }, runtime: { untrusted: "runsc" } })).bounds;
    expect(out).toMatchObject({ maxPids: 200, splitCache: false, runtime: { default: "runc", untrusted: "runsc" } });
  });
});

describe("baseRefusal", () => {
  it("is the reason when the policy refused the repo's base, so approving one is refused too, and null otherwise", () => {
    const refused = boundSandbox(sandbox({ image: { base: "node:22" } }), policy({ images: { repo_base: "deny" } }));
    expect(baseRefusal(refused)).toMatch(/images\.repo_base: deny/);
    expect(baseRefusal(boundSandbox(sandbox({ image: { base: "node:22" } }), DEFAULT_MACHINE_POLICY))).toBeNull();
    expect(baseRefusal({ bounds: undefined })).toBeNull();
  });
});
