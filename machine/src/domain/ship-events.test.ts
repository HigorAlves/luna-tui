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
  it("names parent_merged when the parent merged into the default branch", () => {
    expect(shipEvents({ ...calm, stack: { state: "merged", head: null, recordedBase: "b1" } })).toEqual(["parent_merged"]);
  });
  it("names parent_changed when the open parent's head is not the recorded base", () => {
    expect(shipEvents({ ...calm, stack: { state: "open", head: "b2", recordedBase: "b1" } })).toEqual(["parent_changed"]);
  });
  it("names nothing for a stacked card whose parent has not moved, or whose parent head is unknown", () => {
    expect(shipEvents({ ...calm, stack: { state: "open", head: "b1", recordedBase: "b1" } })).toEqual([]);
    expect(shipEvents({ ...calm, stack: { state: "open", head: null, recordedBase: "b1" } })).toEqual([]);
    expect(shipEvents({ ...calm, stack: { state: "open", head: "b2", recordedBase: null } })).toEqual([]);
  });
  it("does not name base_moved for a stacked card: its base is its parent", () => {
    expect(shipEvents({ ...calm, mergeState: "BEHIND", stack: { state: "open", head: "b1", recordedBase: "b1" } })).toEqual([]);
    expect(shipEvents({ ...calm, mergeState: "BEHIND", stack: { state: "open", head: "b2", recordedBase: "b1" } })).toEqual(["parent_changed"]);
    expect(shipEvents({ ...calm, mergeState: "BEHIND" })).toEqual(["base_moved"]);
  });
  it("names no parent event for a parent that is gone, and a card with no stack is as before", () => {
    expect(shipEvents({ ...calm, stack: { state: "gone", head: null, recordedBase: "b1" } })).toEqual([]);
    expect(shipEvents({ ...calm, stack: null })).toEqual([]);
  });
});
