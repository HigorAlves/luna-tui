// A repo's `sandbox` section, held within the owner's machine policy (`sandbox.yaml`). Pure: it returns the bounded section and, for each
// thing it dropped or lowered, a reason in the repo's own vocabulary, so the person who wrote the luna.yaml can see why it did not take effect.
import type { FactoryConfig, MachinePolicy } from "@hardness/contracts";

export type RepoSandbox = FactoryConfig["sandbox"];

/** What the bounds did, as sentences. `notes` (cpu, memory) go on the task; `egress` and `image` go in repo health. */
export interface SandboxBounds {
  notes: string[];
  egress: string[];
  image: string[];
  /** The seccomp profile path the policy names; null for docker's default. */
  seccomp: string | null;
}

const hostOf = (pattern: string): string => pattern.toLowerCase().split(":")[0]!;

/** Whether the deny entry covers the repo's entry: a name, or a `*.suffix` (and every subdomain under a deny's `*.suffix`). Ports are ignored. */
function denies(deny: string, entry: string): boolean {
  const d = hostOf(deny);
  const e = hostOf(entry);
  const entrySuffix = e.startsWith("*.") ? e.slice(2) : null;
  if (d.startsWith("*.")) {
    const suffix = d.slice(2);
    return entrySuffix === null ? e.endsWith(`.${suffix}`) : entrySuffix === suffix || entrySuffix.endsWith(`.${suffix}`);
  }
  return entrySuffix === null ? e === d : entrySuffix === d;
}

const plural = (count: number): string => `${count} host${count === 1 ? "" : "s"}`;

export function boundSandbox(sandbox: RepoSandbox, policy: MachinePolicy): { sandbox: RepoSandbox; bounds: SandboxBounds } {
  const out: RepoSandbox = structuredClone(sandbox);
  const bounds: SandboxBounds = { notes: [], egress: [], image: [], seccomp: policy.seccomp === "default" ? null : policy.seccomp };

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

/** A container's size: the repo's bounded cpu and memory, and the policy's seccomp profile when it names one. */
export function sandboxSizeOf(policy: { factory: { sandbox: { cpu: number; memory_gb: number } }; bounds?: SandboxBounds }): { cpu: number; memoryGb: number; seccomp?: string } {
  const seccomp = policy.bounds?.seccomp;
  return { cpu: policy.factory.sandbox.cpu, memoryGb: policy.factory.sandbox.memory_gb, ...(seccomp ? { seccomp } : {}) };
}
