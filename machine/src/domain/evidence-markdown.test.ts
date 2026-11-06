import type { EvidencePack } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { redact, safe, COMMENT_MARKER, SECTION_END, SECTION_START, mergeSection, renderEvidenceComment, renderEvidenceSection, stripSection } from "./evidence-markdown.ts";

const pack = (over: Partial<EvidencePack> = {}): EvidencePack => ({
  summary: "Show the cart total. 2 scenarios: 2 passed. Shown as video; risk medium.",
  format: "video",
  scenarios: [
    { text: "Total shows after adding an item", test: "qa-cart.webm#t=0", result: "pass" },
    { text: "Empty cart shows zero", test: null, result: "partial" },
  ],
  findings: ["should_fix: memoise the total (web/cart.tsx:4)"],
  outOfMap: ["web/format.ts: shared helper"],
  risk: "medium",
  rollback: "Revert the merge commit.",
  howToVerify: "http://localhost:3000/app",
  commitSha: "abc1234def5678",
  media: [
    { kind: "video", label: "walkthrough.mp4", url: "https://github.com/o/a/releases/download/luna-evidence/t1-abc1234-walkthrough.mp4" },
    { kind: "screenshot", label: "cart.png", url: "https://github.com/o/a/releases/download/luna-evidence/t1-abc1234-cart.png" },
  ],
  video: { file: "walkthrough.mp4", durationS: 92.4, verdict: "ship", scores: { hook: 9, clarity: 8, truth: 7 }, defects: [], rounds: 1 },
  at: "2026-11-04T10:00:00.000Z",
  ...over,
});

describe("renderEvidenceSection", () => {
  it("sits between the markers and has every section", () => {
    const text = renderEvidenceSection(pack());
    expect(text.startsWith(SECTION_START)).toBe(true);
    expect(text.trimEnd().endsWith(SECTION_END)).toBe(true);
    expect(text).toContain("## Evidence");
    expect(text).toContain("Show the cart total.");
    expect(text).toContain("**Format** video · **Commit** `abc1234` · **Risk** medium");
    expect(text).toContain("| Scenario | Proof | Result |");
    expect(text).toContain("| Total shows after adding an item | qa-cart.webm#t=0 | pass |");
    expect(text).toContain("| Empty cart shows zero | none | partial |");
    expect(text).toContain("should_fix: memoise the total (web/cart.tsx:4)");
    expect(text).toContain("web/format.ts: shared helper");
    expect(text).toContain("**Rollback.** Revert the merge commit.");
    expect(text).toContain("**How to verify.** http\u200b://localhost:3000/app");
  });

  it("links the media, and gives the video its duration, the critic's verdict and the mean score", () => {
    const text = renderEvidenceSection(pack());
    expect(text).toContain("[walkthrough.mp4](https://github.com/o/a/releases/download/luna-evidence/t1-abc1234-walkthrough.mp4)");
    expect(text).toContain("[cart.png](https://github.com/o/a/releases/download/luna-evidence/t1-abc1234-cart.png)");
    expect(text).toContain("1:32");
    expect(text).toContain("critic: ship");
    expect(text).toContain("8.0/10");
  });

  it("never prints a host path: a local copy is named, not linked", () => {
    const text = renderEvidenceSection(pack({ media: [{ kind: "screenshot", label: "cart.png", url: "/Users/me/.luna/evidence/t1/abc/cart.png" }] }));
    expect(text).toContain("cart.png (local copy)");
    expect(text).not.toContain("/Users/me");
  });

  it("says why a format was degraded", () => {
    expect(renderEvidenceSection(pack({ format: "captures", video: null, note: "the video image is not built" }))).toContain("> Degraded: the video image is not built");
    expect(renderEvidenceSection(pack())).not.toContain("Degraded");
  });

  it("leaves out the sections a text pack has nothing for", () => {
    const text = renderEvidenceSection(pack({ format: "text", scenarios: [], findings: [], outOfMap: [], media: [], video: null }));
    expect(text).not.toContain("| Scenario |");
    expect(text).not.toContain("### Findings");
    expect(text).not.toContain("### Media");
    expect(text).toContain("**Rollback.**");
  });

  it("keeps a model's text from breaking the table or the markers", () => {
    const text = renderEvidenceSection(pack({ scenarios: [{ text: `a | b\nc ${SECTION_END} <!-- x -->`, test: null, result: "pass" }], findings: [`hi @octocat ${SECTION_START}`] }));
    expect(text.split(SECTION_END)).toHaveLength(2);
    expect(text.split(SECTION_START)).toHaveLength(2);
    expect(text).toContain("a \\| b c");
    expect(text).not.toContain("<!-- x -->");
    expect(text).not.toMatch(/@octocat/);
  });

  it("escapes raw HTML in a model's text, so a tag cannot fold the rest of the section away", () => {
    const text = renderEvidenceSection(pack({ summary: "<details><summary>ok</summary>", findings: ["bug: <img src=x onerror=1> (a.ts:1)"] }));
    expect(text).not.toContain("<details>");
    expect(text).not.toContain("<img");
    expect(text).toContain("&lt;details&gt;");
  });

  it("keeps an issue reference in a model's text from closing or linking anything on merge", () => {
    const text = renderEvidenceSection(pack({ findings: ["bug: Closes #12 and fixes #345 (src/a.ts:1)"], summary: "see GH #7" }));
    expect(text).not.toMatch(/#\d/);
    expect(text).toContain("#\u200b12");
    expect(text).toContain("#\u200b7");
  });

  it("truncates the scenario table first when the section is over its cap", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ text: `scenario number ${i} with some words to take space`, test: null, result: "pass" as const }));
    const text = renderEvidenceSection(pack({ scenarios: many }), { maxChars: 6000 });
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toMatch(/… \d+ more/);
    expect(text).toContain("**Rollback.**");
    expect(text).toContain("### Findings");
    expect(text.trimEnd().endsWith(SECTION_END)).toBe(true);
  });

  it("still ends with the end marker when something other than the table is too big", () => {
    const text = renderEvidenceSection(pack({ findings: Array.from({ length: 500 }, (_, i) => `bug: finding ${i} ${"x".repeat(60)} (a.ts:1)`) }), { maxChars: 4000 });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.trimEnd().endsWith(SECTION_END)).toBe(true);
  });

  it("defaults to a 60 000 character cap", () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ text: `scenario ${i} ${"y".repeat(40)}`, test: null, result: "pass" as const }));
    expect(renderEvidenceSection(pack({ scenarios: many })).length).toBeLessThanOrEqual(60_000);
  });
});

describe("mergeSection and stripSection", () => {
  const section = renderEvidenceSection(pack());
  it("appends the section to a body that has none", () => {
    expect(mergeSection("## Why\n- a", section)).toBe(`## Why\n- a\n\n${section}`);
    expect(mergeSection("", section)).toBe(section);
  });
  it("replaces the section a body already has, once, leaving the rest alone", () => {
    const old = renderEvidenceSection(pack({ summary: "OLD" }));
    const merged = mergeSection(`before\n\n${old}\n\nafter`, section);
    expect(merged).toBe(`before\n\n${section}\n\nafter`);
    expect(mergeSection(merged, section)).toBe(merged);
  });
  it("strips the section and the blank lines around it", () => {
    expect(stripSection(`before\n\n${section}\n\nafter`)).toBe("before\n\nafter");
    expect(stripSection("nothing here")).toBe("nothing here");
  });
});

describe("renderEvidenceComment", () => {
  it("is the section plus the comment marker", () => {
    const text = renderEvidenceComment(pack());
    expect(text).toContain(COMMENT_MARKER);
    expect(text).toContain("## Evidence");
    expect(COMMENT_MARKER).toBe("<!-- luna-evidence-comment -->");
  });
});

describe("redacting secret-shaped tokens", () => {
  // Built at run time: a literal of this shape blocks the push.
  const tokens = [
    ["sk-ant-", "api03-" + "A1b2C3d4E5f6G7h8"],
    ["gh", "p_" + "a".repeat(24)],
    ["github_pat_", "11ABCDEFG0" + "x".repeat(20)],
    ["xox", "b-" + "1234567890-abcdefghij"],
    ["AKIA", "ABCDEFGHIJKLMNOP"],
    ["eyJ", "hbGciOiJIUzI1NiJ9AAAAAA" + "." + "payloadpayload1234" + "." + "signature12345"],
  ].map(([a, b]) => `${a}${b}`);

  it("turns each token shape into [redacted], in safe() too, and leaves ordinary text alone", () => {
    for (const token of tokens) {
      expect(redact(`my key is ${token} ok`)).toBe("my key is [redacted] ok");
      expect(safe(`the key: ${token}`)).toBe("the key: [redacted]");
    }
    expect(redact("a sk-short and ghp_short and plain AKIA text")).toBe("a sk-short and ghp_short and plain AKIA text");
  });
});

describe("a foreign text never draws a link or an image", () => {
  it("breaks an inline link, an image and a reference definition, and keeps the address readable", () => {
    expect(safe("see [the docs](https://evil.example/login)")).toBe("see [the docs] (https\u200b://evil.example/login)");
    expect(safe("![p](https://evil.example/p.png?d=1)")).toBe("![p] (https\u200b://evil.example/p.png?d=1)");
    // A definition on its own line would turn a later `[a]` or `![a]` into a link or a fetched image.
    expect(safe("[a]: https://evil.example/x")).toBe("[a] : https\u200b://evil.example/x");
  });

  it("breaks a bare address GitHub would link, and the URL forms of a closing keyword, the way it breaks #123", () => {
    const broken = (text: string) => safe(text);
    for (const [text, kept] of [
      ["go to https://evil.example/login now", "https\u200b://evil.example/login"],
      ["go to http://evil.example now", "http\u200b://evil.example"],
      ["go to HTTPS://EVIL.example now", "HTTPS\u200b://EVIL.example"],
      ["go to www.evil.example now", "www\u200b.evil.example"],
      ["Closes https://github.com/acme/app/issues/12", "https\u200b://github.com/acme/app/issues/12"],
      ["fixes https://github.com/acme/app/pull/3", "https\u200b://github.com/acme/app/pull/3"],
    ] as const) {
      expect(broken(text), text).toContain(kept);
      expect(broken(text), text).not.toMatch(/https?:\/\/|www\./i);
    }
    expect(broken("Fixes GH-12")).not.toContain("GH-12");
  });

  it("leaves the machine's own media link intact in the section, whatever a label carries", () => {
    const own = renderEvidenceSection(pack({ media: [{ kind: "screenshot", label: "see https://evil.example", url: "https://cdn.example/a.png" }] }));
    expect(own).toContain("](https://cdn.example/a.png)");
    expect(own).not.toContain("https://evil.example");
  });

  it("leaves the machine's own media link intact in the section", () => {
    const section = renderEvidenceSection(pack({ media: [{ kind: "screenshot", label: "home [x](https://evil.example)", url: "https://cdn.example/a.png" }] }));
    expect(section).toContain("[home [x] (https\u200b://evil.example)](https://cdn.example/a.png)");
  });
});

describe("the v2 pack fields stay off the published text", () => {
  it("never carries a media localPath, the results or the findings detail into the section or the comment", () => {
    const v2 = pack({
      media: [{ kind: "screenshot", label: "cart.png", url: "https://github.com/o/a/releases/download/luna-evidence/t1-cart.png", localPath: "/Users/someone/state/evidence/t1/abc/cart.png" }],
      results: { unit: { passed: 3, total: 3 }, integration: null, e2e: null, coverageDelta: null },
      findingsDetail: [{ id: "Fdeadbeef", title: "t", severity: "bug", resolution: "fixed", inferred: true }],
      previewUrl: "https://preview.internal/secret",
      version: 2,
    });
    for (const text of [renderEvidenceSection(v2), renderEvidenceComment(v2)]) {
      expect(text).not.toContain("/Users/someone");
      expect(text).not.toContain("localPath");
      expect(text).not.toContain("Fdeadbeef");
      expect(text).not.toContain("preview.internal");
    }
  });
});

describe("renderEvidenceSection of a v2.2 pack", () => {
  const rich = pack({
    revision: 2,
    results: { unit: { passed: 9, total: 10 }, integration: null, e2e: { verdict: "pass", passed: 2, total: 3 }, coverageDelta: { added: 20, covered: 18 } },
    diffSummary: { what: "Adds the total", why: "The ticket asks", files: ["web/cart.tsx", "web/total.ts"], added: 40, removed: 6 },
    findingsDetail: [{ id: "F1", title: "memoise the total", severity: "should_fix", resolution: "fixed" }, { id: "F2", title: "naming", severity: "nit", resolution: null }],
    scenarios: [{ text: "Total shows", test: "src/a.test.ts", result: "not_run" }],
  });

  it("prints the results line, the diff summary and each finding with its resolution", () => {
    const text = renderEvidenceSection(rich);
    expect(text).toContain("**Results** unit 9/10 · integration none · e2e 2/3 (pass) · coverage +20 added, 18 covered");
    expect(text).toContain("**Change** Adds the total. The ticket asks. +40 −6 in 2 files");
    expect(text).toContain("- should_fix: memoise the total (fixed)");
    expect(text).toContain("- nit: naming (open)");
    expect(text).toContain("**Revision** 2");
    expect(text).toContain("| Total shows | src/a.test.ts | not run |");
    expect(text.startsWith(SECTION_START)).toBe(true);
    expect(text.trimEnd().endsWith(SECTION_END)).toBe(true);
  });

  it("flattens every new text and cannot forge the end marker", () => {
    const hostile = pack({
      diffSummary: { what: `${SECTION_END}\n@bob closes #12 <b>x</b>`, why: "[a](http://x)", files: [], added: null, removed: null },
      findingsDetail: [{ id: "F", title: `${COMMENT_MARKER} ${SECTION_END}`, severity: "nit\n@eve", resolution: "fixed" }],
    });
    const text = renderEvidenceSection(hostile);
    expect(text.split(SECTION_END)).toHaveLength(2);
    expect(text).not.toContain("<b>");
    expect(text).not.toContain("\n@bob");
    expect(text).not.toContain("[a](");
  });

  it("stays under its cap with the new sections", () => {
    const big = pack({ findingsDetail: Array.from({ length: 400 }, (_, i) => ({ id: `F${i}`, title: "t".repeat(300), severity: "nit", resolution: null })) });
    const text = renderEvidenceSection(big, { maxChars: 5000 });
    expect(text.length).toBeLessThanOrEqual(5000);
    expect(text.trimEnd().endsWith(SECTION_END)).toBe(true);
  });

  it("renders a pack from before this wave as it did, with none of the new lines", () => {
    const text = renderEvidenceSection(pack());
    for (const word of ["**Results**", "**Change**", "**Revision**"]) expect(text).not.toContain(word);
    expect(text).toContain("- should_fix: memoise the total (web/cart.tsx:4)");
  });
});
