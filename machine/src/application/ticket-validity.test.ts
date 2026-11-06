import type { CanonicalTicket } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Near } from "../domain/similarity.ts";
import { type ValidityAnswer, buildValidityContext, checkValidity, validityOf } from "./ticket-validity.ts";

const yes = (p = 0.95) => ({ value: p >= 0.5, p });
const no = (p = 0.05) => ({ value: p >= 0.5, p });
const good: ValidityAnswer = { goal: yes(), criteria: yes(), scope: yes(), duplicate: { choice: "none", confidence: 0.9 }, project: yes(), reporter: yes() };
const shortlist: Near[] = [{ id: "card-1", kind: "open", score: 0.6 }];

describe("validity, by script over the pack's answers", () => {
  it("calls a ticket workable when it has a goal, criteria, a bounded scope and a project", () => {
    expect(validityOf(good, shortlist)).toEqual({ outcome: "workable", missing: [], duplicateOf: null, reporterReachable: true });
  });

  it("says exactly what is missing, in fixed words, when a bar is not met", () => {
    const v = validityOf({ ...good, goal: no(), criteria: yes(0.55), scope: yes() }, shortlist);
    expect(v.outcome).toBe("needs_info");
    expect(v.missing).toEqual(["what outcome is wanted", "steps to reproduce it, or what done looks like"]);
  });

  it("names the duplicate only when the pack is sure, and of which card", () => {
    expect(validityOf({ ...good, duplicate: { choice: "slot1", confidence: 0.9 } }, shortlist)).toMatchObject({ outcome: "duplicate", duplicateOf: "card-1" });
    expect(validityOf({ ...good, duplicate: { choice: "slot1", confidence: 0.4 } }, shortlist).outcome).toBe("workable");
    expect(validityOf({ ...good, duplicate: { choice: "slot3", confidence: 0.99 } }, shortlist).outcome).toBe("workable");
  });

  it("is not ours when the pack is sure it names no project or repository of ours", () => {
    expect(validityOf({ ...good, project: no() }, shortlist).outcome).toBe("not_ours");
    expect(validityOf({ ...good, project: yes(0.5) }, shortlist)).toMatchObject({ outcome: "needs_info", missing: ["which project or repository this is for"] });
  });

  it("keeps an unreachable reporter as a fact for the assessment, not as a reason to stop", () => {
    expect(validityOf({ ...good, reporter: no() }, shortlist)).toMatchObject({ outcome: "workable", reporterReachable: false });
  });
});

describe("the validity call", () => {
  const ticket = { key: "PAY-12", title: "Fails <b>now</b>", description: "x".repeat(9000), type: null, priority: null, reporter: { id: "u", name: "Ana" }, labels: ["a"], sprint: null, dueAt: null, comments: [{ author: "Bo", text: "hi @all closes #3", at: null }] } as unknown as CanonicalTicket;
  const enrichment = { linked: ["PAY-30"], epic: null, recent: [], files: ["a.ts"], shortlist };

  it("hands the pack the ticket flattened and capped, as data", () => {
    const ctx = buildValidityContext(ticket, enrichment, [{ id: "card-1", kind: "open", title: "A card", text: "its text" }]);
    expect(ctx.title).toBe("Fails &lt;b&gt;now&lt;/b&gt;");
    expect(ctx.description.length).toBeLessThanOrEqual(4000);
    expect(ctx.comments[0]!.text).not.toContain("@all");
    expect(ctx.candidates).toEqual([{ slot: 1, kind: "open", title: "A card", summary: "its text" }]);
    expect(ctx.reachable).toBe(true);
  });

  it("makes one call, and a failed call is no outcome: the ticket is not assessed", async () => {
    const decide = vi.fn(async () => good);
    expect((await checkValidity({ decide }, ticket, enrichment, [{ id: "card-1", kind: "open", title: "A card", text: "t" }]))?.outcome).toBe("workable");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await checkValidity({ decide: async () => { throw new Error("down"); } }, ticket, enrichment, [])).toBeNull();
  });
});
