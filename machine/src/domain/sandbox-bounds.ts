// A repo's `sandbox` section, held within the owner's machine policy (`sandbox.yaml`). Pure: it returns the bounded section and, for each
// thing it dropped or lowered, a reason in the repo's own vocabulary, so the person who wrote the luna.yaml can see why it did not take effect.
import type { FactoryConfig, MachinePolicy } from "@hardness/contracts";

import type { Trust } from "./trust.ts";

export type RepoSandbox = FactoryConfig["sandbox"];

/** What the bounds did, as sentences. `notes` (cpu, memory) go on the task; `egress` and `image` go in repo health. */
export interface SandboxBounds {
  notes: string[];
  egress: string[];
  image: string[];
  /** The seccomp profile path the policy names; null for docker's default. */
  seccomp: string | null;
  /** The container runtime per trust level, the process limit and whether an untrusted card's cache is its own: the policy's, read where a container starts. */
  runtime: { default: "runc" | "runsc"; untrusted: "runc" | "runsc" };
  maxPids: number;
  splitCache: boolean;
}

/** The name as the proxy compares it: trimmed, lowercased, no port, no trailing dot. */
const hostOf = (pattern: string): string => pattern.trim().toLowerCase().split(":")[0]!.replace(/\.+$/, "");

/** Whether the deny entry covers the repo's entry: a name, or a `*.suffix` (and every subdomain under a deny's `*.suffix`). A repo `*.S` is covered too when the deny's
 *  name (without its `*.`) is `S` or sits under it, because the wildcard would let that name through. Ports and trailing dots are ignored. */
export function denies(deny: string, entry: string): boolean {
  const d = hostOf(deny);
  const e = hostOf(entry);
  const entrySuffix = e.startsWith("*.") ? e.slice(2) : null;
  const denySuffix = d.startsWith("*.") ? d.slice(2) : null;
  if (denySuffix !== null) {
    return entrySuffix === null ? e.endsWith(`.${denySuffix}`) : entrySuffix === denySuffix || entrySuffix.endsWith(`.${denySuffix}`) || denySuffix.endsWith(`.${entrySuffix}`);
  }
  return entrySuffix === null ? e === d : d === entrySuffix || d.endsWith(`.${entrySuffix}`);
}

const plural = (count: number): string => `${count} host${count === 1 ? "" : "s"}`;

export function boundSandbox(sandbox: RepoSandbox, policy: MachinePolicy): { sandbox: RepoSandbox; bounds: SandboxBounds } {
  const out: RepoSandbox = structuredClone(sandbox);
  const bounds: SandboxBounds = { notes: [], egress: [], image: [], seccomp: policy.seccomp === "default" ? null : policy.seccomp, runtime: { ...policy.runtime }, maxPids: policy.limits.max_pids, splitCache: policy.cache.split_by_trust };

  if (out.cpu > policy.limits.max_cpu) {
    bounds.notes.push(`sandbox.cpu ${out.cpu} is capped at ${policy.limits.max_cpu} by the machine's sandbox policy (limits.max_cpu)`);
    out.cpu = policy.limits.max_cpu;
  }
  if (out.memory_gb > policy.limits.max_memory_gb) {
    bounds.notes.push(`sandbox.memory_gb ${out.memory_gb} is capped at ${policy.limits.max_memory_gb} by the machine's sandbox policy (limits.max_memory_gb)`);
    out.memory_gb = policy.limits.max_memory_gb;
  }

  if (policy.egress.repo_hosts === "deny") {
    if (out.egress.allow.length > 0) bounds.egress.push(`sandbox.egress.allow: ${plural(out.egress.allow.length)} dropped, the machine's sandbox policy allows no repo hosts (egress.repo_hosts: deny)`);
    out.egress.allow = [];
  } else {
    const kept: string[] = [];
    for (const entry of out.egress.allow) {
      const rule = policy.egress.deny.find((deny) => denies(deny, entry));
      if (rule) bounds.egress.push(`sandbox.egress.allow: "${entry}" dropped, it matches egress.deny "${rule}" in the machine's sandbox policy`);
      else kept.push(entry);
    }
    if (kept.length > policy.egress.max_repo_hosts) {
      bounds.egress.push(`sandbox.egress.allow: ${plural(kept.length - policy.egress.max_repo_hosts)} dropped past egress.max_repo_hosts ${policy.egress.max_repo_hosts} in the machine's sandbox policy`);
      kept.length = policy.egress.max_repo_hosts;
    }
    out.egress.allow = kept;
  }

  if (out.image.base && policy.images.repo_base === "deny") {
    bounds.image.push(`sandbox.image.base "${out.image.base}" is refused by the machine's sandbox policy (images.repo_base: deny); the machine's image runs`);
    out.image.base = null;
  }
  return { sandbox: out, bounds };
}

/** Why the machine's policy refused the repo's base image, or null; `POST /repos/base/approve` refuses the same base. */
export const baseRefusal = (policy: { bounds?: Pick<SandboxBounds, "image"> | undefined }): string | null => policy.bounds?.image[0] ?? null;

/** A container's size: the repo's bounded cpu and memory, the policy's process limit, its seccomp profile when it names one, its runtime for the card's trust when that is not runc,
 *  and the trust the cache volume is split by (`trusted` when the policy does not split). */
export function sandboxSizeOf(policy: { factory: { sandbox: { cpu: number; memory_gb: number } }; bounds?: SandboxBounds }, trust: Trust = "trusted"): { cpu: number; memoryGb: number; pids: number; cacheTrust: Trust; seccomp?: string; runtime?: string } {
  const bounds = policy.bounds;
  const runtime = bounds ? bounds.runtime[trust === "untrusted" ? "untrusted" : "default"] : "runc";
  return {
    cpu: policy.factory.sandbox.cpu,
    memoryGb: policy.factory.sandbox.memory_gb,
    pids: bounds?.maxPids ?? 1024,
    cacheTrust: bounds && !bounds.splitCache ? "trusted" : trust,
    ...(bounds?.seccomp ? { seccomp: bounds.seccomp } : {}),
    ...(runtime !== "runc" ? { runtime } : {}),
  };
}
