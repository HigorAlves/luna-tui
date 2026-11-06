// The list a run of each kind may reach, built by the machine from the USER's checkout: `luna.yaml` through the policy store and the
// lockfiles at the root of the same checkout. Nothing in a card's work folder (its luna.yaml, its lockfiles, a .npmrc) is read here, so an agent
// steered by a ticket cannot widen its own list by editing a file. The proxy that enforces the list is the adapter's (adapters/docker/egress.ts).
import { join } from "node:path";
import type { CredentialOwner } from "@hardness/contracts";

import { readRegularFile } from "../adapters/fs/bounded.ts";
import { LOCKFILES } from "../domain/env-hash.ts";
import { type EgressKind, egressFor } from "../domain/egress.ts";
import { type LockfileText, registryHostsOf } from "../domain/registry-hosts.ts";
import type { PolicyStore } from "./policy.ts";

/** What a run is given: its list, and the machine's own image the proxy runs from (never a repository's). */
export interface EgressRun {
  allow: string[];
  allowPrivate: string[];
  proxyImage: string;
}

export interface EgressRequest {
  /** The user's repository; null for a pack with no repository. */
  repoPath: string | null;
  kind: EgressKind;
  /** The credential owners of the run's engine and of each helper's (an agent or a pack). */
  owners?: readonly CredentialOwner[];
  /** Hosts the repository's config names for a browser run. */
  targets?: readonly string[];
}

export interface EgressPolicy {
  for(request: EgressRequest): Promise<EgressRun>;
}

export interface EgressPolicyDeps {
  policies: Pick<PolicyStore, "for">;
  /** The machine's own runner image. */
  proxyImage: string;
  /** `MACHINE_EGRESS_ENGINE_HOSTS`, already checked. */
  engineHosts?: readonly string[];
  /** The machine's trace endpoints a stage may reach, `host:port`, only when traces are in full mode. */
  traceEntries?: readonly string[];
  /** Reads one lockfile; the default reads a regular file of at most 32 MB and never follows a link. */
  readLockfile?: (path: string) => Promise<string>;
}

const LOCKFILE_CAP = 32 * 1024 * 1024;

export function egressPolicy(deps: EgressPolicyDeps): EgressPolicy {
  const read = deps.readLockfile ?? ((path: string) => readRegularFile(path, LOCKFILE_CAP));
  return {
    async for(request) {
      const policy = request.repoPath ? await deps.policies.for(request.repoPath) : null;
      const sandbox = policy?.factory.sandbox.egress ?? { allow: [], registries: "always" as const };
      const lockfiles: LockfileText[] = [];
      if (request.repoPath && request.kind !== "pack") {
        for (const name of LOCKFILES) {
          try {
            lockfiles.push({ name, text: await read(join(request.repoPath, name)) });
          } catch {
            // absent, a link, too big: no registry from it
          }
        }
      }
      const agentLike = request.kind === "agent" || request.kind === "pack";
      const { allow, allowPrivate } = egressFor(request.kind, {
        allow: sandbox.allow,
        registries: sandbox.registries,
        registryHosts: registryHostsOf(lockfiles),
        ...(request.owners ? { owners: request.owners } : {}),
        engineHosts: agentLike ? (deps.engineHosts ?? []) : [],
        targets: request.targets ?? [],
        machineEntries: agentLike ? (deps.traceEntries ?? []) : [],
      });
      return { allow, allowPrivate, proxyImage: deps.proxyImage };
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
