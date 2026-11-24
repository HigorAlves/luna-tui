"use client"

// The PR sheet in 3D: it turns to face you as the pinned section scrolls, the slice lines get
// their highlights, the commit chips fly into their slots, and the checks light up.
import { Canvas, useFrame } from "@react-three/fiber"
import { type RefObject, useEffect, useMemo, useRef } from "react"
import * as THREE from "three"
import { how } from "@/content/landing"
import type { SceneProps } from "../fx/lazy-scene"
import {
  BAR,
  BULLETS,
  CHECKS_SCORE,
  COLORS,
  type Fonts,
  HIGHLIGHTS,
  PILLS,
  type Rect,
  SHEET,
  drawHashChip,
  drawLitPill,
  drawPrSheet,
  readFonts,
} from "../how/sheet"

const W = 3.1
const H = (W * SHEET.h) / SHEET.w

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const easeInOutCubic = (e: number) => (e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2)

/** Sheet pixels → scene units, centred on the sheet. */
const toScene = (r: Rect) => ({
  x: ((r.x + r.w / 2) / SHEET.w - 0.5) * W,
  y: (0.5 - (r.y + r.h / 2) / SHEET.h) * H,
  w: (r.w / SHEET.w) * W,
  h: (r.h / SHEET.h) * H,
})

type State = { p: number; t: number; intro: number }
type Draw = (ctx: CanvasRenderingContext2D, fonts: Fonts) => void

function createTexture(w: number, h: number) {
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

function paint(texture: THREE.CanvasTexture, draw: Draw) {
  const canvas = texture.image as HTMLCanvasElement
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  draw(ctx, readFonts())
  texture.needsUpdate = true
}

/** Paints now, again once the web fonts load, and disposes on unmount. */
function paintWhenFontsReady(texture: THREE.CanvasTexture, draw: Draw) {
  paint(texture, draw)
  const state = { alive: true }
  document.fonts?.ready.then(() => state.alive && paint(texture, draw)).catch(() => {})
  return () => {
    state.alive = false
    texture.dispose()
  }
}

function useCanvasTexture(w: number, h: number, draw: Draw) {
  const texture = useMemo(() => createTexture(w, h), [w, h])
  const drawRef = useRef(draw)
  useEffect(() => {
    drawRef.current = draw
  })
  useEffect(() => paintWhenFontsReady(texture, (ctx, fonts) => drawRef.current(ctx, fonts)), [texture])
  return texture
}

function HashChip({ hash, index, target, state }: { hash: string; index: number; target: ReturnType<typeof toScene>; state: RefObject<State> }) {
  const mesh = useRef<THREE.Mesh>(null)
  const map = useCanvasTexture(392, 88, (ctx, fonts) => drawHashChip(ctx, hash, 392, 88, fonts))
  const side = index % 2 === 0 ? -1 : 1
  const startRot = useMemo(() => new THREE.Euler(-0.4 * side, 0.6 * side, 0.25 * (index - 2)), [index, side])
  const end = useMemo(() => new THREE.Vector3(target.x, target.y, 0.019), [target])

  useFrame(({ viewport }) => {
    const m = mesh.current
    if (!m) return
    const { p, t } = state.current
    const startX = side * Math.max(Math.min(2.3 + (index % 3) * 0.35, viewport.width / 2 - 0.55), 1.75)
    const startY = 1.6 - 0.75 * index
    const land = easeInOutCubic(smooth(0.6 + 0.05 * index, 0.8 + 0.05 * index, p))
    const grow = smooth(0, 0.12, p)
    const bob = (1 - land) * Math.sin(1.3 * t + index) * 0.08
    m.position.set(
      THREE.MathUtils.lerp(startX, end.x, land),
      THREE.MathUtils.lerp(startY + bob, end.y, land),
      THREE.MathUtils.lerp(0.8 + (index % 3) * 0.5, end.z, land),
    )
    m.rotation.set(THREE.MathUtils.lerp(startRot.x, 0, land), THREE.MathUtils.lerp(startRot.y, 0, land), THREE.MathUtils.lerp(startRot.z, 0, land))
    m.scale.setScalar(Math.max(1e-4, grow * (1 + (1 - land) * 0.25)))
  })

  return (
    <mesh ref={mesh}>
      <planeGeometry args={[target.w, target.h]} />
      <meshBasicMaterial map={map} toneMapped={false} transparent side={THREE.DoubleSide} />
    </mesh>
  )
}

/** A bar that grows left to right as `range(p)` goes 0 → 1. */
function Grow({ rect, range, color, opacity = 1, state }: { rect: Rect; range: (p: number) => number; color: string; opacity?: number; state: RefObject<State> }) {
  const mesh = useRef<THREE.Mesh>(null)
  const r = useMemo(() => toScene(rect), [rect])
  const left = r.x - r.w / 2
  useFrame(() => {
    const m = mesh.current
    if (!m) return
    const s = range(state.current.p)
    m.scale.x = Math.max(1e-4, s)
    m.position.x = left + (r.w * s) / 2
  })
  return (
    <mesh ref={mesh} position={[left, r.y, 0.017]}>
      <planeGeometry args={[r.w, r.h]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} depthWrite={false} />
    </mesh>
  )
}

/** A check pill that lights up green in turn, after the chips start landing. */
function LitPill({ rect, index, state }: { rect: (typeof PILLS)[number]; index: number; state: RefObject<State> }) {
  const material = useRef<THREE.MeshBasicMaterial>(null)
  const r = useMemo(() => toScene(rect), [rect])
  const map = useCanvasTexture(rect.w * 4, rect.h * 4, (ctx, fonts) => drawLitPill(ctx, rect.label, rect.w * 4, rect.h * 4, fonts))
  useFrame(() => {
    if (material.current) material.current.opacity = smooth(0.62 + 0.04 * index, 0.72 + 0.04 * index, state.current.p)
  })
  return (
    <mesh position={[r.x, r.y, 0.018]}>
      <planeGeometry args={[r.w, r.h]} />
      <meshBasicMaterial ref={material} map={map} transparent opacity={0} toneMapped={false} depthWrite={false} />
    </mesh>
  )
}

const barRange = (p: number) => clamp01((p - 0.3) / 0.6) * (CHECKS_SCORE / 100)

function Sheet({ progressRef }: { progressRef: RefObject<number> }) {
  const group = useRef<THREE.Group>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const state = useRef<State>({ p: 0, t: 0, intro: 0 })
  const face = useCanvasTexture(SHEET.w, SHEET.h, (ctx, fonts) => drawPrSheet(ctx, fonts, false))
  const materials = useMemo(() => {
    const edge = new THREE.MeshBasicMaterial({ color: COLORS.light, toneMapped: false })
    const back = new THREE.MeshBasicMaterial({ color: "#17181b", toneMapped: false })
    return [edge, edge, edge, edge, new THREE.MeshBasicMaterial({ map: face, toneMapped: false }), back]
  }, [face])
  useEffect(() => () => new Set(materials).forEach((m) => m.dispose()), [materials])
  const slots = useMemo(() => BULLETS.map((b) => toScene(b.slot)), [])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener("pointermove", onMove, { passive: true })
    return () => window.removeEventListener("pointermove", onMove)
  }, [])

  useFrame((frame, dt) => {
    const g = group.current
    if (!g) return
    const s = state.current
    s.t = frame.clock.elapsedTime
    s.p = THREE.MathUtils.damp(s.p, clamp01(progressRef.current), 6, dt)
    s.intro = Math.min(1, s.intro + dt / 1.2)
    const u = easeInOutCubic(smooth(0, 0.85, s.p))
    const rotY = THREE.MathUtils.lerp(-0.9, 0.12, u) + 0.35 * Math.sin(s.p * Math.PI)
    const rotX = THREE.MathUtils.lerp(-0.45, -0.06, u)
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, rotY + 0.12 * pointer.current.x, 4, dt)
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, rotX + 0.08 * pointer.current.y, 4, dt)
    g.rotation.z = THREE.MathUtils.lerp(0.14, -0.02, u)
    g.position.y = 0.05 * Math.sin(0.6 * s.t) * (1 - u)
    g.scale.setScalar(0.92 + 0.08 * easeInOutCubic(s.intro))
  })

  return (
    <group ref={group}>
      <mesh position={[0.18, -0.24, -0.3]}>
        <planeGeometry args={[W * 1.02, 1.02 * H]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <mesh material={materials}>
        <boxGeometry args={[W, H, 0.03]} />
      </mesh>
      {HIGHLIGHTS.map((h, i) => (
        <Grow key={i} rect={h} range={(p) => smooth(0.36 + 0.05 * i, 0.5 + 0.05 * i, p)} color={COLORS.brand} opacity={0.6} state={state} />
      ))}
      {PILLS.map((pill, i) => (
        <LitPill key={pill.label} rect={pill} index={i} state={state} />
      ))}
      <Grow rect={BAR} range={barRange} color={COLORS.bar} state={state} />
      {how.paper.commits.map((hash, i) => (
        <HashChip key={hash} hash={hash} index={i} target={slots[i]!} state={state} />
      ))}
    </group>
  )
}

export default function PrScene({ progressRef, active, onReady }: SceneProps) {
  return (
    <Canvas
      aria-hidden="true"
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 11], fov: 30 }}
      style={{ pointerEvents: "none" }}
      onCreated={({ gl }) => {
        gl.setClearColor(0, 0)
        requestAnimationFrame(onReady)
      }}
    >
      <Sheet progressRef={progressRef} />
    </Canvas>
  )
}
