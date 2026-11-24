import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import Home from "@/app/page"

afterEach(cleanup)

describe("Home page", () => {
  it("still renders every existing section and the four new ones", () => {
    const { container } = render(<Home />)
    for (const id of ["how", "repos", "github", "board", "example", "features", "factory", "moments", "pricing", "faq"]) {
      expect(container.querySelector(`section#${id}`), id).toBeTruthy()
    }
    for (const id of ["hero-title", "cta-title"]) expect(container.querySelector(`#${id}`), id).toBeTruthy()
    for (const id of ["test-first", "stacks", "engines", "sandbox"]) {
      const section = container.querySelector(`section#${id}`)
      expect(section, id).toBeTruthy()
      expect(section!.querySelector("h2")).toBeTruthy()
    }
  })
})
