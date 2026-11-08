import { describe, expect, it } from "vitest"
import facts from "./facts.json"
import * as landing from "./landing"

const { engines, faq, factory, pricing, repos, sandbox, stacks, testFirst } = landing

const words = (s: string) => s.split(/\s+/).filter(Boolean)
const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).filter(Boolean)

/** Sentences over the limit: 25 words, or 20 for a procedural string. */
export function tooLong(text: string, procedural = false) {
  const limit = procedural ? 20 : 25
  return sentences(text).filter((s) => words(s).length > limit)
}

const ALLOWED_NAMES = new Set(["Luna", "GitHub", "Claude", "Anthropic", "Codex", "OpenAI", "Jev", "herdr", "Docker", "Postgres"])
// Capitalised words that are not names: product terms and the start of a label.
const COMMON = new Set(["Build", "Node", "Rust", "Test-first", "Sandbox", "Stacked", "Engines", "Stage", "Free", "Metered", "Without", "Needs", "PR", "PRs", "AI", "S1", "S2", "S3"])
// Defaults the code or docs state: the retry budget, the resume delay, Node 24+ and the stack's #1 to #3.
const DEFAULT_NUMBERS = new Set(["1", "2", "3", "24", "30"])

export function strangeNames(text: string) {
  const found: string[] = []
  for (const s of sentences(text)) {
    for (const w of words(s).slice(1)) {
      const bare = w.replace(/[^A-Za-z-]/g, "")
      if (/^[A-Z]/.test(bare) && !/^[A-Z]+s?$/.test(bare) &&!ALLOWED_NAMES.has(bare) && !COMMON.has(bare)) found.push(bare)
    }
  }
  return found
}

const factNumbers = new Set(JSON.stringify(facts).match(/\d+/g) ?? [])
export function strangeNumbers(text: string) {
  return (text.match(/\d+/g) ?? []).filter((n) => !factNumbers.has(n) && !DEFAULT_NUMBERS.has(n))
}

const section = (s: { eyebrow: string; title: string; lead: string; steps: { title: string; body: string }[]; visual: { label: string; rows: string[] } }) => [
  s.eyebrow, s.title, s.lead, s.visual.label, ...s.visual.rows, ...s.steps.flatMap((x) => [x.title, x.body]),
]

const usageAnswer = faq.items.find((i) => /usage limit/i.test(i.q))!.a
const credentialAnswer = faq.items.find((i) => /login/i.test(i.q))!.a
const costAnswer = faq.items.find((i) => /cost/i.test(i.q))!.a

const covered = [
  ...section(testFirst), ...section(stacks), ...section(engines), ...section(sandbox),
  pricing.title, pricing.lead, pricing.footnote, pricing.plans[1]!.items[2]!,
  factory.lead, factory.note, repos.heatmap.title,
  usageAnswer, credentialAnswer, costAnswer,
]
const procedural: string[] = []

describe("copy rules", () => {
  it("every covered sentence has at most 25 words", () => {
    for (const t of covered) expect(tooLong(t), t).toEqual([])
  })
  it("every procedural sentence has at most 20 words", () => {
    for (const t of procedural) expect(tooLong(t, true), t).toEqual([])
  })
  it("the checker fails a 26-word sentence and a 21-word procedural one", () => {
    const n = (k: number) => Array.from({ length: k }, () => "word").join(" ") + "."
    expect(tooLong(n(26))).toHaveLength(1)
    expect(tooLong(n(25))).toHaveLength(0)
    expect(tooLong(n(21), true)).toHaveLength(1)
    expect(tooLong(n(20), true)).toHaveLength(0)
  })
  it("every number is in facts.json or a documented default", () => {
    for (const t of covered) expect(strangeNumbers(t), t).toEqual([])
    expect(strangeNumbers("1,204 runs")).toEqual(["1", "204"].filter((n) => !DEFAULT_NUMBERS.has(n) && !factNumbers.has(n)))
  })
  it("names only the allowed products and no customer", () => {
    for (const t of covered) expect(strangeNames(t), t).toEqual([])
    expect(strangeNames("Luna works. We thank Initech daily.")).toEqual(["Initech"])
  })
  it("no landing string holds the invented heatmap count", () => {
    expect(JSON.stringify(landing)).not.toContain("1,204")
  })
})
