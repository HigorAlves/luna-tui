import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { FinalCta } from "@/components/landing/final-cta"
import { Hero } from "@/components/landing/hero"
import { INSTALL_DOC, cta, finalCta, hero } from "@/content/landing"

afterEach(cleanup)

describe("Hero", () => {
  it("shows the eyebrow, title, lead, both CTAs and the checks", () => {
    render(<Hero />)
    expect(screen.getByRole("heading", { level: 1, name: hero.title })).toBeTruthy()
    expect(screen.getByText(hero.eyebrow)).toBeTruthy()
    expect(screen.getByText(hero.lead)).toBeTruthy()
    expect(screen.getByRole("link", { name: cta.primary }).getAttribute("href")).toBe(INSTALL_DOC)
    expect(screen.getByRole("link", { name: cta.secondary }).getAttribute("href")).toBe("#example")
    for (const check of hero.checks) expect(screen.getByText(check)).toBeTruthy()
  })

  it("draws the ticket + repo + factory = PR equation", () => {
    render(<Hero />)
    const figure = screen.getByRole("figure", { name: hero.figureLabel })
    for (const part of [...hero.equation, hero.result]) {
      expect(within(figure).getByText(part.name)).toBeTruthy()
      expect(within(figure).getByText(part.tag)).toBeTruthy()
    }
    expect(within(figure).getByText(hero.result.commit)).toBeTruthy()
  })

  it("renders the commit rain canvas behind the hero", () => {
    const { container } = render(<Hero />)
    expect(container.querySelector("section canvas")).toBeTruthy()
  })
})

describe("FinalCta", () => {
  it("shows the closing heading, lead and install link", () => {
    const { container } = render(<FinalCta />)
    expect(screen.getByRole("heading", { level: 2, name: finalCta.title })).toBeTruthy()
    expect(screen.getByText(finalCta.lead)).toBeTruthy()
    expect(screen.getByRole("link", { name: cta.primary }).getAttribute("href")).toBe(INSTALL_DOC)
    expect((container.querySelector("canvas") as HTMLCanvasElement).style.opacity).toBe("0.16")
  })
})
