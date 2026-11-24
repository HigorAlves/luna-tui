import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Board } from "@/components/landing/board"
import { Factory } from "@/components/landing/factory"
import { board, factory } from "@/content/landing"

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

describe("Factory", () => {
  it("is the #factory section with features, terminal lines and every pack", () => {
    const { container } = render(<Factory />)
    expect(container.querySelector("section")?.id).toBe("factory")
    expect(screen.getByRole("heading", { level: 2, name: factory.title })).toBeTruthy()
    for (const f of factory.features) expect(screen.getByRole("heading", { level: 3, name: f.title })).toBeTruthy()
    const terminal = screen.getByRole("list", { name: "Example machine session" })
    for (const line of factory.terminal.lines) expect(within(terminal).getByText(line.text, { exact: false })).toBeTruthy()
    expect(screen.getByText(factory.terminal.title)).toBeTruthy()
    for (const p of factory.packs) expect(screen.getByText(p.name)).toBeTruthy()
    expect(screen.getByRole("heading", { level: 3, name: factory.setup.title })).toBeTruthy()
    expect(screen.getByRole("heading", { level: 3, name: factory.packsTitle })).toBeTruthy()
  })

  it("switches the setup commands with the tabs", () => {
    render(<Factory />)
    const [agents, stubs] = factory.setup.tabs
    expect(screen.getByText(agents!.commands[0]!)).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: stubs!.label }))
    expect(screen.getByRole("tab", { name: stubs!.label }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByText(stubs!.commands.at(-1)!)).toBeTruthy()
    expect(screen.queryByText(agents!.commands[0]!)).toBeNull()
  })

  it("answers each press of the mascot button with the next reply", () => {
    render(<Factory />)
    const button = screen.getByRole("button", { name: factory.mascot.button })
    fireEvent.click(button)
    expect(screen.getByText(factory.mascot.replies[0]!)).toBeTruthy()
    fireEvent.click(button)
    expect(screen.getByText(factory.mascot.replies[1]!)).toBeTruthy()
  })
})
