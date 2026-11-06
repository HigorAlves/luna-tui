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
  /** Every value at the path is a number within min..max (and there is at least one). */
  z.object({ kind: z.literal("between"), path: Path, min: z.number().optional(), max: z.number().optional() }),
  /** The text at the path names these words, case-insensitively: all of them, or with `any`, one. */
  z.object({ kind: z.literal("mentions"), path: Path, words: Words, any: z.boolean().optional() }),
  /** The text at the path names none of these words. */
  z.object({ kind: z.literal("avoids"), path: Path, words: Words }),
]);
export type Check = z.infer<typeof Check>;

const LabelShape = z.record(z.string(), z.record(z.string(), z.unknown()));

/** The reading behind a hand-written case's label: the pack's own criterion text for each labelled question (checked character for character), why, what was ruled out, and a second reading made later without the label in view. */
export const Reading = z.object({
  criteria: z.record(z.string(), z.string()),
  why: z.string().min(1),
  ruledOut: z.array(z.object({ question: z.string(), label: z.string(), why: z.string() })).optional(),
  /** A borderline case: each way it can be read. */
  readings: z.array(z.object({ label: LabelShape, criteria: z.record(z.string(), z.string()), why: z.string().min(1) })).optional(),
  second: z.object({ label: LabelShape.nullable(), agrees: z.boolean(), note: z.string().optional() }),
  note: z.string().optional(),
});
export type Reading = z.infer<typeof Reading>;

export const CaseKind = z.enum(["labelled", "adversarial", "borderline"]);
export type CaseKind = z.infer<typeof CaseKind>;

export const Expect = z.object({
  schema: z.literal(1),
  /** The StageOutput outcome a good answer settles to (`needs_input` for triage's questions). */
  outcome: StageOutcome.optional(),
  checks: z.array(Check).default([]),
  /** For the judge: what a good answer does, in words. */
  rubric: z.string().min(1),
  /** A decision case: the label a reviewer (or a later fact) gave, one object per question in the answer's shape. A scalar is exact, an array the labels it may be. */
  label: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  /** Harvested without a label: a person still has to give it, in the Laminar queue or here. */
  review: z.boolean().optional(),
  /** Where a harvested case came from, and the model's own answer then (to prefill a labeling queue). */
  recordId: z.string().optional(),
  traceId: z.string().nullable().optional(),
  modelAnswer: z.record(z.string(), z.unknown()).optional(),
  /** A hand-written decision case's kind: a clear one, one with steering text inside (and a neutral `twin`), one with two readings. Absent on a harvested case or an older one. */
  kind: CaseKind.optional(),
  /** An adversarial case's twin: the id of the same pack's labelled case that is the same input without the steering text. */
  twin: z.string().optional(),
  reading: Reading.optional(),
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
    case "between":
      return `${at(check.path)} within ${check.min ?? "-∞"}..${check.max ?? "∞"}`;
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
    case "between": {
      const wrong = hits.filter((hit) => typeof hit !== "number" || hit < (check.min ?? Number.NEGATIVE_INFINITY) || hit > (check.max ?? Number.POSITIVE_INFINITY));
      return result(hits.length > 0 && wrong.length === 0, hits.length === 0 ? "nothing there" : `found ${wrong.map(show).join(", ")}`);
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
