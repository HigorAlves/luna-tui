import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import facts from "@/content/facts.json"
import { collectFacts, diffFacts } from "../../scripts/facts.mjs"

const script = join(__dirname, "../../scripts/facts.mjs")

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "luna-facts-"))
  mkdirSync(join(root, "contracts/src"), { recursive: true })
  mkdirSync(join(root, "machine/src/domain"), { recursive: true })
  mkdirSync(join(root, "machine/runner"), { recursive: true })
  mkdirSync(join(root, "machine/runner-qa"), { recursive: true })
  writeFileSync(join(root, "machine/runner/Dockerfile"), "FROM x")
  writeFileSync(join(root, "machine/runner-qa/Dockerfile"), "FROM x")
  writeFileSync(
    join(root, "contracts/src/index.ts"),
    `export const COLUMNS = [\n  "A",\n  "B",\n  "C",\n] as const;\nexport const TaskState = z.enum([\n  "one",\n  "two",\n]);\n`,
  )
  writeFileSync(
    join(root, "machine/src/domain/stage-input.ts"),
    `export const PACK_LIMITS: Record<PackId, { maxTurns: number }> = {\n  triage: { maxTurns: 30 },\n  e2e: { maxTurns: 60 },\n  evidence: { maxTurns: 0 },\n  ci_watch: { maxTurns: 30 },\n};\n`,
  )
  return root
}

describe("facts", () => {
  it("counts states, columns, packs and images from the repo files", () => {
    expect(collectFacts(fixtureRepo())).toEqual({ states: 2, columns: 3, packs: 4, images: 2 })
  })

  it("names every drifted field", () => {
    expect(diffFacts({ states: 1, columns: 3 }, { states: 2, columns: 3, packs: 4 })).toEqual(["packs: undefined → 4", "states: 1 → 2"])
  })

  it("committed facts.json has the factory numbers", () => {
    expect(facts).toEqual({ states: 18, columns: 8, packs: 8, images: 2 })
  })

  it("--check passes against the real repo", () => {
    expect(() => execFileSync("node", [script, "--check"], { stdio: "pipe" })).not.toThrow()
  })
})
