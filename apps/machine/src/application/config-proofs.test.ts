import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MachinePolicySchema } from "@hardness/contracts";

import { validateLunaConfig } from "../domain/luna-config.ts";
import { sandboxSizeOf } from "../domain/sandbox-bounds.ts";
import { ConfigProofError, ConfigProofs, type ProofJob } from "./config-proofs.ts";
import { type AppProof, type ProofExec, type ProofRig, boundedProof, proofAppDeps } from "./config-proof.ts";

/** A rig whose clone is a folder beside the repository, and whose app answers as told. */
function fakeRig(app: AppProof = { ok: true, seconds: 4, refused: [] }) {
  const clones: string[] = [];
  const closed: string[] = [];
  const apps: Array<{ workspace: string; command: string | null | undefined }> = [];
  const rig: ProofRig = {
    workspace: async (repoPath) => {
      const path = `${repoPath}-proof-${clones.length}`;
      clones.push(path);
      return { path, close: async () => void closed.push(path) };
    },
    app: async ({ workspace, config }) => {
      apps.push({ workspace, command: config.verify?.e2e?.start?.command });
      return app;
    },
  };
  return { rig, clones, closed, apps };
}

const repoWith = (text: string | null): string => {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  if (text !== null) writeFileSync(join(dir, "luna.yaml"), text);
  return dir;
};

async function settled(proofs: ConfigProofs, id: string): Promise<ProofJob> {
  for (let i = 0; i < 200; i++) {
    const job = proofs.get(id)!;
    if (job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("still running");
}

describe("boundedProof: the policy the proof's app runs on", () => {
  it("caps a proposal that asks 128 CPUs, drops its denied host, and carries the bounds", () => {
    const file = validateLunaConfig({ sandbox: { cpu: 128, memory_gb: 512, egress: { allow: ["pastebin.com", "ok.example.com"] } } });
    const out = boundedProof(file, MachinePolicySchema.parse({ limits: { max_cpu: 4, max_memory_gb: 8 }, egress: { deny: ["pastebin.com"] } }));
    expect(out.policy.factory.sandbox).toMatchObject({ cpu: 4, memory_gb: 8 });
    expect(out.allow).toEqual(["ok.example.com"]);
    expect(out.policy.bounds?.notes).toHaveLength(2);
    expect(out.reasons.some((line) => line.includes('"pastebin.com" dropped'))).toBe(true);
    expect(sandboxSizeOf(out.policy)).toMatchObject({ cpu: 4, memoryGb: 8 });
  });
});

describe("proofAppDeps: the app the proof starts", () => {
  it("runs on the bounded policy and the bounded egress list: a proposal asking 128 CPUs and a denied host gets neither", async () => {
    const file = validateLunaConfig({ sandbox: { cpu: 128, egress: { allow: ["pastebin.com", "ok.example.com"] } } });
    const base = { policies: { for: async () => { throw new Error("the repo's own policy is not the proof's"); } }, egress: { for: async () => ({ allow: ["github.com:443"], allowPrivate: [], proxyImage: "machine:dev" }) } };
    const deps = proofAppDeps(base as never, file, MachinePolicySchema.parse({ limits: { max_cpu: 4 }, egress: { deny: ["pastebin.com"] } }));
    expect(sandboxSizeOf(await deps.policies.for("/r")).cpu).toBe(4);
    expect((await deps.egress!.for({ repoPath: "/r", kind: "check" })).allow).toEqual(["github.com:443", "ok.example.com"]);
  });

  it("keeps the proof's own list as it is without a machine policy", async () => {
    const file = validateLunaConfig({ sandbox: { egress: { allow: ["pastebin.com"] } } });
    const base = { policies: { for: async () => ({}) }, egress: { for: async () => ({ allow: [], allowPrivate: [], proxyImage: "m" }) } };
    expect((await proofAppDeps(base as never, file, undefined).egress!.for({ repoPath: "/r", kind: "check" })).allow).toEqual(["pastebin.com"]);
  });
});

describe("ConfigProofs: the setup skill's proof of a repository's own luna.yaml", () => {
  it("runs every check of the file once, with its services and egress list, and suggests the refused hosts as allow entries", async () => {
    const repo = repoWith(["checks:", "  - { name: unit, run: pnpm test }", "  - { name: lint, run: pnpm lint, cwd: web }", "services:", "  db: { image: postgres:16 }", "sandbox:", "  egress:", "    allow: [index.crates.io]"].join("\n"));
    const exec = vi.fn<ProofExec>(async (_c, args) =>
      args.join(" ").includes("lint") ? { code: 1, stdout: "", stderr: "fetch failed", blocked: [{ host: "fonts.gstatic.com", port: 443, reason: "not_listed" }] } : { code: 0, stdout: "ok", stderr: "" },
    );
    const { rig, clones, closed } = fakeRig();
    const proofs = new ConfigProofs({ exec, rig, gitIdentity: async () => ({ name: "Ada", email: "a@x.dev" }) });
    const started = await proofs.start(repo);
    expect(started.state).toBe("running");
    const job = await settled(proofs, started.id);
    expect(job).toMatchObject({ state: "done", check: { ok: true }, suggestedAllow: ["fonts.gstatic.com"], proof: { proof: [{ name: "unit", ok: true }, { name: "lint", ok: false }], refused: ["fonts.gstatic.com:443"] } });
    // In a throwaway clone, never the checkout itself (a check's install wrote Linux binaries into one), and the clone is removed after.
    expect(exec.mock.calls.map((c) => c[2].cwd)).toEqual([clones[0], clones[0]]);
    expect(exec.mock.calls[0]![2]).toMatchObject({ repoPath: repo, services: { db: { image: "postgres:16" } }, egressAllow: ["index.crates.io"], env: expect.objectContaining({ GIT_AUTHOR_NAME: "Ada", HARDNESS_STAGE: "setup" }) });
    expect(closed).toEqual(clones);
    // No start command in the file: no app to prove.
    expect(job).toMatchObject({ proof: { app: null } });
  });

  it("holds the file's egress list within the machine's sandbox policy, and says what it dropped", async () => {
    const repo = repoWith(["checks:", "  - { name: unit, run: pnpm test }", "sandbox:", "  egress:", "    allow: [pastebin.com, index.crates.io]"].join("\n"));
    const exec = vi.fn<ProofExec>(async () => ({ code: 0, stdout: "ok", stderr: "" }));
    const proofs = new ConfigProofs({ exec, rig: fakeRig().rig, gitIdentity: async () => null, machinePolicy: MachinePolicySchema.parse({ egress: { deny: ["pastebin.com"] } }) });
    const job = await settled(proofs, (await proofs.start(repo)).id);
    expect(exec.mock.calls[0]![2]).toMatchObject({ egressAllow: ["index.crates.io"] });
    expect(job).toMatchObject({ proof: { bounds: ['sandbox.egress.allow: "pastebin.com" dropped, it matches egress.deny "pastebin.com" in the machine\'s sandbox policy'] } });
  });

  it("runs nothing for a file the machine cannot read, and says why", async () => {
    const exec = vi.fn<ProofExec>();
    const proofs = new ConfigProofs({ exec, rig: fakeRig().rig, gitIdentity: async () => null });
    const job = await settled(proofs, (await proofs.start(repoWith("policy:\n  qa: sometimes\n"))).id);
    expect(job).toMatchObject({ state: "done", check: { ok: false, problems: [expect.stringContaining("policy.qa")] }, proof: null });
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails a repository with no luna.yaml, refuses a relative or missing path, and runs one proof per repository at a time", async () => {
    const exec = vi.fn<ProofExec>(async () => new Promise(() => {}));
    const proofs = new ConfigProofs({ exec, rig: fakeRig().rig, gitIdentity: async () => null });
    expect(await settled(proofs, (await proofs.start(repoWith(null))).id)).toMatchObject({ state: "failed", error: expect.stringContaining("no readable luna.yaml") });
    await expect(proofs.start("relative/repo")).rejects.toBeInstanceOf(ConfigProofError);
    await expect(proofs.start("/no/such/repo")).rejects.toBeInstanceOf(ConfigProofError);
    const repo = repoWith("checks:\n  - { name: unit, run: pnpm test }\n");
    const first = await proofs.start(repo);
    expect((await proofs.start(repo)).id).toBe(first.id);
  });

  it("proves the app start in the same clone after the checks, and adds what its proxy refused to the suggestions", async () => {
    const repo = repoWith(["checks:", "  - { name: unit, run: pnpm test }", "verify:", "  e2e:", "    start: { command: \"pnpm dev --hostname 0.0.0.0\", port: 3000 }"].join("\n"));
    const { rig, clones, closed, apps } = fakeRig({ ok: false, seconds: 120, reason: "the app did not answer / within 120 s", logTail: "Error: getaddrinfo ENOTFOUND fonts.googleapis.com", refused: ["fonts.googleapis.com:443"] });
    const proofs = new ConfigProofs({ exec: async () => ({ code: 0, stdout: "ok", stderr: "" }), rig, gitIdentity: async () => null });
    const job = await settled(proofs, (await proofs.start(repo)).id);
    expect(apps).toEqual([{ workspace: clones[0], command: "pnpm dev --hostname 0.0.0.0" }]);
    expect(job).toMatchObject({ state: "done", proof: { app: { ok: false, reason: expect.stringContaining("did not answer"), logTail: expect.stringContaining("ENOTFOUND") }, refused: ["fonts.googleapis.com:443"] }, suggestedAllow: ["fonts.googleapis.com"] });
    expect(closed).toEqual(clones);
  });

  it("removes the clone even when a check throws, and reports the throw as that check's failure", async () => {
    const repo = repoWith("checks:\n  - { name: unit, run: pnpm test }\n  - { name: lint, run: pnpm lint }\n");
    const { rig, clones, closed } = fakeRig();
    const exec = vi.fn<ProofExec>(async (_c, args) => {
      if (args.join(" ").includes("test")) throw new Error("the install failed: pnpm install exited 1");
      return { code: 0, stdout: "ok", stderr: "" };
    });
    const proofs = new ConfigProofs({ exec, rig, gitIdentity: async () => null });
    const job = await settled(proofs, (await proofs.start(repo)).id);
    expect(job).toMatchObject({ state: "done", proof: { proof: [{ name: "unit", ok: false, tail: expect.stringContaining("install failed") }, { name: "lint", ok: true }] } });
    expect(closed).toEqual(clones);
  });
});
