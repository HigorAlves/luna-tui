import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Example } from "@/components/landing/example"
import { example } from "@/content/landing"

afterEach(cleanup)

const evidence = () => document.getElementById("proof-evidence")!

describe("Example", () => {
  it("starts on the first PR line with its evidence", () => {
    const { container } = render(<Example />)
    expect(container.querySelector("section")?.id).toBe("example")
    const lines = screen.getAllByRole("button", { pressed: true })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toContain(example.bullets[0]!.text)
    expect(within(evidence()).getByText(example.bullets[0]!.commits[0]!.hash)).toBeTruthy()
    expect(within(evidence()).getByText("1 commit")).toBeTruthy()
  })

  it("switches the evidence when another line is hovered or tapped", () => {
    render(<Example />)
    const second = example.bullets[1]!
    const button = screen.getByRole("button", { name: new RegExp(second.text.slice(0, 30)) })
    fireEvent.mouseEnter(button)
    expect(button.getAttribute("aria-pressed")).toBe("true")
    expect(within(evidence()).getByText("2 commits")).toBeTruthy()
    for (const c of second.commits) expect(within(evidence()).getByText(c.hash)).toBeTruthy()
    expect(within(evidence()).getByText(`${second.stage} · ${second.attempt}`)).toBeTruthy()
    const third = screen.getByRole("button", { name: new RegExp(example.bullets[2]!.text.slice(0, 30)) })
    fireEvent.click(third)
    expect(third.getAttribute("aria-pressed")).toBe("true")
    expect(button.getAttribute("aria-pressed")).toBe("false")
  })

  it("shows the acceptance score with what was met and what was out of scope", () => {
    render(<Example />)
    expect(screen.getByText(`${example.acceptance.score}%`)).toBeTruthy()
    for (const item of [...example.acceptance.metItems, ...example.acceptance.outItems]) expect(screen.getByText(item)).toBeTruthy()
  })
})
