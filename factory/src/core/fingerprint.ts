// A run's fingerprint (RFC 0003 §7): a sha256 over everything that shapes the model's input apart
// from the task's data. Two runs with one fingerprint gave the model the same template, role (with
// the runtime's addendum), skills, access, answer schema and factory rules, so a change in quality
// between them is the model's or the task's; a new fingerprint names a change in the harness.
import { type Access, type Pack, type ResolvedEngine, type RunInfo, type ToolMask, answerJsonSchema } from "@hardness/contracts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { maskKey, maskedPack } from "./economy/mask.ts";
import type { Runtime } from "./runtime.ts";

export interface FingerprintInput {
  /** The prompt template, or what a decision pack asks in its place (its questions). */
  template: string;
  /** The role as the runtime gives it: the body, its helpers', the runtime's addendum. */
  role: string;
  /** The factory rules, in the runtime's tool names. */
  rules: string;
  /** The skills the runtime loads, by name, read from `skillsDir`. */
  skills: string[];
  skillsDir: string;
  access: Access | null;
  /** The pack's answer, as JSON Schema. */
  answer: Record<string, unknown>;
  /** The approved tool mask the run was narrowed by (`maskKey`), when it was: absent, a fingerprint is what it was before masks. */
  mask?: string | null;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** JSON with every object's keys sorted, so the hash does not depend on the order they were written in. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));

/** A skill as its files, each by path and content hash; a skill that is not there is its name alone. */
const skill = (dir: string, name: string) => {
  const root = join(dir, name);
  if (!existsSync(root) || !statSync(root).isDirectory()) return { name, files: [] };
  return { name, files: files(root).map((file) => [relative(root, file).split("\\").join("/"), sha256(readFileSync(file))]).sort(([a], [b]) => (a! < b! ? -1 : 1)) };
};

export function fingerprint(input: FingerprintInput): string {
  const { skillsDir, skills, mask, ...rest } = input;
  return sha256(canonical({ v: 1, ...rest, ...(mask ? { mask } : {}), skills: [...new Set(skills)].sort().map((name) => skill(skillsDir, name)) }));
}

/** An SDK by its package name and the version installed, read from its own package.json. */
export function sdkInfo(name: string): { name: string; version: string } {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve(name)));
    for (;;) {
      const file = join(dir, "package.json");
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
        if (pkg.name === name && pkg.version) return { name, version: pkg.version };
      }
      if (dirname(dir) === dir) break;
      dir = dirname(dir);
    }
  } catch {}
  return { name, version: "unknown" };
}

/** What a run ran on and its fingerprint: `template` is the prompt template, or what a decision
 *  pack asks in its place. */
export function runInfo(runtime: Runtime, engine: ResolvedEngine, pack: Pack, template: string, factoryRoot: string, mask?: ToolMask): RunInfo {
  // Only Claude narrows by a mask (eve's apps are built with the image), so only its runs are told apart by one.
  const applied = runtime.id === "claude" && pack.kind === "agent" ? maskedPack(pack, mask) : pack;
  const hash = fingerprint({
    template,
    ...runtime.instructions(applied, factoryRoot),
    skillsDir: join(factoryRoot, "plugin", "skills"),
    access: applied.kind === "agent" ? applied.access : null,
    answer: answerJsonSchema(pack),
    mask: applied === pack ? null : maskKey(mask),
  });
  return { runtime: runtime.id, engine: engine.id, modelId: engine.modelId, sdk: sdkInfo(runtime.sdk), fingerprint: hash };
}
