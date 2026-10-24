import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Board } from "@/components/landing/board"
import { Orc } from "@/components/landing/orc"
import { board, orc } from "@/content/landing"

afterEach(cleanup)

describe("Board", () => {
  it("is the #board section with its heading, the ticket cards fallback and the four features", () => {
    const { container } = render(<Board />)
    expect(container.querySelector("section")?.id).toBe("board")
    expect(screen.getByRole("heading", { level: 2, name: board.title })).toBeTruthy()
    const scene = container.querySelector("[data-scene]")!
    for (const card of board.cards) {
      expect(within(scene as HTMLElement).getByText(card.title)).toBeTruthy()
      expect(within(scene as HTMLElement).getByText(`${card.stage} · ${card.detail}`)).toBeTruthy()
      expect(within(scene as HTMLElement).getByText(`${card.runs} runs`)).toBeTruthy()
    }
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(board.features.map((f) => f.title))
  })
})

describe("Orc", () => {
  it("is the #orc section with features, terminal lines and every pack", () => {
    const { container } = render(<Orc />)
    expect(container.querySelector("section")?.id).toBe("orc")
    expect(screen.getByRole("heading", { level: 2, name: orc.title })).toBeTruthy()
    for (const f of orc.features) expect(screen.getByRole("heading", { level: 3, name: f.title })).toBeTruthy()
    const terminal = screen.getByRole("list", { name: "Example machine session" })
    for (const line of orc.terminal.lines) expect(within(terminal).getByText(line.text, { exact: false })).toBeTruthy()
    expect(screen.getByText(orc.terminal.title)).toBeTruthy()
    for (const p of orc.packs) expect(screen.getByText(p.name)).toBeTruthy()
    expect(screen.getByRole("heading", { level: 3, name: orc.setup.title })).toBeTruthy()
    expect(screen.getByRole("heading", { level: 3, name: orc.packsTitle })).toBeTruthy()
  })

  it("switches the setup commands with the tabs", () => {
    render(<Orc />)
    const [agents, stubs] = orc.setup.tabs
    expect(screen.getByText(agents!.commands[0]!)).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: stubs!.label }))
    expect(screen.getByRole("tab", { name: stubs!.label }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByText(stubs!.commands.at(-1)!)).toBeTruthy()
    expect(screen.queryByText(agents!.commands[0]!)).toBeNull()
  })

  it("answers each press of the mascot button with the next reply", () => {
    render(<Orc />)
    const button = screen.getByRole("button", { name: orc.mascot.button })
    fireEvent.click(button)
    expect(screen.getByText(orc.mascot.replies[0]!)).toBeTruthy()
    fireEvent.click(button)
    expect(screen.getByText(orc.mascot.replies[1]!)).toBeTruthy()
  })
})
