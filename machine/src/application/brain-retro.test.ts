import type { ClaimDraft } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../domain/task.ts";
import type { Admission, ClaimOrigin } from "./brain-admission.ts";
import { retroClaims } from "./brain-retro.ts";
import type { StageContext } from "./ports.ts";

const context = { task: { id: "t1", title: "Export CSV", repoPath: "/work/luna" } as unknown as TaskRow, stage: "reviewing_memory", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
const drafts: ClaimDraft[] = [{ statement: "The export job retries three times", quote: "retries three times", kind: "fact", scope: "repo" }];

describe("retroClaims", () => {
  it("proposes the drafts with the card as their source and the retro's prompt as the text the quotes are checked against", () => {
    const calls: Array<[ClaimDraft[], ClaimOrigin]> = [];
    const admission = { propose: async (d: ClaimDraft[], origin: ClaimOrigin) => (calls.push([d, origin]), []) } as unknown as Admission;
    retroClaims(admission, () => {})(context, drafts, "the retro prompt");
    expect(calls).toEqual([[drafts, { taskId: "t1", repoPath: "/work/luna", extractor: "reviewing_memory", source: { kind: "card", ref: "t1", title: "Export CSV" }, sourceText: "the retro prompt", speaker: null, speakerTrust: "machine" }]]);
  });

  it("hands over a null source text as it is", () => {
    const seen: Array<string | null> = [];
    const admission = { propose: async (_d: ClaimDraft[], origin: ClaimOrigin) => (seen.push(origin.sourceText), []) } as unknown as Admission;
    retroClaims(admission, () => {})(context, drafts, null);
    expect(seen).toEqual([null]);
  });

  it("logs a proposal that rejects and never throws", async () => {
    const lines: string[] = [];
    const admission = { propose: async () => { throw new Error("db down"); } } as unknown as Admission;
    expect(() => retroClaims(admission, (line) => lines.push(line))(context, drafts, "p")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines).toEqual(["brain: the retro's claims were not admitted: db down"]);
  });
});
