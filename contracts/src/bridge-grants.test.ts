// The golden list of bridged tools (RFC 0013, Trust): a pack names the exact tools it may call, and a tool a server adds is never offered until a pack names it here.
import { describe, expect, it } from "vitest";

import { AGENT_PACKS } from "./packs.ts";

const FIGMA = ["get_metadata", "get_design_context", "get_variable_defs", "get_code_connect_map", "get_screenshot"];
// design_parity reads frames and tokens only: no Code Connect, no Mobbin.
const PARITY = ["get_design_context", "get_metadata", "get_screenshot", "get_variable_defs"];
const MOBBIN = ["search_screens", "search_flows", "search_sections"];
const WRITES = /(^|_)(create|save|add|update|delete|write|post|set|upload|remove)(_|$)/;

describe("bridged tool grants", () => {
  it("pins which packs hold which bridged tools", () => {
    const held = Object.fromEntries(AGENT_PACKS.filter((p) => p.access.bridge.length > 0).map((p) => [p.id, p.access.bridge]));
    expect(held).toEqual({
      a11y_audit: [{ server: "mobbin", tools: MOBBIN }],
      design_parity: [{ server: "figma", tools: PARITY }, { server: "figma-desktop", tools: PARITY }],
      design_spec: [{ server: "figma", tools: FIGMA }, { server: "figma-desktop", tools: FIGMA }, { server: "mobbin", tools: MOBBIN }],
    });
  });
  it("grants no tool whose name reads as a write", () => {
    for (const pack of AGENT_PACKS) for (const grant of pack.access.bridge) for (const tool of grant.tools) expect(WRITES.test(tool), `${pack.id}: ${grant.server}.${tool}`).toBe(false);
  });
});
