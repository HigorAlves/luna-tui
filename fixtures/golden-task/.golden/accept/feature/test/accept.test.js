import assert from "node:assert/strict";
import { test } from "node:test";

import { describeCart } from "../src/cart.js";

test("describeCart counts units, not lines", () => {
  assert.equal(describeCart([]), "Cart is empty");
  assert.equal(describeCart([{ priceCents: 100, qty: 1 }]), "1 item");
  assert.equal(
    describeCart([
      { priceCents: 100, qty: 2 },
      { priceCents: 50, qty: 1 },
    ]),
    "3 items",
  );
});
