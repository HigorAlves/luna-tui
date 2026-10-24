// The PR sheet shown in "How it works": one geometry shared by the static DOM version and
// the canvas texture the 3D scene draws. Coordinates are in sheet pixels (1024 × 1448).
import { how } from "@/content/landing"

export const SHEET = { w: 1024, h: 1448, margin: 84 }

/** The checks meter ends here: every check green. */
export const CHECKS_SCORE = 100

export const STEP_LABEL = "Step"

const LINE2 = [640, 560, 700, 520, 610]

export const BULLETS = [470, 520, 430, 560, 490].map((w, i) => {
  const y = 420 + 136 * i
  const x = SHEET.margin + 36
  return {
    marker: { x: SHEET.margin, y: y + 4, w: 14, h: 14 },
    line1: { x, y, w, h: 20 },
    line2: { x, y: y + 44, w: LINE2[i]!, h: 14 },
    slot: { x: x + w + 26, y: y - 12, w: 196, h: 44 },
  }
})

export const HIGHLIGHTS = [
  { x: BULLETS[0]!.line1.x + 120, y: BULLETS[0]!.line1.y - 6, w: 190, h: 32 },
  { x: BULLETS[1]!.line1.x + 40, y: BULLETS[1]!.line1.y - 6, w: 150, h: 32 },
  { x: BULLETS[3]!.line1.x + 260, y: BULLETS[3]!.line1.y - 6, w: 220, h: 32 },
]

const PILL_WIDTHS = [120, 150, 96, 170, 130, 110]
const PILL_Y = 1176
const PILL_H = 32

export const PILLS = (() => {
  let x = SHEET.margin
  return how.paper.pills.map((label, i) => {
    const w = PILL_WIDTHS[i % PILL_WIDTHS.length]!
    const rect = { x, y: PILL_Y, w, h: PILL_H, label }
    x += w + 16
    return rect
  })
})()

export const BAR = { x: SHEET.margin + 120, y: 1356, w: 420, h: 12 }

export const COLORS = {
  paper: "#f4f4f5",
  ink: "#08090a",
  grey: "#71717a",
  light: "#d4d4d8",
  green: "#006d32",
  bar: "#26a641",
  brand: "#39d353",
  brandInk: "#04110a",
}

export type Rect = { x: number; y: number; w: number; h: number }
export type Fonts = { sans: string; mono: string }

/** Rect → absolute-position style in percent of the sheet. */
export const pct = (r: Rect) => ({
  left: `${(r.x / SHEET.w) * 100}%`,
  top: `${(r.y / SHEET.h) * 100}%`,
  width: `${(r.w / SHEET.w) * 100}%`,
  height: `${(r.h / SHEET.h) * 100}%`,
})

export function readFonts(): Fonts {
  const style = getComputedStyle(document.documentElement)
  const sans = style.getPropertyValue("--font-geist-sans").trim()
  const mono = style.getPropertyValue("--font-geist-mono").trim()
  return {
    sans: `${sans ? `${sans}, ` : ""}ui-sans-serif, system-ui, sans-serif`,
    mono: `${mono ? `${mono}, ` : ""}ui-monospace, monospace`,
  }
}

/** Largest font size (≤ `max`) at which `text` fits in `width`. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, family: string, max: number, width: number) {
  let size = max
  ctx.font = `${weight} ${size}px ${family}`
  while (size > 24 && ctx.measureText(text).width > width) {
    size -= 2
    ctx.font = `${weight} ${size}px ${family}`
  }
  return size
}

/** The sheet as the 3D scene's texture. `filled` draws the end state (bar full, score). */
export function drawPrSheet(ctx: CanvasRenderingContext2D, fonts: Fonts, filled = true) {
  const { w, margin: m } = SHEET
  ctx.fillStyle = COLORS.paper
  ctx.fillRect(0, 0, w, SHEET.h)
  ctx.textBaseline = "alphabetic"
  ctx.textAlign = "left"

  ctx.fillStyle = COLORS.ink
  fitFont(ctx, how.paper.title, 600, fonts.sans, 84, w - 2 * m - 60)
  ctx.fillText(how.paper.title, m, 196)
  ctx.fillStyle = COLORS.brand
  ctx.beginPath()
  ctx.roundRect(w - m - 26, 156, 26, 26, 6)
  ctx.fill()

  ctx.fillStyle = COLORS.grey
  ctx.font = `500 24px ${fonts.mono}`
  ctx.fillText(how.paper.sub, m, 250)
  ctx.fillStyle = COLORS.ink
  ctx.fillRect(m, 290, w - 2 * m, 2)

  ctx.fillStyle = COLORS.green
  ctx.font = `500 22px ${fonts.mono}`
  ctx.fillText(how.paper.slices, m, 360)

  for (const b of BULLETS) {
    ctx.fillStyle = COLORS.ink
    ctx.fillRect(b.marker.x, b.marker.y, b.marker.w, b.marker.h)
    ctx.fillRect(b.line1.x, b.line1.y, b.line1.w, b.line1.h)
    ctx.fillStyle = COLORS.light
    ctx.fillRect(b.line2.x, b.line2.y, b.line2.w, b.line2.h)
    ctx.setLineDash([8, 6])
    ctx.strokeStyle = COLORS.light
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(b.slot.x + 1, b.slot.y + 1, b.slot.w - 2, b.slot.h - 2, 22)
    ctx.stroke()
    ctx.setLineDash([])
  }

  ctx.fillStyle = COLORS.green
  ctx.font = `500 22px ${fonts.mono}`
  ctx.fillText(how.paper.checks, m, 1140)
  for (const pill of PILLS) {
    ctx.fillStyle = COLORS.light
    ctx.beginPath()
    ctx.roundRect(pill.x, pill.y, pill.w, pill.h, pill.h / 2)
    ctx.fill()
    ctx.fillStyle = COLORS.grey
    ctx.font = `500 18px ${fonts.mono}`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(pill.label, pill.x + pill.w / 2, pill.y + pill.h / 2 + 1)
    ctx.textAlign = "left"
    ctx.textBaseline = "alphabetic"
  }

  ctx.fillStyle = COLORS.ink
  ctx.fillRect(m, 1290, w - 2 * m, 2)
  ctx.fillStyle = COLORS.grey
  ctx.font = `500 22px ${fonts.mono}`
  ctx.fillText(how.paper.footer, m, 1372)
  ctx.fillStyle = COLORS.light
  ctx.fillRect(BAR.x, BAR.y, BAR.w, BAR.h)
  if (filled) {
    ctx.fillStyle = COLORS.bar
    ctx.fillRect(BAR.x, BAR.y, (CHECKS_SCORE * BAR.w) / 100, BAR.h)
    ctx.fillStyle = COLORS.green
    ctx.font = `600 80px ${fonts.sans}`
    const score = `${CHECKS_SCORE}%`
    ctx.fillText(score, w - m - ctx.measureText(score).width, 1386)
  }
}

/** A commit-hash chip: brand pill, ink mono text. */
export function drawHashChip(ctx: CanvasRenderingContext2D, hash: string, w: number, h: number, fonts: Fonts) {
  ctx.fillStyle = COLORS.brand
  ctx.beginPath()
  ctx.roundRect(0, 0, w, h, h / 2)
  ctx.fill()
  ctx.fillStyle = COLORS.brandInk
  ctx.font = `500 ${Math.round(0.46 * h)}px ${fonts.mono}`
  ctx.textBaseline = "middle"
  ctx.textAlign = "center"
  ctx.fillText(hash, w / 2, h / 2 + 1)
}

/** A lit check pill (drawn at 4× the sheet size for a crisp texture). */
export function drawLitPill(ctx: CanvasRenderingContext2D, label: string, w: number, h: number, fonts: Fonts) {
  ctx.fillStyle = COLORS.brand
  ctx.beginPath()
  ctx.roundRect(0, 0, w, h, h / 2)
  ctx.fill()
  ctx.fillStyle = COLORS.brandInk
  ctx.font = `600 ${Math.round(0.56 * h)}px ${fonts.mono}`
  ctx.textBaseline = "middle"
  ctx.textAlign = "center"
  ctx.fillText(label, w / 2, h / 2 + 1)
}
