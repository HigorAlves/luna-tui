import { describe, expect, it } from "vitest";

import { locate, tokens } from "./graph-locate.ts";

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

  it("is more confident when one file stands out than when two tie", () => {
    const clear = locate(graph, "applyCoupon applyCoupon");
    const tie = locate({ nodes: [{ id: "a", label: "checkout", source_file: "a/x.ts" }, { id: "b", label: "checkout", source_file: "b/y.ts" }] }, "checkout");
    expect(clear.confidence).toBeGreaterThan(tie.confidence);
    expect(tie.confidence).toBeGreaterThan(0);
    expect(tie.confidence).toBeLessThan(1);
  });

  it("caps files and symbols at twenty and reads a bounded text", () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, label: `pay${i}`, source_file: `src/pay${i}/pay.ts` }));
    const out = locate({ nodes }, `pay ${"x ".repeat(100_000)}`);
    expect(out.files).toHaveLength(20);
    expect(out.symbols.length).toBeLessThanOrEqual(20);
  });

  it("splits camelCase, snake_case and paths, and ignores short words and stop words", () => {
    expect(tokens("applyCoupon_code in src/cart-total.ts the")).toEqual(["apply", "coupon", "code", "cart", "total"]);
  });
});
