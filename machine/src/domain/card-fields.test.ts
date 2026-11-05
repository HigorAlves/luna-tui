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

describe("the demand sub-score is derived from the count of reporters", () => {
  it("is the count, from 1 to 3, whatever it was before, and the priority follows", async () => {
    const { withDemand } = await import("./card-fields.ts");
    const record = { urgencyDetail: { priority: "P2", subScores: { who: 3, what: 3, impact: 3, time: 3, demand: 2 } } } as never;
    const demand = (n: number) => (withDemand(record, n) as { urgencyDetail: { subScores: { demand: number } } }).urgencyDetail.subScores.demand;
    expect([demand(1), demand(2), demand(3), demand(9), demand(0)]).toEqual([1, 2, 3, 3, 1]);
    expect(withDemand(null, 2)).toBeNull();
  });
  it("scores the priority by the repository's own weights and bands", async () => {
    const { withDemand } = await import("./card-fields.ts");
    const record = { urgencyDetail: { priority: "P3", subScores: { who: 2, what: 2, impact: 2, time: 2, demand: 1 } } } as never;
    const p = (r: unknown) => (r as { urgencyDetail: { priority: string } }).urgencyDetail.priority;
    expect(p(withDemand(record, 2, { weights: { who: 1, what: 1, impact: 1, time: 1, demand: 1 }, bands: { P0: 10, P1: 9, P2: 7 } }))).toBe("P0");
    expect(p(withDemand(record, 2))).toBe("P1");
  });
});

describe("a merge records what it added, and an unmerge removes only that", () => {
  const gh = { kind: "github", repo: "o/a", number: 1, url: "https://github.com/o/a/issues/1" } as const;
  const slack = { kind: "slack", channel: "C1", ts: "1", permalink: "https://x.slack.com/p1" } as const;
  const base = { reporter: null, hints: null, originMachine: null, attachments: [], project: null, owners: [], links: {} };
  it("keeps what the kept card already had, even when the duplicate repeats it", async () => {
    const { mergeFields, unmergeFields } = await import("./card-fields.ts");
    const kept = { ...base, sources: [gh, slack], reporter: { id: "alice" }, followers: ["bob"] } as never;
    const dup = { ...base, sources: [slack, { ...gh, number: 2, url: "https://github.com/o/a/issues/2" }], reporter: { id: "bob" }, followers: ["carol"] } as never;
    const merged = mergeFields(kept, dup, "d1");
    expect(merged.merged).toEqual([{ id: "d1", sources: [{ ...gh, number: 2, url: "https://github.com/o/a/issues/2" }], followers: ["carol"] }]);
    const back = unmergeFields(merged, "d1");
    expect(back.sources).toEqual([gh, slack]);
    expect(back.followers).toEqual(["bob"]);
    expect(back.merged).toEqual([]);
  });
  it("counts distinct reporters: one already on the card adds nothing", async () => {
    const { mergeFields } = await import("./card-fields.ts");
    const kept = { ...base, sources: [gh], reporter: { id: "alice" }, followers: [] } as never;
    const same = mergeFields(kept, { ...base, sources: [slack], reporter: { id: "alice" }, followers: [] } as never, "d1");
    expect(same.demand).toBe(1);
    const other = mergeFields(same, { ...base, sources: [slack], reporter: { id: "bob" }, followers: [] } as never, "d2");
    expect(other.demand).toBe(2);
  });
});

describe("a stored web address", () => {
  it("has no whitespace, angle bracket or quote", () => {
    const fields = cardFieldsOf({
      attachments: [
        { name: "ok", url: "https://f.example/a.txt" },
        { name: "space", url: "https://f.example/a b" },
        { name: "tag", url: "https://f.example/<script>" },
        { name: "quote", url: 'https://f.example/"x' },
        { name: "apos", url: "https://f.example/'x" },
        { name: "newline", url: "https://f.example/a\nb" },
      ],
      links: { good: "https://x.example/1", bad: "https://x.example/ 1" },
    });
    expect(fields.attachments.map((a) => a.name)).toEqual(["ok"]);
    expect(fields.links).toEqual({ good: "https://x.example/1" });
  });
});
