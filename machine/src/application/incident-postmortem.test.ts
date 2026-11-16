import type { PostmortemContext } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Incident } from "../domain/incident.ts";
import { DraftRefusedError } from "./compliance-drafts.ts";
import { postmortemWriter } from "./incident-postmortem.ts";

const incident: Incident = {
  id: "datadog:incident:812",
  title: "Checkout failing",
  severity: "critical",
  status: "resolved",
  startedAt: "2026-11-10T09:00:00.000Z",
  resolvedAt: "2026-11-10T11:00:00.000Z",
  service: null,
  signals: [],
  timeline: [],
  breach: { assessedAt: "x", answers: {} as never, regimes: ["gdpr"], clocks: { gdpr: "2026-11-13T09:00:00.000Z" } },
};
const answer = { summary: "s", impact: "i", timeline: [], rootCauses: ["c"], contributingFactors: [], actionItems: [{ title: "Add a check", owner: null, due: null }], breachNotes: null };

const deps = (over: Partial<Parameters<typeof postmortemWriter>[0]> = {}) => {
  const open = vi.fn(async (fields: unknown) => fields as never);
  const write = vi.fn(async (_context: PostmortemContext) => answer as unknown);
  const log = vi.fn();
  return { open, write, log, deps: { drafts: { open }, write, wikiRepo: "acme/handbook", jiraProject: null, log, ...over } as Parameters<typeof postmortemWriter>[0] };
};

describe("postmortemWriter", () => {
  it("opens a postmortem draft for the wiki, with the nearest clock in its summary", async () => {
    const { open, write, deps: d } = deps();
    await postmortemWriter(d)(incident);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ breach: { regimes: ["gdpr"], clocks: incident.breach && "clocks" in incident.breach ? incident.breach.clocks : {} } }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "postmortem:datadog:incident:812",
        kind: "postmortem",
        repo: "acme/handbook",
        title: "Postmortem: Checkout failing",
        period: null,
        summary: "critical · 1 action item · ⏱ gdpr by 2026-11-13",
        targets: [{ kind: "wiki", repo: "acme/handbook", path: expect.stringMatching(/^Incidents\/2026-11-10-checkout-failing-[0-9a-f]{6}\.md$/) }],
      }),
    );
    expect(open.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining("- [ ] Add a check (owner: unassigned, due: none)") });
  });

  it("adds a jira_actions target when a Jira project is set", async () => {
    const { open, deps: d } = deps({ jiraProject: "OPS" });
    await postmortemWriter(d)(incident);
    expect((open.mock.calls[0]![0] as { targets: unknown[] }).targets).toEqual([
      { kind: "wiki", repo: "acme/handbook", path: expect.stringMatching(/^Incidents\/2026-11-10-checkout-failing-[0-9a-f]{6}\.md$/) },
      { kind: "jira_actions", project: "OPS" },
    ]);
  });

  it("skips with one log line when there is no wiki repo", async () => {
    const { open, write, log, deps: d } = deps({ wikiRepo: null });
    expect(await postmortemWriter(d)(incident)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("logs a pack that fails or answers badly, and opens no draft", async () => {
    const down = deps({ write: async () => Promise.reject(new Error("agents are off")) });
    expect(await postmortemWriter(down.deps)(incident)).toBeNull();
    expect(down.log).toHaveBeenCalledWith(expect.stringContaining("agents are off"));
    const odd = deps({ write: async () => ({ summary: "only" }) });
    expect(await postmortemWriter(odd.deps)(incident)).toBeNull();
    expect(odd.open).not.toHaveBeenCalled();
  });

  it("logs a text the drafts refuse", async () => {
    const refused = deps({ drafts: { open: async () => Promise.reject(new DraftRefusedError()) } });
    expect(await postmortemWriter(refused.deps)(incident)).toBeNull();
    expect(refused.log).toHaveBeenCalledWith(expect.stringContaining("token-shaped"));
  });
});
