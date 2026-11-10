import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Faq } from "@/components/landing/faq"
import { Features } from "@/components/landing/features"
import { Moments } from "@/components/landing/moments"
import { Pricing } from "@/components/landing/pricing"
import { faq, features, moments, pricing } from "@/content/landing"

afterEach(cleanup)

const titles = (level: number) => screen.getAllByRole("heading", { level }).map((h) => h.textContent)

describe("Features", () => {
  it("is the #features section with the six detail cards and their footers", () => {
    const { container } = render(<Features />)
    expect(container.querySelector("section")?.id).toBe("features")
    expect(screen.getByRole("heading", { level: 2, name: features.title })).toBeTruthy()
    expect(titles(3)).toEqual(features.cards.map((c) => c.title))
    expect(screen.getByText("b72d0aa")).toBeTruthy()
    expect(screen.getByText("Post a review comment: asks you")).toBeTruthy()
    expect(screen.getByText("≥ 80% to pass")).toBeTruthy()
  })
})

describe("Moments", () => {
  it("lists each way of working plus the golden-task starter", () => {
    const { container } = render(<Moments />)
    expect(container.querySelector("section")?.id).toBe("moments")
    expect(titles(3)).toEqual([...moments.cards.map((c) => c.title), moments.start.title])
    for (const card of moments.cards) expect(screen.getByText(`"${card.quote}"`)).toBeTruthy()
    expect(screen.getAllByRole("link", { name: new RegExp(moments.link) })).toHaveLength(moments.cards.length)
  })
})

describe("Pricing", () => {
  it("shows three plans with the agents plan recommended", () => {
    const { container } = render(<Pricing />)
    expect(container.querySelector("section")?.id).toBe("pricing")
    expect(titles(3)).toEqual(pricing.plans.map((p) => p.name))
    const recommended = screen.getByText("Recommended").closest("li")!
    expect(within(recommended).getByText("Board + agents")).toBeTruthy()
    expect(within(recommended).getByText("+ your Claude")).toBeTruthy()
    expect(screen.getByText(pricing.footnote)).toBeTruthy()
  })
})

// New capability sections, read through the rendered page.
const text = (s: string | null) => (s ?? "").replace(/\s+/g, " ")
const homeSection = async (heading: RegExp) => {
  const { default: Home } = await import("@/app/page")
  const { container } = render(<Home />)
  const h2 = [...container.querySelectorAll("h2")].find((h) => heading.test(h.textContent ?? ""))
  const section = h2?.closest("section")
  expect(section, "h2 matching " + heading).toBeTruthy()
  return { h2: h2!, text: text(section!.textContent) }
}
const NEW_SECTIONS = [/test-first|failing test/i, /stack/i, /engine|fallback/i, /sandbox|safety/i]

describe("Test-first Build section", () => {
  // @scenario:S1
  it("S1 says Build writes one failing test per approved scenario before any code, judged for the right reason", async () => {
    const { text: t } = await homeSection(NEW_SECTIONS[0]!)
    expect(t).toMatch(/before any code/i)
    expect(t).toMatch(/one failing test per approved scenario/i)
    expect(t).toMatch(/judge/i)
    expect(t).toMatch(/right reason/i)
  })
  // @scenario:S2
  it("S2 says a documentation-only change gets no tests and is checked by reading it", async () => {
    const { text: t } = await homeSection(NEW_SECTIONS[0]!)
    expect(t).toMatch(/documentation/i)
    expect(t).toMatch(/no tests/i)
    expect(t).toMatch(/reading/i)
  })
})

describe("Stacked cards section", () => {
  // @scenario:S3
  it("S3 says a big ticket splits into parts that build on each other", async () => {
    const { text: t } = await homeSection(NEW_SECTIONS[1]!)
    expect(t).toMatch(/big ticket/i)
    expect(t).toMatch(/build on each other/i)
  })
  // @scenario:S4
  it("S4 says a child is rebased onto its parent when the parent moves", async () => {
    const { text: t } = await homeSection(NEW_SECTIONS[1]!)
    expect(t).toMatch(/parent moves/i)
    expect(t).toMatch(/rebased onto/i)
  })
})

describe("Engines section", () => {
  // @scenario:S5
  it("S5 says Claude runs on your subscription, Codex on your Codex login, Jev is opt-in metered", async () => {
    const { text: t } = await homeSection(NEW_SECTIONS[2]!)
    expect(t).toMatch(/your subscription/i)
    expect(t).toMatch(/codex login/i)
    expect(t).toMatch(/jev/i)
    expect(t).toMatch(/opt-in/i)
    expect(t).toMatch(/metered/i)
  })
  // @scenario:S6
  it("S6 says a decision moves to its fallback engine when a login is busy or rate-limited", async () => {
    const { text: t } = await homeSection(NEW_SECTIONS[2]!)
    expect(t).toMatch(/fallback engine/i)
    expect(t).toMatch(/busy/i)
    expect(t).toMatch(/rate-limited/i)
  })
  // @scenario:S21
  it("S21 names only claude, codex and jev as engines", async () => {
    const { text: t } = await homeSection(NEW_SECTIONS[2]!)
    const found = new Set(t.toLowerCase().match(/\b(claude|codex|jev|gemini|gpt|llama|mistral|cohere|ollama|copilot|cursor)\b/g) ?? [])
    expect([...found].sort()).toEqual(["claude", "codex", "jev"])
  })
})

describe("Sandbox section", () => {
  // @scenario:S7
  it("S7 has an h2 and says each stage runs in a container with a per-repository egress allow-list", async () => {
    const { h2, text: t } = await homeSection(NEW_SECTIONS[3]!)
    expect(h2.tagName).toBe("H2")
    expect(t).toMatch(/container/i)
    expect(t).toMatch(/per-repository egress allow-list/i)
  })
  // @scenario:S8
  it("S8 says every change gets secret checks and commits are never credited to an AI", async () => {
    const { text: t } = await homeSection(NEW_SECTIONS[3]!)
    expect(t).toMatch(/secret checks/i)
    expect(t).toMatch(/never credited to an AI/i)
  })
})

describe("Cost and engine copy", () => {
  // @scenario:S10
  it("S10 pricing and FAQ do not make a Claude subscription or Anthropic key the only credential", () => {
    const { container } = render(<Pricing />)
    const p = text(container.textContent)
    expect(p).toMatch(/codex/i)
    expect(p).not.toMatch(/Anthropic API key/i)
    const cred = faq.items.find((i) => /which claude|credential|login/i.test(i.q))!
    expect(cred.a).toMatch(/codex/i)
    expect(cred.a).not.toMatch(/Anthropic API key/i)
  })
  // @scenario:S11
  it("S11 usage-limit answer moves to a fallback engine first and pauses only when none is left", () => {
    const a = faq.items.find((i) => /usage limit/i.test(i.q))!.a
    expect(a).toMatch(/fallback engine first/i)
    expect(a).toMatch(/pauses only when no fallback is left/i)
  })
  // @scenario:S12
  it("S12 factory copy does not say every stage runs through the Claude Agent SDK", async () => {
    const { Factory } = await import("@/components/landing/factory")
    const { container } = render(<Factory />)
    const t = text(container.textContent)
    expect(t).not.toMatch(/through the Claude Agent SDK/i)
    expect(t).toMatch(/codex/i)
  })
  // @scenario:S18
  it("S18 pricing lead begins with local running on existing Claude and Codex subscriptions; metered keys optional", () => {
    expect(pricing.lead).toMatch(/^Luna[^.]*runs locally on the Claude and Codex subscriptions you already have/i)
    const { container } = render(<Pricing />)
    expect(text(container.textContent)).toMatch(/metered[^.]*optional|optional[^.]*metered/i)
  })
})

describe("Page-wide copy rules", () => {
  // @scenario:S16
  it("S16 has no invented heatmap count and no logo image, and the new sections exist", async () => {
    const { default: Home } = await import("@/app/page")
    const { container } = render(<Home />)
    expect(container.textContent).not.toContain("1,204 stage runs in the last year")
    expect(container.querySelector("img")).toBeNull()
    for (const re of NEW_SECTIONS) {
      expect([...container.querySelectorAll("h2")].some((h) => re.test(h.textContent ?? ""))).toBe(true)
    }
  })
  // @scenario:S17
  it("S17 numbers in the new sections come from facts.json or are small documented defaults", async () => {
    const facts = JSON.stringify((await import("@/content/facts.json")).default)
    const allowed = new Set(facts.match(/\d+/g) ?? [])
    for (const re of NEW_SECTIONS) {
      const { text: t } = await homeSection(re)
      cleanup()
      for (const n of t.match(/\d+/g) ?? []) expect(allowed.has(n) || Number(n) <= 10, "number " + n).toBe(true)
    }
  })
  // @scenario:S20
  it("S20 no sentence in the new sections exceeds 25 words", async () => {
    for (const re of NEW_SECTIONS) {
      const { text: t } = await homeSection(re)
      cleanup()
      for (const s of t.split(/(?<=[.!?])\s+/)) expect(s.split(/\s+/).length, s).toBeLessThanOrEqual(25)
    }
  })
})

describe("Faq", () => {
  it("opens one answer at a time", () => {
    const { container } = render(<Faq />)
    expect(container.querySelector("section")?.id).toBe("faq")
    const [first, second] = faq.items
    const firstButton = screen.getByRole("button", { name: first!.q })
    expect(firstButton.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(firstButton)
    expect(firstButton.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText(first!.a)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: second!.q }))
    expect(firstButton.getAttribute("aria-expanded")).toBe("false")
  })
})
