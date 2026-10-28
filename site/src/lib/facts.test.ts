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
  mkdirSync(join(root, "machine/runner"), { recursive: true })
  mkdirSync(join(root, "machine/runner-qa"), { recursive: true })
  writeFileSync(join(root, "machine/runner/Dockerfile"), "FROM x")
  writeFileSync(join(root, "machine/runner-qa/Dockerfile"), "FROM x")
  writeFileSync(
    join(root, "contracts/src/index.ts"),
    `export const COLUMNS = [\n  "A",\n  "B",\n  "C",\n] as const;\nexport const TaskState = z.enum([\n  "one",\n  "two",\n]);\n`,
  )
  writeFileSync(
    join(root, "contracts/src/packs.ts"),
    `export const PACKS: Record<PackId, Pack> = {\n  triage: {\n    id: "triage",\n  },\n  e2e: {\n    id: "e2e",\n  },\n  evidence: {\n    id: "evidence",\n  },\n  ci_watch: {\n    id: "ci_watch",\n  },\n};\n`,
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
    expect(facts).toEqual({ states: 22, columns: 8, packs: 11, images: 2 })
  })

  it("--check passes against the real repo", () => {
    expect(() => execFileSync("node", [script, "--check"], { stdio: "pipe" })).not.toThrow()
  })
})
