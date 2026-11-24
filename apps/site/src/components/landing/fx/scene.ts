// Helpers shared by every animated section: the 3D capability gate, a seeded RNG and smoothstep.

let webglCache: boolean | undefined

/** False with reduced motion, on weak mobile devices, and without WebGL. */
export function canRender3D(): boolean {
  if (typeof window === "undefined") return false
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false
  const coarse = window.matchMedia("(pointer: coarse)").matches
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  const cores = navigator.hardwareConcurrency ?? 8
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  if ((coarse || mobileUA) && (cores <= 4 || mem <= 2)) return false
  webglCache ??= (() => {
    try {
      const c = document.createElement("canvas")
      const gl = c.getContext("webgl2") ?? c.getContext("webgl")
      gl?.getExtension("WEBGL_lose_context")?.loseContext()
      return !!gl
    } catch {
      return false
    }
  })()
  return webglCache
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** mulberry32: deterministic, so server and client draw the same "random" data. */
export const rng = (seed: number) => {
  let t = seed >>> 0
  return () => {
    let e = (t = (t + 0x6d2b79f5) >>> 0)
    e = Math.imul(e ^ (e >>> 15), 1 | e)
    e ^= e + Math.imul(e ^ (e >>> 7), 61 | e)
    return ((e ^ (e >>> 14)) >>> 0) / 4294967296
  }
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const
