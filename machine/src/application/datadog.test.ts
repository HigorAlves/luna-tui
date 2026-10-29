import { describe, expect, it } from "vitest";

import { NoDatadogTokenError, noTokenDatadog } from "./datadog.ts";

describe("noTokenDatadog", () => {
  it("refuses every call with the same reason", async () => {
    const dd = noTokenDatadog();
    for (const call of [() => dd.incidents(), () => dd.alertingMonitors(""), () => dd.errorTrackingIssues("", "1", "2"), () => dd.errorLogClusters("", "1", "2", 10)]) {
      await expect(call()).rejects.toBeInstanceOf(NoDatadogTokenError);
    }
  });

  it("still builds links to the site's web app", () => {
    expect(noTokenDatadog().webUrl("/incidents/42")).toBe("https://app.datadoghq.com/incidents/42");
    expect(noTokenDatadog("datadoghq.eu").webUrl("monitors/1")).toBe("https://app.datadoghq.eu/monitors/1");
    expect(noTokenDatadog("us5.datadoghq.com").webUrl("monitors/1")).toBe("https://us5.datadoghq.com/monitors/1");
  });
});
