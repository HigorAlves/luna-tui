import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// vitest runs with cwd = apps/site/
const root = (p: string) => resolve(process.cwd(), "../..", p)

function ihdr(path: string) {
  const b = readFileSync(root(path))
  expect(b.subarray(1, 4).toString()).toBe("PNG")
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }
}

describe("icon set", () => {
  it.each([
    ["apps/site/public/icon.png", 256],
    ["apps/site/public/mark.png", 64],
    ["apps/site/src/app/icon.png", 512],
    ["apps/site/src/app/apple-icon.png", 180],
    ["apps/board/icon.png", 512],
  ])("%s is %i px square", (path, size) => {
    const { w, h } = ihdr(path)
    expect([w, h]).toEqual([size, size])
  })

  it("apps/board/icon.png keeps an alpha channel for the transparent margin", () => {
    expect(ihdr("apps/board/icon.png").colorType).toBe(6)
  })
})
