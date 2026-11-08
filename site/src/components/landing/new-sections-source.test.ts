import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const dir = __dirname
const EXISTING = new Set([
  "board", "example", "faq", "features", "final-cta", "github", "hero", "how", "moments", "factory", "pricing", "repos",
])
// New section modules are the landing components the page imports beyond today's twelve.
const newSections = () => {
  const page = readFileSync(join(dir, "../../app/page.tsx"), "utf8")
  const mods = [...page.matchAll(/from\s+["']@\/components\/landing\/([a-z-]+)["']/g)].map((m) => m[1]!)
  return mods.filter((m) => !EXISTING.has(m)).map((m) => m + ".tsx")
}
const importsOf = (f: string) => [...readFileSync(join(dir, f), "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!)
const deps = () => {
  const pkg = JSON.parse(readFileSync(join(dir, "../../../package.json"), "utf8"))
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
}

describe("new section sources", () => {
  // @scenario:S13
  it("S13 four new sections import the existing primitives and fx or scenes", () => {
    const files = newSections()
    expect(files.length, "new section modules rendered by page.tsx").toBeGreaterThanOrEqual(4)
    for (const f of files) {
      expect(existsSync(join(dir, f)), f).toBe(true)
      const i = importsOf(f)
      expect(i, f).toContain("./primitives")
      expect(i.some((p) => /(^\.\/|landing\/)(fx|scenes)\//.test(p)), f).toBe(true)
    }
  })
  // @scenario:S15
  it("S15 non-relative imports of the new sections are dependencies already in package.json", () => {
    const files = newSections()
    expect(files.length, "new section modules rendered by page.tsx").toBeGreaterThanOrEqual(4)
    const known = deps()
    for (const f of files) {
      for (const p of importsOf(f).filter((p) => !p.startsWith(".") && !p.startsWith("@/"))) {
        expect(known.some((d) => p === d || p.startsWith(d + "/")) || p.startsWith("node:"), p).toBe(true)
      }
    }
  })
})
