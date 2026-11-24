import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Glyph, Mark, Wordmark } from "@/components/brand"

describe("brand", () => {
  it("Mark renders the Eclipse Prompt geometry, hidden from assistive tech", () => {
    const { container } = render(<Mark />)
    const svg = container.querySelector("svg")!
    expect(svg.getAttribute("aria-hidden")).toBe("true")
    expect(svg.getAttribute("width")).toBe("28")
    expect(container.querySelector('circle[r="250"]')).not.toBeNull()
    expect(container.querySelector('path[d="M470 522l54 43-54 43"]')).not.toBeNull()
  })
  it("Mark honours size and appearance", () => {
    const { container } = render(<Mark size={64} appearance="dark" />)
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("64")
    expect(container.innerHTML).toContain("#141418")
  })
  it("Glyph is 24x18 and follows currentColor", () => {
    const { container } = render(<Glyph />)
    const svg = container.querySelector("svg")!
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["24", "18"])
    expect(container.innerHTML).toContain("currentColor")
  })
  it("Wordmark pairs the mark with the name", () => {
    const { container } = render(<Wordmark />)
    expect(container.textContent).toBe("Luna TUI")
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
