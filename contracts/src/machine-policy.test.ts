import { describe, expect, it } from "vitest";

import { DEFAULT_MACHINE_POLICY, MachinePolicySchema, machinePolicyProblem } from "./machine-policy.ts";

describe("MachinePolicySchema", () => {
  it("an empty file is today's behaviour", () => {
    expect(MachinePolicySchema.parse({})).toEqual(DEFAULT_MACHINE_POLICY);
    expect(DEFAULT_MACHINE_POLICY).toEqual({
      runtime: { default: "runc", untrusted: "runc" },
      seccomp: "default",
      limits: { max_cpu: 128, max_memory_gb: 1024, max_pids: 1024 },
      egress: { deny: [], max_repo_hosts: 50, repo_hosts: "allow" },
      images: { repo_base: "allow", devcontainer: "allow" },
      cache: { split_by_trust: true },
      guard: { trusted: "log", untrusted: "log", block_severity: "high" },
      bash_sandbox: "off",
    });
  });

  it("takes the documented file and fills the rest from the defaults", () => {
    const parsed = MachinePolicySchema.parse({ runtime: { untrusted: "runsc" }, seccomp: "/etc/luna/seccomp.json", limits: { max_cpu: 4, max_memory_gb: 8 }, egress: { deny: ["*.pastebin.com"], repo_hosts: "deny" }, images: { repo_base: "deny" }, bash_sandbox: "on" });
    expect(parsed.runtime).toEqual({ default: "runc", untrusted: "runsc" });
    expect(parsed.seccomp).toBe("/etc/luna/seccomp.json");
    expect(parsed.limits).toEqual({ max_cpu: 4, max_memory_gb: 8, max_pids: 1024 });
    expect(parsed.egress).toEqual({ deny: ["*.pastebin.com"], max_repo_hosts: 50, repo_hosts: "deny" });
    expect(parsed.images).toEqual({ repo_base: "deny", devcontainer: "allow" });
    expect(parsed.bash_sandbox).toBe("on");
  });
});

describe("machinePolicyProblem", () => {
  it("is null for a valid policy", () => {
    expect(machinePolicyProblem({ limits: { max_cpu: 2 } })).toBeNull();
  });

  it("names an unknown key, at any depth", () => {
    expect(machinePolicyProblem({ limitz: {} })).toMatch(/limitz/);
    expect(machinePolicyProblem({ limits: { max_gpu: 1 } })).toMatch(/limits/);
    expect(machinePolicyProblem({ limits: { max_gpu: 1 } })).toMatch(/max_gpu/);
  });

  it("names a bad value's key", () => {
    expect(machinePolicyProblem({ runtime: { default: "kata" } })).toMatch(/^runtime\.default/);
    expect(machinePolicyProblem({ limits: { max_cpu: 0 } })).toMatch(/^limits\.max_cpu/);
    expect(machinePolicyProblem({ seccomp: "relative/profile.json" })).toMatch(/^seccomp/);
    expect(machinePolicyProblem({ egress: { deny: ["https://x.com/path"] } })).toMatch(/^egress\.deny\.0/);
    expect(machinePolicyProblem({ egress: { repo_hosts: "maybe" } })).toMatch(/^egress\.repo_hosts/);
    expect(machinePolicyProblem({ guard: { trusted: "warn" } })).toMatch(/^guard\.trusted/);
    expect(machinePolicyProblem({ guard: { untrusted: 1 } })).toMatch(/^guard\.untrusted/);
    expect(machinePolicyProblem({ guard: { block_severity: "severe" } })).toMatch(/^guard\.block_severity/);
  });

  it("takes a guard section and refuses an unknown key under it", () => {
    expect(MachinePolicySchema.parse({ guard: { untrusted: "block", block_severity: "medium" } }).guard).toEqual({ trusted: "log", untrusted: "block", block_severity: "medium" });
    expect(machinePolicyProblem({ guard: { mode: "block" } })).toMatch(/guard\.mode: unknown key/);
  });
});
