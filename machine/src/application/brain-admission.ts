// Admission (RFC 0010, "Remember"): what a pack hands over, or a person writes, enters the journal as a claim. The code checks it
// first; the memory_admit decision pack judges what passes; the person decides what waits. In `shadow` Jev's outcome is only
// recorded, in `auto` it is applied, and a claim with a reason the code holds back is always the person's.
import { createHash } from "node:crypto";

import {
  admissionOutcome, applyPolicy, claimHighRiskReasons, PACKS,
  type AdmitContext, type BrainClaim, type ClaimDraft, type ClaimSpeakerTrust, type ClaimStatus, type DecisionOverrides,
} from "@hardness/contracts";

import { checkClaim, excerptAround } from "../domain/brain/claim-checks.ts";
import { maskPii, screen } from "../domain/secrets-check.ts";
import type { ClaimStore } from "./brain-claims.ts";
import type { Brain } from "./brain.ts";
import { recordIdOf } from "./decision-truth.ts";

export type AdmitMode = "off" | "shadow" | "auto";

export interface ClaimOrigin {
  taskId: string | null;
  repoPath: string | null;
  extractor: string;
  source: BrainClaim["source"];
  /** The text the quote must be found in; null when the machine does not hold it. */
  sourceText: string | null;
  speaker: string | null;
  speakerTrust: ClaimSpeakerTrust;
}

export interface AdmissionDeps {
  store: ClaimStore;
  brain: Brain;
  /** Runs memory_admit and gives its answer; null when the machine runs no packs. */
  decide: ((admit: AdmitContext, repoPath: string | null) => Promise<Record<string, unknown>>) | null;
  /** The repository's own confidence bars for memory_admit. */
  overrides?: (repoPath: string | null) => Promise<DecisionOverrides | undefined>;
  /** `brain.admit` of the repository's luna.yaml; `shadow` for a claim with no repository. */
  mode: (repoPath: string | null) => Promise<AdmitMode>;
  repoSlug: (repoPath: string) => string;
  /** Called after a claim was added or changed, to start a projection. Never awaited. */
  changed?: () => void;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface Admission {
  /** What a pack handed over. Never throws; a draft that fails is logged and skipped. */
  propose(drafts: ClaimDraft[], origin: ClaimOrigin): Promise<BrainClaim[]>;
  /** A person's own note: stored and, when the code checks pass, verified at once. */
  remember(text: string, origin: { repoPath: string | null; speaker: string | null }): Promise<BrainClaim>;
  /** A person verifies or rejects a claim: a waiting one, or one that was decided the other way, Jev's included. A refused claim never changes. */
  settle(id: string, decision: "verify" | "reject"): Promise<{ claim: BrainClaim } | { problem: "not_found" | "not_waiting" }>;
}

const SIMILAR_MAX = 5;
const NOTE_MIN = 12;
const NOTE_MAX = 300;
const SIMILAR_STATUS = new Set(["unverified", "verified", "rejected"]);

/** A refused claim's text as the journal keeps it: every secret cut out and every address and phone number masked. The journal must not hold what the claim was refused for. */
const storable = (text: string): string => maskPii(screen(text).text);

export function admission(deps: AdmissionDeps): Admission {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const log = (line: string) => deps.log?.(line);
  const changed = () => {
    try {
      deps.changed?.();
    } catch {
      // A projection that cannot start is the projector's to report.
    }
  };
  const slugOf = (repoPath: string | null) => (repoPath ? deps.repoSlug(repoPath) : null);

  /** The claims most like this one, in the order the questions number them. A brain that is off or fails gives none. */
  async function similarTo(claim: BrainClaim): Promise<AdmitContext["similar"]> {
    try {
      const answer = await deps.brain.query("similar_claims", { q: claim.statement });
      const similar: AdmitContext["similar"] = [];
      for (const row of answer.rows) {
        const id = typeof row.claim === "string" && row.claim.startsWith("claim:") ? row.claim.slice("claim:".length) : "";
        if (id === "" || id === claim.id || typeof row.statement !== "string" || typeof row.status !== "string" || !SIMILAR_STATUS.has(row.status)) continue;
        similar.push({ id, statement: row.statement.slice(0, 300), status: row.status as AdmitContext["similar"][number]["status"] });
        if (similar.length === SIMILAR_MAX) break;
      }
      return similar;
    } catch {
      return [];
    }
  }

  /** What Jev and the code rules come to, applied by the mode. A claim stays as it is when anything fails. */
  async function judge(claim: BrainClaim, origin: ClaimOrigin, mode: AdmitMode): Promise<BrainClaim> {
    if (!deps.decide) return claim;
    try {
      const similar = await similarTo(claim);
      const admit: AdmitContext = {
        claim: { statement: claim.statement, quote: claim.quote, kind: claim.kind, scope: claim.scope, extractor: claim.extractor },
        source: { kind: claim.source.kind, title: claim.source.title.slice(0, 200), excerpt: excerptAround(claim.quote, origin.sourceText ?? "") },
        similar,
      };
      const answer = await deps.decide(admit, origin.repoPath);
      const recordId = recordIdOf(answer) ?? null;
      const { verdicts } = applyPolicy(PACKS.memory_admit, answer, await deps.overrides?.(origin.repoPath));
      const result = admissionOutcome({ answer, verdicts, reasons: claim.reasons, similar: similar.length });
      const patch: Parameters<ClaimStore["update"]>[1] = {
        tier: result.tier,
        proposed: result.outcome,
        durable: result.durable,
        contradicts: result.contradicts.flatMap((n) => similar[n - 1]?.id ?? []),
        recordId,
      };
      if (mode === "auto" && result.outcome !== "ask") {
        patch.status = result.outcome === "reject" ? "rejected" : "verified";
        patch.decidedBy = "jev";
        patch.decidedAt = now();
      }
      return (await deps.store.update(claim.id, patch)) ?? claim;
    } catch (err) {
      // The claim's own words stay out of the log: an error may quote what it was handed.
      const message = (err instanceof Error ? err.message : String(err)).split(claim.statement).join("[statement]").split(claim.quote).join("[quote]").slice(0, 200);
      log(`memory_admit failed for claim ${claim.id}, left for a person: ${message}`);
      return claim;
    }
  }

  return {
    async propose(drafts, origin) {
      const stored: BrainClaim[] = [];
      let mode: AdmitMode;
      try {
        mode = await deps.mode(origin.repoPath);
      } catch (err) {
        log(`admission mode unreadable, claims dropped: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
        return [];
      }
      if (mode === "off") return [];
      for (const draft of drafts) {
        try {
          const checked = checkClaim(draft, origin.sourceText);
          const kept = checked.ok ? draft : { ...draft, statement: storable(draft.statement), quote: storable(draft.quote) };
          const reasons = claimHighRiskReasons({ ...draft, speakerTrust: origin.speakerTrust });
          const added = await deps.store.add({
            repoPath: origin.repoPath, repo: slugOf(origin.repoPath), taskId: origin.taskId, statement: kept.statement, quote: kept.quote, kind: draft.kind, scope: draft.scope,
            source: origin.source, speaker: origin.speaker, speakerTrust: origin.speakerTrust, extractor: origin.extractor,
            status: checked.ok ? "unverified" : "refused", refusal: checked.ok ? null : checked.why, reasons: checked.ok ? reasons : [],
          });
          if (!added) continue;
          stored.push(added.status === "refused" ? added : await judge(added, origin, mode));
        } catch (err) {
          log(`a claim of ${origin.extractor} was skipped: ${err instanceof Error ? err.name : "error"}`);
        }
      }
      if (stored.length > 0) changed();
      return stored;
    },

    async remember(text, origin) {
      const statement = text.trim();
      // The same note in the same repository is one source: its reference is a hash of both.
      const ref = createHash("sha256").update(`${origin.repoPath ?? ""}\n${statement}`).digest("hex").slice(0, 32);
      const source = { kind: "note" as const, ref, title: "A note" };
      // A refused note is stored with its secrets and addresses cut out, so it is looked up in that form too.
      const earlier = (await deps.store.findBySource(source, statement)) ?? (await deps.store.findBySource(source, storable(statement)));
      if (earlier) return earlier;

      const length = [...statement].length;
      const checked = length < NOTE_MIN ? { ok: false as const, why: `a note is at least ${NOTE_MIN} characters` } : length > NOTE_MAX ? { ok: false as const, why: `a note is at most ${NOTE_MAX} characters` } : checkClaim({ statement, quote: statement }, statement);
      // A refused note is kept so the person sees why, with what made it refusable cut out.
      const kept = checked.ok ? statement : storable(statement);
      const added = await deps.store.add({
        repoPath: origin.repoPath, repo: slugOf(origin.repoPath), taskId: null, statement: kept, quote: kept, kind: "fact", scope: origin.repoPath ? "repo" : "org", source,
        speaker: origin.speaker, speakerTrust: "owner", extractor: "person", status: checked.ok ? "unverified" : "refused", refusal: checked.ok ? null : checked.why, reasons: [],
      });
      // Another call stored it between the look and the add: that one is the claim.
      if (!added) return (await deps.store.findBySource(source, kept))!;
      const claim = checked.ok ? ((await deps.store.update(added.id, { status: "verified", durable: true, decidedBy: "person", decidedAt: now() })) ?? added) : added;
      changed();
      return claim;
    },

    async settle(id, decision) {
      const claim = await deps.store.get(id);
      if (!claim) return { problem: "not_found" };
      const open: ClaimStatus[] = decision === "verify" ? ["unverified", "rejected"] : ["unverified", "verified"];
      if (!open.includes(claim.status)) return { problem: "not_waiting" };
      const decided = { decidedBy: "person" as const, decidedAt: now() };
      const updated = await deps.store.update(id, decision === "verify" ? { status: "verified", durable: claim.durable ?? true, ...decided } : { status: "rejected", ...decided });
      if (!updated) return { problem: "not_found" };
      changed();
      return { claim: updated };
    },
  };
}
