import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SiteFooter } from "@/components/site-footer"
import { footer } from "@/content/landing"

afterEach(cleanup)

describe("SiteFooter", () => {
  it("shows the tagline, every link column and the facts line", () => {
    render(<SiteFooter />)
    expect(screen.getByText(footer.tagline)).toBeTruthy()
    for (const column of footer.columns) {
      const nav = screen.getByRole("navigation", { name: column.title })
      expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(column.links.map((l) => l.href))
    }
    expect(screen.getByText(footer.facts)).toBeTruthy()
  })
})
