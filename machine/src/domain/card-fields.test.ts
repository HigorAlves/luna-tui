import { describe, expect, it } from "vitest";

import { cardFieldsOf } from "./card-fields.ts";

describe("what a card keeps of the entry contract", () => {
  it("keeps every source, with the first as the card's own, and the reporter", () => {
    const fields = cardFieldsOf({
      sources: [
        { kind: "github", repo: "o/a", number: 12, url: "https://github.com/o/a/issues/12" },
        { kind: "slack", channel: "C1", ts: "1.2", permalink: "https://example.slack.com/archives/C1/p12" },
      ],
      reporter: { id: "U123", channel: "slack" },
    });
    expect(fields.sources).toHaveLength(2);
    expect(fields.sources[0]).toMatchObject({ kind: "github", number: 12 });
    expect(fields.reporter).toEqual({ id: "U123", channel: "slack" });
  });

  it("reads a card made before this wave: one source, nothing else", () => {
    const fields = cardFieldsOf({ source: { kind: "jira", key: "EX-1", url: "https://example.atlassian.net/browse/EX-1", issueType: "Bug" } });
    expect(fields.sources).toEqual([{ kind: "jira", key: "EX-1", url: "https://example.atlassian.net/browse/EX-1", issueType: "Bug" }]);
    expect(fields).toMatchObject({ reporter: null, hints: null, attachments: [], owners: [], followers: [], project: null });
  });

  it("keeps an attachment as a reference only, and only with a web address", () => {
    const fields = cardFieldsOf({
      attachments: [
        { name: "trace.txt", url: "https://files.example/trace.txt", mediaType: "text/plain", size: 120 },
        { name: "local", url: "file:///etc/passwd" },
        { name: "script", url: "javascript:alert(1)" },
      ],
    });
    expect(fields.attachments).toEqual([{ name: "trace.txt", url: "https://files.example/trace.txt", mediaType: "text/plain", size: 120 }]);
  });

  it("flattens and caps what a stranger wrote, and bounds every list", () => {
    const fields = cardFieldsOf({
      reporter: { id: `a\nb${"x".repeat(500)}`, channel: "github" },
      project: "PAY\n# heading",
      owners: Array.from({ length: 80 }, (_, i) => `@team-${i}`),
    });
    expect(fields.reporter!.id).not.toContain("\n");
    expect(fields.reporter!.id.length).toBeLessThanOrEqual(120);
    expect(fields.project).toBe("PAYheading");
    expect(fields.owners.length).toBeLessThanOrEqual(20);
  });

  it("stores an identifier only from letters, digits and @ / . _ -, so it cannot carry markup or control characters", () => {
    const fields = cardFieldsOf({
      reporter: { id: "<img src=x onerror=1>U1\u0000\u202e", channel: "sl`ack" },
      project: "PAY[1](x)",
      owners: ["@team-a/core.x_y", "<b>@evil</b>", "\u0007"],
      followers: ["U2\n[link](http://x)"],
    });
    expect(fields.reporter).toEqual({ id: "imgsrcxonerror1U1", channel: "slack" });
    expect(fields.project).toBe("PAY1x");
    expect(fields.owners).toEqual(["@team-a/core.x_y", "b@evil/b"]);
    expect(fields.followers).toEqual(["U2linkhttp//x"]);
  });
});

describe("the demand sub-score", () => {
  it("never goes past 3 or below 0, and the priority follows", async () => {
    const { withDemand } = await import("./card-fields.ts");
    const record = { urgencyDetail: { priority: "P2", subScores: { who: 3, what: 3, impact: 3, time: 3, demand: 3 } } } as never;
    expect((withDemand(record, 1) as { urgencyDetail: { subScores: { demand: number } } }).urgencyDetail.subScores.demand).toBe(3);
    expect((withDemand(record, -9) as { urgencyDetail: { subScores: { demand: number } } }).urgencyDetail.subScores.demand).toBe(0);
    expect(withDemand(null, 1)).toBeNull();
  });
});

describe("the demand score with a repository's own weights and bands", () => {
  it("scores the priority by them", async () => {
    const { withDemand } = await import("./card-fields.ts");
    const record = { urgencyDetail: { priority: "P3", subScores: { who: 2, what: 2, impact: 2, time: 2, demand: 1 } } } as never;
    // Defaults: 21 is P2. With every weight 1 and the bars 7 and 9, 2+2+2+2+2 = 10 is P0 after the bump.
    expect((withDemand(record, 1, { weights: { who: 1, what: 1, impact: 1, time: 1, demand: 1 }, bands: { P0: 10, P1: 9, P2: 7 } }) as { urgencyDetail: { priority: string } }).urgencyDetail.priority).toBe("P0");
    expect((withDemand(record, 1) as { urgencyDetail: { priority: string } }).urgencyDetail.priority).toBe("P1");
  });
});
