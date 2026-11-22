import { expect, test } from "vitest";

import { renderEmailField } from "../../src/ui/EmailField.ts";

test("the label is tied to the input and the hint describes it", () => {
  const html = renderEmailField({ value: "", hint: "We send the receipt here" });
  expect(html).toContain('<label for="email">');
  expect(html).toContain('id="email"');
  expect(html).toContain('aria-describedby="email-hint"');
});

test("an error marks the input invalid and is announced", () => {
  const html = renderEmailField({ value: "x", hint: "We send the receipt here", error: "Enter an email like name@example.com" });
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('aria-describedby="email-hint email-error"');
  expect(html).toContain('role="alert"');
});
