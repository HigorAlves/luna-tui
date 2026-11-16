// The list a run of each kind may reach, built by the machine from the USER's checkout: `luna.yaml` through the policy store and the
// lockfiles at the root of the same checkout. Nothing in a card's work folder (its luna.yaml, its lockfiles, a .npmrc) is read here, so an agent
// steered by a ticket cannot widen its own list by editing a file. The proxy that enforces the list is the adapter's (adapters/docker/egress.ts).
import { join } from "node:path";
import type { CredentialOwner, MachinePolicy } from "@hardness/contracts";

import { readRegularFile } from "../adapters/fs/bounded.ts";
import { HOST_GIT } from "../adapters/git/worktree.ts";
import { exec } from "../adapters/process/exec.ts";
import { LOCKFILES } from "../domain/env-hash.ts";
import { type EgressKind, egressFor } from "../domain/egress.ts";
import { type LockfileText, registryHostsSplit } from "../domain/registry-hosts.ts";
import { boundRepoHosts } from "../domain/sandbox-bounds.ts";
import type { PolicyStore } from "./policy.ts";

/** What a run is given: its list, and the machine's own image the proxy runs from (never a repository's). */
export interface EgressRun {
  allow: string[];
  allowPrivate: string[];
  proxyImage: string;
  /** What the machine's sandbox policy dropped from the hosts the repo chose, as sentences (also in repo health). */
  bounds?: string[];
}

export interface EgressRequest {
  /** The user's repository; null for a pack with no repository. */
  repoPath: string | null;
  kind: EgressKind;
  /** The credential owners of the run's engine and of each helper's (an agent or a pack). */
  owners?: readonly CredentialOwner[];
  /** Owners whose credential the run holds only as a placeholder (the engine relay): their hosts are left off the list. */
  relayed?: readonly CredentialOwner[];
  /** Hosts the repository's config names for a browser run. */
  targets?: readonly string[];
  /** The preview host (`host:443`) a deploy brings up, for a check that reaches it. */
  deploy?: readonly string[];
}

export interface EgressPolicy {
  for(request: EgressRequest): Promise<EgressRun>;
  /** Why the machine's policy dropped hosts the repo's lockfiles, QA targets and last preview named, for repo health. */
  bounds?(repoPath: string): Promise<string[]>;
}

export interface EgressPolicyDeps {
  policies: Pick<PolicyStore, "for">;
  /** The owner's sandbox policy: every host the repo chose is held within it. Absent, they stand. */
  machinePolicy?: MachinePolicy;
  /** The machine's own runner image. */
  proxyImage: string;
  /** `MACHINE_EGRESS_ENGINE_HOSTS`, already checked. */
  engineHosts?: readonly string[];
  /** The machine's trace endpoints a stage may reach, `host:port`, only when traces are in full mode. */
  traceEntries?: readonly string[];
  /** The tracked lockfiles below the repository's root, as paths; the default asks git (`trackedNestedLockfiles`). */
  nestedLockfiles?: (repoPath: string) => Promise<string[]>;
  /** Reads one lockfile; the default reads a regular file of at most 32 MB and never follows a link. */
  readLockfile?: (path: string) => Promise<string>;
}

const LOCKFILE_CAP = 32 * 1024 * 1024;

const NESTED_MAX = 50;

/** The lockfiles the repository tracks below its root, as paths (`board/Cargo.lock`): git's index, so never an untracked or ignored folder
 *  (`node_modules`, `target/`), and nothing is read. At most 50. */
export async function trackedNestedLockfiles(repoPath: string): Promise<string[]> {
  const out = await exec("git", [...HOST_GIT, "-C", repoPath, "ls-files", "-z", "--", ...LOCKFILES.map((name) => `:(glob)*/**/${name}`)], { timeoutMs: 10_000 });
  if (out.code !== 0) return [];
  return out.stdout.split("\0").filter((path) => path.includes("/")).slice(0, NESTED_MAX);
}

export function egressPolicy(deps: EgressPolicyDeps): EgressPolicy {
  const read = deps.readLockfile ?? ((path: string) => readRegularFile(path, LOCKFILE_CAP));
  const listNested = deps.nestedLockfiles ?? trackedNestedLockfiles;
  /** The drops of the last preview host per repo: the preview's host is known only when a deploy starts. */
  const deployDrops = new Map<string, string[]>();
  const compute = async (request: EgressRequest): Promise<{ run: EgressRun; reasons: string[] }> => {
    {
      const policy = request.repoPath ? await deps.policies.for(request.repoPath) : null;
      const sandbox = policy?.factory.sandbox.egress ?? { allow: [], registries: "always" as const };
      const lockfiles: LockfileText[] = [];
      let nested: string[] = [];
      if (request.repoPath && (request.kind === "install" || request.kind === "check" || request.kind === "agent")) {
        for (const name of LOCKFILES) {
          try {
            lockfiles.push({ name, text: await read(join(request.repoPath, name)) });
          } catch {
            // absent, a link, too big: no registry from it
          }
        }
        // The lockfiles in subfolders the repository tracks (`board/Cargo.lock`), by path only: their ecosystems' own hosts.
        nested = await listNested(request.repoPath).catch(() => []);
      }
      const agentLike = request.kind === "agent" || request.kind === "pack" || request.kind === "github";
      // Every host the repo chose goes through the machine's policy, in a fixed order that counts against `max_repo_hosts`: its allow list (bounded by the store), then the hosts its
      // lockfiles name, its QA targets and its preview. The machine's own (GitHub, each ecosystem's registries, the engines') are not the repo's and pass.
      const reasons: string[] = [];
      let taken = sandbox.allow.length;
      const bound = (hosts: readonly string[], source: string): string[] => {
        if (!deps.machinePolicy) return [...hosts];
        const out = boundRepoHosts(hosts, deps.machinePolicy, source, taken);
        taken += out.kept.length;
        reasons.push(...out.reasons);
        return out.kept;
      };
      const split = registryHostsSplit(lockfiles, nested);
      const namedHosts = bound(split.named, "lockfile");
      const targets = bound(request.targets ?? [], "qa_targets");
      const deploy = bound(request.deploy ?? [], "deploy.url_pattern");
      const { allow, allowPrivate } = egressFor(request.kind, {
        allow: sandbox.allow,
        registries: sandbox.registries,
        registryHosts: [...split.own, ...namedHosts],
        ...(request.owners ? { owners: request.owners } : {}),
        ...(request.relayed ? { relayed: request.relayed } : {}),
        engineHosts: agentLike ? (deps.engineHosts ?? []) : [],
        targets,
        deploy,
        machineEntries: agentLike ? (deps.traceEntries ?? []) : [],
      });
      return { run: { allow, allowPrivate, proxyImage: deps.proxyImage, bounds: reasons }, reasons };
    }
  };
  return {
    async for(request) {
      const { run, reasons } = await compute(request);
      if (request.repoPath && request.deploy) deployDrops.set(request.repoPath, reasons.filter((line) => line.startsWith("deploy.url_pattern")));
      return run;
    },
    async bounds(repoPath) {
      const policy = await deps.policies.for(repoPath);
      const targets = policy.qaTargets.flatMap((target) => {
        try {
          const url = new URL(target.baseUrl);
          return [`${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`];
        } catch {
          return [];
        }
      });
      const { reasons } = await compute({ repoPath, kind: "check", targets });
      return [...reasons, ...(deployDrops.get(repoPath) ?? [])];
    },
  };
}

/** The step a refused connection belongs to. */
export type BlockedStep = "stage" | "check" | "install" | "app" | "seed" | "deploy";
export const MAX_BLOCKED_EVENTS = 20;

/** The payloads of the `sandbox.egress_blocked` rows for a run: one per (host, port, via), at most 20, then one `{ step, more }`. Host text was flattened by the adapter. */
export function blockedPayloads(rows: ReadonlyArray<{ host: string; port: number; via: string; reason: string; count: number }> | undefined, step: BlockedStep): Array<Record<string, unknown>> {
  if (!rows || rows.length === 0) return [];
  const shown = rows.slice(0, MAX_BLOCKED_EVENTS).map((r) => ({ step, host: r.host, port: r.port, via: r.via, reason: r.reason, count: r.count }));
  return rows.length > MAX_BLOCKED_EVENTS ? [...shown, { step, more: rows.length - MAX_BLOCKED_EVENTS }] : shown;
}
