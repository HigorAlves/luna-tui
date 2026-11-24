import type { SlackWatch } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { inConversationScope, optedIn } from "./conversation-scope.ts";

const watch = (over: Partial<SlackWatch>): SlackWatch => ({ id: "w", kind: "channel", value: "C1", label: "#eng", channels: [], enabled: true, builtin: false, priority: null, createdAt: "2026-10-28T00:00:00.000Z", ...over });

describe("optedIn", () => {
  it("holds the channels of enabled channel watches and the channels a repository claims", () => {
    const opted = optedIn([watch({ value: "C1" }), watch({ id: "w2", value: "C2", enabled: false }), watch({ id: "w3", kind: "keyword", value: "outage", channels: ["C9"] }), watch({ id: "w4", kind: "usergroup", value: "S1" })], ["C3", "D4"]);
    expect([...opted].sort()).toEqual(["C1", "C3", "D4"]);
  });
});

describe("inConversationScope", () => {
  const opted = new Set(["C1", "D4"]);
  it("lets in only an opted-in channel, DM or group DM by its own id", () => {
    expect(inConversationScope({ id: "C1", kind: "channel" }, opted, "opted_in")).toBe(true);
    expect(inConversationScope({ id: "D4", kind: "dm" }, opted, "opted_in")).toBe(true);
    expect(inConversationScope({ id: "D5", kind: "dm" }, opted, "opted_in")).toBe(false);
    expect(inConversationScope({ id: "G7", kind: "mpim" }, opted, "opted_in")).toBe(false);
    expect(inConversationScope({ id: "C2", kind: "channel" }, opted, "opted_in")).toBe(false);
  });
  it("reads everything with the scope all", () => {
    expect(inConversationScope({ id: "D5", kind: "dm" }, new Set(), "all")).toBe(true);
  });
});
