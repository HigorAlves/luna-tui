// The machine's own sandbox policy (`~/.config/hardness/sandbox.yaml`, or `MACHINE_SANDBOX_POLICY`): what the OWNER allows any repository's
// sandbox to ask for. A repo's `luna.yaml` may only stay within it. Unlike luna.yaml this file is the owner's, so it is strict and every key
// has a default equal to today's behaviour: an absent file changes nothing, an unknown or bad key is a startup error naming it.
import { z } from "zod";

import { hostPatternProblem } from "./egress.ts";

const section = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const HostPattern = z.string().superRefine((text, ctx) => {
  const problem = hostPatternProblem(text);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
const Runtime = z.enum(["runc", "runsc"]);
const Allow = z.enum(["allow", "deny"]);
export const GuardMode = z.enum(["off", "log", "block"]);
export type GuardMode = z.infer<typeof GuardMode>;
export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const MachinePolicySchema = section({
  /** The container runtime per trust level (`--runtime`); read where trust is known. */
  runtime: section({ default: Runtime.default("runc"), untrusted: Runtime.default("runc") }).default({ default: "runc", untrusted: "runc" }),
  /** `default` is docker's own profile; an absolute path is passed as `--security-opt seccomp=<path>`. */
  seccomp: z.union([z.literal("default"), z.string().regex(/^\/[\x21-\x7e]*$/, "default or an absolute path to a profile")]).default("default"),
  /** The most a repo's `sandbox.cpu`, `sandbox.memory_gb` may ask for, and the process limit. The defaults are luna.yaml's own maxima. */
  limits: section({
    max_cpu: z.number().int().min(1).max(128).default(128),
    max_memory_gb: z.number().int().min(1).max(1024).default(1024),
    max_pids: z.number().int().min(64).max(4_194_304).default(1024),
  }).default({ max_cpu: 128, max_memory_gb: 1024, max_pids: 1024 }),
  /** `deny` hosts are dropped from a repo's `sandbox.egress.allow`; `repo_hosts: deny` drops them all; at most `max_repo_hosts` stay. */
  egress: section({
    deny: z.array(HostPattern).max(200).default([]),
    max_repo_hosts: z.number().int().min(0).max(50).default(50),
    repo_hosts: Allow.default("allow"),
  }).default({ deny: [], max_repo_hosts: 50, repo_hosts: "allow" }),
  /** `deny` refuses a repo's `sandbox.image.base` (and the devcontainer source, when it exists). */
  images: section({ repo_base: Allow.default("allow"), devcontainer: Allow.default("allow") }).default({ repo_base: "allow", devcontainer: "allow" }),
  /** Untrusted cards get their own cache volume. */
  cache: section({ split_by_trust: z.boolean().default(true) }).default({ split_by_trust: true }),
  /** The stage guard (RFC 0012): `off` runs none, `log` runs it and journals what it would block, `block` blocks. A repo's `sandbox.guard` may only be stricter: a higher mode, a lower `block_severity`. */
  guard: section({ trusted: GuardMode.default("log"), untrusted: GuardMode.default("log"), block_severity: Severity.default("high") }).default({ trusted: "log", untrusted: "log", block_severity: "high" }),
  /** Reserved. The nested Bash sandbox was not built (RFC 0009), so `on` has no effect: the machine warns at start and `GET /health` lists it under `notInForce`. */
  bash_sandbox: z.enum(["off", "on"]).default("off"),
}).strict();

export type MachinePolicy = z.infer<typeof MachinePolicySchema>;

export const DEFAULT_MACHINE_POLICY: MachinePolicy = MachinePolicySchema.parse({});

/** Why `input` is not a machine policy, naming the key (`limits.max_cpu: ...`, or the unknown key under its section), or null. */
export function machinePolicyProblem(input: unknown): string | null {
  const parsed = MachinePolicySchema.safeParse(input);
  if (parsed.success) return null;
  return parsed.error.issues
    .map((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => `${[...issue.path, key].join(".")}: unknown key`).join("; ") : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}
