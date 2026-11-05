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
