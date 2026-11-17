import type { BrainClaim } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { brainForget } from "./brain-forget.ts";
import { type ClaimStore, noClaims } from "./brain-claims.ts";
import type { ForgetResult } from "./brain-projector.ts";

const ID = "5b1c1b1e-0000-4000-8000-000000000001";
const claim = (over: Partial<BrainClaim> = {}) => ({ id: ID, source: { kind: "card", ref: "t1", title: "A card" }, speaker: null, ...over }) as BrainClaim;

/** A projector and a store that write what they are asked into one list, so the order is what is checked. */
function setup(options: { held?: BrainClaim | null; result?: ForgetResult; changed?: number } = {}) {
  const calls: string[] = [];
  const projector = {
    forget: async (slugs: string[]): Promise<ForgetResult> => {
      calls.push(`forget ${slugs.join(",")}`);
      return options.result ?? { nodes: slugs.length, edges: 2, note: null };
    },
  };
  const claims: ClaimStore = {
    ...noClaims(),
    get: async () => (options.held === undefined ? claim() : options.held),
    delete: async (id) => (calls.push(`delete ${id}`), true),
    forgetSpeaker: async (login) => (calls.push(`speaker ${login}`), options.changed ?? 3),
  };
  return { forgetter: brainForget({ projector, claims }), calls };
}

describe("brainForget.claim", () => {
  it("forgets the claim, its lesson and (for a card's claim) not the card's source, then deletes the row", async () => {
    const { forgetter, calls } = setup();
    expect(await forgetter.claim(ID)).toEqual({ forgotten: { nodes: 2, edges: 2 }, claims: 1 });
    expect(calls).toEqual([`forget claim:${ID},learning:${ID}`, `delete ${ID}`]);
  });

  it("also forgets the source of a person's note", async () => {
    const { forgetter, calls } = setup({ held: claim({ source: { kind: "note", ref: "abc", title: "A note" } }) });
    await forgetter.claim(ID);
    expect(calls[0]).toBe(`forget claim:${ID},learning:${ID},source:note/${ID}`);
  });

  it("stops before the table when the graph refused, and says why", async () => {
    const { forgetter, calls } = setup({ result: { nodes: 0, edges: 0, note: "unlink_refused" } });
    expect(await forgetter.claim(ID)).toEqual({ problem: "failed", note: "unlink_refused" });
    expect(calls).toEqual([`forget claim:${ID},learning:${ID}`]);
  });

  it("answers not_found for a claim the table does not hold, and touches nothing", async () => {
    const { forgetter, calls } = setup({ held: null });
    expect(await forgetter.claim(ID)).toEqual({ problem: "not_found" });
    expect(calls).toEqual([]);
  });
});

describe("brainForget.person", () => {
  it("lower-cases and trims the login, forgets the person, then blanks the speaker of the claims", async () => {
    const { forgetter, calls } = setup();
    expect(await forgetter.person("  Octo-Cat ")).toEqual({ forgotten: { nodes: 1, edges: 2 }, claims: 3 });
    expect(calls).toEqual(["forget person:octo-cat", "speaker octo-cat"]);
  });

  it("stops before the table when the graph refused", async () => {
    const { forgetter, calls } = setup({ result: { nodes: 0, edges: 0, note: "remove_refused" } });
    expect(await forgetter.person("octo")).toEqual({ problem: "failed", note: "remove_refused" });
    expect(calls).toEqual(["forget person:octo"]);
  });

  it("refuses a login that is not the shape a person's slug takes, without touching anything", async () => {
    const { forgetter, calls } = setup();
    for (const bad of ["", "   ", "two words", "line\nbreak", "x".repeat(201)]) expect(await forgetter.person(bad)).toEqual({ problem: "invalid" });
    expect(calls).toEqual([]);
  });
});
