import { describe, expect, it } from "vitest";

import { DesignSpec } from "./design-spec.ts";

const empty = { color: [], type: [], spacing: [], radius: [] };
const frame = (states: unknown[]) => ({ id: "1:2", name: "Checkout", viewport: { width: 1440, height: 900 }, states });
const spec = (states: unknown[]) => ({ frames: [frame(states)], tokens: empty, components: [], a11yNotes: [], missing: [], confidence: 0.8 });

describe("DesignSpec", () => {
  it("takes a frame with a designed state and a suggested one", () => {
    const parsed = DesignSpec.parse(spec([
      { state: "default", nodeId: "1:2", suggestion: null },
      { state: "empty", nodeId: null, suggestion: { source: "mobbin", ref: "screen 4411", note: "an empty cart with one call to action" } },
    ]));
    expect(parsed.frames[0]!.states).toHaveLength(2);
  });
  it("refuses a state that is both designed and suggested: a suggestion is never the design", () => {
    expect(DesignSpec.safeParse(spec([{ state: "hover", nodeId: "1:3", suggestion: { source: "mobbin", ref: "x", note: "y" } }])).success).toBe(false);
  });
  it("refuses a state the spec does not know and a frame id in URL form", () => {
    expect(DesignSpec.safeParse(spec([{ state: "pressed", nodeId: "1:3", suggestion: null }])).success).toBe(false);
    expect(DesignSpec.safeParse({ ...spec([]), frames: [{ ...frame([]), id: "1-2" }] }).success).toBe(false);
  });
  it("takes a token with the variable it came from, or none when the file has no variables", () => {
    const tokens = { ...empty, color: [{ name: "primary", value: "#0B5FFF", variable: "color/brand/primary", nodeId: null }, { name: "surface", value: "#FFFFFF", variable: null, nodeId: "1:9" }] };
    expect(DesignSpec.parse({ ...spec([]), tokens }).tokens.color).toHaveLength(2);
  });
});
