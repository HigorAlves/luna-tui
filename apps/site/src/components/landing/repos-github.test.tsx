import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { GitHub } from "@/components/landing/github"
import { Repos } from "@/components/landing/repos"
import { github, repos } from "@/content/landing"

afterEach(cleanup)

describe("Repos", () => {
  it("is the #repos section with the heatmap and one ticket → PR row per repo", () => {
    const { container } = render(<Repos />)
    expect(container.querySelector("section")?.id).toBe("repos")
    expect(screen.getByRole("heading", { level: 2, name: repos.title })).toBeTruthy()
    expect(screen.getByText(repos.heatmap.title)).toBeTruthy()
    expect(screen.getByText(repos.heatmap.label)).toBeTruthy()
    expect(container.querySelectorAll("[data-week]")).toHaveLength(53)
    const rows = screen.getAllByRole("listitem").filter((li) => li.querySelector("[data-tilt]"))
    expect(rows).toHaveLength(repos.rows.length)
    repos.rows.forEach((row, i) => {
      const li = within(rows[i]!)
      expect(li.getByText(`Ticket · ${row.kind}`)).toBeTruthy()
      expect(li.getByText(row.repo)).toBeTruthy()
      expect(li.getByText(row.ticket)).toBeTruthy()
      expect(li.getByText(row.pr)).toBeTruthy()
      expect(li.getByText(`PR · ${row.number}`)).toBeTruthy()
      for (const tag of row.tags) expect(li.getByText(tag)).toBeTruthy()
    })
    expect(screen.getByText(repos.footnote)).toBeTruthy()
  })
})

describe("GitHub", () => {
  it("is the #github section with four features and a static scene fallback", () => {
    const { container } = render(<GitHub />)
    expect(container.querySelector("section")?.id).toBe("github")
    expect(screen.getByRole("heading", { level: 2, name: github.title })).toBeTruthy()
    expect(screen.getByText(github.lead)).toBeTruthy()
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(github.features.map((f) => f.title))
    const scene = container.querySelector("[data-scene]")
    expect(scene).toBeTruthy()
    expect(scene!.querySelectorAll("[data-voxel]")).toHaveLength(22 * 7)
    expect(scene!.querySelector("canvas")).toBeNull()
  })
})
