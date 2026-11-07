import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The commit the rewrite starts from. The four READMEs are compared with it.
const BASE = "de1ae7afa3d78c3e522692e511ffb11e294d3a01";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = ["docs/README.md", ".github/README.md", "evals/README.md", "board/README.md"] as const;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const oldText = (f: string): string => git("show", `${BASE}:${f}`);
const newText = (f: string): string => readFileSync(resolve(root, f), "utf8");

// A check against the base proves nothing until the rewrite exists.
const rewritten = (f: string): void => {
  expect(newText(f), `${f} is still the base text`).not.toBe(oldText(f));
};

const KEYS_RE = /<!-- keys:start[^\n]*-->[\s\S]*?<!-- keys:end -->/g;

/** Prose only: no fences, key blocks, tables, headings, HTML, code spans. */
const prose = (text: string): string[] => {
  const kept: string[] = [];
  let fence = false;
  let inKeys = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/<!-- keys:start/.test(line)) inKeys = true;
    if (inKeys) {
      if (/<!-- keys:end -->/.test(line)) inKeys = false;
      continue;
    }
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

const sentences = (text: string): string[] =>
  prose(text).flatMap((p) => clean(p).split(/(?<=[.!?:])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter((s) => s !== ""));

const words = (s: string): number => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

const IMPERATIVE = /^(Run|Set|Add|Open|Copy|Create|Use|Install|Start|Edit|Press|Check|Link|Build|Put|Pick|Choose|Write|Call|Pass|Export|Make|Keep|Read|Send|Add|Remove|Stop|Follow|Replace|Change|Update|Click|Type|Enter|Go|Save|Wait|Look|Make|Register|Pin)\b/;

const proceduralSentences = (text: string): string[] =>
  prose(text).flatMap((p) => {
    const numbered = /^\s*\d+\.\s/.test(p);
    return clean(p)
      .split(/(?<=[.!?:])\s+(?=[A-Z0-9])/)
      .map((s) => s.trim())
      .filter((s) => s !== "" && (numbered || IMPERATIVE.test(s)));
  });

const inlineCode = (t: string): string[] => [...t.replace(/```[\s\S]*?```/g, "").matchAll(/`[^`\n]+`/g)].map((m) => m[0]);
const fences = (t: string): string[] => [...t.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
const linkTargets = (t: string): string[] => [...t.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1] as string);
const srcs = (t: string): string[] => [...t.matchAll(/src="([^"]*)"/g)].map((m) => m[1] as string);
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
const levels = (t: string): number[] => headings(t).map((h) => (/^#+/.exec(h) as RegExpExecArray)[0].length);
const columns = (t: string): number[] => {
  let fence = false;
  const out: number[] = [];
  for (const line of t.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence && /^\s*\|/.test(line)) out.push(line.trim().replace(/\\\|/g, "").split("|").length - 2);
  }
  return out;
};

/** Facts to keep: numbers, inline code, link targets, env vars. */
const facts = (t: string): string[] => {
  const body = prose(t).join("\n");
  const nums = [...clean(body).matchAll(/\b\d+(?:[.,]\d+)*%?/g)].map((m) => m[0]);
  const env = [...t.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)].map((m) => m[0]);
  return [...new Set([...nums, ...inlineCode(t), ...linkTargets(t), ...env])];
};

describe("README STE rewrite", () => {
  // @scenario:S1
  it("S1 @scenario:S1 no prose sentence is over 25 words", () => {
    for (const f of FILES) {
      rewritten(f);
      const long = sentences(newText(f)).filter((s) => words(s) > 25);
      expect(long, f).toEqual([]);
    }
  });

  // @scenario:S2
  it("S2 @scenario:S2 no procedural sentence is over 20 words and each holds one imperative", () => {
    for (const f of FILES) {
      rewritten(f);
      const steps = proceduralSentences(newText(f));
      expect(steps.filter((s) => words(s) > 20), `${f} long`).toEqual([]);
      expect(steps.filter((s) => /;\s|,\s+then\b|\bthen\s+[a-z]+\b.*\bthen\b/i.test(s) || /\band then\b/i.test(s)), `${f} multi`).toEqual([]);
    }
  });

  // @scenario:S3
  it("S3 @scenario:S3 no passive sentence remains", () => {
    const passive = /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ed|built|run|written|given|made|shown|kept|chosen|known|taken|done|seen|found|sent|read|held|stored|picked)\b/i;
    for (const f of FILES) {
      rewritten(f);
      const hits = sentences(newText(f)).filter((s) => passive.test(s));
      expect(hits, f).toEqual([]);
    }
  });

  // @scenario:S4
  it("S4 @scenario:S4 each number, command, path, env var and link is still in the same file", () => {
    for (const f of FILES) {
      rewritten(f);
      const nt = newText(f);
      const missing = facts(oldText(f)).filter((x) => !nt.includes(x));
      expect(missing, f).toEqual([]);
    }
  });

  // @scenario:S5
  it("S5 @scenario:S5 heading levels and order are identical", () => {
    for (const f of FILES) {
      rewritten(f);
      expect(levels(newText(f)), f).toEqual(levels(oldText(f)));
    }
  });

  // @scenario:S6
  it("S6 @scenario:S6 the diff lists only the four README paths", () => {
    const changed = git("diff", "--name-only", BASE).split("\n").filter((l) => l !== "");
    // This test file itself is a test file; the rewrite is judged on the rest.
    // The core-docs rewrite (part 2) adds docs/*.md paths and its own guard test.
    const rest = changed.filter((c) => !/^contracts\/src\/(readme-ste|core-docs-ste)\.test\.ts$/.test(c));
    expect(rest.filter((c) => !(FILES as readonly string[]).includes(c) && !/^docs\/[^/]+\.md$/.test(c))).toEqual([]);
    for (const f of FILES) expect(rest, `${f} not rewritten`).toContain(f);
  });

  // @scenario:S7
  it("S7 @scenario:S7 readme.test.ts and keys.rs are not in the diff", () => {
    const changed = git("diff", "--name-only", BASE).split("\n");
    expect(changed).not.toContain("contracts/src/readme.test.ts");
    expect(changed).not.toContain("board/src/keys.rs");
    for (const f of FILES) rewritten(f);
  });

  // @scenario:S8
  it("S8 @scenario:S8 the strings readme.test.ts pins stay in .github/README.md", () => {
    const f = ".github/README.md";
    rewritten(f);
    const t = newText(f);
    const head = t.split("\n").slice(0, 12).join("\n");
    expect(head).toContain("**A board in your terminal that runs a software factory. You keep the final say.**");
    expect(head).toContain("# Luna TUI");
    expect(head).toMatch(/<img [^>]*width="112"/);
    for (const term of ["0.7.0", "make tools", "herdr.dev", "pnpm board:link", "[[keys.command]]", "hardness.board.open"]) {
      expect(t, term).toContain(term);
    }
    expect(t.trimEnd().split("\n").length).toBeLessThanOrEqual(90);
  });

  // @scenario:S9
  it("S9 @scenario:S9 every key block in board/README.md is byte-identical", () => {
    const f = "board/README.md";
    rewritten(f);
    const before = oldText(f).match(KEYS_RE) ?? [];
    expect(before.length).toBe(9);
    expect(newText(f).match(KEYS_RE) ?? []).toEqual(before);
  });

  // @scenario:S10
  it("S10 @scenario:S10 the board README keeps its key blocks and only markdown changes, so board:test stays green", () => {
    const f = "board/README.md";
    rewritten(f);
    expect(newText(f).match(KEYS_RE) ?? []).toEqual(oldText(f).match(KEYS_RE) ?? []);
    const changed = git("diff", "--name-only", BASE).split("\n").filter((l) => l !== "" && l !== "contracts/src/readme-ste.test.ts" && l !== "contracts/src/core-docs-ste.test.ts");
    expect(changed.filter((c) => !c.endsWith(".md"))).toEqual([]);
  });

  // @scenario:S11
  it("S11 @scenario:S11 code, links, src values and HTML tags are unchanged", () => {
    for (const f of FILES) {
      rewritten(f);
      const o = oldText(f);
      const n = newText(f);
      expect(fences(n), `${f} fences`).toEqual(fences(o));
      expect(inlineCode(n), `${f} code`).toEqual(inlineCode(o));
      expect(linkTargets(n), `${f} links`).toEqual(linkTargets(o));
      expect(srcs(n), `${f} src`).toEqual(srcs(o));
      expect(htmlTags(n), `${f} html`).toEqual(htmlTags(o));
    }
  });

  // @scenario:S12
  it("S12 @scenario:S12 every table row keeps its column count", () => {
    for (const f of FILES) {
      rewritten(f);
      expect(columns(newText(f)), f).toEqual(columns(oldText(f)));
    }
  });

  // @scenario:S13
  it("S13 @scenario:S13 the branch changes only markdown, so board clippy has nothing new to flag", () => {
    for (const f of FILES) rewritten(f);
    const changed = git("diff", "--name-only", BASE).split("\n").filter((l) => l !== "" && l !== "contracts/src/readme-ste.test.ts" && l !== "contracts/src/core-docs-ste.test.ts");
    expect(changed.filter((c) => !c.endsWith(".md"))).toEqual([]);
    expect(changed.filter((c) => c.startsWith("board/src/") || c.endsWith(".rs"))).toEqual([]);
  });
});
