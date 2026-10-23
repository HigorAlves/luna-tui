import { expect, test } from "vitest";

import { cartTotal, formatPrice, renderCart } from "../src/cart.ts";

test("formatPrice shows two decimals", () => {
  expect(formatPrice(1234)).toBe("$12.34");
  expect(formatPrice(100)).toBe("$1.00");
});

test("cartTotal multiplies price by quantity", () => {
  expect(
    cartTotal([
      { name: "pen", priceCents: 500, qty: 2 },
      { name: "ink", priceCents: 150, qty: 1 },
    ]),
  ).toBe(1150);
});

test("renderCart lists each item with its line total", () => {
  const html = renderCart([{ name: "pen", priceCents: 500, qty: 2 }]);
  expect(html).toBe("<ul><li>pen x2 - $10.00</li></ul>");
});
