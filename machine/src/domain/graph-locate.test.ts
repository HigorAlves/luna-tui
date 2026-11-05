import { describe, expect, it } from "vitest";

import { locate } from "./graph-locate.ts";

const graph = {
  nodes: [
    { id: "cart.applyCoupon", label: "applyCoupon", source_file: "src/cart/coupon.ts", community: 1 },
    { id: "cart.total", label: "cartTotal", source_file: "src/cart/total.ts", community: 1 },
    { id: "auth.login", label: "login", source_file: "src/auth/login.ts", community: 2 },
  ],
  links: [{ source: "cart.total", target: "cart.applyCoupon" }],
};

describe("locate", () => {
  it("names the files a ticket's words point at, best match first, with the symbols that matched", () => {
    const found = locate(graph, "The coupon code is applied twice when applyCoupon runs");
    expect(found.files[0]).toBe("src/cart/coupon.ts");
    expect(found.files).not.toContain("src/auth/login.ts");
    expect(found.symbols).toContain("applyCoupon");
    expect(found.confidence).toBeGreaterThan(0);
  });

  it("finds nothing, with no confidence, for words the graph does not know", () => {
    expect(locate(graph, "rotate the TLS certificates")).toMatchObject({ files: [], symbols: [], confidence: 0 });
  });
});
