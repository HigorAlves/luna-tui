import { describe, expect, it } from "vitest";

import { bankPage, bankPath, chunkText, filledMarkdown, parseFilled } from "./questionnaire.ts";

const answers = [
  { n: 1, question: "Do you encrypt data at rest?", answer: "Yes, with AES-256.", citations: ["Compliance/Policies/Encryption.md"], fromBank: null, confidence: "high" as const },
  { n: 2, question: "Is **MFA** enforced for `admin` users?", answer: "Yes.\n\nSSO with MFA is required.", citations: ["Compliance/Controls/Access.md"], fromBank: "Compliance/Answers/is-mfa-enforced-5d38d7.md", confidence: "medium" as const },
];
const unanswered = [{ n: 3, question: "Do you hold ISO 27001?", why: "No page names the certification." }];

const filled = [
  "# acme-vendor.csv: answers",
  "",
  "## 1. Do you encrypt data at rest?",
  "",
  "Yes, with AES-256.",
  "",
  "_Sources: Compliance/Policies/Encryption.md_",
  "",
  "## 2. Is **MFA** enforced for `admin` users?",
  "",
  "Yes.",
  "",
  "SSO with MFA is required.",
  "",
  "_Sources: Compliance/Controls/Access.md · from the answer bank: Compliance/Answers/is-mfa-enforced-5d38d7.md_",
  "",
  "## Unanswered",
  "",
  "- 3. Do you hold ISO 27001? No page names the certification.",
  "",
].join("\n");

describe("filledMarkdown", () => {
  it("renders a section per answer with its sources, marks a bank answer, and lists the unanswered", () => {
    expect(filledMarkdown("acme-vendor.csv", answers, unanswered)).toBe(filled);
  });

  it("leaves out the Unanswered section when every question is answered", () => {
    expect(filledMarkdown("q.md", answers, [])).not.toContain("Unanswered");
  });

  it("keeps a question to one heading line and a '#' at the start of an answer line from opening a section", () => {
    const text = filledMarkdown("q.md", [{ ...answers[0]!, question: "Do you encrypt\ndata?", answer: "Yes.\n## 9. Fake\nNo." }], []);
    expect(text).toContain("## 1. Do you encrypt data?\n");
    expect(parseFilled(text)).toEqual([{ n: 1, question: "Do you encrypt data?", answer: "Yes.\n## 9. Fake\nNo.", sources: ["Compliance/Policies/Encryption.md"], fromBank: null }]);
  });
});

describe("parseFilled", () => {
  it("reads the sections back, skipping the unanswered", () => {
    expect(parseFilled(filled)).toEqual([
      { n: 1, question: "Do you encrypt data at rest?", answer: "Yes, with AES-256.", sources: ["Compliance/Policies/Encryption.md"], fromBank: null },
      { n: 2, question: "Is **MFA** enforced for `admin` users?", answer: "Yes.\n\nSSO with MFA is required.", sources: ["Compliance/Controls/Access.md"], fromBank: "Compliance/Answers/is-mfa-enforced-5d38d7.md" },
    ]);
  });

  it("reads the person's edit: a rewritten answer, a deleted section and a section with no sources line", () => {
    const edited = filled
      .replace("Yes, with AES-256.", "Yes: AES-256 at rest, TLS 1.3 in transit.")
      .replace(/## 2\.[\s\S]*## Unanswered/, "## 4. Do you test backups?\n\nQuarterly.\n\n## Unanswered");
    expect(parseFilled(edited)).toEqual([
      { n: 1, question: "Do you encrypt data at rest?", answer: "Yes: AES-256 at rest, TLS 1.3 in transit.", sources: ["Compliance/Policies/Encryption.md"], fromBank: null },
      { n: 4, question: "Do you test backups?", answer: "Quarterly.", sources: [], fromBank: null },
    ]);
  });

  it("reads nothing from text with no numbered section", () => {
    expect(parseFilled("# q.md: answers\n\n## Unanswered\n\n- 3. x y\n")).toEqual([]);
  });
});

describe("bankPath", () => {
  it.each([
    ["Do you encrypt data at rest?", "Compliance/Answers/do-you-encrypt-data-at-rest-5a02c3.md"],
    ["Is **MFA** enforced for `admin` users?", "Compliance/Answers/is-mfa-enforced-for-admin-users-5d38d7.md"],
  ])("names %s by a kebab slug and the first six hex of its sha256", (question, path) => {
    expect(bankPath(question)).toBe(path);
  });

  it("cuts the slug at 60 characters without a trailing dash, and has a slug for a question with no letters", () => {
    const long = bankPath("Please describe in detail how your organisation handles encryption of customer data at rest and in transit");
    const slug = long.replace(/^Compliance\/Answers\//, "").replace(/-[0-9a-f]{6}\.md$/, "");
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("please-describe-in-detail-how-your-organisation")).toBe(true);
    expect(bankPath("???")).toMatch(/^Compliance\/Answers\/question-[0-9a-f]{6}\.md$/);
  });

  it("names the same question the same way whatever its whitespace", () => {
    expect(bankPath("Do you  encrypt\ndata at rest?")).toBe("Compliance/Answers/do-you-encrypt-data-at-rest-" + bankPath("Do you encrypt data at rest?").slice(-9));
  });
});

describe("bankPage", () => {
  it("keeps the question, the approved answer, its sources, when it was approved and where it came from", () => {
    expect(bankPage("Do you encrypt data at rest?", "Yes, with AES-256.", ["Compliance/Policies/Encryption.md"], "2026-11-16T12:00:00Z", "acme-vendor.csv")).toEqual({
      path: "Compliance/Answers/do-you-encrypt-data-at-rest-5a02c3.md",
      text: ["# Do you encrypt data at rest?", "", "Yes, with AES-256.", "", "- Sources: Compliance/Policies/Encryption.md", "- Approved: 2026-11-16", "- From: acme-vendor.csv", ""].join("\n"),
    });
  });

  it("says there are no sources when there are none", () => {
    expect(bankPage("Is MFA on?", "Yes.", [], "2026-11-16T12:00:00Z", "q.md").text).toContain("- Sources: none");
  });

  it("is always the question's own page, even when the sources cite another bank page", () => {
    const page = bankPage("Do you use SSO?", "Yes.", ["Compliance/Controls/Access.md", "Compliance/Answers/is-mfa-on-abcdef.md"], "2026-11-16T12:00:00Z", "q.md");
    expect(page.path).toBe(bankPath("Do you use SSO?"));
    expect(page.text).toContain("- Sources: Compliance/Controls/Access.md, Compliance/Answers/is-mfa-on-abcdef.md");
  });
});

describe("a citation of another bank page", () => {
  it("round-trips as a source, apart from the bank page the answer came from", () => {
    const text = filledMarkdown("q.md", [{ n: 5, question: "Do you use SSO?", answer: "Yes.", citations: ["Compliance/Answers/is-mfa-on-abcdef.md"], fromBank: null, confidence: "low" as const }], []);
    expect(parseFilled(text)).toEqual([{ n: 5, question: "Do you use SSO?", answer: "Yes.", sources: ["Compliance/Answers/is-mfa-on-abcdef.md"], fromBank: null }]);
  });
});

describe("chunkText", () => {
  it("keeps a short text whole", () => {
    expect(chunkText("one\n\ntwo", 100)).toEqual(["one\n\ntwo"]);
  });

  it("cuts between paragraphs, in order, each chunk within the limit", () => {
    expect(chunkText("aaaa\n\nbbbb\n\ncccc", 10)).toEqual(["aaaa\n\nbbbb", "cccc"]);
  });

  it("cuts a paragraph longer than the limit at its lines, then at the limit", () => {
    expect(chunkText("aaa\nbbb\nccc", 7)).toEqual(["aaa\nbbb", "ccc"]);
    expect(chunkText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("gives no chunk for an empty text", () => {
    expect(chunkText("  \n", 10)).toEqual([]);
  });
});
