import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ConfigProofError, ConfigProofs, type ProofJob } from "./config-proofs.ts";
import type { ProofExec } from "./config-proof.ts";

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

describe("ConfigProofs: the setup skill's proof of a repository's own luna.yaml", () => {
  it("runs every check of the file once, with its services and egress list, and suggests the refused hosts as allow entries", async () => {
    const repo = repoWith(["checks:", "  - { name: unit, run: pnpm test }", "  - { name: lint, run: pnpm lint, cwd: web }", "services:", "  db: { image: postgres:16 }", "sandbox:", "  egress:", "    allow: [index.crates.io]"].join("\n"));
    const exec = vi.fn<ProofExec>(async (_c, args) =>
      args.join(" ").includes("lint") ? { code: 1, stdout: "", stderr: "fetch failed", blocked: [{ host: "fonts.gstatic.com", port: 443, reason: "not_listed" }] } : { code: 0, stdout: "ok", stderr: "" },
    );
    const proofs = new ConfigProofs({ exec, gitIdentity: async () => ({ name: "Ada", email: "a@x.dev" }) });
    const started = await proofs.start(repo);
    expect(started.state).toBe("running");
    const job = await settled(proofs, started.id);
    expect(job).toMatchObject({ state: "done", check: { ok: true }, suggestedAllow: ["fonts.gstatic.com"], proof: { proof: [{ name: "unit", ok: true }, { name: "lint", ok: false }], refused: ["fonts.gstatic.com:443"] } });
    expect(exec.mock.calls[0]![2]).toMatchObject({ cwd: repo, services: { db: { image: "postgres:16" } }, egressAllow: ["index.crates.io"], env: expect.objectContaining({ GIT_AUTHOR_NAME: "Ada", HARDNESS_STAGE: "setup" }) });
  });

  it("runs nothing for a file the machine cannot read, and says why", async () => {
    const exec = vi.fn<ProofExec>();
    const proofs = new ConfigProofs({ exec, gitIdentity: async () => null });
    const job = await settled(proofs, (await proofs.start(repoWith("policy:\n  qa: sometimes\n"))).id);
    expect(job).toMatchObject({ state: "done", check: { ok: false, problems: [expect.stringContaining("policy.qa")] }, proof: null });
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails a repository with no luna.yaml, refuses a relative or missing path, and runs one proof per repository at a time", async () => {
    const exec = vi.fn<ProofExec>(async () => new Promise(() => {}));
    const proofs = new ConfigProofs({ exec, gitIdentity: async () => null });
    expect(await settled(proofs, (await proofs.start(repoWith(null))).id)).toMatchObject({ state: "failed", error: expect.stringContaining("no readable luna.yaml") });
    await expect(proofs.start("relative/repo")).rejects.toBeInstanceOf(ConfigProofError);
    await expect(proofs.start("/no/such/repo")).rejects.toBeInstanceOf(ConfigProofError);
    const repo = repoWith("checks:\n  - { name: unit, run: pnpm test }\n");
    const first = await proofs.start(repo);
    expect((await proofs.start(repo)).id).toBe(first.id);
  });
});
