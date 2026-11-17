// The claim journal's port (RFC 0010, "Remember"): Postgres keeps every claim, the graph gets a copy later.
import type { BrainClaim, ClaimKind, ClaimScope, ClaimSpeakerTrust, ClaimStatus } from "@hardness/contracts";

export interface NewClaim {
  repoPath: string | null;
  repo: string | null;
  taskId: string | null;
  statement: string;
  quote: string;
  kind: ClaimKind;
  scope: ClaimScope;
  source: BrainClaim["source"];
  speaker: string | null;
  speakerTrust: ClaimSpeakerTrust;
  extractor: string;
  status: ClaimStatus;
  refusal: string | null;
  reasons: string[];
}

export interface ClaimStats {
  /** Claims that wait for a person. */
  waiting: number;
  /** Claims a person decided that Jev also proposed an outcome for. */
  decided: number;
  /** Of those, where the person went the way Jev proposed. */
  agreed: number;
  /** Of those, where Jev would have verified or flagged and the person rejected. */
  missed: number;
  /** Whether the shadow period has shown enough for Jev to decide alone (`shadowReady`). */
  ready: boolean;
}

export type ClaimPatch = Partial<Pick<BrainClaim, "status" | "tier" | "proposed" | "durable" | "contradicts" | "recordId" | "decidedBy" | "decidedAt" | "reasons">>;

export interface ClaimStore {
  /** Adds a claim; null when the same source already handed over the same statement. */
  add(claim: NewClaim): Promise<BrainClaim | null>;
  get(id: string): Promise<BrainClaim | null>;
  /** The claim a source already handed over with this statement, so a person's note said twice is one claim. */
  findBySource(source: Pick<BrainClaim["source"], "kind" | "ref">, statement: string): Promise<BrainClaim | null>;
  /** Newest first, or with `order: "updated_asc"` the longest-unchanged first, which is what a cursor over `updated_at` pages by. `since` keeps those updated at or after it; `except` leaves one status out; `decidedBy` and `decidedSince` (at or after) keep the claims decided by that one, since then. */
  list(filter?: { status?: ClaimStatus; except?: ClaimStatus; repoPath?: string; since?: Date; decidedBy?: "code" | "jev" | "person"; decidedSince?: Date; limit?: number; order?: "updated_asc" }): Promise<BrainClaim[]>;
  /** Changes what admission or a person settled; touches `updated_at`. Null when there is no such claim. */
  update(id: string, patch: ClaimPatch): Promise<BrainClaim | null>;
  stats(repoPath?: string): Promise<ClaimStats>;
}

/** A machine started without a database: holds nothing, never throws. */
export function noClaims(): ClaimStore {
  return {
    add: async () => null,
    get: async () => null,
    findBySource: async () => null,
    list: async () => [],
    update: async () => null,
    stats: async () => ({ waiting: 0, decided: 0, agreed: 0, missed: 0, ready: false }),
  };
}
