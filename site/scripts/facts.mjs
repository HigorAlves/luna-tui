// Writes src/content/facts.json from the repo, so the site never prints a count
// that the code does not have.
//   node scripts/facts.mjs           regenerate
//   node scripts/facts.mjs --check   exit 1 when the committed file has drifted (CI)
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, "../src/content/facts.json")

const quoted = (body) => [...body.matchAll(/"([^"]+)"/g)].length

export function collectFacts(repoRoot) {
  const contracts = readFileSync(join(repoRoot, "contracts/src/index.ts"), "utf8")
  const columns = contracts.match(/COLUMNS\s*=\s*\[([^\]]*)\]/)?.[1]
  const states = contracts.match(/TaskState\s*=\s*z\.enum\(\[([^\]]*)\]/)?.[1]
  const registry = readFileSync(join(repoRoot, "contracts/src/packs.ts"), "utf8")
  const packs = registry.match(/PACKS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1]
  if (columns === undefined || states === undefined || packs === undefined) throw new Error("facts: could not parse contracts or PACKS")
  const machine = join(repoRoot, "machine")
  const images = readdirSync(machine, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(machine, d.name, "Dockerfile"))).length
  return {
    states: quoted(states),
    columns: quoted(columns),
    packs: [...packs.matchAll(/^\s{2}(\w+):\s*\{/gm)].length,
    images,
  }
}

export function diffFacts(committed, disk) {
  return Object.keys(disk)
    .filter((k) => committed?.[k] !== disk[k])
    .sort()
    .map((k) => `${k}: ${committed?.[k]} → ${disk[k]}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const disk = collectFacts(join(here, "../.."))
  if (process.argv.includes("--check")) {
    const committed = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null
    const drift = diffFacts(committed, disk)
    if (drift.length) {
      console.error(`facts: src/content/facts.json is stale (run pnpm --filter site facts):\n  ${drift.join("\n  ")}`)
      process.exit(1)
    }
    console.log("facts: OK")
  } else {
    writeFileSync(OUT, JSON.stringify(disk, null, 2) + "\n")
    console.log("facts:", JSON.stringify(disk))
  }
}
