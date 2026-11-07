import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Part 1's tip: the commit this branch starts from. The five core docs are compared with it.
const BASE = "25b756475cf7b719de7e65116a2bc29abc4e514a";
const ROOT_BASE = "de1ae7afa3d78c3e522692e511ffb11e294d3a01";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = ["docs/api.md", "docs/architecture.md", "docs/configuration.md", "docs/contributing.md", "docs/install.md"] as const;
// Strict mode: every file must be rewritten and every section checked.
const STRICT = process.env.CORE_DOCS_STE_STRICT === "1";

const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const oldText = (f: string): string => git("show", `${BASE}:${f}`);
const newText = (f: string): string => readFileSync(resolve(root, f), "utf8");

// The definitions below are copies of contracts/src/readme-ste.test.ts, so that file keeps its own shape.
const prose = (text: string): string[] => {
  const kept: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/^\s*\|/.test(line) || /^#+\s/.test(line) || /^\s*</.test(line) || /^\s*<!--/.test(line)) {
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").split(/\n\s*\n/).flatMap((para) => {
    const items = para.split(/\n(?=\s*(?:[-*]|\d+\.)\s)/);
    return items.map((it) => it.replace(/\s+/g, " ").trim()).filter((s) => s !== "");
  });
};

const clean = (s: string): string =>
  s
    .replace(/`[^`]*`/g, "X")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
    .replace(/\b(e\.g|i\.e|etc|vs)\./gi, "$1");

const SPLIT = /(?<=[.!?:])\s+(?=[A-Z0-9])/;
const sentences = (text: string): string[] => prose(text).flatMap((p) => clean(p).split(SPLIT).map((s) => s.trim()).filter((s) => s !== ""));
const words = (s: string): number => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

const IMPERATIVE = /^(Run|Set|Add|Open|Copy|Create|Use|Install|Start|Edit|Press|Check|Link|Build|Put|Pick|Choose|Write|Call|Pass|Export|Make|Keep|Read|Send|Add|Remove|Stop|Follow|Replace|Change|Update|Click|Type|Enter|Go|Save|Wait|Look|Make|Register|Pin)\b/;
const proceduralSentences = (text: string): string[] =>
  prose(text).flatMap((p) => {
    const numbered = /^\s*\d+\.\s/.test(p);
    return clean(p)
      .split(SPLIT)
      .map((s) => s.trim())
      .filter((s) => s !== "" && (numbered || IMPERATIVE.test(s)));
  });

const PASSIVE = /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ed|built|run|written|given|made|shown|kept|chosen|known|taken|done|seen|found|sent|read|held|stored|picked)\b/i;
const MULTI = (s: string): boolean => /;\s|,\s+then\b|\bthen\s+[a-z]+\b.*\bthen\b/i.test(s) || /\band then\b/i.test(s);

const inlineCode = (t: string): string[] => [...t.replace(/```[\s\S]*?```/g, "").matchAll(/`[^`\n]+`/g)].map((m) => m[0]);
const fences = (t: string): string[] => [...t.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
const linkTargets = (t: string): string[] => [...t.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1] as string);
const htmlTags = (t: string): string[] => [...t.replace(/```[\s\S]*?```/g, "").matchAll(/<\/?[a-zA-Z][^>]*>/g)].map((m) => m[0]);
const headings = (t: string): string[] => {
  let fence = false;
  const out: string[] = [];
  for (const line of t.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence && /^#{1,6}\s/.test(line)) out.push(line.trim());
  }
  return out;
};
const columns = (t: string): number[] => {
  let fence = false;
  const out: number[] = [];
  for (const line of t.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence && /^\s*\|/.test(line)) out.push(line.trim().replace(/\\\|/g, "").split("|").length - 2);
  }
  return out;
};

/** Facts to keep, with repeats: numbers, inline code, link targets, env vars. */
const factList = (t: string): string[] => {
  const nums = [...clean(prose(t).join("\n")).matchAll(/\b\d+(?:[.,]\d+)*%?/g)].map((m) => m[0]);
  const env = [...t.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)].map((m) => m[0]);
  return [...nums, ...inlineCode(t), ...linkTargets(t), ...env];
};
const count = (xs: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
/** Each base fact must appear in the new text at least as many times as in the base. */
const missingFacts = (base: string, next: string): string[] => {
  const have = count(factList(next));
  return [...count(factList(base))].filter(([k, n]) => (have.get(k) ?? 0) < n).map(([k, n]) => `${k} (base ${n}, new ${have.get(k) ?? 0})`);
};

/** Sentence-level STE violations in one text. */
const sentenceViolations = (text: string): string[] => {
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (words(s) > 25) out.push(`over 25 words: ${s}`);
    if (PASSIVE.test(s)) out.push(`passive: ${s}`);
  }
  for (const s of proceduralSentences(text)) {
    if (words(s) > 20) out.push(`procedure over 20 words: ${s}`);
    if (MULTI(s)) out.push(`procedure with more than one instruction: ${s}`);
  }
  return out;
};

/** Split a text into heading-bounded sections. The first holds the text before any heading. */
const sections = (text: string): { heading: string; body: string }[] => {
  const out: { heading: string; body: string[] }[] = [{ heading: "(top)", body: [] }];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence && /^#{1,6}\s/.test(line)) {
      out.push({ heading: line.trim(), body: [line] });
      continue;
    }
    (out[out.length - 1] as { body: string[] }).body.push(line);
  }
  return out.map((s) => ({ heading: s.heading, body: s.body.join("\n") }));
};

/**
 * STE violations per section, each prefixed with the section heading.
 * Default mode checks only sections that differ from the base. Strict mode checks all.
 */
const checkSections = (base: string, next: string, strict: boolean): string[] => {
  const was = sections(base);
  const sameShape = was.length === sections(next).length;
  const out: string[] = [];
  sections(next).forEach((sec, i) => {
    const changed = !sameShape || (was[i] as { body: string }).body !== sec.body;
    if (!strict && !changed) return;
    for (const v of sentenceViolations(sec.body)) out.push(`[${sec.heading}] ${v}`);
  });
  return out;
};

/** Structure checks that run on whole files, always. */
const structureProblems = (base: string, next: string): string[] => {
  const out: string[] = [];
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (!same(headings(next), headings(base))) out.push("headings differ from the base");
  if (!same(fences(next), fences(base))) out.push("fenced blocks differ from the base");
  if (!same(htmlTags(next), htmlTags(base))) out.push("HTML tags differ from the base");
  if (!same(columns(next), columns(base))) out.push("table column counts differ from the base");
  for (const m of missingFacts(base, next)) out.push(`missing fact: ${m}`);
  return out;
};

/** In strict mode the first commit that touches a core doc touches contributing.md alone. */
const firstCommitOk = (touched: string[]): boolean => {
  const docs = touched.filter((f) => (FILES as readonly string[]).includes(f));
  return docs.length === 1 && docs[0] === "docs/contributing.md";
};

/** The rule section of contributing.md. */
const ruleProblems = (t: string): string[] => {
  const out: string[] = [];
  if (!t.includes("ASD-STE100")) out.push("no mention of ASD-STE100");
  if (!/\b25 words\b/.test(t)) out.push("no 25-word rule");
  if (!/\b20 words\b/.test(t)) out.push("no 20-word rule");
  if (!/\bactive voice\b/i.test(t)) out.push("no active-voice rule");
  return out;
};
const budgetProblems = (t: string): string[] => (/about 300 changed lines/.test(t) ? [] : ["no 300-line PR budget"]);

/** The changed-path scope: markdown, plus the two test files of this work. */
const ALLOWED_TESTS = ["contracts/src/core-docs-ste.test.ts", "contracts/src/readme-ste.test.ts"];
const scopeProblems = (changed: string[]): string[] => changed.filter((c) => !c.endsWith(".md") && !ALLOWED_TESTS.includes(c));

const long25 = Array.from({ length: 25 }, () => "word").join(" ");
const long26 = `${long25} word`;

describe("core docs STE guard: fixtures", () => {
  // @scenario:S5
  it("S5 a 25-word sentence passes, a 26-word one fails, tables and headings are skipped", () => {
    const text = `# ${long26}\n\n${long25}.\n\n| ${long26} | b |\n`;
    expect(sentenceViolations(text)).toEqual([]);
    expect(sentenceViolations(`${long26}.\n`)).toHaveLength(1);
  });

  // @scenario:S7
  it("S7 a 21-word step and an 'and then' step are violations", () => {
    const w21 = Array.from({ length: 21 }, () => "word").join(" ");
    expect(sentenceViolations(`1. Run ${w21}.\n`).join("\n")).toContain("procedure over 20 words");
    expect(sentenceViolations("1. Run the build and then run the test.\n").join("\n")).toContain("more than one instruction");
    expect(sentenceViolations("Run the build, then run the test.\n")).toHaveLength(1);
    expect(sentenceViolations("1. Run the build.\n")).toEqual([]);
  });

  // @scenario:S9
  it("S9 a passive sentence is reported", () => {
    expect(sentenceViolations("The file is loaded by the runner.\n")).toHaveLength(1);
    expect(sentenceViolations("The runner loads the file.\n")).toEqual([]);
  });

  // @scenario:S11
  it("S11 a dropped number or inline code span is named", () => {
    const base = "Wait 30 seconds. Run `pnpm test` and `pnpm test` again.\n";
    expect(missingFacts(base, base)).toEqual([]);
    expect(missingFacts(base, "Wait 30 seconds. Run `pnpm test`.\n").join()).toContain("`pnpm test`");
    expect(missingFacts(base, "Wait. Run `pnpm test` and `pnpm test`.\n").join()).toContain("30");
  });

  // @scenario:S13
  it("S13 an edited or swapped fenced block fails", () => {
    const a = "Text.\n\n```sh\none\n```\n\n```sh\ntwo\n```\n";
    expect(structureProblems(a, a)).toEqual([]);
    expect(structureProblems(a, a.replace("one", "onE")).join()).toContain("fenced");
    expect(structureProblems(a, "Text.\n\n```sh\ntwo\n```\n\n```sh\none\n```\n").join()).toContain("fenced");
  });

  // @scenario:S15
  it("S15 a reworded or re-levelled heading fails", () => {
    const a = "# One\n\nText.\n\n## Two\n";
    expect(structureProblems(a, a.replace("## Two", "## Three")).join()).toContain("headings");
    expect(structureProblems(a, a.replace("## Two", "### Two")).join()).toContain("headings");
  });

  // @scenario:S17
  it("S17 a table row that gains or loses a column fails", () => {
    const a = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(structureProblems(a, a)).toEqual([]);
    expect(structureProblems(a, a.replace("| 1 | 2 |", "| 1 | 2 | 3 |")).join()).toContain("table");
    expect(structureProblems(a, a.replace("| 1 | 2 |", "| 1 |")).join()).toContain("table");
  });

  // @scenario:S22
  it("S22 the first doc commit must touch contributing.md alone", () => {
    expect(firstCommitOk(["docs/contributing.md", "contracts/src/core-docs-ste.test.ts"])).toBe(true);
    expect(firstCommitOk(["docs/install.md"])).toBe(false);
    expect(firstCommitOk(["docs/api.md"])).toBe(false);
    expect(firstCommitOk(["docs/contributing.md", "docs/install.md"])).toBe(false);
    expect(firstCommitOk([])).toBe(false);
  });

  // @scenario:S24
  it("S24 a contributing.md without ASD-STE100 or a word limit fails", () => {
    const ok = "ASD-STE100. 25 words. 20 words. Use active voice.";
    expect(ruleProblems(ok)).toEqual([]);
    expect(ruleProblems(ok.replace("ASD-STE100", "STE"))).toHaveLength(1);
    expect(ruleProblems(ok.replace("25 words", "many words"))).toHaveLength(1);
    expect(ruleProblems(ok.replace("20 words", "few words"))).toHaveLength(1);
    expect(ruleProblems(ok.replace("active voice", "voice"))).toHaveLength(1);
  });

  // @scenario:S26
  it("S26 a contributing.md without the 300-line budget fails", () => {
    expect(budgetProblems("Keep a PR under about 300 changed lines.")).toEqual([]);
    expect(budgetProblems("Keep a PR small.")).toHaveLength(1);
  });

  // @scenario:S28
  it("S28 a long sentence passes in a base-text section, fails in a changed one, and fails in strict mode", () => {
    const base = `# A\n\nShort.\n\n## B\n\n${long26}.\n`;
    // Section B is at base text: not checked by default, checked in strict mode.
    expect(checkSections(base, base, false)).toEqual([]);
    expect(checkSections(base, base, true).join()).toContain("[## B]");
    // Section A changes, so it is checked. Section B stays unchecked.
    expect(checkSections(base, base.replace("Short.", "Also short."), false)).toEqual([]);
    const bad = base.replace("Short.", `${long26}.`);
    expect(checkSections(bad, bad.replace(long26, `${long26} more`), false).join()).toContain("[# A]");
  });

  // @scenario:S30
  it("S30 the scope check fails on any non-markdown path outside the two test files", () => {
    expect(scopeProblems(["docs/api.md", "contracts/src/core-docs-ste.test.ts", "contracts/src/readme-ste.test.ts"])).toEqual([]);
    expect(scopeProblems(["docs/api.md", "board/src/main.rs"])).toEqual(["board/src/main.rs"]);
    expect(scopeProblems(["contracts/src/readme.test.ts"])).toEqual(["contracts/src/readme.test.ts"]);
  });
});

describe("core docs STE guard: the five docs", () => {
  // @scenario:S2
  it("S2 contributing.md differs from its base text", () => {
    expect(newText("docs/contributing.md"), "docs/contributing.md is still the base text").not.toBe(oldText("docs/contributing.md"));
  });

  // @scenario:S3
  it("S3 strict mode: each of the five files differs from its base text", () => {
    if (!STRICT) return;
    const same = FILES.filter((f) => newText(f) === oldText(f));
    expect(same, "files still at base text").toEqual([]);
  });

  // @scenario:S4
  it("S4 sentence rules hold in every changed section (all sections in strict mode)", () => {
    for (const f of FILES) expect(checkSections(oldText(f), newText(f), STRICT), f).toEqual([]);
  });

  // @scenario:S10
  it("S10 headings, fences, HTML, tables and facts are kept", () => {
    for (const f of FILES) expect(structureProblems(oldText(f), newText(f)), f).toEqual([]);
  });

  // @scenario:S23
  it("S23 contributing.md states the STE rules and the PR budget", () => {
    const t = newText("docs/contributing.md");
    expect(ruleProblems(t)).toEqual([]);
    expect(budgetProblems(t)).toEqual([]);
  });

  // @scenario:S21
  it("S21 strict mode: the first commit after the base that touches a core doc touches contributing.md alone", () => {
    if (!STRICT) return;
    const first = git("log", "--reverse", "--format=%H", `${BASE}..HEAD`, "--", ...FILES).split("\n").find((l) => l !== "");
    expect(first, "no commit touches the five docs").toBeTruthy();
    const touched = git("show", "--name-only", "--format=", first as string).split("\n").filter((l) => l !== "");
    expect(firstCommitOk(touched), `first doc commit ${first} touches ${touched.join(", ")}`).toBe(true);
  });

  // @scenario:S18
  it("S18 the branch changes only markdown and the two test files", () => {
    const changed = git("diff", "--name-only", ROOT_BASE).split("\n").filter((l) => l !== "");
    expect(scopeProblems(changed)).toEqual([]);
  });
});
