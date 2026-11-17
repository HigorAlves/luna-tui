// The brain's routes (RFC 0010): its health with the last projection, and the two commands that run the projector now. With the
// brain off the routes still answer: health says so, and a command answers the projector's own "the brain is off" result.
import { type ApiError, BrainAskAnswer, BrainAskContext, type BrainClaim, type BrainDigest, brainAskCites, ClaimStatus } from "@hardness/contracts";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, z } from "zod";

import { type Brain, noBrain } from "../../application/brain.ts";
import type { Admission } from "../../application/brain-admission.ts";
import { brainEvidence } from "../../application/brain-ask.ts";
import type { ClaimStore } from "../../application/brain-claims.ts";
import { type PackRunsPort, RunFailedError } from "../../application/pack-runs.ts";
import type { ProjectionResult } from "../../application/brain-projector.ts";

export interface TrackedProjector {
  run(): Promise<ProjectionResult>;
  rebuild(): Promise<ProjectionResult>;
  /** The last projection of any kind, with when it ended; null before the first. */
  last(): { at: string; result: ProjectionResult } | null;
}

/** Remembers the last result of a projector, whoever started the run: a close, the clock or a route. */
export function trackProjector(projector: { run(): Promise<ProjectionResult>; rebuild(): Promise<ProjectionResult> }, now: () => Date = () => new Date()): TrackedProjector {
  let last: { at: string; result: ProjectionResult } | null = null;
  const remember = async (job: () => Promise<ProjectionResult>): Promise<ProjectionResult> => {
    const result = await job();
    last = { at: now().toISOString(), result };
    return result;
  };
  return { run: () => remember(() => projector.run()), rebuild: () => remember(() => projector.rebuild()), last: () => last };
}

/** What an app with no brain wired answers. */
export function offBrain(): { brain: Brain; projector: TrackedProjector } {
  const off = noBrain();
  const result: ProjectionResult = { tasks: 0, loaded: 0, skipped: 0, unlinked: 0, hygiene: [], note: "the brain is off" };
  return { brain: off, projector: trackProjector({ run: async () => result, rebuild: async () => result }) };
}

/** `POST /brain/ask`: the person's question. */
const AskInput = z.object({ question: BrainAskContext.shape.question });

/** `GET /brain/claims`: the status defaults to the claims that wait. */
const ClaimsQuery = z.object({
  status: ClaimStatus.default("unverified"),
  repo: z.string().startsWith("/", "repo must be an absolute path").optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
/** `GET /brain/digest`: what Jev did alone in the last `days`. */
const DigestQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  repo: z.string().startsWith("/", "repo must be an absolute path").optional(),
});
const DIGEST_SHOWN = 100;
// The store pages by creation, the digest by decision: read the most it gives, then keep the newest decisions.
const DIGEST_READ = 200;
const DAY_MS = 86_400_000;
const RejectInput = z.object({ reason: z.string().max(1000).optional() });
/** `POST /brain/remember`: a person's own note. */
const RememberInput = z.object({ text: z.string().trim().min(1).max(2000), repo: z.string().startsWith("/", "repo must be an absolute path").optional() });

const fail = (c: Context, status: 400 | 404 | 409 | 502 | 503, error: string, message: string) => c.json<ApiError>({ error, message }, status as ContentfulStatusCode);

export function brainRoutes(app: Hono, deps: { brain: Brain; projector: TrackedProjector; runs?: PackRunsPort; claims?: ClaimStore; admission?: Admission; speaker?: () => Promise<string | null>; now?: () => Date }): void {
  app.get("/brain/health", async (c) => {
    const { ok, version, note } = await deps.brain.health();
    return c.json({ enabled: deps.brain.enabled, ok, version, note, last: deps.projector.last() });
  });
  app.post("/brain/project", async (c) => c.json(await deps.projector.run()));
  app.post("/brain/rebuild", async (c) => c.json(await deps.projector.rebuild()));

  /** One question on the company brain: the machine reads the rows with named queries, the pack answers from them and cites them. A cite of a row it never showed is dropped. */
  app.post("/brain/ask", async (c) => {
    const parsed = AskInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "invalid_request", parsed.error instanceof ZodError ? z.prettifyError(parsed.error) : "body must be JSON with a question");
    const { question } = parsed.data;
    if (!deps.runs) return fail(c, 503, "agents_off", "this machine runs no packs: agents are off (MACHINE_AGENTS=off)");
    if (!deps.brain.enabled) return fail(c, 503, "brain_off", "the brain is off: set MACHINE_BRAIN_URL to a running omnigraph server (start one with `pnpm brain`) and restart the machine");
    const rows = await brainEvidence(deps.brain, question);
    // Nothing to read: no model call for nothing.
    if (rows.length === 0) return c.json({ known: false, reply: "The brain holds nothing about that yet.", cites: [], dropped: [] });
    const context: BrainAskContext = { question, rows };
    let answer: BrainAskAnswer;
    try {
      const result = await deps.runs.run({ pack: "brain_ask", context: { brainAsk: context } }, "board", c.req.raw.signal);
      answer = BrainAskAnswer.parse(result.answer);
    } catch (error) {
      if (error instanceof RunFailedError) return fail(c, 502, "brain_ask_failed", error.message);
      if (error instanceof ZodError) return fail(c, 502, "brain_ask_failed", "the brain's answerer gave no valid answer");
      throw error;
    }
    const { cites, dropped } = brainAskCites(answer, context);
    // A claim that rests on no row that was shown is not known.
    return c.json({ known: answer.known && cites.length > 0, reply: answer.reply, cites, dropped });
  });

  // The claim journal: what the brain was told and has not yet decided (RFC 0010, "Remember").
  const claimsOff = (c: Context) => fail(c, 503, "brain_claims_off", "this machine was started without the claim journal: there is no database for claims, so it cannot list, settle or remember them");
  const invalid = (c: Context, error: unknown) => fail(c, 400, "invalid_request", error instanceof ZodError ? z.prettifyError(error) : "body must be JSON");

  app.get("/brain/claims", async (c) => {
    if (!deps.claims || !deps.admission) return claimsOff(c);
    const parsed = ClaimsQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const { status, repo, limit } = parsed.data;
    const [claims, stats] = await Promise.all([deps.claims.list({ status, ...(repo ? { repoPath: repo } : {}), ...(limit ? { limit } : {}) }), deps.claims.stats(repo)]);
    return c.json({ claims, stats });
  });

  const newestFirst = (a: BrainClaim, b: BrainClaim) => Date.parse(b.decidedAt ?? "") - Date.parse(a.decidedAt ?? "");
  /** The rows of one of the machine's own queries whose columns are all strings; a brain that is off or a query that fails gives none. */
  async function rowsOf<K extends string>(name: string, columns: readonly K[]): Promise<Array<Record<K, string>>> {
    try {
      const { rows } = await deps.brain.query(name);
      return rows.filter((row): row is Record<K, string> & typeof row => columns.every((column) => typeof row[column] === "string")).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])) as unknown as Record<K, string>);
    } catch {
      return [];
    }
  }

  app.get("/brain/digest", async (c) => {
    if (!deps.claims || !deps.admission) return claimsOff(c);
    const parsed = DigestQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const { days, repo } = parsed.data;
    const since = new Date((deps.now ?? (() => new Date()))().getTime() - days * DAY_MS);
    const decided = (status: "verified" | "rejected") => deps.claims!.list({ status, decidedBy: "jev", decidedSince: since, ...(repo ? { repoPath: repo } : {}), limit: DIGEST_READ });
    const [verified, rejected, atRisk, contested] = await Promise.all([
      decided("verified"),
      decided("rejected"),
      rowsOf("learnings_at_risk", ["learning", "title", "claim"] as const),
      rowsOf("contested_claims", ["claim", "says", "contradicts", "against"] as const),
    ]);
    // A flagged claim is the one Jev was least sure of: it comes first.
    const flaggedFirst = (a: BrainClaim, b: BrainClaim) => Number(b.proposed === "flag") - Number(a.proposed === "flag") || newestFirst(a, b);
    const digest: BrainDigest = {
      since: since.toISOString(),
      verified: verified.sort(flaggedFirst).slice(0, DIGEST_SHOWN),
      rejected: rejected.sort(newestFirst).slice(0, DIGEST_SHOWN),
      atRisk,
      contested,
    };
    return c.json(digest);
  });

  const settle = (decision: "verify" | "reject") => async (c: Context) => {
    if (!deps.claims || !deps.admission) return claimsOff(c);
    if (decision === "reject") {
      // The reason is only logged; the body may be left out.
      const text = await c.req.text();
      let json: unknown = null;
      try {
        json = text.trim() === "" ? {} : JSON.parse(text);
      } catch {
        // Not JSON: the schema below refuses it.
      }
      const body = RejectInput.safeParse(json);
      if (!body.success) return invalid(c, body.error);
    }
    const settled = await deps.admission.settle(c.req.param("id")!, decision);
    if ("problem" in settled) return settled.problem === "not_found" ? fail(c, 404, "not_found", "no such claim") : fail(c, 409, "not_waiting", "the claim was already decided");
    return c.json({ claim: settled.claim });
  };
  app.post("/brain/claims/:id/verify", settle("verify"));
  app.post("/brain/claims/:id/reject", settle("reject"));

  app.post("/brain/remember", async (c) => {
    if (!deps.claims || !deps.admission) return claimsOff(c);
    const parsed = RememberInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error);
    // The board has no login of its own: the note is the machine's owner's, when the machine knows who that is.
    const speaker = (await deps.speaker?.().catch(() => null)) ?? null;
    const claim = await deps.admission.remember(parsed.data.text, { repoPath: parsed.data.repo ?? null, speaker });
    return c.json({ claim });
  });
}
