// Proofs of a repository's own luna.yaml on demand, for the setup skill (`POST /repos/config/prove`): the file is read and checked, then every
// check it names runs once in the sandbox, as the setup stage proves a proposal. A proof can take as long as a check suite, longer than an HTTP
// request should stay open, so it is a job: started, then read by id. Jobs live in memory; a restart forgets them, and the skill starts again.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { readRegularFile } from "../adapters/fs/bounded.ts";
import { CONFIG_FILE, type ConfigCheck, checkLunaConfigText, validateLunaConfig } from "../domain/luna-config.ts";
import { parse as parseYaml } from "yaml";
import { type Proof, type ProofExec, type ProofRig, allowEntriesOf, proveConfig } from "./config-proof.ts";

const FILE_CAP = 256 * 1024;
const JOBS_KEPT = 20;

export type ProofJob =
  | { id: string; repoPath: string; state: "running"; startedAt: string }
  | { id: string; repoPath: string; state: "done"; startedAt: string; finishedAt: string; check: ConfigCheck; proof: Proof | null; suggestedAllow: string[] }
  | { id: string; repoPath: string; state: "failed"; startedAt: string; finishedAt: string; error: string };

export class ConfigProofs {
  private readonly jobs = new Map<string, ProofJob>();

  constructor(
    private readonly deps: {
      exec: ProofExec;
      /** Where the proof runs and how the app start is proven: a throwaway clone, never the checkout. */
      rig: ProofRig;
      gitIdentity: (repoPath: string) => Promise<{ name: string; email: string } | null>;
      now?: () => Date;
    },
  ) {}

  /** Starts proving `<repoPath>/luna.yaml`; a path that is not an absolute directory is refused at once. */
  async start(repoPath: string): Promise<ProofJob> {
    if (!isAbsolute(repoPath)) throw new ConfigProofError("repoPath must be an absolute path to the repository checkout");
    const info = await stat(repoPath).catch(() => null);
    if (!info?.isDirectory()) throw new ConfigProofError(`${repoPath} is not a directory the machine can see (in compose, repositories live under LUNA_REPOS_DIR, ~/Developer by default)`);
    // One proof per repository at a time: a second request reads the running one.
    const running = [...this.jobs.values()].find((j) => j.repoPath === repoPath && j.state === "running");
    if (running) return running;
    const id = randomUUID();
    const startedAt = this.now().toISOString();
    const job: ProofJob = { id, repoPath, state: "running", startedAt };
    this.keep(job);
    void this.run(job).then(
      (done) => this.keep(done),
      (error: unknown) => this.keep({ id, repoPath, state: "failed", startedAt, finishedAt: this.now().toISOString(), error: error instanceof Error ? error.message : String(error) }),
    );
    return job;
  }

  get(id: string): ProofJob | null {
    return this.jobs.get(id) ?? null;
  }

  private async run(job: ProofJob): Promise<ProofJob> {
    const finished = () => this.now().toISOString();
    const text = await readRegularFile(join(job.repoPath, CONFIG_FILE), FILE_CAP).catch(() => null);
    if (text === null) return { ...job, state: "failed", finishedAt: finished(), error: `no readable ${CONFIG_FILE} at the repository's root (write it first, then prove it)` };
    const check = checkLunaConfigText(text);
    // A file the machine cannot read is not run: the check says why.
    if (!check.ok) return { ...job, state: "done", finishedAt: finished(), check, proof: null, suggestedAllow: [] };
    const config = validateLunaConfig(parseYaml(text) ?? {});
    const identity = await this.deps.gitIdentity(job.repoPath).catch(() => null);
    const env = identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {};
    const proof = await proveConfig(config, { exec: this.deps.exec, rig: this.deps.rig, repoPath: job.repoPath, signal: new AbortController().signal, env, stage: "setup" });
    return { ...job, state: "done", finishedAt: finished(), check, proof, suggestedAllow: allowEntriesOf(proof.refused) };
  }

  private keep(job: ProofJob): void {
    this.jobs.set(job.id, job);
    while (this.jobs.size > JOBS_KEPT) this.jobs.delete(this.jobs.keys().next().value!);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export class ConfigProofError extends Error {}
