import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// vitest runs with cwd = site/
const root = (p: string) => resolve(process.cwd(), "..", p)

function ihdr(path: string) {
  const b = readFileSync(root(path))
  expect(b.subarray(1, 4).toString()).toBe("PNG")
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }
}

describe("icon set", () => {
  it.each([
    ["site/public/icon.png", 256],
    ["site/public/mark.png", 64],
    ["site/src/app/icon.png", 512],
    ["site/src/app/apple-icon.png", 180],
    ["board/icon.png", 512],
  ])("%s is %i px square", (path, size) => {
    const { w, h } = ihdr(path)
    expect([w, h]).toEqual([size, size])
  })

  it("board/icon.png keeps an alpha channel for the transparent margin", () => {
    expect(ihdr("board/icon.png").colorType).toBe(6)
  })
})
