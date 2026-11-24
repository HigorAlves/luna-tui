// Every test file holds the API's answers to its OpenAPI document (adapters/http/openapi/conformance.ts).
// `OPENAPI_CONFORMANCE_REPORT=<file>` appends what was found instead of failing, for an audit of the whole suite.
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect } from "vitest";

import { violations } from "../adapters/http/openapi/conformance.ts";

process.env.MACHINE_OPENAPI_CONFORMANCE = "1";

beforeAll(() => {
  violations.length = 0;
});

afterAll(() => {
  const found = violations.splice(0);
  const report = process.env.OPENAPI_CONFORMANCE_REPORT;
  if (report) {
    for (const violation of found) appendFileSync(report, `${JSON.stringify({ file: expect.getState().testPath, ...violation })}\n`);
    return;
  }
  expect(found, "answers that break the OpenAPI document").toEqual([]);
});
