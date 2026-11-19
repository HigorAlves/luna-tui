import { describe, expect, it } from "vitest";

import { NoMcpTokenError, noTokenMcp, shapeResult } from "./mcp.ts";

describe("noTokenMcp", () => {
  it("rejects a list with NoMcpTokenError", async () => {
    await expect(noTokenMcp().listTools("figma")).rejects.toBeInstanceOf(NoMcpTokenError);
  });
  it("answers a call with an error result, never a throw", async () => {
    expect(await noTokenMcp().callTool("figma", "x", {})).toEqual({ ok: false, error: "figma: not logged in (pnpm mcp login figma)" });
  });
});

describe("shapeResult", () => {
  it("joins text parts with a newline", () => {
    expect(shapeResult([{ type: "text", text: "a" }, { type: "text", text: "b" }], false)).toEqual({ ok: true, text: "a\nb", images: [], truncated: false });
  });
  it("keeps a resource part as its text and drops unknown parts", () => {
    expect(shapeResult([{ type: "resource", resource: { text: "doc" } }, { type: "audio", data: "zz" }], false)).toEqual({ ok: true, text: "doc", images: [], truncated: false });
  });
  it("turns an error result into its text", () => {
    expect(shapeResult([{ type: "text", text: "nope" }], true)).toEqual({ ok: false, error: "nope" });
  });
});
