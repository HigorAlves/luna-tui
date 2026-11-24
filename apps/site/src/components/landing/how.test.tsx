import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { How } from "@/components/landing/how"
import { how } from "@/content/landing"

afterEach(cleanup)

describe("How", () => {
  it("is the #how section with the heading and the three steps in order", () => {
    const { container } = render(<How />)
    expect(container.querySelector("section")?.id).toBe("how")
    expect(screen.getByRole("heading", { level: 2, name: how.title })).toBeTruthy()
    const steps = container.querySelectorAll("[data-step]")
    expect(steps).toHaveLength(3)
    how.steps.forEach((step, i) => {
      const li = steps[i] as HTMLElement
      expect(within(li).getByRole("heading", { level: 3, name: step.title })).toBeTruthy()
      expect(within(li).getByText(step.body)).toBeTruthy()
      expect(within(li).getByText(String(i + 1).padStart(2, "0"))).toBeTruthy()
    })
  })

  it("shows the step counter and the checks meter", () => {
    render(<How />)
    expect(screen.getByText(how.meter)).toBeTruthy()
    expect(screen.getByText(/^Step/).textContent).toBe("Step 01 / 03")
  })

  it("renders the static PR sheet with every commit chip and check pill when 3D is off", () => {
    const { container } = render(<How />)
    const sheet = container.querySelector("[data-pr-sheet]") as HTMLElement
    expect(sheet).toBeTruthy()
    expect(within(sheet).getByText(how.paper.title)).toBeTruthy()
    expect(within(sheet).getByText(how.paper.sub)).toBeTruthy()
    expect(within(sheet).getByText(how.paper.slices)).toBeTruthy()
    expect(within(sheet).getByText(how.paper.checks)).toBeTruthy()
    for (const hash of how.paper.commits) expect(within(sheet).getByText(hash)).toBeTruthy()
    for (const pill of how.paper.pills) expect(within(sheet).getByText(pill)).toBeTruthy()
    expect(container.querySelector("canvas")).toBeNull()
  })
})
