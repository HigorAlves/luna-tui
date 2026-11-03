// What a good answer to an eval case must contain: expect.json, read here, and the deterministic
// checks applied to the answer before any judge sees it. Pure: no files, no model.
import { StageOutcome } from "@hardness/contracts";
import { z } from "zod";

/** Where in the answer a check looks: dot-separated keys; `items[]` is every element, `items[id=m1]`
 *  the elements whose `id` is `m1`, `items[0]` the first. An empty path is the whole answer. */
const Path = z.string().default("");
const Words = z.array(z.string().min(1)).min(1);

export const Check = z.discriminatedUnion("kind", [
  /** Every value at the path equals `value` (and there is at least one). */
  z.object({ kind: z.literal("equals"), path: Path, value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  /** Every value at the path is one of `values` (and there is at least one). */
  z.object({ kind: z.literal("oneOf"), path: Path, values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1) }),
  /** How many: the array's length, or the number of matches when the path ends in a selector. */
  z.object({ kind: z.literal("count"), path: Path, min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }),
  /** The text at the path names these words, case-insensitively: all of them, or with `any`, one. */
  z.object({ kind: z.literal("mentions"), path: Path, words: Words, any: z.boolean().optional() }),
  /** The text at the path names none of these words. */
  z.object({ kind: z.literal("avoids"), path: Path, words: Words }),
]);
export type Check = z.infer<typeof Check>;

export const Expect = z.object({
  schema: z.literal(1),
  /** The StageOutput outcome a good answer settles to (`needs_input` for triage's questions). */
  outcome: StageOutcome.optional(),
  checks: z.array(Check).default([]),
  /** For the judge: what a good answer does, in words. */
  rubric: z.string().min(1),
});
export type Expect = z.infer<typeof Expect>;

export interface CheckResult {
  check: string;
  pass: boolean;
  /** What was found, when the check failed. */
  detail: string | null;
}

const SEGMENT = /^([^[\]]*)(?:\[([^\]]*)\])?$/;

/** The values at `path` in `value`, flattened. */
export function resolvePath(value: unknown, path: string): unknown[] {
  let hits: unknown[] = [value];
  for (const segment of path === "" ? [] : path.split(".")) {
    const match = SEGMENT.exec(segment);
    if (!match) return [];
    const [, key, selector] = match;
    hits = hits.flatMap((hit) => (key === "" ? [hit] : hit !== null && typeof hit === "object" && key! in hit ? [(hit as Record<string, unknown>)[key!]] : []));
    if (selector === undefined) continue;
    hits = hits.flatMap((hit) => {
      if (!Array.isArray(hit)) return [];
      if (selector === "") return hit;
      if (/^\d+$/.test(selector)) return hit.length > Number(selector) ? [hit[Number(selector)]] : [];
      const at = selector.indexOf("=");
      if (at < 0) return [];
      const [field, wanted] = [selector.slice(0, at), selector.slice(at + 1)];
      return hit.filter((el) => el !== null && typeof el === "object" && String((el as Record<string, unknown>)[field]) === wanted);
    });
  }
  return hits;
}

const show = (value: unknown): string => JSON.stringify(value) ?? "undefined";
const textOf = (hits: unknown[]): string => hits.map((hit) => (typeof hit === "string" ? hit : show(hit))).join("\n").toLowerCase();
const at = (path: string) => (path === "" ? "the answer" : path);

/** One line naming the check, as the scorecard prints it. */
export function describeCheck(check: Check): string {
  switch (check.kind) {
    case "equals":
      return `${at(check.path)} = ${show(check.value)}`;
    case "oneOf":
      return `${at(check.path)} in ${show(check.values)}`;
    case "count":
      return `${at(check.path)} count ${check.min ?? 0}..${check.max ?? "∞"}`;
    case "mentions":
      return `${at(check.path)} mentions ${check.any ? "any of " : ""}${check.words.join(", ")}`;
    case "avoids":
      return `${at(check.path)} avoids ${check.words.join(", ")}`;
  }
}

export function runCheck(answer: unknown, check: Check): CheckResult {
  const hits = resolvePath(answer, check.path);
  const result = (pass: boolean, detail: string): CheckResult => ({ check: describeCheck(check), pass, detail: pass ? null : detail });
  switch (check.kind) {
    case "equals": {
      const wrong = hits.filter((hit) => show(hit) !== show(check.value));
      return result(hits.length > 0 && wrong.length === 0, hits.length === 0 ? "nothing there" : `found ${wrong.map(show).join(", ")}`);
    }
    case "oneOf": {
      const allowed = new Set(check.values.map(show));
      const wrong = hits.filter((hit) => !allowed.has(show(hit)));
      return result(hits.length > 0 && wrong.length === 0, hits.length === 0 ? "nothing there" : `found ${wrong.map(show).join(", ")}`);
    }
    case "count": {
      // `items[priority=P0]` counts the matches; `slices` counts the array it names (absent: 0).
      const n = check.path.endsWith("]") ? hits.length : Array.isArray(hits[0]) ? hits[0].length : hits.length;
      return result(n >= (check.min ?? 0) && n <= (check.max ?? Number.POSITIVE_INFINITY), `found ${n}`);
    }
    case "mentions": {
      const text = textOf(hits);
      const missing = check.words.filter((word) => !text.includes(word.toLowerCase()));
      const pass = check.any ? missing.length < check.words.length : missing.length === 0;
      return result(pass, `missing ${missing.join(", ")}`);
    }
    case "avoids": {
      const text = textOf(hits);
      const found = check.words.filter((word) => text.includes(word.toLowerCase()));
      return result(found.length === 0, `found ${found.join(", ")}`);
    }
  }
}
