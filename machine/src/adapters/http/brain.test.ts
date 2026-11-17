import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { type Brain, type BrainAnswer, noBrain } from "../../application/brain.ts";
import type { ProjectionResult } from "../../application/brain-projector.ts";
import { RunFailedError, type HostRunInput, type PackRunsPort } from "../../application/pack-runs.ts";
import type { BrainClaim, RunResult } from "@hardness/contracts";
import type { Admission } from "../../application/brain-admission.ts";
import { type ClaimStore, noClaims } from "../../application/brain-claims.ts";
import { brainRoutes, trackProjector } from "./brain.ts";

const result = (over: Partial<ProjectionResult> = {}): ProjectionResult => ({ tasks: 1, loaded: 3, skipped: 0, unlinked: 0, hygiene: [], note: null, ...over });

function setup(brain: Brain = noBrain(), now = () => new Date("2026-05-01T00:00:00.000Z")) {
  const calls: string[] = [];
  const projector = trackProjector(
    {
      run: async () => (calls.push("run"), result()),
      rebuild: async () => (calls.push("rebuild"), result({ loaded: 9 })),
    },
    now,
  );
  const app = new Hono();
  brainRoutes(app, { brain, projector });
  return { app, calls };
}

const on: Brain = { ...noBrain(), enabled: true, health: async () => ({ ok: true, version: "0.15.0", note: null }) };

describe("GET /brain/health", () => {
  it("says the brain is off, with no last run", async () => {
    const { app } = setup();
    const res = await app.request("/brain/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, ok: false, version: null, note: "the brain is off", last: null });
  });

  it("gives the server's health and the last projection with its time", async () => {
    const { app } = setup(on);
    await app.request("/brain/project", { method: "POST" });
    expect(await (await app.request("/brain/health")).json()).toEqual({ enabled: true, ok: true, version: "0.15.0", note: null, last: { at: "2026-05-01T00:00:00.000Z", result: result() } });
  });
});

describe("POST /brain/project and /brain/rebuild", () => {
  it("run the projector and answer its result", async () => {
    const { app, calls } = setup(on);
    const project = await app.request("/brain/project", { method: "POST" });
    expect(await project.json()).toEqual(result());
    const rebuild = await app.request("/brain/rebuild", { method: "POST" });
    expect(await rebuild.json()).toEqual(result({ loaded: 9 }));
    expect(calls).toEqual(["run", "rebuild"]);
  });

  it("answer the off result with 200 when the brain is off", async () => {
    const off: ProjectionResult = { ...result(), tasks: 0, loaded: 0, note: "the brain is off" };
    const projector = trackProjector({ run: async () => off, rebuild: async () => off });
    const app = new Hono();
    brainRoutes(app, { brain: noBrain(), projector });
    const res = await app.request("/brain/project", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).note).toBe("the brain is off");
  });
});

describe("POST /brain/ask", () => {
  const cardRow = { card: "card:a", title: "Export CSV", state: "closed", size: "M", risk: "low", est_loc: 40, actual_loc: 55, retries: 1, escalations: 0, opened_at: "2026-10-01T09:00:00.000Z", closed_at: "2026-10-03T17:00:00.000Z" };
  const withCards: Brain = { ...on, query: async (name) => ({ rows: name === "search_cards" ? [cardRow] : [], note: null }) };

  function ask(brain: Brain, first: Record<string, unknown> | Error | null) {
    const calls: Array<{ input: HostRunInput; client: string | null }> = [];
    const runs: PackRunsPort | undefined =
      first === null
        ? undefined
        : {
            run: async (input, client) => {
              calls.push({ input, client });
              if (first instanceof Error) throw first;
              return { answer: first, usage: { model: "m", engine: "claude:haiku", turns: 1, durationMs: 1, costUsd: 0 } } satisfies RunResult;
            },
          };
    const app = new Hono();
    brainRoutes(app, { brain, projector: trackProjector({ run: async () => result(), rebuild: async () => result() }), runs });
    return { calls, post: (body: unknown) => app.request("/brain/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) };
  }

  it("runs brain_ask with the question and the rows, as the board client, and answers the cited rows in full", async () => {
    const { calls, post } = ask(withCards, { known: true, reply: "It shipped.", cites: ["card:a"] });
    const res = await post({ question: "how did the export go?" });
    expect(res.status).toBe(200);
    const row = { slug: "card:a", kind: "card", text: "Export CSV · state closed · size M · risk low · estimated 40 lines · actual 55 lines · retries 1 · escalations 0 · opened 2026-10-01 · closed 2026-10-03" };
    expect(await res.json()).toEqual({ known: true, reply: "It shipped.", cites: [row], dropped: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.client).toBe("board");
    expect(calls[0]!.input).toEqual({ pack: "brain_ask", context: { brainAsk: { question: "how did the export go?", rows: [row] } } });
  });

  it("drops a cite of a row it never showed and reports it", async () => {
    const { post } = ask(withCards, { known: true, reply: "Two cards.", cites: ["card:a", "card:ghost"] });
    const body = await (await post({ question: "x" })).json();
    expect(body.cites.map((c: { slug: string }) => c.slug)).toEqual(["card:a"]);
    expect(body.dropped).toEqual(["card:ghost"]);
    expect(body.known).toBe(true);
  });

  it("answers known false when a claim rests on no row that was shown", async () => {
    const { post } = ask(withCards, { known: true, reply: "Trust me.", cites: ["card:ghost"] });
    expect(await (await post({ question: "x" })).json()).toEqual({ known: false, reply: "Trust me.", cites: [], dropped: ["card:ghost"] });
  });

  it("answers that the brain holds nothing, without running the pack, when no row is found", async () => {
    const { calls, post } = ask(on, { known: true, reply: "x", cites: [] });
    const res = await post({ question: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ known: false, reply: "The brain holds nothing about that yet.", cites: [], dropped: [] });
    expect(calls).toHaveLength(0);
  });

  it("answers 503 brain_down, not that it holds nothing, when the brain is on but its health fails", async () => {
    const down: Brain = { ...on, health: async () => ({ ok: false, version: null, note: "unavailable" }), query: async () => ({ rows: [], note: "unavailable" }) };
    const { calls, post } = ask(down, { known: true, reply: "x", cites: [] });
    const res = await post({ question: "x" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("brain_down");
    expect(calls).toHaveLength(0);
  });

  it("answers 503 brain_off, saying how to turn it on, when the brain is off", async () => {
    const { calls, post } = ask(noBrain(), { known: true, reply: "x", cites: [] });
    const res = await post({ question: "x" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("brain_off");
    expect(body.message).toContain("MACHINE_BRAIN_URL");
    expect(body.message).toContain("pnpm brain");
    expect(calls).toHaveLength(0);
  });

  it("answers 503 agents_off when the machine runs no packs", async () => {
    const res = await ask(withCards, null).post({ question: "x" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("agents_off");
  });

  it("rejects a body with no question, an empty one or a long one", async () => {
    const { calls, post } = ask(withCards, { known: true, reply: "x", cites: [] });
    for (const body of [{}, { question: "" }, { question: "q".repeat(2001) }, { question: 3 }]) expect((await post(body)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 502 brain_ask_failed when the pack fails or gives an answer that is not a brain answer", async () => {
    const failed = await ask(withCards, new RunFailedError("model gave no answer")).post({ question: "x" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: "brain_ask_failed", message: "model gave no answer" });
    const odd = await ask(withCards, { known: "yes" }).post({ question: "x" });
    expect(odd.status).toBe(502);
    expect((await odd.json()).error).toBe("brain_ask_failed");
  });
});

describe("the claim routes", () => {
  const claim = (over: Partial<BrainClaim> = {}): BrainClaim => ({
    id: "c1", repo: "a-1", repoPath: "/r/a", taskId: null, statement: "The queue drains in order.", quote: "drains in order", kind: "fact", scope: "repo", source: { kind: "note", ref: "n", title: "A note" },
    speaker: null, speakerTrust: "owner", extractor: "person", status: "unverified", refusal: null, tier: null, proposed: null, reasons: [], durable: null, contradicts: [], recordId: null, decidedBy: null, decidedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z", ...over,
  });

  function claimsApp(over: { settle?: Admission["settle"]; remember?: Admission["remember"]; speaker?: () => Promise<string | null> } = {}) {
    const listed: unknown[] = [];
    const statsFor: unknown[] = [];
    const settled: Array<[string, string]> = [];
    const remembered: Array<[string, unknown]> = [];
    const claims: ClaimStore = {
      add: async () => null, get: async () => null, findBySource: async () => null, update: async () => null,
      list: async (filter) => (listed.push(filter), [claim()]),
      stats: async (repoPath) => (statsFor.push(repoPath), { waiting: 1, decided: 4, agreed: 3, missed: 1, ready: false }),
    };
    const admission: Admission = {
      propose: async () => [],
      remember: over.remember ?? (async (text, origin) => (remembered.push([text, origin]), claim({ statement: text }))),
      settle: over.settle ?? (async (id, decision) => (settled.push([id, decision]), { claim: claim({ id, status: decision === "verify" ? "verified" : "rejected" }) })),
    };
    const projector = trackProjector({ run: async () => result(), rebuild: async () => result() });
    const app = new Hono();
    brainRoutes(app, { brain: noBrain(), projector, claims, admission, ...(over.speaker ? { speaker: over.speaker } : {}) });
    return { app, listed, statsFor, settled, remembered };
  }
  const post = (app: Hono, path: string, body?: unknown) => app.request(path, { method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

  it("answer 503 brain_claims_off when the deps are absent", async () => {
    const { app } = setup();
    for (const res of [await app.request("/brain/claims"), await post(app, "/brain/claims/c1/verify"), await post(app, "/brain/claims/c1/reject"), await post(app, "/brain/remember", { text: "a note to keep" })]) {
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("brain_claims_off");
      expect(body.message).toContain("claim journal");
    }
    const only = new Hono();
    brainRoutes(only, { brain: noBrain(), projector: trackProjector({ run: async () => result(), rebuild: async () => result() }), claims: noClaims() });
    expect((await only.request("/brain/claims")).status).toBe(503);
  });

  it("lists the waiting claims by default, with the stats of the same repo", async () => {
    const t = claimsApp();
    const res = await t.app.request("/brain/claims");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claims: [claim()], stats: { waiting: 1, decided: 4, agreed: 3, missed: 1, ready: false } });
    expect(t.listed).toEqual([{ status: "unverified" }]);
    expect(t.statsFor).toEqual([undefined]);
  });

  it("passes the status, repo and limit to the store", async () => {
    const t = claimsApp();
    await t.app.request("/brain/claims?status=refused&repo=%2Fr%2Fa&limit=20");
    expect(t.listed).toEqual([{ status: "refused", repoPath: "/r/a", limit: 20 }]);
    expect(t.statsFor).toEqual(["/r/a"]);
  });

  it("answers 400 invalid_request for an unknown status, a relative repo or a bad limit", async () => {
    const t = claimsApp();
    for (const query of ["status=maybe", "repo=relative%2Fpath", "limit=0", "limit=abc"]) {
      const res = await t.app.request(`/brain/claims?${query}`);
      expect(res.status, query).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
    }
    expect(t.listed).toEqual([]);
  });

  it("verifies and rejects through the admission, with a body or none", async () => {
    const t = claimsApp();
    const verify = await post(t.app, "/brain/claims/c1/verify");
    expect(verify.status).toBe(200);
    expect((await verify.json()).claim).toMatchObject({ id: "c1", status: "verified" });
    const reject = await post(t.app, "/brain/claims/c2/reject", { reason: "stale" });
    expect((await reject.json()).claim).toMatchObject({ id: "c2", status: "rejected" });
    expect((await post(t.app, "/brain/claims/c3/verify", {})).status).toBe(200);
    expect(t.settled).toEqual([["c1", "verify"], ["c2", "reject"], ["c3", "verify"]]);
  });

  it("answers 400 for a reject reason that is not a string", async () => {
    const t = claimsApp();
    expect((await post(t.app, "/brain/claims/c1/reject", { reason: 4 })).status).toBe(400);
    expect(t.settled).toEqual([]);
  });

  it("answers 404 not_found and 409 not_waiting", async () => {
    const missing = claimsApp({ settle: async () => ({ problem: "not_found" }) });
    const gone = await post(missing.app, "/brain/claims/x/verify");
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe("not_found");
    const decided = claimsApp({ settle: async () => ({ problem: "not_waiting" }) });
    const late = await post(decided.app, "/brain/claims/c1/reject");
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe("not_waiting");
  });

  it("remembers a note as the machine's own GitHub login when it is known, and with none when it is not or cannot be read", async () => {
    const known = claimsApp({ speaker: async () => "higor" });
    await post(known.app, "/brain/remember", { text: "The queue drains in order." });
    expect(known.remembered).toEqual([["The queue drains in order.", { repoPath: null, speaker: "higor" }]]);
    for (const speaker of [async () => null, async () => { throw new Error("no token"); }]) {
      const t = claimsApp({ speaker });
      expect((await post(t.app, "/brain/remember", { text: "The queue drains in order." })).status).toBe(200);
      expect(t.remembered).toEqual([["The queue drains in order.", { repoPath: null, speaker: null }]]);
    }
  });

  it("remembers a note with no speaker, also a refused one", async () => {
    const t = claimsApp();
    const res = await post(t.app, "/brain/remember", { text: "  The queue drains in order.  ", repo: "/r/a" });
    expect(res.status).toBe(200);
    expect((await res.json()).claim.statement).toBe("The queue drains in order.");
    expect(t.remembered).toEqual([["The queue drains in order.", { repoPath: "/r/a", speaker: null }]]);
    const refused = claimsApp({ remember: async () => claim({ status: "refused", refusal: "it holds personal data (email)" }) });
    const second = await post(refused.app, "/brain/remember", { text: "Mail ana@example.com now." });
    expect(second.status).toBe(200);
    expect((await second.json()).claim).toMatchObject({ status: "refused", refusal: "it holds personal data (email)" });
  });

  it("answers 400 for a note that is empty, too long or not JSON, and for a relative repo", async () => {
    const t = claimsApp();
    for (const body of [{ text: "" }, { text: "   " }, { text: "x".repeat(2001) }, { text: "ok note here", repo: "rel" }, {}]) {
      expect((await post(t.app, "/brain/remember", body)).status).toBe(400);
    }
    expect((await t.app.request("/brain/remember", { method: "POST", body: "nope" })).status).toBe(400);
    expect(t.remembered).toEqual([]);
  });
});

describe("GET /brain/digest", () => {
  const NOW = new Date("2026-05-10T12:00:00.000Z");
  const jev = (id: string, status: "verified" | "rejected", over: Partial<BrainClaim> = {}): BrainClaim => ({
    id, repo: "a-1", repoPath: "/r/a", taskId: null, statement: `Statement ${id} of the claim.`, quote: "a quote of it", kind: "fact", scope: "repo", source: { kind: "note", ref: "n", title: "A note" },
    speaker: null, speakerTrust: "owner", extractor: "retro", status, refusal: null, tier: "low", proposed: status === "verified" ? "verify" : "reject", reasons: [], durable: true, contradicts: [], recordId: null,
    decidedBy: "jev", decidedAt: "2026-05-09T00:00:00.000Z", createdAt: "2026-05-01T00:00:00.000Z", ...over,
  });

  function digestApp(opts: { verified?: BrainClaim[]; rejected?: BrainClaim[]; brain?: Brain; claims?: boolean } = {}) {
    const listed: unknown[] = [];
    const claims: ClaimStore = {
      ...noClaims(),
      list: async (filter) => (listed.push(filter), (filter?.status === "verified" ? opts.verified : opts.rejected) ?? []),
    };
    const app = new Hono();
    brainRoutes(app, {
      brain: opts.brain ?? noBrain(), projector: trackProjector({ run: async () => result(), rebuild: async () => result() }),
      ...(opts.claims === false ? {} : { claims, admission: { propose: async () => [], remember: async () => jev("n", "verified"), settle: async () => ({ problem: "not_found" }) } }),
      now: () => NOW,
    });
    return { app, listed };
  }

  it("gives what Jev decided alone since the window, flagged verifications first and then newest first", async () => {
    const verified = [
      jev("old-verify", "verified", { decidedAt: "2026-05-05T00:00:00.000Z" }),
      jev("new-verify", "verified", { decidedAt: "2026-05-09T00:00:00.000Z" }),
      jev("old-flag", "verified", { proposed: "flag", decidedAt: "2026-05-06T00:00:00.000Z" }),
      jev("new-flag", "verified", { proposed: "flag", decidedAt: "2026-05-08T00:00:00.000Z" }),
    ];
    const rejected = [jev("r-old", "rejected", { decidedAt: "2026-05-06T00:00:00.000Z" }), jev("r-new", "rejected", { decidedAt: "2026-05-08T00:00:00.000Z" })];
    const t = digestApp({ verified, rejected });
    const res = await t.app.request("/brain/digest");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.since).toBe("2026-05-03T12:00:00.000Z");
    expect(body.verified.map((c: BrainClaim) => c.id)).toEqual(["new-flag", "old-flag", "new-verify", "old-verify"]);
    expect(body.rejected.map((c: BrainClaim) => c.id)).toEqual(["r-new", "r-old"]);
    expect(body.atRisk).toEqual([]);
    expect(body.contested).toEqual([]);
  });

  it("asks the store for Jev's decisions since the window, in the repo, at most 100 kept", async () => {
    const many = Array.from({ length: 150 }, (_, i) => jev(`v${i}`, "verified", { decidedAt: new Date(Date.UTC(2026, 4, 5, 0, i)).toISOString() }));
    const t = digestApp({ verified: many });
    const body = await (await t.app.request("/brain/digest?days=30&repo=%2Fr%2Fa")).json();
    expect(body.since).toBe("2026-04-10T12:00:00.000Z");
    expect(body.verified).toHaveLength(100);
    const since = new Date("2026-04-10T12:00:00.000Z");
    expect(t.listed).toContainEqual({ status: "verified", decidedBy: "jev", decidedSince: since, repoPath: "/r/a", limit: 200 });
    expect(t.listed).toContainEqual({ status: "rejected", decidedBy: "jev", decidedSince: since, repoPath: "/r/a", limit: 200 });
  });

  it("defaults to seven days and sends no repo when none is given", async () => {
    const t = digestApp();
    expect((await (await t.app.request("/brain/digest")).json()).since).toBe("2026-05-03T12:00:00.000Z");
    expect(t.listed[0]).toEqual({ status: "verified", decidedBy: "jev", decidedSince: new Date("2026-05-03T12:00:00.000Z"), limit: 200 });
  });

  it("maps the brain's two queries and skips a row that lacks a column or holds a non-string", async () => {
    const asked: string[] = [];
    const brain: Brain = {
      ...on,
      query: async (name): Promise<BrainAnswer> => {
        asked.push(name);
        if (name === "learnings_at_risk") return { rows: [{ learning: "learning:a", title: "A lesson", claim: "claim:x" }, { learning: "learning:b", title: "No claim" }, { learning: "learning:c", title: 3, claim: "claim:y" }], note: null };
        if (name === "contested_claims") return { rows: [{ claim: "claim:p", says: "yes", contradicts: "claim:q", against: "no" }, { claim: "claim:p", says: null, contradicts: "claim:q", against: "no" }], note: null };
        return { rows: [], note: null };
      },
    };
    const body = await (await digestApp({ brain }).app.request("/brain/digest")).json();
    expect(asked.sort()).toEqual(["contested_claims", "learnings_at_risk"]);
    expect(body.atRisk).toEqual([{ learning: "learning:a", title: "A lesson", claim: "claim:x" }]);
    expect(body.contested).toEqual([{ claim: "claim:p", says: "yes", contradicts: "claim:q", against: "no" }]);
  });

  it("says in a note that the lists are unknown when the graph did not answer or the brain is off, and has no note otherwise", async () => {
    const refusing: Brain = { ...on, query: async () => ({ rows: [], note: "unavailable" }) };
    const failed = await (await digestApp({ brain: refusing }).app.request("/brain/digest")).json();
    expect(failed).toMatchObject({ atRisk: [], contested: [], note: "the graph did not answer: lessons at risk and contested claims are unknown" });
    expect((await (await digestApp().app.request("/brain/digest")).json()).note).toBe("the graph did not answer: lessons at risk and contested claims are unknown");
    const empty: Brain = { ...on, query: async (name) => ({ rows: [], note: `${name} found nothing` }) };
    expect((await (await digestApp({ brain: empty }).app.request("/brain/digest")).json()).note).toBeNull();
  });

  it("leaves the two lists empty when a brain query fails, and still answers", async () => {
    const brain: Brain = { ...on, query: async () => { throw new Error("down"); } };
    const res = await digestApp({ brain }).app.request("/brain/digest");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ atRisk: [], contested: [] });
  });

  it("answers 503 brain_claims_off without the claim journal", async () => {
    const res = await digestApp({ claims: false }).app.request("/brain/digest");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("brain_claims_off");
  });

  it("answers 400 invalid_request for days out of range or not a number, and for a relative repo", async () => {
    const t = digestApp();
    for (const query of ["days=0", "days=91", "days=x", "days=1.5", "repo=rel"]) {
      const res = await t.app.request(`/brain/digest?${query}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
    }
    expect(t.listed).toEqual([]);
  });
});

