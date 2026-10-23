import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { BoardFrame } from "@/components/board-frame"
import { Hero } from "@/components/sections/hero"

afterEach(cleanup)

describe("BoardFrame", () => {
  it("renders the nine columns in order with their counts", () => {
    render(<BoardFrame />)
    const heads = screen.getAllByRole("heading", { level: 3 })
    expect(heads.map((h) => h.textContent)).toEqual([
      "Backlog2", "Intake1", "Triage1", "Approved0", "Build1", "Verify1", "Evidence0", "Ship1", "Done3",
    ])
  })

  it("lists the six key legends", () => {
    render(<BoardFrame />)
    const keys = screen.getByLabelText("Keys")
    for (const [k, label] of [["a", "approve"], ["r", "send back"], ["f", "watch"], ["o", "issue"], ["F", "floor"], ["X", "abort"]]) {
      expect(within(keys).getByText(k, { exact: true })).toBeTruthy()
      expect(within(keys).getByText(label)).toBeTruthy()
    }
  })

  it("shows the machine status and a card with its badge", () => {
    render(<BoardFrame />)
    expect(screen.getByText(/127\.0\.0\.1:4317/)).toBeTruthy()
    expect(screen.getByText("#43 Login error copy")).toBeTruthy()
    expect(screen.getByText("needs you · plan")).toBeTruthy()
  })
})

describe("Hero", () => {
  it("has the headline, both calls to action and a hidden cursor", () => {
    const { container } = render(<Hero />)
    const h1 = screen.getByRole("heading", { level: 1 })
    expect(h1.textContent).toContain("Tickets in. Pull requests out.")
    expect(h1.textContent).toContain("You approve three times")
    expect(screen.getByRole("link", { name: "Install" }).getAttribute("href")).toBe("#install")
    expect(screen.getByRole("link", { name: "See the line" }).getAttribute("href")).toBe("#line")
    expect(container.querySelector("h1 span[aria-hidden='true']")).not.toBeNull()
  })
})
