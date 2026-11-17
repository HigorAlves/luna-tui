import type { ClaimDraft, ClaimSpeakerTrust } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../domain/task.ts";
import type { Admission, ClaimOrigin } from "./brain-admission.ts";
import { retroClaims, speakerTrustOf } from "./brain-retro.ts";
import type { StageContext } from "./ports.ts";

const context = { task: { id: "t1", title: "Export CSV", repoPath: "/work/luna" } as unknown as TaskRow, stage: "reviewing_memory", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
const drafts: ClaimDraft[] = [{ statement: "The export job retries three times", quote: "retries three times", kind: "fact", scope: "repo" }];

const machine = async (): Promise<ClaimSpeakerTrust> => "machine";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("retroClaims", () => {
  it("proposes the drafts with the card as their source, the prompt's data blocks as the text the quotes are checked against and its title as the ticket's words", async () => {
    const calls: Array<[ClaimDraft[], ClaimOrigin]> = [];
    const admission = { propose: async (d: ClaimDraft[], origin: ClaimOrigin) => (calls.push([d, origin]), []) } as unknown as Admission;
    const prompt = "Propose changes.\n\n## Task\nExport CSV\n\n## Facts\n<<<data:context.retro>>>\n| the export job retries three times\n<<<end-data:context.retro>>>\n";
    retroClaims(admission, () => {}, machine)(context, drafts, prompt);
    await tick();
    expect(calls).toEqual([[drafts, { taskId: "t1", repoPath: "/work/luna", extractor: "reviewing_memory", source: { kind: "card", ref: "t1", title: "Export CSV" }, sourceText: "the export job retries three times", ticketText: "Export CSV", speaker: null, speakerTrust: "machine" }]]);
  });

  it("hands over a null source text as it is", async () => {
    const seen: Array<string | null> = [];
    const admission = { propose: async (_d: ClaimDraft[], origin: ClaimOrigin) => (seen.push(origin.sourceText), []) } as unknown as Admission;
    retroClaims(admission, () => {}, machine)(context, drafts, null);
    await tick();
    expect(seen).toEqual([null]);
  });

  it("logs a proposal that rejects and never throws", async () => {
    const lines: string[] = [];
    const admission = { propose: async () => { throw new Error("db down"); } } as unknown as Admission;
    expect(() => retroClaims(admission, (line) => lines.push(line), machine)(context, drafts, "p")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines).toEqual(["brain: the retro's claims were not admitted: db down"]);
  });

  it("hands the claims over with the trust the card's source earns, outside for an outsider's issue", async () => {
    const seen: string[] = [];
    const admission = { propose: async (_d: ClaimDraft[], origin: ClaimOrigin) => (seen.push(origin.speakerTrust), []) } as unknown as Admission;
    retroClaims(admission, () => {}, async (task) => speakerTrustOf(task))({ ...context, task: { ...context.task, source: { kind: "github", repo: "o/r", number: 4, url: "u", authorAssociation: "NONE" } } as unknown as TaskRow }, drafts, "p");
    retroClaims(admission, () => {}, async (task) => speakerTrustOf(task))(context, drafts, "p");
    await tick();
    expect(seen).toEqual(["outside", "machine"]);
  });

  it("counts a failed trust lookup as outside", async () => {
    const seen: string[] = [];
    const admission = { propose: async (_d: ClaimDraft[], origin: ClaimOrigin) => (seen.push(origin.speakerTrust), []) } as unknown as Admission;
    retroClaims(admission, () => {}, async () => { throw new Error("lookup down"); })(context, drafts, "p");
    await tick();
    expect(seen).toEqual(["outside"]);
  });
});

describe("speakerTrustOf", () => {
  const of = (source: unknown) => speakerTrustOf({ source } as unknown as TaskRow);
  it("is the machine's for a card with no outside source: Jira and Slack are the org's own tools, as for the sandbox", () => {
    for (const source of [null, { kind: "github", repo: "o/r", number: 1, url: "u", authorAssociation: "MEMBER" }, { kind: "github_pr", repo: "o/r", number: 1, url: "u", headRef: "a", baseRef: "b", authorAssociation: "OWNER" }, { kind: "github_alert", repo: "o/r", alert: 1, tool: "dependabot", url: "u" }, { kind: "incident", id: "i" }, { kind: "notch", ref: "L-1", id: "x" }, { kind: "jira", key: "A-1", url: "u", issueType: null }, { kind: "slack", channel: "c", ts: "1", permalink: "p" }]) expect(of(source)).toBe("machine");
  });
  it("is outside for an issue or PR from a stranger or with no recorded author", () => {
    for (const source of [{ kind: "github", repo: "o/r", number: 1, url: "u", authorAssociation: "NONE" }, { kind: "github", repo: "o/r", number: 1, url: "u" }, { kind: "github_pr", repo: "o/r", number: 1, url: "u", headRef: "a", baseRef: "b", authorAssociation: "CONTRIBUTOR" }]) expect(of(source)).toBe("outside");
  });
});
