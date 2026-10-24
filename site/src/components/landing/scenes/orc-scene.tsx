"use client"

import { Canvas, useFrame } from "@react-three/fiber"
import { type RefObject, useEffect, useMemo, useRef } from "react"
import * as THREE from "three"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"
import type { SceneProps } from "../fx/lazy-scene"
import { rng, smooth } from "../fx/scene"
import { ARM_LEFT, ARM_RIGHT, BODY, BROWS, EARS, EYES, LEGS, ORC, type Cell } from "./orc-data"

const U = 0.26
const BRAND = "#39d353"

/** Seconds since the last button press (Infinity before the first). */
const sincePoke = (poke: RefObject<number>) => (poke.current ? (performance.now() - poke.current) / 1000 : Infinity)

function usePointer() {
  const p = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      p.current.x = (e.clientX / window.innerWidth) * 2 - 1
      p.current.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener("pointermove", onMove, { passive: true })
    return () => window.removeEventListener("pointermove", onMove)
  }, [])
  return p
}

/** One rounded box over the bounding box of `cells`, positioned on the 11×8 grid. */
function Voxels({ cells, depth, radius, material, origin = [0, 0] }: { cells: Cell[]; depth: number; radius: number; material: THREE.Material; origin?: [number, number] }) {
  const { geometry, position } = useMemo(() => {
    const xs = cells.map(([x]) => x)
    const ys = cells.map(([, y]) => y)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    return {
      geometry: new RoundedBoxGeometry((x1 - x0 + 1) * U, (y1 - y0 + 1) * U, depth * U, 4, radius),
      position: [((x0 + x1) / 2 - 5) * U - origin[0], (3.5 - (y0 + y1) / 2) * U - origin[1], 0] as [number, number, number],
    }
  }, [cells, depth, radius, origin])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh geometry={geometry} material={material} position={position} />
}

const armL: [number, number] = [-1.17, 0.26]
const armR: [number, number] = [1.17, 0.26]
const legPivots = LEGS.map(([[x]]) => [(x - 5) * U, -0.52] as [number, number])

function Turntable({ progressRef, children }: { progressRef: SceneProps["progressRef"]; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (g.current) g.current.rotation.y = THREE.MathUtils.damp(g.current.rotation.y, ((progressRef.current ?? 0) - 0.5) * 0.35, 3, dt)
  })
  return <group ref={g}>{children}</group>
}

function Orc({ poke }: { poke: RefObject<number> }) {
  const root = useRef<THREE.Group>(null)
  const body = useRef<THREE.Group>(null)
  const left = useRef<THREE.Group>(null)
  const right = useRef<THREE.Group>(null)
  const legs = useRef<(THREE.Group | null)[]>([])
  const eyesIdle = useRef<THREE.Group>(null)
  const eyesHappy = useRef<THREE.Group>(null)
  const pointer = usePointer()

  const skin = useMemo(() => new THREE.MeshPhysicalMaterial({ color: ORC.skin, roughness: 0.55, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.4 }), [])
  const shade = useMemo(() => new THREE.MeshPhysicalMaterial({ color: ORC.shade, roughness: 0.6, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5 }), [])
  const dark = useMemo(() => new THREE.MeshStandardMaterial({ color: ORC.eyes, roughness: 0.35 }), [])
  const tusk = useMemo(() => new THREE.MeshPhysicalMaterial({ color: ORC.tusk, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2 }), [])
  // The ear tapers: a thick base against the head and a thinner, shorter tip.
  const earBase = useMemo(() => new RoundedBoxGeometry(0.3, 0.26, 0.28, 4, 0.06), [])
  const earTip = useMemo(() => new RoundedBoxGeometry(0.22, 0.14, 0.18, 4, 0.05), [])
  useEffect(
    () => () => {
      skin.dispose()
      shade.dispose()
      dark.dispose()
      tusk.dispose()
      earBase.dispose()
      earTip.dispose()
    },
    [skin, shade, dark, tusk, earBase, earTip],
  )

  useFrame((state, dt) => {
    const r = root.current
    const b = body.current
    if (!r || !b) return
    const t = state.clock.elapsedTime
    const f = t % 7
    const since = sincePoke(poke)
    const wave = Math.max(smooth(2.9, 3.1, f) * (1 - smooth(5.2, 5.5, f)), since < 1.6 ? 1 : 0)
    const intro = smooth(0, 0.9, t)
    const pk = since < 0.9 ? since / 0.9 : 1
    const pokeJump = 0.75 * Math.sin(Math.PI * pk)
    const hop = f > 2.75 && f < 3.25 ? 0.22 * Math.sin(((f - 2.75) / 0.5) * Math.PI) : 0
    r.position.y = 0.03 * Math.sin(2.2 * t) + pokeJump + hop + (1 - intro) * 1.4
    const S = 1 - (f < 2.6 ? Math.sin(15 * f) ** 2 * 0.045 : 0) - smooth(2.3, 2.6, f) * (1 - smooth(2.75, 3, f)) * 0.12
    b.scale.set(1 + (1 - S) * 0.6, S, 1 + (1 - S) * 0.6)
    const spin = pk < 1 ? (1 - (1 - pk) ** 3) * Math.PI * 2 : 0
    r.rotation.y = THREE.MathUtils.damp(r.rotation.y - ((r.userData.spin as number | undefined) ?? 0), 0.55 * pointer.current.x, 4, dt) + spin
    r.userData.spin = spin
    r.rotation.x = THREE.MathUtils.damp(r.rotation.x, 0.18 * pointer.current.y, 4, dt)
    const flap = 0.7 * Math.abs(Math.sin(9 * t))
    if (left.current) left.current.rotation.z = -(0.06 * Math.sin(1.6 * t) + wave * (0.35 + flap))
    if (right.current) right.current.rotation.z = 0.06 * Math.sin(1.6 * t + 1) + wave * (0.35 + flap)
    legs.current.forEach((leg, i) => {
      if (leg) leg.rotation.x = 0.35 * Math.sin(13 * t + (i % 2) * Math.PI) * wave
    })
    if (eyesIdle.current) {
      eyesIdle.current.visible = wave < 0.5
      eyesIdle.current.scale.y = t % 3.7 < 0.12 ? 0.12 : 1
    }
    if (eyesHappy.current) eyesHappy.current.visible = wave >= 0.5
  })

  const face = 0.532
  const at = (x: number, y: number): [number, number, number] => [(x - 5.5) * U, (4 - y) * U, 0]

  return (
    <group ref={root}>
      <group ref={body}>
        <Voxels cells={BODY} depth={4} radius={0.12} material={skin} />
        {EARS.map((ear) => (
          <group key={ear.x} position={[ear.x, ear.y, 0]} rotation={[0, 0, ear.tilt]}>
            <mesh geometry={earBase} material={shade} />
            <mesh geometry={earTip} material={shade} position={[Math.sign(ear.x) * 0.22, 0, 0]} />
          </group>
        ))}
        {/* brow ridge, eyes, mouth and tusks sit on the front face */}
        <group position={[0, 0, face]}>
          {BROWS.map((b, i) => (
            <mesh key={i} position={at(b.x, b.y)} rotation={[0, 0, b.tilt]} material={dark}>
              <boxGeometry args={[0.36, 0.08, 0.06]} />
            </mesh>
          ))}
          <mesh position={at(5.5, 4.35)} material={dark}>
            <boxGeometry args={[1.25, 0.07, 0.05]} />
          </mesh>
          {[3.75, 7.25].map((x) => (
            <mesh key={x} position={[(x - 5.5) * U, (4 - 4.05) * U, 0.02]} material={tusk}>
              <boxGeometry args={[0.11, 0.24, 0.1]} />
            </mesh>
          ))}
        </group>
        <group ref={eyesIdle} position={[0, 0, face]}>
          {EYES.map((e, i) => (
            <mesh key={i} position={at(e.x, e.y)} material={dark}>
              <boxGeometry args={[0.1456, 0.26, 0.06]} />
            </mesh>
          ))}
        </group>
        <group ref={eyesHappy} position={[0, 0, face]} visible={false}>
          {EYES.map((e, i) => {
            const s = i === 0 ? 1 : -1
            return (
              <group key={i} position={at(e.x, e.y)}>
                <mesh position={[0, 0.0715, 0]} rotation={[0, 0, -0.6 * s]} material={dark}>
                  <boxGeometry args={[0.273, 0.104, 0.06]} />
                </mesh>
                <mesh position={[0, -0.0715, 0]} rotation={[0, 0, 0.6 * s]} material={dark}>
                  <boxGeometry args={[0.273, 0.104, 0.06]} />
                </mesh>
              </group>
            )
          })}
        </group>
        <group ref={left} position={[armL[0], armL[1], 0]}>
          <Voxels cells={ARM_LEFT} depth={2} radius={0.07} material={skin} origin={armL} />
        </group>
        <group ref={right} position={[armR[0], armR[1], 0]}>
          <Voxels cells={ARM_RIGHT} depth={2} radius={0.07} material={skin} origin={armR} />
        </group>
      </group>
      {LEGS.map((leg, i) => (
        <group
          key={i}
          ref={(el) => {
            legs.current[i] = el
          }}
          position={[legPivots[i]![0], legPivots[i]![1], 0]}
        >
          <Voxels cells={leg} depth={2} radius={0.07} material={shade} origin={legPivots[i]} />
        </group>
      ))}
    </group>
  )
}

function Shadow({ poke }: { poke: RefObject<number> }) {
  const mesh = useRef<THREE.Mesh>(null)
  const texture = useMemo(() => {
    const c = document.createElement("canvas")
    c.width = c.height = 128
    const g = c.getContext("2d")!
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0, "rgba(0,0,0,0.55)")
    grad.addColorStop(1, "rgba(0,0,0,0)")
    g.fillStyle = grad
    g.fillRect(0, 0, 128, 128)
    return new THREE.CanvasTexture(c)
  }, [])
  useEffect(() => () => texture.dispose(), [texture])
  useFrame(() => {
    if (!mesh.current) return
    const s = sincePoke(poke)
    mesh.current.scale.setScalar(1 - 0.4 * (s < 0.9 ? Math.sin((s / 0.9) * Math.PI) : 0))
  })
  return (
    <mesh ref={mesh} position={[0, -1.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[3.6, 1.8]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  )
}

const target = new THREE.Vector3(0, 0.15, 0.4)

/** Commit cubes flying into the orc on a 7 s loop. */
function Confetti() {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const geometry = useMemo(() => new THREE.BoxGeometry(0.1, 0.1, 0.1), [])
  useEffect(() => () => geometry.dispose(), [geometry])
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), e: new THREE.Euler() }), [])
  const bits = useMemo(() => {
    const rand = rng(7)
    return Array.from({ length: 18 }, (_, i) => {
      const a = rand() * Math.PI * 2
      return { from: new THREE.Vector3(2.6 * Math.cos(a), 1.5 * Math.sin(a) + 0.3, (rand() - 0.5) * 2), delay: (i / 18) * 1.8, spin: 6 * rand() }
    })
  }, [])
  useFrame((state) => {
    const m = mesh.current
    if (!m) return
    const f = state.clock.elapsedTime % 7
    bits.forEach((b, i) => {
      const n = Math.min(1, Math.max(0, (f - b.delay) / 0.75))
      tmp.p.lerpVectors(b.from, target, n * n)
      tmp.p.y += 0.5 * Math.sin(Math.PI * n)
      tmp.s.setScalar(n > 0 && n < 1 ? Math.min(1, (1 - n) * 4) : 1e-4)
      tmp.q.setFromEuler(tmp.e.set(b.spin + 3 * f, b.spin + 2 * f, 0))
      m.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.s))
    })
    m.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, 18]} frustumCulled={false}>
      <meshBasicMaterial color={BRAND} toneMapped={false} />
    </instancedMesh>
  )
}

// [width, x, y, colour]: a title, a branch line, body lines and a green "checks passed" bar.
const PR_LINES: [number, number, number, string][] = [
  [0.42, -0.12, 0.36, "#1d1f23"],
  [0.26, -0.2, 0.26, "#9aa0a8"],
  [0.56, -0.05, 0.12, "#c4c8cd"],
  [0.5, -0.08, 0.04, "#c4c8cd"],
  [0.56, -0.05, -0.04, "#c4c8cd"],
  [0.3, -0.18, -0.16, "#26a641"],
  [0.56, -0.05, -0.26, "#c4c8cd"],
  [0.44, -0.11, -0.34, "#c4c8cd"],
]

/** The finished PR the orc tosses up between hops. */
function ThrownPr() {
  const g = useRef<THREE.Group>(null)
  useFrame((state) => {
    const el = g.current
    if (!el) return
    const t = state.clock.elapsedTime
    const n = ((t % 7) - 3) / 3.4
    const on = n > 0 && n < 1
    const a = on ? smooth(0, 0.22, n) : 0
    const o = on ? smooth(0.82, 1, n) : 0
    el.visible = on
    el.position.set(0.15, 0.55 + 1.2 * a + 0.4 * o, 0.2)
    el.scale.setScalar(Math.max(1e-4, a * (1 - o)))
    el.rotation.set(-0.08, 0.35 * Math.sin(1.3 * t), 0.06 * Math.sin(1.7 * t))
  })
  return (
    <group ref={g} visible={false}>
      <mesh>
        <boxGeometry args={[0.78, 0.96, 0.025]} />
        <meshStandardMaterial color="#f4f4f5" roughness={0.8} />
      </mesh>
      {PR_LINES.map(([w, x, y, color], i) => (
        <mesh key={i} position={[x, y, 0.015]}>
          <boxGeometry args={[w, i === 0 ? 0.06 : 0.035, 0.005]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  )
}

export default function OrcScene({ progressRef, active, onReady, poke }: SceneProps & { poke: RefObject<number> }) {
  return (
    <Canvas
      aria-hidden="true"
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.55, 8.4], fov: 30 }}
      style={{ pointerEvents: "none" }}
      onCreated={({ gl, camera }) => {
        gl.setClearColor(0, 0)
        gl.toneMapping = THREE.ACESFilmicToneMapping
        camera.lookAt(0, 0.3, 0)
        requestAnimationFrame(onReady)
      }}
    >
      <ambientLight intensity={0.75} />
      <directionalLight position={[3, 5, 6]} intensity={2.2} />
      <directionalLight position={[-4, 2, 3]} intensity={0.5} color="#e4ffd6" />
      <pointLight position={[0, 1, -2.4]} color={BRAND} intensity={20} distance={7} decay={1.6} />
      <Turntable progressRef={progressRef}>
        <Shadow poke={poke} />
        <Orc poke={poke} />
        <Confetti />
        <ThrownPr />
      </Turntable>
    </Canvas>
  )
}
