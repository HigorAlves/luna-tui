import { describe, expect, it } from "vitest";

import { inScope } from "./ticket-scope.ts";

// The diagram's first question about a ticket: is it assigned to me or my team? Anything else is ignored, with no comment.
const ticket = (assignee: string | null, labels: string[] = []) => ({ key: "PAY-12", assignee, labels, components: [] as string[] });

describe("the ticket machine's scope", () => {
  it("takes a ticket assigned to one of the configured people", () => {
    expect(inScope(ticket("ana"), { assignees: ["ana", "bo"], teams: [] })).toBe(true);
    expect(inScope(ticket("carla"), { assignees: ["ana", "bo"], teams: [] })).toBe(false);
  });

  it("takes a ticket of one of the configured teams, by label or component", () => {
    expect(inScope(ticket(null, ["team-payments"]), { assignees: [], teams: ["team-payments"] })).toBe(true);
    expect(inScope({ key: "PAY-13", assignee: null, labels: [], components: ["payments"] }, { assignees: [], teams: ["payments"] })).toBe(true);
  });

  it("ignores an unassigned ticket of no configured team, and everything when nothing is configured", () => {
    expect(inScope(ticket(null), { assignees: ["ana"], teams: ["team-payments"] })).toBe(false);
    expect(inScope(ticket("ana"), { assignees: [], teams: [] })).toBe(false);
  });

  it("compares names without regard to case or surrounding space", () => {
    expect(inScope(ticket(" Ana "), { assignees: ["ana"], teams: [] })).toBe(true);
  });
});
