import { BRAIN_QUERIES } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type Brain, type BrainAnswer, type BrainValue, noBrain } from "./brain.ts";
import { brainEvidence } from "./brain-ask.ts";

type Row = Record<string, BrainValue>;
type Params = Record<string, string | number>;

/** A brain that records every query and answers from a table of `name` or `name:<first param value>`. */
function fake(answers: Record<string, Row[] | Error>) {
  const asked: Array<{ name: string; params: Params }> = [];
  const brain: Brain = {
    ...noBrain(),
    enabled: true,
    query: async (name, params = {}): Promise<BrainAnswer> => {
      asked.push({ name, params });
      const hit = answers[`${name}:${Object.values(params)[0]}`] ?? answers[name] ?? [];
      if (hit instanceof Error) throw hit;
      return { rows: hit, note: null };
    },
  };
  return { brain, asked };
}

const card = (id: string, over: Row = {}): Row => ({ card: `card:${id}`, title: `Card ${id}`, state: "closed", size: "M", risk: "low", est_loc: 40, actual_loc: 55, retries: 1, escalations: 0, opened_at: "2026-10-01T09:00:00.000Z", closed_at: "2026-10-03T17:00:00.000Z", ...over });

describe("brainEvidence", () => {
  it("asks for the cards of a ticket named in the question", async () => {
    const { brain, asked } = fake({ cards_for_ticket: [card("a")] });
    const rows = await brainEvidence(brain, "how did PLAT-12 go, and PLAT-12 again? And plat-9, or PLAT-13 and PLAT-14 and PLAT-15?");
    expect(asked.filter((q) => q.name === "cards_for_ticket").map((q) => q.params)).toEqual([{ ticket: "ticket:jira/PLAT-12" }, { ticket: "ticket:jira/PLAT-13" }, { ticket: "ticket:jira/PLAT-14" }]);
    expect(rows.map((r) => r.slug)).toEqual(["card:a"]);
  });

  it("asks the seven searches with the question itself", async () => {
    const { brain, asked } = fake({});
    expect(await brainEvidence(brain, "what went wrong with exports?")).toEqual([]);
    expect(asked).toEqual([
      { name: "search_cards", params: { q: "what went wrong with exports?" } },
      { name: "search_components", params: { q: "what went wrong with exports?" } },
      { name: "search_learnings", params: { q: "what went wrong with exports?" } },
      { name: "search_principles", params: { q: "what went wrong with exports?" } },
      { name: "search_incidents", params: { q: "what went wrong with exports?" } },
      { name: "search_controls", params: { q: "what went wrong with exports?" } },
      { name: "search_answers", params: { q: "what went wrong with exports?" } },
    ]);
  });

  it("writes a card as one line of its columns, a day for a time and nothing for a null column", async () => {
    const { brain } = fake({ search_cards: [card("a"), card("b", { size: null, risk: null, est_loc: null, closed_at: null, state: "open" })] });
    const rows = await brainEvidence(brain, "export");
    expect(rows[0]).toEqual({ slug: "card:a", kind: "card", text: "Card a · state closed · size M · risk low · estimated 40 lines · actual 55 lines · retries 1 · escalations 0 · opened 2026-10-01 · closed 2026-10-03" });
    expect(rows[1]!.text).toBe("Card b · state open · actual 55 lines · retries 1 · escalations 0 · opened 2026-10-01");
  });

  it("gives a card found by the ticket and by the search once, ticket hit first", async () => {
    const { brain } = fake({ cards_for_ticket: [card("t", { title: "From ticket" })], search_cards: [card("s"), card("t", { title: "From search" })] });
    const rows = await brainEvidence(brain, "PLAT-1 export");
    expect(rows.map((r) => [r.slug, r.text.split(" · ")[0]])).toEqual([["card:t", "From ticket"], ["card:s", "Card s"]]);
  });

  it("orders the rows: cards, their pull requests, their verdicts, then the components", async () => {
    const { brain, asked } = fake({
      search_cards: [card("a")],
      search_components: [{ component: "component:exports", name: "exports" }],
      "cards_touching:component:exports": [card("a"), card("c")],
      "prs_for_card:card:a": [{ pr: "pr:acme/shop#12", number: 12, title: "t", state: "merged", url: "https://gh/12", merged_at: "2026-10-03T18:00:00.000Z" }],
      "verdicts_for_card:card:a": [{ verdict: "verdict:v1", pack: "risk_score", question: "how risky", answer: "low", confidence: 0.9, truth: "low", truth_source: "outcome", decided_at: "2026-10-01T10:00:00.000Z" }],
    });
    const rows = await brainEvidence(brain, "export");
    expect(rows.map((r) => [r.kind, r.slug])).toEqual([["card", "card:a"], ["card", "card:c"], ["pr", "pr:acme/shop#12"], ["verdict", "verdict:v1"], ["component", "component:exports"]]);
    expect(rows.find((r) => r.kind === "pr")!.text).toBe("pull request #12 · merged · merged 2026-10-03 · https://gh/12 · for card:a");
    expect(rows.find((r) => r.kind === "verdict")!.text).toBe("risk_score asked how risky · answered low · confidence 0.9 · truth low (outcome) · on card:a · 2026-10-01");
    expect(rows.find((r) => r.kind === "component")!.text).toBe("exports · touched by card:a, card:c");
    // pull requests and verdicts are asked for the cards, cards_touching for the component.
    expect(asked.map((q) => q.name)).toEqual(expect.arrayContaining(["cards_touching", "prs_for_card", "verdicts_for_card"]));
  });

  it("leaves a null column out of a pull request and a verdict, and the touched-by part out of a component nobody touched", async () => {
    const { brain } = fake({
      search_cards: [card("a")],
      search_components: [{ component: "component:lonely", name: "lonely" }],
      prs_for_card: [{ pr: "pr:o/r#1", number: 1, title: "t", state: "open", url: "https://gh/1", merged_at: null }],
      verdicts_for_card: [{ verdict: "verdict:v", pack: "p", question: "q", answer: "a", confidence: null, truth: null, truth_source: null, decided_at: "2026-10-01T10:00:00.000Z" }],
    });
    const rows = await brainEvidence(brain, "x");
    expect(rows.find((r) => r.kind === "pr")!.text).toBe("pull request #1 · open · https://gh/1 · for card:a");
    expect(rows.find((r) => r.kind === "verdict")!.text).toBe("p asked q · answered a · on card:a · 2026-10-01");
    expect(rows.find((r) => r.kind === "component")!.text).toBe("lonely");
  });

  it("reads pull requests and verdicts of the first five cards only, at most six verdicts each, and touching of the first three components", async () => {
    const verdicts = Array.from({ length: 9 }, (_, i) => ({ verdict: `verdict:v${i}`, pack: "p", question: "q", answer: "a", confidence: null, truth: null, truth_source: null, decided_at: "2026-10-01T10:00:00.000Z" }));
    const { brain, asked } = fake({
      search_cards: Array.from({ length: 8 }, (_, i) => card(`c${i}`)),
      search_components: Array.from({ length: 5 }, (_, i) => ({ component: `component:k${i}`, name: `k${i}` })),
      "verdicts_for_card:card:c0": verdicts,
    });
    const rows = await brainEvidence(brain, "x");
    expect(asked.filter((q) => q.name === "prs_for_card").map((q) => q.params.card)).toEqual(["card:c0", "card:c1", "card:c2", "card:c3", "card:c4"]);
    expect(asked.filter((q) => q.name === "cards_touching")).toHaveLength(3);
    expect(rows.filter((r) => r.kind === "verdict")).toHaveLength(6);
    expect(rows.filter((r) => r.kind === "component")).toHaveLength(5);
  });

  it("keeps at most twelve cards, sixty rows, and cuts a text to 600 characters", async () => {
    const many = Array.from({ length: 15 }, (_, i) => card(`c${i}`, i === 0 ? { title: "t".repeat(900) } : {}));
    const prsOf = (c: number) => Array.from({ length: 20 }, (_, i) => ({ pr: `pr:o/r#${c}-${i}`, number: i, title: "t", state: "open", url: "https://gh", merged_at: null }));
    const { brain } = fake({ search_cards: many, ...Object.fromEntries(Array.from({ length: 5 }, (_, c) => [`prs_for_card:card:c${c}`, prsOf(c)])) });
    const rows = await brainEvidence(brain, "x");
    expect(rows).toHaveLength(60);
    expect(rows.filter((r) => r.kind === "card")).toHaveLength(12);
    expect(rows.filter((r) => r.kind === "pr")).toHaveLength(48);
    expect(rows.every((r) => r.text.length <= 600)).toBe(true);
    expect(rows[0]!.text).toHaveLength(600);
  });

  it("contributes nothing for a query that fails, and never throws", async () => {
    const { brain } = fake({ search_cards: new Error("boom"), search_components: [{ component: "component:k", name: "k" }], "cards_touching:component:k": new Error("boom") });
    await expect(brainEvidence(brain, "x")).resolves.toEqual([{ slug: "component:k", kind: "component", text: "k" }]);
  });

  it("asks only for queries an agent may run", async () => {
    const { brain, asked } = fake({ cards_for_ticket: [card("a")], search_cards: [card("b")], search_components: [{ component: "component:k", name: "k" }], cards_touching: [card("c")] });
    await brainEvidence(brain, "PLAT-1 export");
    expect(asked.length).toBeGreaterThan(4);
    for (const { name } of asked) expect(BRAIN_QUERIES.find((q) => q.name === name)).toMatchObject({ agent: true });
  });

  it("answers nothing, with no call, when the brain is off", async () => {
    expect(await brainEvidence(noBrain(), "PLAT-1 export")).toEqual([]);
  });
});

describe("brainEvidence lessons", () => {
  const lesson = (id: string, over: Row = {}): Row => ({ learning: `learning:${id}`, title: `Lesson ${id}`, kind: "pattern", scope: "repo", recorded_at: "2026-11-02T08:00:00.000Z", ...over });
  const claim = (id: string, over: Row = {}): Row => ({ claim: `claim:${id}`, statement: "s", quote: `the exact words of ${id}`, status: "verified", source: "source:card/a", source_title: "Export CSV", ...over });

  it("puts a lesson first, with the quote of its first verified claim and where it came from", async () => {
    const { brain } = fake({ search_cards: [card("a")], search_learnings: [lesson("l1")], claims_of_learning: [claim("c0", { status: "unverified" }), claim("c1")] });
    const rows = await brainEvidence(brain, "export");
    expect(rows.map((r) => [r.kind, r.slug])).toEqual([["learning", "learning:l1"], ["card", "card:a"]]);
    expect(rows[0]!.text).toBe('Lesson l1 · pattern · scope repo · learned 2026-11-02 · rests on "the exact words of c1" from Export CSV');
  });

  it("leaves the quote and the day out of a lesson with no verified claim", async () => {
    const { brain } = fake({ search_learnings: [lesson("l1", { recorded_at: null })], claims_of_learning: [claim("c0", { status: "rejected" })] });
    expect((await brainEvidence(brain, "export"))[0]!.text).toBe("Lesson l1 · pattern · scope repo");
  });

  it("cuts a quote to 200 characters, takes at most 5 lessons and reads the claims of the first 3", async () => {
    const { brain, asked } = fake({ search_learnings: Array.from({ length: 7 }, (_, i) => lesson(`l${i}`)), claims_of_learning: [claim("c1", { quote: "q".repeat(300) })] });
    const rows = await brainEvidence(brain, "export");
    expect(rows).toHaveLength(5);
    expect(rows[0]!.text).toContain(`"${"q".repeat(200)}"`);
    expect(rows[0]!.text).not.toContain("q".repeat(201));
    expect(rows.every((r) => r.text.length <= 600)).toBe(true);
    expect(asked.filter((q) => q.name === "claims_of_learning").map((q) => q.params)).toEqual([{ learning: "learning:l0" }, { learning: "learning:l1" }, { learning: "learning:l2" }]);
    expect(asked.find((q) => q.name === "search_learnings")!.params).toEqual({ q: "export" });
  });

  it("asks only agent-readable queries", async () => {
    const { brain, asked } = fake({ search_learnings: [lesson("l1")] });
    await brainEvidence(brain, "PLAT-1 export");
    const readable = new Set(BRAIN_QUERIES.filter((q) => q.agent).map((q) => q.name));
    expect(asked.map((q) => q.name).filter((name) => !readable.has(name))).toEqual([]);
    expect(asked.map((q) => q.name)).toContain("search_learnings");
  });

  it("keeps the 60-row cap with lessons first", async () => {
    const { brain } = fake({ search_cards: Array.from({ length: 12 }, (_, i) => card(`c${i}`)), search_learnings: [lesson("l1")] });
    const rows = await brainEvidence(brain, "export");
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(rows[0]!.kind).toBe("learning");
  });
});

describe("brainEvidence principles", () => {
  const principle = (id: string, over: Row = {}): Row => ({ principle: `principle:luna-ab12/${id}`, statement: `Rule ${id}`, section: "Testing", repo: "repo:luna-ab12", ...over });

  it("puts up to 5 principles after the lessons and before the cards, as one line", async () => {
    const lesson: Row = { learning: "learning:l1", title: "Lesson", kind: "pattern", scope: "repo", recorded_at: null };
    const { brain } = fake({ search_cards: [card("a")], search_learnings: [lesson], search_principles: Array.from({ length: 7 }, (_, i) => principle(`p${i}`)) });
    const rows = await brainEvidence(brain, "tests");
    expect(rows.map((r) => r.kind)).toEqual(["learning", "principle", "principle", "principle", "principle", "principle", "card"]);
    expect(rows[1]).toEqual({ slug: "principle:luna-ab12/p0", kind: "principle", text: "Rule p0 · rule of luna-ab12 · section Testing" });
  });

  it("leaves a missing column out, and a failing search adds nothing", async () => {
    const { brain } = fake({ search_principles: [principle("p1", { section: null, repo: null })] });
    expect((await brainEvidence(brain, "x"))[0]!.text).toBe("Rule p1");
    const failing = fake({ search_principles: new Error("boom"), search_cards: [card("a")] });
    expect((await brainEvidence(failing.brain, "x")).map((r) => r.kind)).toEqual(["card"]);
  });
});

describe("brainEvidence compliance", () => {
  const incident = (id: string, over: Row = {}): Row => ({ incident: `incident:${id}`, title: `Incident ${id}`, severity: "high", status: "resolved", service: "exports", breach: true, started_at: "2026-11-10T09:00:00.000Z", resolved_at: "2026-11-11T10:00:00.000Z", ...over });
  const control = (id: string, over: Row = {}): Row => ({ control: `control:luna-ab12/Compliance/Controls/${id}.md`, title: `Control ${id}`, kind: "control", path: `Compliance/Controls/${id}.md`, repo: "repo:luna-ab12", ...over });
  const answer = (id: string, over: Row = {}): Row => ({ answer: `answer:luna-ab12/Compliance/Answers/${id}.md`, question: `Question ${id}?`, path: `Compliance/Answers/${id}.md`, repo: "repo:luna-ab12", ...over });

  it("puts up to 3 incidents, controls and answers after the principles and before the cards, as one line", async () => {
    const { brain } = fake({
      search_cards: [card("a")],
      search_principles: [{ principle: "principle:luna-ab12/p", statement: "Rule", section: null, repo: null }],
      search_incidents: ["1", "2", "3", "4"].map((id) => incident(id)),
      search_controls: ["1", "2", "3", "4"].map((id) => control(id)),
      search_answers: ["1", "2", "3", "4"].map((id) => answer(id)),
    });
    const rows = await brainEvidence(brain, "breach");
    expect(rows.map((r) => r.kind)).toEqual(["principle", ...Array(3).fill("incident"), ...Array(3).fill("control"), ...Array(3).fill("answer"), "card"]);
    expect(rows[1]).toEqual({ slug: "incident:1", kind: "incident", text: "Incident 1 · high · resolved · service exports · exposed personal data: yes · started 2026-11-10 · resolved 2026-11-11" });
    expect(rows[4]).toEqual({ slug: "control:luna-ab12/Compliance/Controls/1.md", kind: "control", text: "Control 1 · control page · Compliance/Controls/1.md · wiki of luna-ab12" });
    expect(rows[7]).toEqual({ slug: "answer:luna-ab12/Compliance/Answers/1.md", kind: "answer", text: "Question 1? · approved answer · Compliance/Answers/1.md · wiki of luna-ab12" });
  });

  it("leaves out the parts of an incident whose value is null, and says no for a breach of false", async () => {
    const { brain } = fake({ search_incidents: [incident("x", { service: null, breach: null, resolved_at: null, status: "open" }), incident("y", { breach: false })] });
    const rows = await brainEvidence(brain, "q");
    expect(rows[0]!.text).toBe("Incident x · high · open · started 2026-11-10");
    expect(rows[1]!.text).toContain("exposed personal data: no");
  });

  it("writes a policy page as a policy page", async () => {
    const { brain } = fake({ search_controls: [control("p", { kind: "policy" })] });
    expect((await brainEvidence(brain, "q"))[0]!.text).toContain("· policy page ·");
  });

  it("skips a failing compliance query and keeps the others", async () => {
    const { brain } = fake({ search_incidents: new Error("boom"), search_controls: [control("1")] });
    expect((await brainEvidence(brain, "q")).map((r) => r.kind)).toEqual(["control"]);
  });
});
