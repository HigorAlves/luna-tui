import { createHash } from "node:crypto";
import type { BrainNodeRow, BrainRow } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { AssessedBreach } from "../breach.ts";
import type { Incident } from "../incident.ts";
import { incidentRows, pageRows, regimeRows } from "./rows-compliance.ts";

const repo = { slug: "luna-tui-ab12", name: "luna-tui" };
const nodes = (rows: BrainRow[], type?: string) => rows.filter((row): row is BrainNodeRow => "type" in row && (type === undefined || row.type === type));
const edges = (rows: BrainRow[]) => rows.filter((row) => "edge" in row);

const yes = { value: true, p: 0.9 };
const no = { value: false, p: 0.1 };
const assessed = (regimes: AssessedBreach["regimes"], answers: Partial<AssessedBreach["answers"]> = {}): AssessedBreach => ({
  assessedAt: "2026-11-10T10:00:00.000Z",
  answers: { personal_data: yes, phi: no, eu_subjects: yes, br_subjects: yes, us_subjects: no, us_elements: no, subjects: { score: 1, confidence: 0.8 }, ...answers } as AssessedBreach["answers"],
  regimes,
  clocks: {},
});

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: "datadog:incident:42",
    title: "Export bucket public",
    severity: "high",
    status: "open",
    startedAt: "2026-11-10T09:00:00Z",
    resolvedAt: null,
    service: "exports",
    signals: [],
    timeline: [{ at: "2026-11-10T09:20:00.000Z", source: "slack", text: "TIMELINE-SECRET-TEXT" }],
    ...over,
  };
}

describe("regimeRows", () => {
  it("gives the repository, then a regime and an edge for each known regime, and drops unknown names", () => {
    const rows = regimeRows(repo, ["soc2", "gdpr", "nope"]);
    expect(rows[0]).toEqual({ type: "Repo", data: { slug: "repo:luna-tui-ab12", name: "luna-tui" } });
    expect(nodes(rows, "Regime").map((row) => row.data)).toEqual([
      { slug: "regime:soc2", name: "SOC 2" },
      { slug: "regime:gdpr", name: "GDPR" },
    ]);
    expect(edges(rows)).toEqual([
      { edge: "RepoUnderRegime", from: "repo:luna-tui-ab12", to: "regime:soc2" },
      { edge: "RepoUnderRegime", from: "repo:luna-tui-ab12", to: "regime:gdpr" },
    ]);
  });

  it("names every regime readably", () => {
    expect(nodes(regimeRows(repo, ["soc2", "hipaa", "gdpr", "lgpd", "us_privacy"]), "Regime").map((row) => row.data.name)).toEqual(["SOC 2", "HIPAA", "GDPR", "LGPD", "US privacy"]);
  });
});

describe("incidentRows", () => {
  it("gives the incident, its regimes and an edge each, with breach true", () => {
    const rows = incidentRows(incident({ breach: assessed(["gdpr", "lgpd"]), status: "resolved", resolvedAt: "2026-11-10T12:00:00Z" }));
    expect(nodes(rows, "Incident")[0]!.data).toEqual({
      slug: "incident:datadog:incident:42",
      title: "Export bucket public",
      severity: "high",
      status: "resolved",
      service: "exports",
      breach: true,
      started_at: "2026-11-10T09:00:00.000Z",
      resolved_at: "2026-11-10T12:00:00.000Z",
    });
    expect(nodes(rows, "Regime").map((row) => row.data.slug)).toEqual(["regime:gdpr", "regime:lgpd"]);
    expect(edges(rows)).toEqual([
      { edge: "IncidentUnderRegime", from: "incident:datadog:incident:42", to: "regime:gdpr" },
      { edge: "IncidentUnderRegime", from: "incident:datadog:incident:42", to: "regime:lgpd" },
    ]);
  });

  it("has breach null and no regime with no assessment, or one that failed", () => {
    for (const breach of [undefined, { error: "rate limited" }]) {
      const rows = incidentRows(incident(breach ? { breach } : {}));
      expect(nodes(rows, "Incident")[0]!.data.breach).toBeNull();
      expect(nodes(rows, "Incident")[0]!.data.resolved_at).toBeNull();
      expect(rows).toHaveLength(1);
    }
  });

  it("has breach false for an assessment that found no regime", () => {
    const rows = incidentRows(incident({ breach: assessed([], { personal_data: no }) }));
    expect(nodes(rows, "Incident")[0]!.data.breach).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("has a null service when the incident has none", () => {
    expect(nodes(incidentRows(incident({ service: null })))[0]!.data.service).toBeNull();
  });

  it("makes a slug-safe slug of the id and shortens a long one with a hash", () => {
    expect(nodes(incidentRows(incident({ id: "sentry:ABC 123?x=y@2026" })))[0]!.data.slug).toBe("incident:sentry:ABC-123-x-y-2026");
    const long = `jira:${"A".repeat(200)}`;
    const slug = String(nodes(incidentRows(incident({ id: long })))[0]!.data.slug);
    expect(slug).toBe(`incident:${long.slice(0, 100)}${createHash("sha256").update(long).digest("hex").slice(0, 12)}`);
  });

  it("masks an address in the title, and keeps one line of 200 characters", () => {
    expect(nodes(incidentRows(incident({ title: "Leak reported by ana@example.com" })))[0]!.data.title).toBe("Leak reported by [email]");
    const title = nodes(incidentRows(incident({ title: `${"x".repeat(150)}\n${"y".repeat(150)}` })))[0]!.data.title as string;
    expect(title).toHaveLength(200);
    expect(title).not.toMatch(/\n/);
  });

  it("cuts a secret out of the title", () => {
    const title = nodes(incidentRows(incident({ title: "Key AKIAIOSFODNN7EXAMPLE leaked" })))[0]!.data.title as string;
    expect(title).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("never carries the timeline text", () => {
    expect(JSON.stringify(incidentRows(incident({ breach: assessed(["gdpr"]) })))).not.toContain("TIMELINE-SECRET-TEXT");
  });
});

describe("pageRows", () => {
  const pages = [
    { path: "Compliance/Controls/Access-Control.md", text: "# Access control\n\nBODY-OF-CONTROL" },
    { path: "Compliance/Policies/data_retention.md", text: "no heading here, BODY-OF-POLICY" },
    { path: "Compliance/Answers/2026-q3.md", text: "# Do you encrypt at rest?\n\nBODY-OF-ANSWER yes" },
    { path: "Home.md", text: "# Home" },
    { path: "Compliance/Other/x.md", text: "# Other" },
  ];

  it("gives a control, a policy and an answer with their edges, the repository first, and skips other pages", () => {
    const rows = pageRows(pages, repo);
    expect(rows[0]).toEqual({ type: "Repo", data: { slug: "repo:luna-tui-ab12", name: "luna-tui" } });
    expect(nodes(rows).slice(1).map((row) => [row.type, row.data])).toEqual([
      ["Control", { slug: "control:luna-tui-ab12/Compliance/Controls/Access-Control.md", title: "Access control", kind: "control", path: "Compliance/Controls/Access-Control.md" }],
      ["Control", { slug: "control:luna-tui-ab12/Compliance/Policies/data_retention.md", title: "data retention", kind: "policy", path: "Compliance/Policies/data_retention.md" }],
      ["Answer", { slug: "answer:luna-tui-ab12/Compliance/Answers/2026-q3.md", question: "Do you encrypt at rest?", path: "Compliance/Answers/2026-q3.md" }],
    ]);
    expect(edges(rows)).toEqual([
      { edge: "ControlOfRepo", from: "control:luna-tui-ab12/Compliance/Controls/Access-Control.md", to: "repo:luna-tui-ab12" },
      { edge: "ControlOfRepo", from: "control:luna-tui-ab12/Compliance/Policies/data_retention.md", to: "repo:luna-tui-ab12" },
      { edge: "AnswerOfRepo", from: "answer:luna-tui-ab12/Compliance/Answers/2026-q3.md", to: "repo:luna-tui-ab12" },
    ]);
    // Each row is followed by its edge.
    expect(rows.indexOf(edges(rows)[0]!)).toBe(rows.indexOf(nodes(rows, "Control")[0]!) + 1);
  });

  it("gives nothing but the repository for pages elsewhere", () => {
    expect(pageRows([{ path: "Home.md", text: "# Home" }], repo)).toHaveLength(1);
  });

  it("never carries a page's body", () => {
    const json = JSON.stringify(pageRows(pages, repo));
    for (const body of ["BODY-OF-CONTROL", "BODY-OF-POLICY", "BODY-OF-ANSWER"]) expect(json).not.toContain(body);
  });

  it("replaces a space or control character in a path with a dash in the slug, and keeps the path", () => {
    const rows = pageRows([{ path: "Compliance/Controls/Key rotation\t.md", text: "# Keys" }], repo);
    expect(nodes(rows, "Control")[0]!.data.slug).toBe("control:luna-tui-ab12/Compliance/Controls/Key-rotation-.md");
  });

  it("takes the title from the first heading, masks it and caps it", () => {
    const rows = pageRows([{ path: "Compliance/Answers/a.md", text: `intro\n# Who is ana@example.com? ${"z".repeat(300)}\n# Second` }], repo);
    const question = nodes(rows, "Answer")[0]!.data.question as string;
    expect(question.startsWith("Who is [email]?")).toBe(true);
    expect(question).toHaveLength(200);
  });

  it("is deeply equal on a second pass over the same pages", () => {
    expect(pageRows(pages, repo)).toEqual(pageRows(pages, repo));
  });
});
