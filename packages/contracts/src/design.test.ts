import { describe, expect, it } from "vitest";

import { DesignContext, DesignRef, figmaNodeId } from "./design.ts";

describe("DesignRef", () => {
  it("takes a file key, node ids in API form and where they came from", () => {
    const ref = DesignRef.parse({ fileKey: "AbCdEf0123456789", nodeIds: ["12:34", "5:6"], page: null, from: "attachment" });
    expect(ref.nodeIds).toEqual(["12:34", "5:6"]);
  });
  it("refuses a node id in URL form and a file key a path could hide in", () => {
    expect(DesignRef.safeParse({ fileKey: "AbCdEf0123456789", nodeIds: ["12-34"], page: null, from: "issue" }).success).toBe(false);
    expect(DesignRef.safeParse({ fileKey: "Ab/../etc", nodeIds: [], page: null, from: "issue" }).success).toBe(false);
  });
  it("refuses a source the machine does not know", () => {
    expect(DesignRef.safeParse({ fileKey: "AbCdEf0123456789", nodeIds: [], page: null, from: "slack" }).success).toBe(false);
  });
});

describe("DesignContext", () => {
  it("holds one to five references", () => {
    expect(DesignContext.safeParse({ refs: [] }).success).toBe(false);
    const ref = { fileKey: "AbCdEf0123456789", nodeIds: [], page: null, from: "luna.yaml" as const };
    expect(DesignContext.safeParse({ refs: Array(6).fill(ref) }).success).toBe(false);
  });
});

describe("figmaNodeId", () => {
  it("turns the URL form into the API form, and refuses anything else", () => {
    expect(figmaNodeId("12-34")).toBe("12:34");
    expect(figmaNodeId("12%3A34")).toBe("12:34");
    expect(figmaNodeId("12:34")).toBe("12:34");
    expect(figmaNodeId("12-34-5")).toBeNull();
    expect(figmaNodeId("<x>")).toBeNull();
  });
});
