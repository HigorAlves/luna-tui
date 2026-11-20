import { describe, expect, it } from "vitest";

import { grantedTools } from "./bridge.ts";

const servers = [
  { name: "figma", transport: "http" as const, url: "https://mcp.figma.com/mcp", credential: { kind: "oauth" as const }, tools: ["get_design_context", "get_screenshot", "get_variable_defs"] },
  { name: "mobbin", transport: "http" as const, url: "https://mcp.mobbin.com/mcp", credential: { kind: "oauth" as const }, tools: ["search_screens"] },
];

describe("grantedTools", () => {
  it("keeps what machine, pack and repo all allow", () => {
    const r = grantedTools([{ server: "figma", tools: ["get_design_context", "get_screenshot", "write_canvas"] }], servers, { figma: { tools: ["get_design_context"] } }, "trusted", { untrusted: "deny" });
    expect(r.grants).toEqual([{ server: "figma", tools: ["get_design_context"] }]);
    expect(r.notes).toEqual(["figma: write_canvas is not bridged by the machine"]);
  });
  it("keeps the pack's list when the repo does not narrow that server", () => {
    const r = grantedTools([{ server: "mobbin", tools: ["search_screens"] }], servers, {}, "trusted", { untrusted: "deny" });
    expect(r.grants).toEqual([{ server: "mobbin", tools: ["search_screens"] }]);
  });
  it("drops a server the machine does not declare", () => {
    const r = grantedTools([{ server: "zeroheight", tools: ["search"] }], servers, {}, "trusted", { untrusted: "deny" });
    expect(r.grants).toEqual([]);
    expect(r.notes).toEqual(["zeroheight: no such server on this machine"]);
  });
  it("gives an untrusted card nothing unless the machine allows it", () => {
    const pack = [{ server: "figma", tools: ["get_screenshot"] }];
    expect(grantedTools(pack, servers, {}, "untrusted", { untrusted: "deny" }).grants).toEqual([]);
    expect(grantedTools(pack, servers, {}, "untrusted", { untrusted: "allow" }).grants).toEqual(pack);
  });
  it("refuses a repo that names tools the machine does not bridge", () => {
    const r = grantedTools([{ server: "figma", tools: ["get_screenshot"] }], servers, { figma: { tools: ["get_screenshot", "write_canvas"] } }, "trusted", { untrusted: "deny" });
    expect(r.grants).toEqual([{ server: "figma", tools: ["get_screenshot"] }]);
  });
});
