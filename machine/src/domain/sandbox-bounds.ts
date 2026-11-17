// A repo's `sandbox` section, held within the owner's machine policy (`sandbox.yaml`). Pure: it returns the bounded section and, for each
// thing it dropped or lowered, a reason in the repo's own vocabulary, so the person who wrote the luna.yaml can see why it did not take effect.
import type { FactoryConfig, GuardMode, MachinePolicy, Severity } from "@hardness/contracts";

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
  /** The stage guard per trust and the lowest severity it blocks: the policy's, or the repo's when that is stricter. */
  guard: { trusted: GuardMode; untrusted: GuardMode; blockSeverity: Severity };
}

const MODE_STRICTNESS: readonly GuardMode[] = ["off", "log", "block"];
/** Lowest first: a lower severity blocks more, so it is stricter. */
const SEVERITY_ORDER: readonly Severity[] = ["low", "medium", "high", "critical"];

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

/** The hosts a repo chose (`sandbox.egress.allow`, a lockfile's URLs, the QA targets, the deploy's preview), held within the machine's policy: `egress.deny` drops a host, `repo_hosts: deny` drops all,
 *  and at most `max_repo_hosts` stay, counting the `taken` the repo already has from other sources. Each drop is a reason that starts with `source`. The machine's own hosts never pass through here. */
export function boundRepoHosts(hosts: readonly string[], policy: Pick<MachinePolicy, "egress">, source: string, taken = 0): { kept: string[]; reasons: string[] } {
  if (policy.egress.repo_hosts === "deny") {
    return { kept: [], reasons: hosts.length > 0 ? [`${source}: ${plural(hosts.length)} dropped, the machine's sandbox policy allows no repo hosts (egress.repo_hosts: deny)`] : [] };
  }
  const reasons: string[] = [];
  const kept: string[] = [];
  for (const entry of hosts) {
    const rule = policy.egress.deny.find((deny) => denies(deny, entry));
    if (rule) reasons.push(`${source}: "${entry}" dropped, it matches egress.deny "${rule}" in the machine's sandbox policy`);
    else kept.push(entry);
  }
  const room = Math.max(0, policy.egress.max_repo_hosts - taken);
  if (kept.length > room) {
    reasons.push(`${source}: ${plural(kept.length - room)} dropped past egress.max_repo_hosts ${policy.egress.max_repo_hosts} in the machine's sandbox policy`);
    kept.length = room;
  }
  return { kept, reasons };
}

export function boundSandbox(sandbox: RepoSandbox, policy: MachinePolicy): { sandbox: RepoSandbox; bounds: SandboxBounds } {
  const out: RepoSandbox = structuredClone(sandbox);
  const bounds: SandboxBounds = { notes: [], egress: [], image: [], seccomp: policy.seccomp === "default" ? null : policy.seccomp, runtime: { ...policy.runtime }, maxPids: policy.limits.max_pids, splitCache: policy.cache.split_by_trust,
    guard: { trusted: policy.guard.trusted, untrusted: policy.guard.untrusted, blockSeverity: policy.guard.block_severity } };

  if (out.cpu > policy.limits.max_cpu) {
    bounds.notes.push(`sandbox.cpu ${out.cpu} is capped at ${policy.limits.max_cpu} by the machine's sandbox policy (limits.max_cpu)`);
    out.cpu = policy.limits.max_cpu;
  }
  if (out.memory_gb > policy.limits.max_memory_gb) {
    bounds.notes.push(`sandbox.memory_gb ${out.memory_gb} is capped at ${policy.limits.max_memory_gb} by the machine's sandbox policy (limits.max_memory_gb)`);
    out.memory_gb = policy.limits.max_memory_gb;
  }

  const hosts = boundRepoHosts(out.egress.allow, policy, "sandbox.egress.allow");
  bounds.egress.push(...hosts.reasons);
  out.egress.allow = hosts.kept;

  if (out.image.base && policy.images.repo_base === "deny") {
    bounds.image.push(`sandbox.image.base "${out.image.base}" is refused by the machine's sandbox policy (images.repo_base: deny); the machine's image runs`);
    out.image.base = null;
  }

  for (const trust of ["trusted", "untrusted"] as const) {
    const asked = out.guard?.[trust];
    if (asked === undefined) continue;
    if (MODE_STRICTNESS.indexOf(asked) > MODE_STRICTNESS.indexOf(bounds.guard[trust])) bounds.guard[trust] = asked;
    else if (asked !== bounds.guard[trust]) bounds.notes.push(`sandbox.guard.${trust} "${asked}" is held at "${bounds.guard[trust]}" by the machine's sandbox policy (guard.${trust})`);
  }
  const severity = out.guard?.block_severity;
  if (severity !== undefined) {
    if (SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(bounds.guard.blockSeverity)) bounds.guard.blockSeverity = severity;
    else if (severity !== bounds.guard.blockSeverity) bounds.notes.push(`sandbox.guard.block_severity "${severity}" is held at "${bounds.guard.blockSeverity}" by the machine's sandbox policy (guard.block_severity)`);
  }
  delete out.guard;
  return { sandbox: out, bounds };
}

/** The guard for a card's trust. The judge failing blocks only for an untrusted card. */
export const guardOf = (bounds: Pick<SandboxBounds, "guard">, trust: Trust): { mode: GuardMode; blockSeverity: Severity; failClosed: boolean } => ({
  mode: bounds.guard[trust],
  blockSeverity: bounds.guard.blockSeverity,
  failClosed: trust === "untrusted",
});

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
