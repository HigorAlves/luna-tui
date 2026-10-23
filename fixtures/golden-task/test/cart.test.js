import assert from "node:assert/strict";
import { test } from "node:test";

import { cartTotal, formatPrice } from "../src/cart.js";

test("formatPrice always shows two decimal places", () => {
  assert.equal(formatPrice(1234), "$12.34");
  assert.equal(formatPrice(100), "$1.00");
});

test("cartTotal sums price times quantity", () => {
  const total = cartTotal([
    { priceCents: 500, qty: 2 },
    { priceCents: 150, qty: 1 },
  ]);
  assert.equal(total, 1150);
});
