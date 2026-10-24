"use client"

import { Canvas, useFrame } from "@react-three/fiber"
import { useEffect, useMemo, useRef } from "react"
import * as THREE from "three"
import { board } from "@/content/landing"
import type { SceneProps } from "../fx/lazy-scene"
import { rng, smooth } from "../fx/scene"
import { COMMIT_COLORS, accentOf } from "./board-data"


const cardPos = (i: number) => new THREE.Vector3(0.28 * i, 1.25 - 1.25 * i, -0.45 * i)
const slotPos = (card: number, slot: number) =>
  cardPos(card).add(new THREE.Vector3(1.58 - (7 - (slot % 8)) * 0.115, -0.25 + 0.115 * Math.floor(slot / 8), 0.0825))

function fonts() {
  const css = getComputedStyle(document.body)
  const sans = css.getPropertyValue("--font-geist-sans").trim() || "sans-serif"
  const mono = css.getPropertyValue("--font-geist-mono").trim() || "monospace"
  return { sans: `${sans}, sans-serif`, mono: `${mono}, monospace` }
}

function useCardFaces() {
  const faces = useMemo(
    () =>
      board.cards.map((card) => {
        const canvas = document.createElement("canvas")
        canvas.width = 1024
        canvas.height = 256
        const texture = new THREE.CanvasTexture(canvas)
        texture.colorSpace = THREE.SRGBColorSpace
        texture.anisotropy = 4
        let shown = 0
        const draw = (runs: number) => {
          shown = runs
          const g = canvas.getContext("2d")
          if (!g) return
          const f = fonts()
          g.clearRect(0, 0, 1024, 256)
          g.fillStyle = "#0d1117"
          g.fillRect(0, 0, 1024, 256)
          g.strokeStyle = "#30363d"
          g.lineWidth = 4
          g.strokeRect(2, 2, 1020, 252)
          g.fillStyle = accentOf(card.detail)
          g.fillRect(0, 0, 12, 256)
          g.textBaseline = "alphabetic"
          g.fillStyle = "#e6edf3"
          g.font = `600 56px ${f.sans}`
          g.fillText(card.title, 48, 104)
          g.fillStyle = "#9ba3ad"
          g.font = `400 32px ${f.mono}`
          g.fillText(`${card.stage} · ${card.detail}`, 48, 186)
          g.textAlign = "right"
          g.fillStyle = runs > 0 ? "#39d353" : "#4a5260"
          g.font = `500 30px ${f.mono}`
          g.fillText(`${Math.max(0, runs)} runs`, 984, 62)
          g.textAlign = "left"
          texture.needsUpdate = true
        }
        draw(0)
        return { texture, draw, redraw: () => draw(shown) }
      }),
    [],
  )
  useEffect(() => {
    let live = true
    void document.fonts?.ready.then(() => live && faces.forEach((f) => f.redraw()))
    return () => {
      live = false
      faces.forEach((f) => f.texture.dispose())
    }
  }, [faces])
  return faces
}

function Cards({ progressRef }: { progressRef: SceneProps["progressRef"] }) {
  const group = useRef<THREE.Group>(null)
  const cubes = useRef<THREE.InstancedMesh>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const shownRuns = useRef(board.cards.map(() => -1))
  const faces = useCardFaces()

  const cubeGeo = useMemo(() => new THREE.BoxGeometry(0.085, 0.085, 0.085), [])
  const cardGeo = useMemo(() => new THREE.BoxGeometry(3.6, 0.9, 0.08), [])
  const side = useMemo(() => new THREE.MeshStandardMaterial({ color: "#0d1117", roughness: 0.6, metalness: 0.2 }), [])
  const materials = useMemo(
    () => faces.map((f) => [side, side, side, side, new THREE.MeshStandardMaterial({ map: f.texture, roughness: 0.55, metalness: 0.05 }), side]),
    [faces, side],
  )
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), c: new THREE.Color(), e: new THREE.Euler() }), [])

  const flights = useMemo(() => {
    const rand = rng(7)
    const list: { card: number; from: THREE.Vector3; to: THREE.Vector3; ctrl: THREE.Vector3; start: number; level: number }[] = []
    board.cards.forEach((card, ci) => {
      for (let slot = 0; slot < card.runs; slot++) {
        const from = new THREE.Vector3(-2.7 + 1.5 * rand(), 1.7 + 0.9 * rand(), 0.6 + 0.8 * rand())
        const to = slotPos(ci, slot)
        const ctrl = new THREE.Vector3((from.x + to.x) / 2, Math.max(from.y, to.y) + 0.8, 1.4)
        list.push({ card: ci, from, to, ctrl, start: 0, level: 2 + Math.floor(3 * rand()) })
      }
    })
    list
      .map((_, i) => i)
      .sort(() => rand() - 0.5)
      .forEach((idx, k) => (list[idx]!.start = 0.15 + (k / list.length) * 0.55))
    return list
  }, [])

  useEffect(() => {
    const mesh = cubes.current
    if (!mesh) return
    flights.forEach((f, i) => mesh.setColorAt(i, tmp.c.set(COMMIT_COLORS[f.level]!)))
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [flights, tmp])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener("pointermove", onMove, { passive: true })
    return () => window.removeEventListener("pointermove", onMove)
  }, [])

  useEffect(
    () => () => {
      cubeGeo.dispose()
      cardGeo.dispose()
      side.dispose()
      materials.forEach((m) => m[4]!.dispose())
    },
    [cubeGeo, cardGeo, side, materials],
  )

  useFrame((state, dt) => {
    const g = group.current
    const mesh = cubes.current
    if (!g || !mesh) return
    const t = state.clock.elapsedTime
    const p = progressRef.current ?? 0
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, -0.42 + (p - 0.5) * 0.35 + 0.18 * pointer.current.x, 3, dt)
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, -0.08 + 0.07 * pointer.current.y, 3, dt)
    const landed = board.cards.map(() => 0)
    flights.forEach((f, i) => {
      const u = smooth(f.start, f.start + 0.1, p)
      if (u >= 1) landed[f.card]!++
      const n = 1 - u
      const bob = n * Math.sin(1.3 * t + i) * 0.06
      tmp.p.set(
        n * n * f.from.x + 2 * n * u * f.ctrl.x + u * u * f.to.x,
        n * n * f.from.y + 2 * n * u * f.ctrl.y + u * u * f.to.y + bob,
        n * n * f.from.z + 2 * n * u * f.ctrl.z + u * u * f.to.z,
      )
      tmp.q.setFromEuler(tmp.e.set(n * (t + i) * 0.8, n * (1.2 * t + i), 0))
      tmp.s.setScalar(1)
      mesh.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.s))
    })
    mesh.instanceMatrix.needsUpdate = true
    landed.forEach((n, i) => {
      if (n !== shownRuns.current[i]) {
        shownRuns.current[i] = n
        faces[i]!.draw(n)
      }
    })
  })

  return (
    <group ref={group} position={[0, -0.35, 0]}>
      {board.cards.map((card, i) => (
        <mesh key={card.title} geometry={cardGeo} material={materials[i]} position={cardPos(i)} />
      ))}
      <instancedMesh ref={cubes} args={[cubeGeo, undefined, flights.length]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.35} metalness={0.1} emissive={COMMIT_COLORS[3]} emissiveIntensity={0.25} />
      </instancedMesh>
    </group>
  )
}

export default function BoardScene({ progressRef, active, onReady }: SceneProps) {
  return (
    <Canvas
      aria-hidden="true"
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.2, 10.5], fov: 30 }}
      style={{ pointerEvents: "none" }}
      onCreated={({ gl }) => {
        gl.setClearColor(0, 0)
        requestAnimationFrame(onReady)
      }}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 4, 6]} intensity={1.3} />
      <pointLight position={[2.5, 1, 2.5]} color={COMMIT_COLORS[4]} intensity={6} distance={8} />
      <Cards progressRef={progressRef} />
    </Canvas>
  )
}
