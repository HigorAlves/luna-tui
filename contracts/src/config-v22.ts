// The v2.2 diagram's config blocks as `luna.yaml` sections, each with the diagram's default. `luna.yaml` is
// repo-controlled input: every value is typed and range-checked, and an unknown key inside a new section is an
// error naming the key. The command and template strings (`verify.mutation.command`, `verify.e2e.*.command`,
// `ship.merge.commit_template`) are stored as opaque text; the machine runs the e2e ones in a container, never on the host.
import { z } from "zod";

import { hostPatternProblem, secretNameProblem, urlPatternProblem } from "./egress.ts";

const unit = z.number().min(0).max(1);
const count = (max: number) => z.number().int().min(0).max(max);
const minutes = (max: number) => z.number().positive().max(max);
const days = z.number().int().min(0).max(365);
/** A command or a template: stored, never run or rendered here. Bounded so a file cannot park megabytes in the policy. */
const opaque = z.string().max(2000);
const section = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
/** A host pattern in `sandbox.egress.allow`: checked, a bad entry named in the error (lowercased where the policy is built; a schema with a transform cannot become the setup pack's JSON schema). */
const HostPattern = z.string().superRefine((text, ctx) => {
  const problem = hostPatternProblem(text);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
/** A secret's name: only the name is ever in `luna.yaml`; the value is in the owner's own store. */
export const SecretNameSchema = z.string().superRefine((name, ctx) => {
  const problem = secretNameProblem(name);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
const secrets = z.array(SecretNameSchema).max(10);
const urlPath = z.string().max(200).regex(/^\/[\x21-\x7e]*$/, "a path starting with /");
const previewPattern = z.string().max(300).superRefine((text, ctx) => {
  const problem = urlPatternProblem(text);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const Risk3 = z.enum(["low", "medium", "high"]);
const SizeBucket = z.enum(["XS", "S", "M", "L", "XL"]);
const Sla = section({ reminder_days: days.optional(), escalate_days: days.optional(), archive_days: days.optional() });

/** What a repo may write, every key optional. */
export const FactoryConfigInput = {
  tickets: section({ assignees: z.array(z.string().max(120)).max(50).optional(), teams: z.array(z.string().max(120)).max(50).optional(), debounce_seconds: count(3600).optional(), auto: z.enum(["off", "on"]).optional(), sla: section({ acknowledge_hours: count(24 * 365).optional(), resolve_days: section({ P0: days.optional(), P1: days.optional(), P2: days.optional(), P3: days.optional() }).optional(), stale_days: days.optional(), needs_info_reminder_days: days.optional(), needs_info_park_days: days.optional() }).optional() }).optional(),
  backlog: section({ stale_days: days.optional() }).optional(),
  conversation: section({
    channels: z.array(z.string().regex(/^[CGD][A-Z0-9]{2,20}$/)).max(50).optional(),
    auto: z.enum(["off", "on"]).optional(),
    debounce_seconds: count(3600).optional(),
    draft_expiry_hours: z.number().int().min(1).max(168).optional(),
    confidence: unit.optional(),
    active_minutes: count(1440).optional(),
  }).optional(),
  dedup: section({ duplicate: unit.optional(), related: unit.optional(), ask_below: unit.optional(), lookback_days: days.optional() }).optional(),
  triage: section({
    confidence: section({ kind: unit.optional(), size: unit.optional(), urgency: unit.optional(), risk: unit.optional(), archive: unit.optional() }).optional(),
    flag_band: unit.optional(),
    hint_weight: unit.optional(),
    max_questions: count(10).optional(),
    max_rounds: count(10).optional(),
    sla: Sla.optional(),
  }).optional(),
  scoring: section({
    weights: section({ who: z.number().min(0).max(100).optional(), what: z.number().min(0).max(100).optional(), impact: z.number().min(0).max(100).optional(), time: z.number().min(0).max(100).optional(), demand: z.number().min(0).max(100).optional() }).optional(),
    bands: section({ P0: z.number().min(0).max(1000).optional(), P1: z.number().min(0).max(1000).optional(), P2: z.number().min(0).max(1000).optional() }).optional(),
  }).optional(),
  graph: section({ stale_commits: count(100_000).optional(), first_build_minutes: minutes(1440).optional() }).optional(),
  fast_lane: section({ max_risk: Risk3.optional(), max_size: SizeBucket.optional(), excluded_types: z.array(z.string().max(40)).max(20).optional(), cross_team: z.boolean().optional() }).optional(),
  plan: section({
    coverage_score_min: unit.optional(),
    coverage_rounds: count(5).optional(),
    plan_check_retries: count(5).optional(),
    approvers: section({ low: count(5).optional(), medium: count(5).optional(), high: count(5).optional(), outside_owning_team: z.boolean().optional() }).optional(),
    sla: Sla.optional(),
  }).optional(),
  size: section({
    target_loc: z.tuple([count(100_000), count(100_000)]).optional(),
    hard_limit_loc: count(20_000).optional(),
    max_children: count(20).optional(),
    max_rounds: count(10).optional(),
    depth: count(3).optional(),
  }).optional(),
  build: section({
    max_iterations: count(50).optional(),
    max_tokens: count(20_000_000).optional(),
    max_minutes: minutes(1440).optional(),
    backoff_minutes: z.tuple([minutes(1440).min(1), minutes(1440)]).optional(),
    regression_full_suite_minutes: minutes(1440).optional(),
  }).optional(),
  sandbox: section({
    cpu: count(128).optional(),
    memory_gb: count(1024).optional(),
    keep_hours: count(720).optional(),
    egress: section({ allow: z.array(HostPattern).max(50).optional(), registries: z.enum(["install", "always"]).optional() }).optional(),
    install: section({ run: z.enum(["on", "off"]).optional(), scripts: z.enum(["off", "on"]).optional() }).optional(),
    image: section({ base: z.string().max(1000).optional() }).optional(),
  }).optional(),
  verify: section({
    coverage_drop_max: z.number().min(0).max(100).optional(),
    mutation: section({ command: opaque.nullable().optional(), min_score: unit.optional() }).optional(),
    build_rounds: count(10).optional(),
    e2e_rounds: count(10).optional(),
    ci_rounds: count(10).optional(),
    env_flake_retries: count(5).optional(),
    ci_flaky_reruns: count(5).optional(),
    auto_rebase: count(5).optional(),
    e2e: section({
      deploy: section({ command: opaque.nullable().optional(), url_pattern: previewPattern.nullable().optional(), health_check: urlPath.optional(), timeout_minutes: minutes(120).optional(), secrets: secrets.optional() }).nullable().optional(),
      start: section({ command: opaque.nullable().optional(), port: z.number().int().min(1).max(65535).optional(), ready: urlPath.optional(), ready_timeout_s: z.number().int().min(1).max(900).optional(), secrets: secrets.optional() }).nullable().optional(),
      seed: section({ command: opaque.nullable().optional(), secrets: secrets.optional() }).nullable().optional(),
    }).optional(),
  }).optional(),
  /** What the machine keeps for this repository: it can only lower what the machine's own switches allow. `full` traces is not a value a repository can write. */
  learning: section({ records: z.boolean().optional(), context: z.enum(["full", "answers"]).optional(), truth: z.boolean().optional(), traces: z.enum(["off", "metadata", "host"]).optional() }).optional(),
  ship: section({
    preview: z.enum(["off", "on"]).optional(),
    auto_merge: z.enum(["off", "low", "medium_when_review_required", "medium"]).optional(),
    merge: section({ method: z.enum(["squash", "merge", "rebase"]).optional(), queue: z.boolean().optional(), delete_branch: z.boolean().optional(), commit_template: opaque.nullable().optional() }).optional(),
    release_owners: z.array(z.string().max(80)).max(50).optional(),
    stale_days: z.number().int().min(1).max(60).optional(),
    sla: Sla.optional(),
    poll_minutes: minutes(1440).optional(),
  }).optional(),
};

/** The evidence keys the diagram adds; `retention_days` is the existing key and keeps its meaning. Unknown keys here stay ignored, as they always were in this older section. */
export const EvidenceConfigV22 = {
  video_budget_s: z.number().int().min(1).max(3600).optional(),
  regenerate: count(5).optional(),
  tts: z.object({ voice: z.string().max(80).nullable().optional(), language: z.string().max(20).nullable().optional() }).optional(),
  storage: z.enum(["release_asset", "local"]).optional(),
};

export interface FactoryConfig {
  learning: { records: boolean; context: "full" | "answers"; truth: boolean; traces: "off" | "metadata" | "host" };
  tickets: { assignees: string[]; teams: string[]; debounce_seconds: number; auto: "off" | "on"; sla: { acknowledge_hours: number; resolve_days: { P0: number; P1: number; P2: number; P3: number }; stale_days: number; needs_info_reminder_days: number; needs_info_park_days: number } };
  dedup: { duplicate: number; related: number; ask_below: number; lookback_days: number };
  backlog: { stale_days: number };
  conversation: { channels: string[]; auto: "off" | "on"; debounce_seconds: number; draft_expiry_hours: number; confidence: number; active_minutes: number };
  triage: { confidence: { kind: number; size: number; urgency: number; risk: number; archive: number }; flag_band: number; hint_weight: number; max_questions: number; max_rounds: number; sla: { reminder_days: number; archive_days: number } };
  scoring: { weights: { who: number; what: number; impact: number; time: number; demand: number }; bands: { P0: number; P1: number; P2: number } };
  graph: { stale_commits: number; first_build_minutes: number };
  fast_lane: { max_risk: "low" | "medium" | "high"; max_size: "XS" | "S" | "M" | "L" | "XL"; excluded_types: string[]; cross_team: boolean };
  plan: { coverage_score_min: number; coverage_rounds: number; plan_check_retries: number; approvers: { low: number; medium: number; high: number; outside_owning_team: boolean }; sla: { reminder_days: number; escalate_days: number } };
  size: { target_loc: [number, number]; hard_limit_loc: number; max_children: number; max_rounds: number; depth: number };
  build: { max_iterations: number; max_tokens: number; max_minutes: number; backoff_minutes: [number, number]; regression_full_suite_minutes: number };
  sandbox: { cpu: number; memory_gb: number; keep_hours: number; egress: { allow: string[]; registries: "install" | "always" }; install: { run: "on" | "off"; scripts: "off" | "on" }; image: { base: string | null } };
  verify: { coverage_drop_max: number; mutation: { command: string | null; min_score: number }; build_rounds: number; e2e_rounds: number; ci_rounds: number; env_flake_retries: number; ci_flaky_reruns: number; auto_rebase: number; e2e: { deploy: { command: string | null; url_pattern: string | null; health_check: string; timeout_minutes: number; secrets: string[] }; start: { command: string | null; port: number; ready: string; ready_timeout_s: number; secrets: string[] }; seed: { command: string | null; secrets: string[] } } };
  evidence: { video_budget_s: number; regenerate: number; tts: { voice: string | null; language: string | null }; storage: "release_asset" | "local"; retention_days: number };
  ship: { preview: "off" | "on"; auto_merge: "off" | "low" | "medium_when_review_required" | "medium"; merge: { method: "squash" | "merge" | "rebase"; queue: boolean; delete_branch: boolean; commit_template: string | null }; release_owners: string[]; stale_days: number; sla: { reminder_days: number; escalate_days: number }; poll_minutes: number };
}

/** The diagram's numbers. A `luna.yaml` section is merged over these. */
export const FACTORY_DEFAULTS: FactoryConfig = {
  learning: { records: true, context: "full", truth: true, traces: "host" },
  tickets: { assignees: [], teams: [], debounce_seconds: 60, auto: "off", sla: { acknowledge_hours: 24, resolve_days: { P0: 2, P1: 7, P2: 30, P3: 90 }, stale_days: 30, needs_info_reminder_days: 3, needs_info_park_days: 10 } },
  dedup: { duplicate: 0.9, related: 0.7, ask_below: 0.7, lookback_days: 90 },
  backlog: { stale_days: 14 },
  conversation: { channels: [], auto: "off", debounce_seconds: 90, draft_expiry_hours: 24, confidence: 0.7, active_minutes: 10 },
  triage: { confidence: { kind: 0.8, size: 0.6, urgency: 0.7, risk: 0.85, archive: 0.9 }, flag_band: 0.15, hint_weight: 0.5, max_questions: 3, max_rounds: 2, sla: { reminder_days: 2, archive_days: 5 } },
  scoring: { weights: { who: 3, what: 3, impact: 2, time: 2, demand: 1 }, bands: { P0: 28, P1: 22, P2: 16 } },
  graph: { stale_commits: 50, first_build_minutes: 10 },
  fast_lane: { max_risk: "low", max_size: "S", excluded_types: ["infra", "data"], cross_team: false },
  plan: { coverage_score_min: 0.85, coverage_rounds: 3, plan_check_retries: 2, approvers: { low: 1, medium: 1, high: 2, outside_owning_team: true }, sla: { reminder_days: 2, escalate_days: 5 } },
  size: { target_loc: [1000, 2000], hard_limit_loc: 2500, max_children: 8, max_rounds: 3, depth: 2 },
  build: { max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90, backoff_minutes: [1, 30], regression_full_suite_minutes: 10 },
  sandbox: { cpu: 2, memory_gb: 4, keep_hours: 24, egress: { allow: [], registries: "always" }, install: { run: "on", scripts: "off" }, image: { base: null } },
  verify: { coverage_drop_max: 0.5, mutation: { command: null, min_score: 0.6 }, build_rounds: 1, e2e_rounds: 3, ci_rounds: 3, env_flake_retries: 1, ci_flaky_reruns: 1, auto_rebase: 1, e2e: { deploy: { command: null, url_pattern: null, health_check: "/", timeout_minutes: 15, secrets: [] }, start: { command: null, port: 3000, ready: "/", ready_timeout_s: 120, secrets: [] }, seed: { command: null, secrets: [] } } },
  evidence: { video_budget_s: 240, regenerate: 1, tts: { voice: null, language: null }, storage: "release_asset", retention_days: 180 },
  ship: { preview: "off", auto_merge: "medium_when_review_required", merge: { method: "squash", queue: true, delete_branch: true, commit_template: null }, release_owners: [], stale_days: 14, sla: { reminder_days: 2, escalate_days: 5 }, poll_minutes: 5 },
};

/** Every key of the config, and the wave that reads it: `8` means code in this wave does. A key nothing reads is dead config. */
export const CONSUMED_FROM: Readonly<Record<string, number>> = {
  "tickets.assignees": 16, "tickets.teams": 16, "tickets.debounce_seconds": 16, "tickets.auto": 16, "tickets.sla.acknowledge_hours": 16, "tickets.sla.resolve_days.P0": 16, "tickets.sla.resolve_days.P1": 16, "tickets.sla.resolve_days.P2": 16, "tickets.sla.resolve_days.P3": 16, "tickets.sla.stale_days": 16, "tickets.sla.needs_info_reminder_days": 16, "tickets.sla.needs_info_park_days": 16,
  "dedup.duplicate": 14, "dedup.related": 14, "dedup.ask_below": 14, "dedup.lookback_days": 14, "backlog.stale_days": 14,
  "conversation.channels": 17, "conversation.auto": 17, "conversation.debounce_seconds": 17, "conversation.draft_expiry_hours": 17, "conversation.confidence": 17, "conversation.active_minutes": 17,
  "triage.confidence.kind": 9, "triage.confidence.size": 9, "triage.confidence.urgency": 9, "triage.confidence.risk": 9, "triage.confidence.archive": 9,
  "triage.flag_band": 9, "triage.hint_weight": 9, "triage.max_questions": 9, "triage.max_rounds": 9, "triage.sla.reminder_days": 9, "triage.sla.archive_days": 9,
  "scoring.weights": 9, "scoring.bands": 9,
  "graph.stale_commits": 9, "graph.first_build_minutes": 11,
  "fast_lane.max_risk": 9, "fast_lane.max_size": 9, "fast_lane.excluded_types": 9, "fast_lane.cross_team": 9,
  "plan.coverage_score_min": 9, "plan.coverage_rounds": 8, "plan.plan_check_retries": 8,
  "plan.approvers.low": 9, "plan.approvers.medium": 9, "plan.approvers.high": 9, "plan.approvers.outside_owning_team": 9, "plan.sla.reminder_days": 9, "plan.sla.escalate_days": 9,
  "size.target_loc": 15, "size.hard_limit_loc": 15, "size.max_children": 15, "size.max_rounds": 15, "size.depth": 15,
  "build.max_iterations": 10, "build.max_tokens": 10, "build.max_minutes": 10, "build.backoff_minutes": 10, "build.regression_full_suite_minutes": 10,
  "sandbox.cpu": 11, "sandbox.memory_gb": 11, "sandbox.keep_hours": 11, "sandbox.egress.allow": 11, "sandbox.egress.registries": 11, "sandbox.install.run": 11, "sandbox.install.scripts": 11, "sandbox.image.base": 11,
  "verify.coverage_drop_max": 12, "verify.mutation.command": 12, "verify.mutation.min_score": 12, "verify.build_rounds": 12, "verify.e2e_rounds": 12, "verify.ci_rounds": 12,
  "verify.env_flake_retries": 8, "verify.ci_flaky_reruns": 8, "verify.auto_rebase": 8,
  "verify.e2e.deploy.command": 11, "verify.e2e.deploy.url_pattern": 11, "verify.e2e.deploy.health_check": 11, "verify.e2e.deploy.timeout_minutes": 11, "verify.e2e.deploy.secrets": 11,
  "verify.e2e.start.command": 11, "verify.e2e.start.port": 11, "verify.e2e.start.ready": 11, "verify.e2e.start.ready_timeout_s": 11, "verify.e2e.start.secrets": 11,
  "verify.e2e.seed.command": 11, "verify.e2e.seed.secrets": 11,
  "evidence.video_budget_s": 12, "evidence.regenerate": 12, "evidence.tts.voice": 12, "evidence.tts.language": 12, "evidence.storage": 12, "evidence.retention_days": 12,
  "ship.preview": 12, "ship.auto_merge": 13, "ship.merge.method": 13, "ship.merge.queue": 13, "ship.merge.delete_branch": 13, "ship.merge.commit_template": 13,
  "learning.records": 18, "learning.context": 18, "learning.truth": 18, "learning.traces": 18,
  "ship.release_owners": 13, "ship.stale_days": 8, "ship.sla.reminder_days": 13, "ship.sla.escalate_days": 13, "ship.poll_minutes": 13,
};

/** The leaf keys of the defaults as dotted paths (arrays and the weights/bands maps count as one key). */
export function configKeys(defaults: unknown = FACTORY_DEFAULTS, prefix = ""): string[] {
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) return [prefix];
  const entries = Object.entries(defaults);
  return entries.flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return path === "scoring.weights" || path === "scoring.bands" ? [path] : configKeys(v, path);
  });
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `base` with `over` merged in, key by key; `undefined` in `over` leaves the default. */
function merge<T>(base: T, over: unknown): T {
  // A bare `start:` or `deploy:` is null in YAML: it leaves the section's defaults, as an absent one does.
  if (isPlain(base) && over === null) return base;
  if (!isPlain(base) || !isPlain(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) if (v !== undefined) out[k] = merge(out[k], v);
  return out as T;
}

/** A repo's sections (already validated) over the diagram's defaults. */
export function factoryConfigOf(sections: Partial<Record<keyof FactoryConfig, unknown>>): FactoryConfig {
  return merge(structuredClone(FACTORY_DEFAULTS), sections);
}
