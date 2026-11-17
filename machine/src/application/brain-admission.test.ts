import { PACKS, type AdmitContext, type BrainClaim, type ClaimDraft } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { admission, admitModeFor, type AdmissionDeps, type ClaimOrigin } from "./brain-admission.ts";
import type { ClaimPatch, ClaimStore, NewClaim } from "./brain-claims.ts";
import { type Brain, type BrainAnswer } from "./brain.ts";
import { tagged } from "./decision-truth.ts";

const SOURCE = "The retro reads the card diff. Then it writes the lessons it learned from the run.";
const draft = (over: Partial<ClaimDraft> = {}): ClaimDraft => ({ statement: "The retro stage reads the card's diff.", quote: "The retro reads the card diff.", kind: "fact", scope: "repo", ...over });
const origin = (over: Partial<ClaimOrigin> = {}): ClaimOrigin => ({
  taskId: "t1", repoPath: "/r/a", extractor: "retro", source: { kind: "card", ref: "t1", title: "A card" }, sourceText: SOURCE, speaker: null, speakerTrust: "member", ...over,
});

/** A store in memory, with the same unique rule as the table. */
function fakeStore(): ClaimStore & { all: BrainClaim[] } {
  const all: BrainClaim[] = [];
  let n = 0;
  return {
    all,
    add: async (c: NewClaim) => {
      if (all.some((x) => x.source.kind === c.source.kind && x.source.ref === c.source.ref && x.statement === c.statement)) return null;
      const claim: BrainClaim = { ...c, id: `c${++n}`, tier: null, proposed: null, durable: null, contradicts: [], recordId: null, decidedBy: null, decidedAt: null, createdAt: "2026-01-01T00:00:00.000Z" };
      all.push(claim);
      return { ...claim };
    },
    get: async (id) => all.find((c) => c.id === id) ?? null,
    findBySource: async (s, statement) => all.find((c) => c.source.kind === s.kind && c.source.ref === s.ref && c.statement === statement) ?? null,
    list: async () => [...all].reverse(),
    update: async (id, patch: ClaimPatch, options) => {
      const claim = all.find((c) => c.id === id);
      if (!claim) return null;
      if (options?.ifStatus && claim.status !== options.ifStatus) return null;
      const { durable, ...rest } = patch;
      Object.assign(claim, options?.keepDurable && claim.durable !== null ? rest : { ...rest, ...(durable === undefined ? {} : { durable }) });
      return { ...claim };
    },
    stats: async () => ({ waiting: 0, decided: 0, agreed: 0, missed: 0, ready: false }),
    delete: async () => false,
    forgetSpeaker: async () => 0,
  };
}

const brainOf = (rows: Array<Record<string, string>>, fails = false, note: string | null = null): Brain & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    enabled: true,
    health: async () => ({ ok: true, version: null, note: null }),
    load: async () => ({ entities: 0, commit: null }),
    query: async (name, params) => {
      asked.push(`${name}:${params?.repo}:${params?.q}`);
      if (fails) throw new Error("graph down");
      return { rows, note } satisfies BrainAnswer;
    },
    unlink: async () => 0,
    remove: async () => 0,
    reset: async () => {},
  };
};

const yes = (value: boolean) => ({ value, p: 0.95 });
/** An answer memory_admit could give: everything sure, low risk, no relation to any similar claim. */
const answer = (over: Record<string, unknown> = {}) => ({
  supported: yes(true), durable: yes(true), scope_fits: yes(true), is_statement: yes(true), risk: { score: 0, confidence: 0.95 },
  ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`relation_${n}`, { choice: "unrelated", confidence: 0.95 }])), ...over,
});

function setup(over: Partial<AdmissionDeps> = {}) {
  const store = fakeStore();
  const brain = brainOf([]);
  const seen: AdmitContext[] = [];
  let changed = 0;
  const logs: string[] = [];
  const deps: AdmissionDeps = {
    store, brain, decide: async (admit) => (seen.push(admit), tagged({ answer: answer(), recordId: "rec-1" })), mode: async () => "auto", repoSlug: (p) => `slug-${p.split("/").pop()}`,
    changed: () => void changed++, now: () => new Date("2026-05-05T00:00:00.000Z"), log: (line) => void logs.push(line), ...over,
  };
  return { store, brain, seen, logs, changed: () => changed, a: admission(deps), deps };
}

describe("admission.propose", () => {
  it("stores nothing in mode off", async () => {
    const t = setup({ mode: async () => "off" });
    expect(await t.a.propose([draft()], origin())).toEqual([]);
    expect(t.store.all).toEqual([]);
    expect(t.changed()).toBe(0);
  });

  it("stores a refused draft as refused and never asks the pack", async () => {
    const t = setup();
    const [claim] = await t.a.propose([draft({ quote: "a line the card never held" })], origin());
    expect(claim).toMatchObject({ status: "refused", refusal: "the quote is not in its source, word for word", proposed: null });
    expect(t.seen).toEqual([]);
    expect(t.changed()).toBe(1);
    const [email] = await t.a.propose([draft({ statement: "Write to ana@example.com for the keys." })], origin());
    expect(email!.status).toBe("refused");
    // the journal keeps the refusal, never what it was refused for
    expect(email!.statement).toBe("Write to [email] for the keys.");
    const [secret] = await t.a.propose([draft({ statement: "The deploy key is sk-abcdefghijklmnopqrstuvwx in the vault." })], origin());
    expect(secret).toMatchObject({ status: "refused", refusal: "it holds what looks like a secret" });
    expect(JSON.stringify(secret)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("skips a draft the same source already handed over", async () => {
    const t = setup();
    await t.a.propose([draft()], origin());
    expect(await t.a.propose([draft()], origin())).toEqual([]);
    expect(t.store.all).toHaveLength(1);
  });

  it("hands the pack the excerpt and the similar claims in order, without the claim itself", async () => {
    const brain = brainOf([
      { claim: "claim:c1", status: "verified", statement: "First." },
      { claim: "claim:other", status: "rejected", statement: "Second." },
    ]);
    const t = setup({ brain });
    await t.a.propose([draft()], origin());
    expect(brain.asked).toEqual(["similar_claims:repo:slug-a:The retro stage reads the card's diff."]);
    expect(t.seen[0]).toEqual({
      claim: { statement: "The retro stage reads the card's diff.", quote: "The retro reads the card diff.", kind: "fact", scope: "repo", extractor: "retro" },
      source: { kind: "card", title: "A card", excerpt: SOURCE },
      similar: [{ id: "other", statement: "Second.", status: "rejected" }],
    });
    const four = brainOf([1, 2, 3, 4, 5, 6, 7].map((n) => ({ claim: `claim:s${n}`, status: "verified", statement: `S${n}` })));
    const u = setup({ brain: four });
    await u.a.propose([draft()], origin());
    expect(u.seen[0]!.similar.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("in auto mode, verifies a verify, verifies a flag, rejects a reject and leaves an ask waiting", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["verify", {}, "verified", "verify"],
      ["flag", { risk: { score: 1, confidence: 0.95 } }, "verified", "flag"],
      ["reject", { supported: yes(false) }, "rejected", "reject"],
      ["ask", { risk: { score: 2, confidence: 0.95 } }, "unverified", "ask"],
    ];
    for (const [, over, status, proposed] of cases) {
      const t = setup({ decide: async () => tagged({ answer: answer(over), recordId: "rec-9" }) });
      const [claim] = await t.a.propose([draft()], origin());
      expect(claim).toMatchObject({ status, proposed, recordId: "rec-9" });
      if (status === "unverified") expect(claim).toMatchObject({ decidedBy: null, decidedAt: null });
      else expect(claim).toMatchObject({ decidedBy: "jev", decidedAt: "2026-05-05T00:00:00.000Z" });
    }
    const t = setup();
    expect(((await t.a.propose([draft()], origin()))[0])).toMatchObject({ tier: "low", durable: true, contradicts: [] });
  });

  it("in shadow mode, records Jev's outcome and leaves every claim unverified", async () => {
    for (const over of [{}, { supported: yes(false) }, { risk: { score: 2, confidence: 0.95 } }]) {
      const t = setup({ mode: async () => "shadow", decide: async () => tagged({ answer: answer(over) }) });
      const [claim] = await t.a.propose([draft()], origin());
      expect(claim).toMatchObject({ status: "unverified", decidedBy: null, decidedAt: null });
      expect(claim!.proposed).not.toBeNull();
    }
  });

  it("holds the code's reasons and sends such a claim to the person even in auto", async () => {
    const t = setup();
    const [claim] = await t.a.propose([draft()], origin({ speakerTrust: "outside" }));
    expect(claim).toMatchObject({ status: "unverified", proposed: "ask", reasons: ["its source was written by someone outside the org"] });
  });

  it("holds a claim whose quote is only the ticket's own words for the person, even when Jev says verify", async () => {
    const reason = "its quote is the ticket's own words";
    const t = setup();
    const [claim] = await t.a.propose([draft({ quote: "Make the nightly sync idempotent", statement: "The nightly sync is meant to be idempotent." })], origin({ sourceText: SOURCE, ticketText: "Make the nightly sync idempotent" }));
    expect(claim).toMatchObject({ status: "unverified", proposed: "ask", reasons: [reason], decidedBy: null });
    expect(t.seen[0]!.source.excerpt).toBe("Make the nightly sync idempotent");
    // a quote the evidence holds carries no such reason, and one found in neither is refused
    const [fine] = await t.a.propose([draft()], origin({ sourceText: SOURCE, ticketText: "Make the nightly sync idempotent" }));
    expect(fine).toMatchObject({ status: "verified", reasons: [] });
    const [none] = await t.a.propose([draft({ statement: "The template asks for a rules block.", quote: "return the rules text in the JSON" })], origin({ sourceText: SOURCE, ticketText: "Make the nightly sync idempotent" }));
    expect(none).toMatchObject({ status: "refused", refusal: "the quote is not in its source, word for word" });
  });

  it("keeps a claim waiting when the pack throws, and logs no claim text", async () => {
    const t = setup({ decide: async () => { throw new Error(`could not read "The retro stage reads the card's diff."`); } });
    const [claim] = await t.a.propose([draft()], origin());
    expect(claim).toMatchObject({ status: "unverified", proposed: null });
    expect(t.logs.length).toBeGreaterThan(0);
    expect(t.logs.join("\n")).not.toContain("retro stage");
    expect(t.logs.join("\n")).not.toContain("card diff");
  });

  it("leaves the claim with the person when no pack runs", async () => {
    const none = setup({ decide: null });
    expect((await none.a.propose([draft()], origin()))[0]).toMatchObject({ status: "unverified", proposed: null });
  });

  it("asks the person when the similar claims could not be read, and still runs the pack with none", async () => {
    const reason = "the similar claims could not be read";
    const unread: Array<[string, Brain]> = [
      ["a query that throws", brainOf([], true)],
      ["an answer with a failure note", brainOf([], false, "similar_claims failed: HTTP 503")],
      ["a brain that is off", { ...brainOf([]), enabled: false }],
    ];
    for (const [why, brain] of unread) {
      const t = setup({ brain });
      const [claim] = await t.a.propose([draft()], origin());
      expect(claim, why).toMatchObject({ status: "unverified", proposed: "ask", reasons: [reason] });
      expect(t.store.all[0]!.reasons, why).toEqual([reason]);
      expect(t.seen[0]!.similar, why).toEqual([]);
    }
    // an empty answer is an answer: nothing is similar, and the claim goes on as before
    const empty = setup({ brain: brainOf([], false, "similar_claims found nothing") });
    expect((await empty.a.propose([draft()], origin()))[0]).toMatchObject({ status: "verified", reasons: [] });
  });

  it("keeps the reasons the code found beside the one for similar claims it could not read", async () => {
    const t = setup({ brain: brainOf([], true) });
    const [claim] = await t.a.propose([draft()], origin({ speakerTrust: "outside" }));
    expect(claim!.reasons).toEqual(["its source was written by someone outside the org", "the similar claims could not be read"]);
  });

  it("compares a claim with its own repository's claims only, and a claim of no repository with nothing", async () => {
    const brain = brainOf([{ claim: "claim:other", status: "verified", statement: "Other." }]);
    const t = setup({ brain });
    await t.a.propose([draft()], origin({ repoPath: "/r/b" }));
    expect(brain.asked).toEqual(["similar_claims:repo:slug-b:The retro stage reads the card's diff."]);
    const org = setup({ brain });
    brain.asked.length = 0;
    const [claim] = await org.a.propose([draft({ scope: "org" })], origin({ repoPath: null }));
    expect(brain.asked).toEqual([]);
    expect(org.seen[0]!.similar).toEqual([]);
    // nothing to compare is not a read that failed: only the org scope holds it for the person
    expect(claim).toMatchObject({ proposed: "ask", reasons: ["applies to the whole org"] });
  });

  it("asks, never rejects, on a duplicate of a claim that is not verified", async () => {
    const dup = answer({ relation_1: { choice: "duplicate", confidence: 0.95 } });
    for (const [status, outcome] of [["verified", "reject"], ["unverified", "ask"], ["rejected", "ask"]] as const) {
      const t = setup({ brain: brainOf([{ claim: "claim:old", status, statement: "Old." }]), decide: async () => tagged({ answer: dup }) });
      const [claim] = await t.a.propose([draft()], origin());
      expect(claim, status).toMatchObject({ proposed: outcome, status: outcome === "reject" ? "rejected" : "unverified" });
    }
  });

  it("keeps the id of the similar claim the outcome says it contradicts", async () => {
    const brain = brainOf([
      { claim: "claim:aaa", status: "verified", statement: "One." },
      { claim: "claim:bbb", status: "verified", statement: "Two." },
    ]);
    const t = setup({ brain, decide: async () => tagged({ answer: answer({ relation_2: { choice: "contradicts", confidence: 0.95 } }) }) });
    const [claim] = await t.a.propose([draft()], origin());
    expect(claim).toMatchObject({ contradicts: ["bbb"], proposed: "ask", status: "unverified" });
  });

  it("calls changed once per call that stored something", async () => {
    const t = setup();
    await t.a.propose([draft(), draft({ statement: "A second statement about the retro stage.", quote: "Then it writes the lessons" })], origin());
    expect(t.changed()).toBe(1);
    await t.a.propose([draft()], origin());
    expect(t.changed()).toBe(1);
  });

  it("uses the repository's bars", async () => {
    const seenOverrides: unknown[] = [];
    const t = setup({ overrides: async (repoPath) => (seenOverrides.push(repoPath), { risk: { proceed: 0.99 } }) });
    const [claim] = await t.a.propose([draft()], origin());
    expect(seenOverrides).toEqual(["/r/a"]);
    // risk 0 at confidence 0.95 is under a 0.99 bar for proceeding: the risk question is flagged, so the outcome is flag, and nothing failed on the way
    expect(claim).toMatchObject({ proposed: "flag", tier: "low", status: "verified", decidedBy: "jev" });
    expect(t.logs).toEqual([]);
    expect(PACKS.memory_admit.kind).toBe("decision");
  });
});

describe("admission.propose, a person deciding while the pack runs", () => {
  it("keeps the person's rejection and records Jev's reading beside it", async () => {
    const t = setup({
      decide: async () => {
        const waiting = t.store.all[0]!;
        Object.assign(waiting, { status: "rejected", decidedBy: "person", decidedAt: "2026-05-04T00:00:00.000Z" });
        return tagged({ answer: answer(), recordId: "rec-1" });
      },
    });
    const [claim] = await t.a.propose([draft()], origin());
    expect(claim).toMatchObject({ status: "rejected", decidedBy: "person", decidedAt: "2026-05-04T00:00:00.000Z", proposed: "verify", recordId: "rec-1" });
    expect(t.store.all[0]).toMatchObject({ status: "rejected", decidedBy: "person", proposed: "verify", tier: expect.any(String) });
  });
});

describe("admission.propose, a person deciding while the pack runs: durable", () => {
  it("leaves the person's durable alone when Jev's status update loses", async () => {
    const t = setup({
      decide: async () => {
        Object.assign(t.store.all[0]!, { status: "rejected", decidedBy: "person", durable: false });
        return tagged({ answer: answer({ durable: yes(true) }) });
      },
    });
    const [claim] = await t.a.propose([draft()], origin());
    expect(claim).toMatchObject({ status: "rejected", decidedBy: "person", durable: false, proposed: "verify" });
  });
});

describe("admitModeFor", () => {
  it("is off when the brain is off, whatever the file says, and without reading it", async () => {
    let read = 0;
    const configured = (mode: "off" | "shadow" | "auto") => async () => (read++, mode);
    expect(await admitModeFor(false, configured("auto"))).toBe("off");
    expect(read).toBe(0);
    expect(await admitModeFor(true, configured("auto"))).toBe("auto");
    expect(await admitModeFor(true, configured("shadow"))).toBe("shadow");
    expect(await admitModeFor(true, configured("off"))).toBe("off");
  });
});

describe("admission.remember", () => {
  const note = "The nightly job runs at two in the morning.";
  it("verifies a good note at once without asking the pack", async () => {
    const t = setup({ mode: async () => "off" });
    const claim = await t.a.remember(`  ${note}  `, { repoPath: "/r/a", speaker: null });
    expect(claim).toMatchObject({ statement: note, quote: note, kind: "fact", scope: "repo", status: "verified", decidedBy: "person", durable: true, extractor: "person", speakerTrust: "owner", source: { kind: "note", title: "A note" }, repo: "slug-a", repoPath: "/r/a" });
    expect(t.seen).toEqual([]);
    expect(t.changed()).toBe(1);
    expect((await t.a.remember(`${note} `, { repoPath: "/r/a", speaker: null })).id).toBe(claim.id);
    expect(t.store.all).toHaveLength(1);
    expect(t.changed()).toBe(1);
  });

  it("gives a note with no repository the org scope", async () => {
    const t = setup();
    expect(await t.a.remember(note, { repoPath: null, speaker: "Ana" })).toMatchObject({ scope: "org", repo: null, speaker: "Ana" });
  });

  it("refuses a note with an email address, one too short and one too long", async () => {
    const t = setup();
    const email = await t.a.remember("Ask ana@example.com about the deploy keys.", { repoPath: null, speaker: null });
    expect(email).toMatchObject({ status: "refused" });
    expect(email.refusal).toContain("personal data");
    expect(JSON.stringify(email)).not.toContain("ana@example.com");
    // the same refused note again is the same claim, not a second row
    expect((await t.a.remember("Ask ana@example.com about the deploy keys.", { repoPath: null, speaker: null })).id).toBe(email.id);
    expect(await t.a.remember("too short", { repoPath: null, speaker: null })).toMatchObject({ status: "refused" });
    expect(await t.a.remember("x ".repeat(200), { repoPath: null, speaker: null })).toMatchObject({ status: "refused" });
    expect(t.seen).toEqual([]);
  });
});

describe("admission.settle", () => {
  const waiting = async () => {
    const t = setup({ mode: async () => "shadow", decide: async () => tagged({ answer: answer({ durable: yes(false) }) }) });
    const [claim] = await t.a.propose([draft()], origin());
    return { t, claim: claim! };
  };

  it("verifies a waiting claim, keeping Jev's durable", async () => {
    const { t, claim } = await waiting();
    const before = t.changed();
    expect(await t.a.settle(claim.id, "verify")).toEqual({ claim: expect.objectContaining({ status: "verified", durable: false, decidedBy: "person", decidedAt: "2026-05-05T00:00:00.000Z" }) });
    expect(t.changed()).toBe(before + 1);
  });

  it("makes durable true when Jev set none, and rejects on reject", async () => {
    const t = setup({ decide: null });
    const [a, b] = await t.a.propose([draft(), draft({ statement: "A second statement about the retro stage.", quote: "Then it writes the lessons" })], origin());
    expect(await t.a.settle(a!.id, "verify")).toEqual({ claim: expect.objectContaining({ status: "verified", durable: true }) });
    expect(await t.a.settle(b!.id, "reject")).toEqual({ claim: expect.objectContaining({ status: "rejected", decidedBy: "person" }) });
  });

  it("keeps the durable Jev's reading set between the read and the verify", async () => {
    const t = setup({ mode: async () => "shadow", decide: null });
    const [claim] = await t.a.propose([draft()], origin());
    const read = t.store.get;
    t.store.get = async (id) => {
      const seen = { ...(await read(id))! };
      // Jev's reading lands after the tap read the claim.
      Object.assign(t.store.all[0]!, { durable: false });
      return seen;
    };
    expect(await t.a.settle(claim!.id, "verify")).toEqual({ claim: expect.objectContaining({ status: "verified", durable: false }) });
  });

  it("answers not_waiting to the tap that lost a race with another decision", async () => {
    const { t, claim } = await waiting();
    const read = t.store.get;
    t.store.get = async (id) => {
      const seen = { ...(await read(id))! };
      // Another tap lands between the read and the write.
      Object.assign(t.store.all[0]!, { status: "verified", decidedBy: "person" });
      return seen;
    };
    expect(await t.a.settle(claim.id, "reject")).toEqual({ problem: "not_waiting" });
    expect(t.store.all[0]).toMatchObject({ status: "verified", decidedBy: "person" });
  });

  it("answers not_waiting for a decided claim and not_found for an unknown id", async () => {
    const { t, claim } = await waiting();
    await t.a.settle(claim.id, "reject");
    expect(await t.a.settle(claim.id, "reject")).toEqual({ problem: "not_waiting" });
    expect(await t.a.settle("nope", "verify")).toEqual({ problem: "not_found" });
  });

  it("answers not_waiting for a refused claim and for the status already asked for", async () => {
    const t = setup({ mode: async () => "auto" });
    const [refused] = await t.a.propose([draft({ quote: "a quote the source does not hold" })], origin());
    expect(refused!.status).toBe("refused");
    expect(await t.a.settle(refused!.id, "verify")).toEqual({ problem: "not_waiting" });
    expect(await t.a.settle(refused!.id, "reject")).toEqual({ problem: "not_waiting" });
    const [verified] = await t.a.propose([draft({ statement: "A second statement about the retro stage.", quote: "Then it writes the lessons" })], origin());
    expect(verified).toMatchObject({ status: "verified", decidedBy: "jev" });
    expect(await t.a.settle(verified!.id, "verify")).toEqual({ problem: "not_waiting" });
  });

  it("lets a person reject what Jev verified alone, keeping Jev's proposal for the stats", async () => {
    const t = setup({ mode: async () => "auto" });
    const [claim] = await t.a.propose([draft()], origin());
    expect(claim).toMatchObject({ status: "verified", decidedBy: "jev", proposed: "verify", durable: true });
    const before = t.changed();
    expect(await t.a.settle(claim!.id, "reject")).toEqual({ claim: expect.objectContaining({ status: "rejected", decidedBy: "person", decidedAt: "2026-05-05T00:00:00.000Z", proposed: "verify", durable: true }) });
    expect(t.changed()).toBe(before + 1);
  });

  it("lets a person verify what Jev rejected alone, with durable true when it was null", async () => {
    const t = setup({ mode: async () => "auto", decide: async () => tagged({ answer: answer({ supported: yes(false) }) }) });
    const [claim] = await t.a.propose([draft()], origin());
    expect(claim).toMatchObject({ status: "rejected", decidedBy: "jev", proposed: "reject", durable: true });
    expect(await t.a.settle(claim!.id, "verify")).toEqual({ claim: expect.objectContaining({ status: "verified", durable: true, decidedBy: "person", decidedAt: "2026-05-05T00:00:00.000Z", proposed: "reject" }) });
    const bare = setup({ decide: null });
    const [noted] = await bare.a.propose([draft()], origin());
    await bare.store.update(noted!.id, { status: "rejected", decidedBy: "jev" });
    expect(await bare.a.settle(noted!.id, "verify")).toEqual({ claim: expect.objectContaining({ status: "verified", durable: true }) });
  });

});
