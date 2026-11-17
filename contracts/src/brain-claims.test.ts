import { describe, expect, it } from "vitest";

import { BrainClaim, ClaimDraft, ClaimKind, ClaimOutcome, ClaimScope, ClaimSpeakerTrust, ClaimStatus, ClaimTier, BrainDigest, SHADOW_BAR, admissionOutcome, claimHighRiskReasons, shadowReady } from "./brain-claims.ts";
import type { Verdict } from "./questions.ts";

const draft = { statement: "The e2e suite needs the seed command first.", quote: "e2e failed until we ran seed", kind: "fact", scope: "repo" };

describe("the claim's schemas", () => {
  it("takes a draft within the bounds and refuses one outside them", () => {
    expect(ClaimDraft.safeParse(draft).success).toBe(true);
    expect(ClaimDraft.safeParse({ ...draft, statement: "too short" }).success).toBe(false);
    expect(ClaimDraft.safeParse({ ...draft, statement: "x".repeat(301) }).success).toBe(false);
    expect(ClaimDraft.safeParse({ ...draft, quote: "short" }).success).toBe(false);
    expect(ClaimDraft.safeParse({ ...draft, quote: "q".repeat(501) }).success).toBe(false);
    expect(ClaimDraft.safeParse({ ...draft, kind: "rule" }).success).toBe(false);
    expect(ClaimDraft.safeParse({ ...draft, scope: "team" }).success).toBe(false);
  });

  it("names the enums", () => {
    expect(ClaimKind.options).toEqual(["fact", "pattern", "decision", "risk"]);
    expect(ClaimScope.options).toEqual(["repo", "org"]);
    expect(ClaimStatus.options).toEqual(["unverified", "verified", "rejected", "refused"]);
    expect(ClaimTier.options).toEqual(["low", "medium", "high"]);
    expect(ClaimOutcome.options).toEqual(["verify", "flag", "ask", "reject"]);
    expect(ClaimSpeakerTrust.options).toEqual(["owner", "member", "outside", "machine"]);
  });

  it("parses a claim as the machine keeps it", () => {
    const claim = {
      id: "c1", repo: null, repoPath: null, taskId: null, ...draft, source: { kind: "card", ref: "t1", title: "A card" }, speaker: null, speakerTrust: "machine", extractor: "reviewing_memory",
      status: "unverified", refusal: null, tier: null, proposed: null, reasons: [], durable: null, contradicts: [], recordId: null, decidedBy: null, decidedAt: null, createdAt: "2026-11-16T00:00:00Z",
    };
    expect(BrainClaim.safeParse(claim).success).toBe(true);
    expect(BrainClaim.safeParse({ ...claim, status: "maybe" }).success).toBe(false);
  });
});

describe("claimHighRiskReasons", () => {
  const base = { statement: "The e2e suite needs the seed command first.", quote: "e2e failed until we ran seed", scope: "repo", speakerTrust: "member" } as const;

  it("is empty when no rule fires", () => {
    expect(claimHighRiskReasons(base)).toEqual([]);
  });

  it("flags the whole org", () => {
    expect(claimHighRiskReasons({ ...base, scope: "org" })).toEqual(["applies to the whole org"]);
  });

  it("flags a source from outside the org, and not the other trusts", () => {
    expect(claimHighRiskReasons({ ...base, speakerTrust: "outside" })).toEqual(["its source was written by someone outside the org"]);
    for (const trust of ["owner", "member", "machine"] as const) expect(claimHighRiskReasons({ ...base, speakerTrust: trust })).toEqual([]);
  });

  it("flags compliance, security, access or an incident, as a whole word and in any case", () => {
    for (const word of ["compliance", "soc2", "SOC 2", "HIPAA", "gdpr", "lgpd", "privacy", "security", "vulnerability", "vulnerabilities", "CVE", "secret", "secrets", "credential", "credentials", "token", "password", "access", "permission", "permissions", "incident", "breach", "outage", "PII", "phi"]) {
      expect(claimHighRiskReasons({ ...base, statement: `The seed step touches the ${word} here.` }), word).toEqual(["about compliance, security, access or an incident"]);
    }
    expect(claimHighRiskReasons({ ...base, quote: "we hit an Outage on deploy" })).toEqual(["about compliance, security, access or an incident"]);
  });

  it("does not match a word inside another word", () => {
    expect(claimHighRiskReasons({ ...base, statement: "The tokenizer and the philosophy doc need the seed command." })).toEqual([]);
    expect(claimHighRiskReasons({ ...base, statement: "The accessibility tests need the seed command first." })).toEqual([]);
  });

  it("lists every rule that fires, in order", () => {
    expect(claimHighRiskReasons({ statement: "The token is shared across the org here.", quote: "the token is shared", scope: "org", speakerTrust: "outside" })).toEqual([
      "applies to the whole org",
      "its source was written by someone outside the org",
      "about compliance, security, access or an incident",
    ]);
  });
});

describe("admissionOutcome", () => {
  const yes = (value: boolean, p = 0.95) => ({ value, p });
  const rel = (choice: string) => ({ choice, confidence: 0.9 });
  const good = () => ({
    supported: yes(true),
    durable: yes(true),
    scope_fits: yes(true),
    is_statement: yes(true),
    risk: { score: 0.1, confidence: 0.9 },
    relation_1: rel("unrelated"),
    relation_2: rel("unrelated"),
    relation_3: rel("unrelated"),
    relation_4: rel("unrelated"),
    relation_5: rel("unrelated"),
  });
  const allProceed = (): Record<string, Verdict> => Object.fromEntries(Object.keys(good()).map((k) => [k, "proceed" as Verdict]));
  const run = (answer: Record<string, unknown> = good(), verdicts: Record<string, Verdict> = allProceed(), reasons: string[] = []) => admissionOutcome({ answer, verdicts, reasons });

  it("verifies a clean claim, with its durability", () => {
    expect(run()).toEqual({ outcome: "verify", tier: "low", durable: true, contradicts: [], duplicateOf: null });
  });

  it("rounds the risk score to a tier, and a risk verdict of ask makes it high", () => {
    expect(run({ ...good(), risk: { score: 0.49, confidence: 0.9 } }).tier).toBe("low");
    expect(run({ ...good(), risk: { score: 0.5, confidence: 0.9 } }).tier).toBe("medium");
    expect(run({ ...good(), risk: { score: 1.4, confidence: 0.9 } }).tier).toBe("medium");
    expect(run({ ...good(), risk: { score: 1.6, confidence: 0.9 } }).tier).toBe("high");
    expect(run({ ...good(), risk: { score: 0, confidence: 0.2 } }, { ...allProceed(), risk: "ask" })).toMatchObject({ tier: "high", outcome: "ask" });
  });

  it("flags a medium tier or any flag verdict", () => {
    expect(run({ ...good(), risk: { score: 1, confidence: 0.9 } }).outcome).toBe("flag");
    expect(run(good(), { ...allProceed(), durable: "flag" }).outcome).toBe("flag");
    expect(run(good(), { ...allProceed(), relation_3: "flag" }).outcome).toBe("flag");
  });

  it("asks when a code rule fired", () => {
    expect(run(good(), allProceed(), ["applies to the whole org"]).outcome).toBe("ask");
  });

  it("asks when any verdict is ask", () => {
    for (const q of Object.keys(good())) expect(run(good(), { ...allProceed(), [q]: "ask" }).outcome, q).toBe("ask");
  });

  it("asks when the scope does not fit, at any confidence", () => {
    expect(run({ ...good(), scope_fits: yes(false) }).outcome).toBe("ask");
  });

  it("lists every contradiction at any confidence, and asks", () => {
    const answer = { ...good(), relation_2: rel("contradicts"), relation_4: { choice: "contradicts", confidence: 0.2 } };
    expect(run(answer, { ...allProceed(), relation_4: "ask" })).toMatchObject({ outcome: "ask", contradicts: [2, 4] });
    expect(run({ ...good(), relation_1: rel("contradicts") })).toMatchObject({ outcome: "ask", contradicts: [1] });
  });

  it("rejects a confident duplicate and names the first one", () => {
    expect(run({ ...good(), relation_2: rel("duplicate"), relation_4: rel("duplicate") })).toMatchObject({ outcome: "reject", duplicateOf: 2 });
  });

  it("asks about a duplicate it was not confident of", () => {
    expect(run({ ...good(), relation_3: rel("duplicate") }, { ...allProceed(), relation_3: "flag" })).toMatchObject({ outcome: "ask", duplicateOf: null });
  });

  it("rejects a confident unsupported claim and a confident non-statement", () => {
    expect(run({ ...good(), supported: yes(false) }).outcome).toBe("reject");
    expect(run({ ...good(), is_statement: yes(false) }).outcome).toBe("reject");
  });

  it("asks about an unsupported claim or a non-statement it was not confident of", () => {
    expect(run({ ...good(), supported: yes(false, 0.4) }, { ...allProceed(), supported: "flag" }).outcome).toBe("ask");
    expect(run({ ...good(), is_statement: yes(false, 0.4) }, { ...allProceed(), is_statement: "ask" }).outcome).toBe("ask");
  });

  it("lets a reject win over everything: a confident unsupported claim with org scope is rejected, not asked", () => {
    expect(run({ ...good(), supported: yes(false), scope_fits: yes(false), risk: { score: 2, confidence: 0.9 }, relation_1: rel("contradicts") }, allProceed(), ["applies to the whole org"]).outcome).toBe("reject");
  });

  it("gives durable only when its verdict is proceed or flag", () => {
    expect(run({ ...good(), durable: yes(false) }).durable).toBe(false);
    expect(run(good(), { ...allProceed(), durable: "flag" }).durable).toBe(true);
    expect(run(good(), { ...allProceed(), durable: "ask" }).durable).toBeNull();
  });

  it("counts a missing or malformed question as ask, never a throw", () => {
    const { supported: _gone, ...missing } = good();
    expect(run(missing).outcome).toBe("ask");
    expect(run({ ...good(), risk: "high" })).toMatchObject({ outcome: "ask", tier: "high" });
    expect(run({ ...good(), durable: { value: "yes" } })).toMatchObject({ outcome: "ask", durable: null });
    expect(run({ ...good(), relation_5: { choice: 7 } }).outcome).toBe("ask");
    expect(run({}, {}).outcome).toBe("ask");
    expect(run(good(), {}).outcome).toBe("ask");
  });
});

describe("the shadow bar", () => {
  it("is 50 claims decided and 95% agreed", () => {
    expect(SHADOW_BAR).toEqual({ decided: 50, agreement: 0.95 });
  });

  it("is ready at the bar and not before it", () => {
    expect(shadowReady({ decided: 50, agreed: 48, missed: 0 })).toBe(true);
    expect(shadowReady({ decided: 49, agreed: 49, missed: 0 })).toBe(false);
    expect(shadowReady({ decided: 50, agreed: 47, missed: 0 })).toBe(false);
    expect(shadowReady({ decided: 50, agreed: 50, missed: 1 })).toBe(false);
    expect(shadowReady({ decided: 0, agreed: 0, missed: 0 })).toBe(false);
  });
});

describe("BrainDigest", () => {
  it("takes the four lists and refuses a row with a missing column", () => {
    const digest = { since: "2026-05-01T00:00:00.000Z", verified: [], rejected: [], atRisk: [{ learning: "learning:a", title: "A", claim: "claim:x" }], contested: [{ claim: "c1", says: "a", contradicts: "c2", against: "b" }] };
    expect(BrainDigest.safeParse(digest).success).toBe(true);
    expect(BrainDigest.safeParse({ ...digest, atRisk: [{ learning: "learning:a" }] }).success).toBe(false);
  });
});
