// Luna TUI mark: Luna's Eclipse with "Prompt" eyes, on Apple's 1024 icon grid.
// One builder shared by the exporter, the study page and the site codegen.

const TILE = 824 // superellipse tile edge, centred at 512
const DEGREE = 5
const CREAM = "#FCF3DC"

export const APPEARANCES = {
  default: { from: "#262B52", to: "#07080F", moon: CREAM, island: "#06070B", glow: 0.38, eyes: CREAM },
  dark: { from: "#141418", to: "#000000", moon: CREAM, island: "#000000", glow: 0.22, eyes: CREAM },
  tinted: { from: "#3A3A3F", to: "#151517", moon: "#F2F2F2", island: "#0E0E10", glow: 0.15, eyes: "#F2F2F2" },
}

export const CHEVRON = "M470 522l54 43-54 43"

const num = (n) => String(Math.round(n * 10) / 10)

/** Superellipse (degree 5) outline as an SVG path, 240 samples. */
export function tilePath() {
  const pts = []
  const n = 240
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = 512 + (TILE / 2) * Math.sign(c) * Math.abs(c) ** (2 / DEGREE)
    const y = 512 + (TILE / 2) * Math.sign(s) * Math.abs(s) ** (2 / DEGREE)
    pts.push(`${num(x)} ${num(y)}`)
  }
  return `M${pts.join("L")}Z`
}

/** Children of the <svg> (defs + shapes) for one appearance. */
export function markInner(appearance = "default") {
  const a = APPEARANCES[appearance]
  if (!a) throw new Error(`unknown appearance: ${appearance}`)
  const id = `lt-${appearance}`
  return (
    `<defs>` +
    `<linearGradient id="${id}-bg" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${a.from}"/><stop offset="1" stop-color="${a.to}"/></linearGradient>` +
    `<radialGradient id="${id}-glow" gradientUnits="userSpaceOnUse" cx="470" cy="470" r="400"><stop offset="0" stop-color="${a.moon}" stop-opacity="${a.glow}"/><stop offset="1" stop-color="${a.moon}" stop-opacity="0"/></radialGradient>` +
    `</defs>` +
    `<path d="${tilePath()}" fill="url(#${id}-bg)"/>` +
    `<circle cx="470" cy="470" r="400" fill="url(#${id}-glow)"/>` +
    `<circle cx="482" cy="482" r="250" fill="${a.moon}"/>` +
    `<circle cx="550" cy="550" r="228" fill="${a.island}"/>` +
    `<path d="${CHEVRON}" fill="none" stroke="${a.eyes}" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<rect x="570" y="582" width="76" height="44" rx="22" fill="${a.eyes}"/>`
  )
}

export function viewBox(fit = "grid") {
  return fit === "tile" ? "100 100 824 824" : "0 0 1024 1024"
}

/** Full standalone SVG document string. fit: "grid" (1024 canvas) | "tile" (edge to edge). */
export function markSvg({ appearance = "default", fit = "grid" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(fit)}">${markInner(appearance)}</svg>`
}

/** Children of the one-colour glyph: crescent with the island cut out, prompt in the same colour. */
export function glyphInner() {
  return (
    `<defs><mask id="lt-glyph-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">` +
    `<rect width="1024" height="1024" fill="#fff"/><circle cx="550" cy="550" r="228" fill="#000"/></mask></defs>` +
    `<circle cx="482" cy="482" r="250" fill="currentColor" mask="url(#lt-glyph-cut)"/>` +
    `<path d="${CHEVRON}" fill="none" stroke="currentColor" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<rect x="570" y="582" width="76" height="44" rx="22" fill="currentColor"/>`
  )
}

export const GLYPH_VIEWBOX = "232 232 546 546"

/** One-colour glyph, 24x18, follows currentColor (menu bar / inline use). */
export function glyphSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${GLYPH_VIEWBOX}" width="24" height="18">${glyphInner()}</svg>`
}
