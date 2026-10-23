// Renders the Luna TUI icon set from the shared SVG builder. Idempotent.
// Never downscales a bitmap: every size is rasterised from the SVG at its own density.
import { mkdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { markSvg } from "./mark.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sharp = createRequire(resolve(root, "site/package.json"))("sharp")

const OUT = [
  ["site/public/icon.png", 256, "tile"],
  ["site/public/mark.png", 64, "tile"],
  ["site/src/app/icon.png", 512, "tile"],
  ["site/src/app/apple-icon.png", 180, "tile"],
  ["board/icon.png", 512, "grid"],
]

const rows = []
for (const [rel, size, fit] of OUT) {
  const svg = Buffer.from(markSvg({ appearance: "default", fit }))
  const view = fit === "tile" ? 824 : 1024
  const file = resolve(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  await sharp(svg, { density: (72 * size) / view })
    .resize(size, size)
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toFile(file)
  rows.push([rel, `${size}x${size}`, fit, `${statSync(file).size} B`])
}

const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join("  "))
