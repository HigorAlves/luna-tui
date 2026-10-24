import { describe, expect, it } from "vitest"
import { glyphSvg, markSvg } from "../../../scripts/mark.mjs"

describe("markSvg", () => {
  it("dark appearance uses the dark tile gradient", () => {
    expect(markSvg({ appearance: "dark" })).toContain("#141418")
  })
  it("default carries the moon, island, chevron and cursor", () => {
    const s = markSvg({ appearance: "default" })
    expect(s).toContain('r="250"')
    expect(s).toContain("M470 522l54 43-54 43")
    expect(s).toContain('width="76"')
  })
  it("tile fit crops to the 824 tile; grid keeps the 1024 canvas", () => {
    expect(markSvg({ fit: "tile" })).toContain('viewBox="100 100 824 824"')
    expect(markSvg({ fit: "grid" })).toContain('viewBox="0 0 1024 1024"')
  })
})

describe("glyphSvg", () => {
  it("is one-colour", () => {
    expect(glyphSvg()).toContain("currentColor")
  })
})
