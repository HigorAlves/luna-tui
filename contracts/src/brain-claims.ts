// The claim: what a model learns enters the company brain as one statement with the exact quote it rests on (RFC 0010, "Remember").
// Code checks the quote, a Jev decision pack (`memory_admit`) judges the claim, and a person decides only when the risk is high or Jev is unsure.
import { z } from "zod";

import type { Verdict } from "./questions.ts";

export const ClaimKind = z.enum(["fact", "pattern", "decision", "risk"]);
export type ClaimKind = z.infer<typeof ClaimKind>;
export const ClaimScope = z.enum(["repo", "org"]);
export type ClaimScope = z.infer<typeof ClaimScope>;

/** What a pack hands over to remember: one statement and the exact words it rests on. The machine checks the quote. */
export const ClaimDraft = z.object({
  statement: z.string().min(12).max(300),
  quote: z.string().min(8).max(500),
  kind: ClaimKind,
  scope: ClaimScope,
});
export type ClaimDraft = z.infer<typeof ClaimDraft>;

/** `refused` is a claim the code checks turned away: it never reaches the graph. */
export const ClaimStatus = z.enum(["unverified", "verified", "rejected", "refused"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;
export const ClaimTier = z.enum(["low", "medium", "high"]);
export type ClaimTier = z.infer<typeof ClaimTier>;
/** What admission comes to for a claim: verify it, verify it and flag it, ask the person, or reject it. */
export const ClaimOutcome = z.enum(["verify", "flag", "ask", "reject"]);
export type ClaimOutcome = z.infer<typeof ClaimOutcome>;
export const ClaimSpeakerTrust = z.enum(["owner", "member", "outside", "machine"]);
export type ClaimSpeakerTrust = z.infer<typeof ClaimSpeakerTrust>;

/** A claim as the machine keeps it and the board shows it (`GET /brain/claims`). */
export const BrainClaim = z.object({
  id: z.string().min(1),
  /** The repository's slug and path; null for a claim about the whole org with no repository. */
  repo: z.string().nullable(),
  repoPath: z.string().nullable(),
  taskId: z.string().nullable(),
  statement: z.string(),
  quote: z.string(),
  kind: ClaimKind,
  scope: ClaimScope,
  source: z.object({ kind: z.enum(["card", "note"]), ref: z.string(), title: z.string() }),
  /** The GitHub login of who said it, when a person did. */
  speaker: z.string().nullable(),
  speakerTrust: ClaimSpeakerTrust,
  /** The pack that extracted it, or "person" for a person's own note. */
  extractor: z.string(),
  status: ClaimStatus,
  /** Why the code checks refused it; null otherwise. */
  refusal: z.string().nullable(),
  tier: ClaimTier.nullable(),
  /** What Jev's answer and the code rules come to. In shadow it is recorded and a person still decides. */
  proposed: ClaimOutcome.nullable(),
  /** The code rules that make it the person's whatever Jev says. */
  reasons: z.array(z.string()),
  /** Whether it still holds for the next card: a verified claim becomes a lesson only when this is true. */
  durable: z.boolean().nullable(),
  /** The ids of the claims it contradicts. */
  contradicts: z.array(z.string()),
  /** The decision record of memory_admit's answer, for the truth a person's decision gives it. */
  recordId: z.string().nullable(),
  decidedBy: z.enum(["code", "jev", "person"]).nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type BrainClaim = z.infer<typeof BrainClaim>;

/** What a repository shows in shadow before Jev decides alone (RFC 0010): this many claims decided by the person, this share of them as Jev would have, and none that Jev would have verified and the person rejected. */
export const SHADOW_BAR = { decided: 50, agreement: 0.95 } as const;

export function shadowReady(stats: { decided: number; agreed: number; missed: number }): boolean {
  return stats.decided >= SHADOW_BAR.decided && stats.agreed / stats.decided >= SHADOW_BAR.agreement && stats.missed === 0;
}

/** What happened without the person since a date, and what needs a look (`GET /brain/digest`). */
export const BrainDigest = z.object({
  since: z.string(),
  /** Claims Jev verified alone, the flagged ones first. */
  verified: z.array(BrainClaim),
  /** Claims Jev rejected alone. */
  rejected: z.array(BrainClaim),
  /** Lessons that rest on a claim that was rejected since. */
  atRisk: z.array(z.object({ learning: z.string(), title: z.string(), claim: z.string() })),
  /** Pairs of claims that say opposite things, with neither rejected. */
  contested: z.array(z.object({ claim: z.string(), says: z.string(), contradicts: z.string(), against: z.string() })),
  /** Why the two lists above may be short: the graph did not answer or the brain is off, so they are unknown, not empty. Null when it answered. */
  note: z.string().nullable().default(null),
});
export type BrainDigest = z.infer<typeof BrainDigest>;

const RISKY_WORDS = [
  "compliance", "soc2", "soc 2", "hipaa", "gdpr", "lgpd", "privacy", "security", "vulnerability", "vulnerabilities", "cve", "secret", "secrets",
  "credential", "credentials", "token", "password", "access", "permission", "permissions", "incident", "breach", "outage", "pii", "phi",
];
// A word of its own, or its plural ("tokens", "breaches"): any other letter or digit on either side means it is part of a longer
// word ("tokenizer", "accessibility").
const RISKY = new RegExp(`(?<![\\p{L}\\p{N}])(?:${RISKY_WORDS.join("|").replace(/ /g, "\\s")})(?:es|s)?(?![\\p{L}\\p{N}])`, "iu");

/** The code rules that make a claim the person's whatever Jev says (RFC 0010, "Always the person's"). Empty when none fires. */
export function claimHighRiskReasons(claim: { statement: string; quote: string; scope: ClaimScope; speakerTrust: ClaimSpeakerTrust }): string[] {
  const reasons: string[] = [];
  if (claim.scope === "org") reasons.push("applies to the whole org");
  if (claim.speakerTrust === "outside") reasons.push("its source was written by someone outside the org");
  if (RISKY.test(claim.statement) || RISKY.test(claim.quote)) reasons.push("about compliance, security, access or an incident");
  return reasons;
}

const YESNO = ["supported", "durable", "scope_fits", "is_statement"] as const;
const SLOTS = [1, 2, 3, 4, 5] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A yes/no question's value, or undefined when the answer is missing or malformed. */
const yesno = (answer: Record<string, unknown>, name: string): boolean | undefined => {
  const q = answer[name];
  return isRecord(q) && typeof q.value === "boolean" ? q.value : undefined;
};
const choiceOf = (answer: Record<string, unknown>, name: string): string | undefined => {
  const q = answer[name];
  return isRecord(q) && typeof q.choice === "string" ? q.choice : undefined;
};
const scoreOf = (answer: Record<string, unknown>): number | undefined => {
  const q = answer.risk;
  return isRecord(q) && typeof q.score === "number" && Number.isFinite(q.score) ? q.score : undefined;
};

/**
 * What admission comes to. Pure: the machine applies it in auto mode and only records it in shadow. `similar` is how many similar
 * claims the pack was shown: an answer that names a duplicate or a contradiction in a slot that held none is a confused answer,
 * so it asks and never rejects or links.
 */
export function admissionOutcome(input: { answer: Record<string, unknown>; verdicts: Record<string, Verdict>; reasons: string[]; similar: number }): {
  outcome: ClaimOutcome;
  tier: ClaimTier;
  durable: boolean | null;
  contradicts: number[];
  duplicateOf: number | null;
} {
  const { answer, reasons } = input;
  const answerShape = isRecord(answer) ? answer : {};
  // A question that is missing or malformed is one the code cannot trust: it counts as ask.
  const wellFormed = (name: string): boolean =>
    name === "risk" ? scoreOf(answerShape) !== undefined : name.startsWith("relation_") ? choiceOf(answerShape, name) !== undefined : yesno(answerShape, name) !== undefined;
  const verdict = (name: string): Verdict => (wellFormed(name) ? (input.verdicts[name] ?? "ask") : "ask");
  const names = [...YESNO, "risk", ...SLOTS.map((n) => `relation_${n}`)];

  const score = scoreOf(answerShape);
  const tier: ClaimTier = verdict("risk") === "ask" || score === undefined ? "high" : (["low", "medium", "high"] as const)[Math.min(2, Math.max(0, Math.round(score)))]!;

  const shown = SLOTS.filter((n) => n <= input.similar);
  const offSlot = SLOTS.some((n) => n > input.similar && choiceOf(answerShape, `relation_${n}`) !== undefined && choiceOf(answerShape, `relation_${n}`) !== "unrelated");
  const contradicts = shown.filter((n) => choiceOf(answerShape, `relation_${n}`) === "contradicts");
  const duplicateOf = shown.find((n) => choiceOf(answerShape, `relation_${n}`) === "duplicate" && verdict(`relation_${n}`) === "proceed") ?? null;

  const durable = verdict("durable") !== "ask" ? (yesno(answerShape, "durable") ?? null) : null;
  const result = (outcome: ClaimOutcome) => ({ outcome, tier, durable, contradicts: [...contradicts], duplicateOf });

  const confidentNo = (name: string) => verdict(name) === "proceed" && yesno(answerShape, name) === false;
  if (confidentNo("supported") || confidentNo("is_statement") || duplicateOf !== null) return result("reject");

  const duplicateNotTaken = shown.some((n) => choiceOf(answerShape, `relation_${n}`) === "duplicate");
  if (
    reasons.length > 0 ||
    offSlot ||
    contradicts.length > 0 ||
    yesno(answerShape, "scope_fits") === false ||
    tier === "high" ||
    names.some((name) => verdict(name) === "ask") ||
    yesno(answerShape, "supported") === false ||
    yesno(answerShape, "is_statement") === false ||
    duplicateNotTaken
  ) {
    return result("ask");
  }

  if (tier === "medium" || names.some((name) => verdict(name) === "flag")) return result("flag");
  return result("verify");
}
