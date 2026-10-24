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
