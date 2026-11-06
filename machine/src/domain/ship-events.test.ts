import { describe, expect, it } from "vitest";

import { shipEvents } from "./ship-events.ts";

const calm = { mergeable: "MERGEABLE", mergeState: "CLEAN", frozen: false, openDependencies: 0 };

describe("shipEvents: the classes facts decide", () => {
  it("names nothing on a calm PR", () => expect(shipEvents(calm)).toEqual([]));
  it("names a conflict from either fact", () => {
    expect(shipEvents({ ...calm, mergeable: "CONFLICTING" })).toEqual(["conflict"]);
    expect(shipEvents({ ...calm, mergeState: "DIRTY" })).toEqual(["conflict"]);
  });
  it("names base_moved when the branch is behind", () => expect(shipEvents({ ...calm, mergeState: "BEHIND" })).toEqual(["base_moved"]));
  it("names a freeze and a blocking PR", () => expect(shipEvents({ ...calm, frozen: true, openDependencies: 2 })).toEqual(["freeze", "blocked_by_other_pr"]));
  it("never names parent_merged or parent_changed before wave 15", () => {
    const all = shipEvents({ mergeable: "CONFLICTING", mergeState: "BEHIND", frozen: true, openDependencies: 1 });
    expect(all).not.toContain("parent_merged");
    expect(all).not.toContain("parent_changed");
  });
});
