"use client"

import { useEffect, useRef } from "react"
import { cn } from "cn"
import { rng } from "./scene"

const FRAME = 1000 / 30
const CELL = 11
const PITCH = 14
const RADIUS = 2.5
const FALLBACK = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"]

type Drop = { head: number; speed: number; tail: number; peak: number; wait: number }

/** Falling contribution-cell columns on a canvas; one static seeded frame under reduced motion. */
export function CommitCascade({
  className,
  opacity = 0.25,
  density = 0.5,
  vignette = "hero",
}: {
  className?: string
  opacity?: number
  density?: number
  vignette?: "hero" | "band"
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext?.("2d")
    if (!canvas || !ctx) return
    const css = getComputedStyle(document.documentElement)
    const colors = FALLBACK.map((c, i) => css.getPropertyValue(`--commit-${i}`).trim() || c)
    const rm = window.matchMedia("(prefers-reduced-motion: reduce)")
    let dpr = 1
    let cols = 0
    let rows = 0
    let base: HTMLCanvasElement | null = null
    let tiles: HTMLCanvasElement[] = []
    let drops: Drop[] = []
    let raf = 0
    let last = 0
    let visible = true
    let w = 0
    let h = 0

    const tile = (color: string) => {
      const size = Math.ceil(CELL * dpr)
      const c = document.createElement("canvas")
      c.width = c.height = size
      const g = c.getContext("2d")!
      g.fillStyle = color
      g.beginPath()
      g.roundRect(0, 0, CELL * dpr, CELL * dpr, RADIUS * dpr)
      g.fill()
      return c
    }

    const spawn = (prev: Drop | undefined, initial: boolean): Drop => {
      const tail = 5 + Math.floor(14 * Math.random())
      return {
        head: initial ? Math.random() * (rows + tail) : -(6 * Math.random()),
        speed: 1.6 + 4.2 * Math.random(),
        tail,
        peak: 2 + Math.floor(3 * Math.random()),
        wait: initial ? (Math.random() < density ? 0 : 6 * Math.random()) : prev ? Math.random() * (1 - density) * 9 : 0,
      }
    }

    const resize = () => {
      const r = canvas.getBoundingClientRect()
      if (r.width === w && r.height === h) return false
      w = r.width
      h = r.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      cols = Math.ceil(w / PITCH) + 1
      rows = Math.ceil(h / PITCH) + 1
      tiles = colors.map(tile)
      base = document.createElement("canvas")
      base.width = canvas.width
      base.height = canvas.height
      const b = base.getContext("2d")!
      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) b.drawImage(tiles[0]!, PITCH * x * dpr, PITCH * y * dpr)
      drops = Array.from({ length: cols }, () => spawn(undefined, true))
      return true
    }

    const drawStatic = () => {
      const rand = rng(7)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (let x = 0; x < cols; x++)
        for (let y = 0; y < rows; y++) {
          const r = rand()
          const lvl = r > 0.985 ? 4 : r > 0.96 ? 3 : r > 0.91 ? 2 : r > 0.82 ? 1 : 0
          ctx.drawImage(tiles[lvl]!, PITCH * x * dpr, PITCH * y * dpr)
        }
    }

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame)
      const d = t - last
      if (d < FRAME) return
      const dt = Math.min(d, 100) / 1000
      last = t
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (base) ctx.drawImage(base, 0, 0)
      for (let x = 0; x < cols; x++) {
        const dr = drops[x]!
        if (dr.wait > 0) {
          dr.wait -= dt
          continue
        }
        dr.head += dr.speed * dt
        const head = Math.floor(dr.head)
        for (let i = 0; i < dr.tail; i++) {
          const y = head - i
          if (y < 0) break
          if (y >= rows) continue
          const a = i / dr.tail
          const lvl = Math.max(1, Math.round(dr.peak * (1 - a)))
          ctx.globalAlpha = (1 - a) * (1 - 0.35 * a)
          ctx.drawImage(tiles[lvl]!, PITCH * x * dpr, PITCH * y * dpr)
        }
        if (head - dr.tail > rows) drops[x] = spawn(dr, false)
      }
      ctx.globalAlpha = 1
    }

    const stop = () => {
      cancelAnimationFrame(raf)
      raf = 0
    }
    const sync = () => {
      const run = visible && !document.hidden && !rm.matches
      if (run && !raf) {
        last = 0
        raf = requestAnimationFrame(frame)
      } else if (!run && raf) stop()
      if (rm.matches) drawStatic()
    }

    const ro = new ResizeObserver(() => {
      if (resize() && rm.matches) drawStatic()
    })
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting
      sync()
    })
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200))
    const cancelIdle = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(
      () => {
        resize()
        sync()
        ro.observe(canvas)
        io.observe(canvas)
        document.addEventListener("visibilitychange", sync)
        rm.addEventListener?.("change", sync)
      },
      { timeout: 1500 },
    )
    return () => {
      cancelIdle(handle)
      stop()
      ro.disconnect()
      io.disconnect()
      document.removeEventListener("visibilitychange", sync)
      rm.removeEventListener?.("change", sync)
    }
  }, [density])

  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <canvas ref={ref} className="absolute inset-0 size-full" style={{ opacity }} />
      {vignette === "hero" ? (
        <>
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_50%_at_50%_40%,var(--background)_25%,transparent_100%)]" />
          <div className="absolute inset-x-0 top-0 h-32 bg-linear-to-b from-background to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-2/5 bg-linear-to-t from-background via-background/80 to-transparent" />
        </>
      ) : (
        <>
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_70%_at_50%_50%,var(--background)_30%,transparent_100%)]" />
          <div className="absolute inset-x-0 top-0 h-1/2 bg-linear-to-b from-background to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-linear-to-t from-background to-transparent" />
        </>
      )}
    </div>
  )
}
