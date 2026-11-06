import { describe, expect, it } from "vitest";

import { CARD_EVENT_NAMES, CARD_EVENT_PANELS, CardEventName } from "./card-events.ts";

describe("the diagram's event names", () => {
  it("lists the thirty-five names of the diagram, each in one panel", () => {
    expect(CARD_EVENT_NAMES).toHaveLength(35);
    expect(new Set(CARD_EVENT_NAMES).size).toBe(35);
    expect(Object.keys(CARD_EVENT_PANELS)).toEqual(["intake", "triage", "plan", "build", "verify", "evidence", "ship"]);
  });

  it("parses a name and refuses anything else", () => {
    expect(CardEventName.parse("ship.merged")).toBe("ship.merged");
    expect(CardEventName.safeParse("ship.mergd").success).toBe(false);
  });

  it("names every build event under build.", () => {
    expect(CARD_EVENT_PANELS.build.every((n) => n.startsWith("build."))).toBe(true);
  });
});
