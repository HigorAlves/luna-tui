import { describe, expect, it } from "vitest";

import { NoSentryTokenError, noTokenSentry } from "./sentry.ts";

describe("noTokenSentry", () => {
  it("refuses every call with the same reason", async () => {
    await expect(noTokenSentry().newOrEscalatingIssues("2026-11-15T00:00:00Z")).rejects.toBeInstanceOf(NoSentryTokenError);
    await expect(noTokenSentry().newOrEscalatingIssues("2026-11-15T00:00:00Z")).rejects.toThrow(/MACHINE_SENTRY_TOKEN/);
  });
});
