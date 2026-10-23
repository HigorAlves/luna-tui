import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Touches } from "@/components/sections/touches"
import { Line } from "@/components/sections/line"
import { OrcInside } from "@/components/sections/orc-inside"
import { Safe } from "@/components/sections/safe"
import { Counter } from "@/components/sections/counter"
import { Install } from "@/components/sections/install"
import { installCommands } from "@/content/install"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("Touches", () => {
  it("shows the heading and the three approvals", () => {
    render(<Touches />)
    expect(screen.getByRole("heading", { level: 2, name: "Three touches per ticket" })).toBeTruthy()
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(titles).toEqual(["Approve the plan", "Approve the tests", "Approve the ship"])
    expect(screen.getByText("03 · a / A")).toBeTruthy()
  })
})

describe("Line", () => {
  it("lists the fourteen stations in order", () => {
    const { container } = render(<Line />)
    expect(screen.getByRole("heading", { level: 2, name: "Eleven stations, one state machine" })).toBeTruthy()
    expect(container.querySelector("section")?.id).toBe("line")
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(names).toEqual([
      "Intake", "Triage", "Plan", "Test design", "Tests", "Implementing", "Verifying",
      "E2E", "Delivering", "CI watch", "Evidence", "Ship", "Shipping", "Close",
    ])
    expect(screen.getAllByText("you").length).toBeGreaterThanOrEqual(3)
  })
})

describe("OrcInside", () => {
  it("links to orc and ADR 0009", () => {
    render(<OrcInside />)
    expect(screen.getByRole("heading", { level: 2, name: "Luna TUI decides when. orc decides how." })).toBeTruthy()
    expect(screen.getByRole("link", { name: "orc, the Claude Code plugin →" }).getAttribute("href")).toBe("https://orc.higoralves.dev")
    expect(screen.getByRole("link", { name: "ADR 0009, the contract →" }).getAttribute("href")).toBe(
      "https://github.com/HigorAlves/orc/blob/main/docs/adr/0009-factory-mode-and-stage-contract.md",
    )
  })
})

describe("Safe", () => {
  it("shows the four guarantees", () => {
    render(<Safe />)
    expect(screen.getByRole("heading", { level: 2, name: "Safe by construction" })).toBeTruthy()
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(titles).toEqual(["Sealed containers", "Tools per stage", "Locked tests", "Outward actions ask"])
  })
})

describe("Counter", () => {
  it("lists the four checks", () => {
    render(<Counter />)
    expect(screen.getByRole("heading", { level: 2, name: "The counter on the wall" })).toBeTruthy()
    for (const cmd of ["pnpm golden --selftest", "pnpm smoke:sandbox", "pnpm golden --matrix", "pnpm golden:live"]) {
      expect(screen.getByText(cmd)).toBeTruthy()
    }
  })
})

describe("Install", () => {
  it("shows the five commands and copies them joined by newlines", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(<Install />)
    expect(screen.getByRole("heading", { level: 2, name: "Five commands, then open the board" })).toBeTruthy()
    expect(installCommands).toHaveLength(5)
    expect(screen.getByText("pnpm install && pnpm db:up")).toBeTruthy()
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }))
    })
    expect(writeText).toHaveBeenCalledWith(installCommands.join("\n"))
    expect(within(screen.getByRole("button", { name: "Copied" })).getByText("Copied")).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy()
  })
})
