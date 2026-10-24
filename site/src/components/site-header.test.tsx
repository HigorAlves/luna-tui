import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SiteHeader } from "@/components/site-header"
import { INSTALL_DOC, REPO, nav } from "@/content/landing"

afterEach(cleanup)

describe("SiteHeader", () => {
  it("shows the wordmark, every section anchor, GitHub and the install CTA", () => {
    render(<SiteHeader />)
    expect(screen.getByRole("link", { name: "Luna TUI, home" }).getAttribute("href")).toBe("/")
    const main = screen.getByRole("navigation", { name: "Main" })
    expect(within(main).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(nav.map((n) => n.href))
    expect(screen.getAllByRole("link", { name: "GitHub" }).some((a) => a.getAttribute("href") === REPO)).toBe(true)
    expect(screen.getAllByRole("link", { name: "Install Luna TUI" })[0]?.getAttribute("href")).toBe(INSTALL_DOC)
  })

  it("gains a border and backdrop once the page scrolls", () => {
    render(<SiteHeader />)
    const header = screen.getByRole("banner")
    expect(header.className).toContain("border-transparent")
    act(() => {
      Object.defineProperty(window, "scrollY", { value: 40, configurable: true })
      window.dispatchEvent(new Event("scroll"))
    })
    expect(header.className).not.toContain("border-transparent")
  })

  it("opens and closes the mobile menu", () => {
    render(<SiteHeader />)
    const toggle = screen.getByRole("button", { name: "Open menu" })
    fireEvent.click(toggle)
    const menu = screen.getByRole("navigation", { name: "Mobile" })
    expect(within(menu).getAllByRole("link").length).toBe(nav.length + 2)
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }))
    expect(screen.queryByRole("navigation", { name: "Mobile" })).toBeNull()
  })
})
