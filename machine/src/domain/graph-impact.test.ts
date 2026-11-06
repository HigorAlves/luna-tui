import { describe, expect, it } from "vitest";

import { impact, isTestFile } from "./graph-impact.ts";

const graph = {
  nodes: [
    { id: "coupon", source_file: "src/cart/coupon.ts" },
    { id: "total", source_file: "src/cart/total.ts" },
    { id: "checkout", source_file: "src/checkout/page.ts" },
    { id: "couponTest", source_file: "src/cart/coupon.test.ts" },
    { id: "pyTest", source_file: "tests/test_total.py" },
    { id: "login", source_file: "src/auth/login.ts" },
  ],
  links: [
    { source: "total", target: "coupon" },
    { source: "checkout", target: "total" },
    { source: "couponTest", target: "coupon" },
  ],
};

describe("impact", () => {
  it("separates who imports a file from who sits one hop further, and finds tests by name and by reach", () => {
    const out = impact(graph, ["src/cart/coupon.ts"]);
    expect(out.importers).toEqual(["src/cart/coupon.test.ts", "src/cart/total.ts"]);
    expect(out.dependents).toEqual(["src/checkout/page.ts"]);
    expect(out.tests).toEqual(["src/cart/coupon.test.ts", "tests/test_total.py"]);
  });

  it("matches a test file to a changed file's name across conventions", () => {
    expect(impact(graph, ["src/cart/total.ts"]).tests).toContain("tests/test_total.py");
    expect(impact(graph, ["src/auth/login.ts"])).toEqual({ importers: [], dependents: [], tests: [] });
  });

  it("knows a test file by its path", () => {
    for (const p of ["a/__tests__/x.ts", "x.spec.ts", "test_x.py", "x_test.go", "FooTest.java", "tests/x.rs"]) expect(isTestFile(p)).toBe(true);
    for (const p of ["src/cart/total.ts", "src/latest.ts"]) expect(isTestFile(p)).toBe(false);
  });
});
