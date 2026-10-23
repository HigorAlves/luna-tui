import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SiteHeader } from "@/components/site-header"

describe("SiteHeader", () => {
  it("shows the wordmark, the nav anchors and both chips", () => {
    render(<SiteHeader />)
    expect(screen.getAllByText("Luna TUI").length).toBeGreaterThan(0)
    expect(screen.getByRole("link", { name: /Luna for the notch/ }).getAttribute("href")).toBe("https://luna-sigma-nine.vercel.app/")
    expect(screen.getByRole("link", { name: /runs orc/ }).getAttribute("href")).toBe("https://orc.higoralves.dev")
    expect(screen.getByRole("link", { name: "How it runs" }).getAttribute("href")).toBe("#line")
    expect(screen.getByRole("link", { name: "Safety" }).getAttribute("href")).toBe("#safe")
    expect(screen.getByRole("link", { name: "Install" }).getAttribute("href")).toBe("#install")
  })
})
