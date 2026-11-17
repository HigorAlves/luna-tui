// Forget (RFC 0010): erases one claim, or one person's login, from the graph, the journal and the claim table. The graph and the journal
// go first, through the projector, which stops when the graph refuses; the table is touched only after that, so the three never disagree
// and the same call can be made again.
import { brainSlug } from "@hardness/contracts";

import type { ClaimStore } from "./brain-claims.ts";
import type { ForgetResult } from "./brain-projector.ts";

export type Forgotten =
  | { forgotten: { nodes: number; edges: number }; claims: number }
  | { problem: "not_found" }
  | { problem: "invalid" }
  /** The graph refused: nothing was changed, and `note` is the error's code. */
  | { problem: "failed"; note: string };

export interface Forgetter {
  claim(id: string): Promise<Forgotten>;
  person(login: string): Promise<Forgotten>;
}

export function brainForget(deps: { projector: { forget(slugs: string[]): Promise<ForgetResult> }; claims: ClaimStore }): Forgetter {
  const { projector, claims } = deps;
  return {
    async claim(id) {
      const held = await claims.get(id);
      if (!held) return { problem: "not_found" };
      // A card's source is shared by the card's other claims and stays; a note is one claim's own.
      const slugs = [brainSlug("claim", id), brainSlug("learning", id), ...(held.source.kind === "note" ? [brainSlug("source", `note/${id}`)] : [])];
      const done = await projector.forget(slugs);
      if (done.note !== null) return { problem: "failed", note: done.note };
      await claims.delete(id);
      return { forgotten: { nodes: done.nodes, edges: done.edges }, claims: 1 };
    },

    // Only the claim's speaker is searched for the login: the table holds a login nowhere else by design. A claim's statement and quote are
    // free text and are not searched for the name; forgetting such a claim is `claim`.
    async person(login) {
      const name = login.trim().toLowerCase();
      let slug: string;
      try {
        slug = brainSlug("person", name);
      } catch {
        return { problem: "invalid" };
      }
      const done = await projector.forget([slug]);
      if (done.note !== null) return { problem: "failed", note: done.note };
      return { forgotten: { nodes: done.nodes, edges: done.edges }, claims: await claims.forgetSpeaker(name) };
    },
  };
}
