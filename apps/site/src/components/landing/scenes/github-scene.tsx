"use client"

import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from "react"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js"
import type { SceneProps } from "../fx/lazy-scene"
import { rng, smooth } from "../fx/scene"
import { COMMIT_COLORS, CONTRIBUTIONS, DAYS, GITHUB_MARK_PATH, WEEKS } from "./github-data"

type Progress = { progressRef: RefObject<number> }

const BAR_HEIGHTS = [0.04, 0.22, 0.45, 0.72, 1.05]
const LOGO_CENTRE = new THREE.Vector3(0, 1.15, 0)
const cellPosition = (w: number, d: number) => new THREE.Vector3((w - (WEEKS - 1) / 2) * 0.235, 0, (d - (DAYS - 1) / 2) * 0.235)

function DisposeEnvironment() {
  const get = useThree((s) => s.get)
  useEffect(() => () => get().scene.environment?.dispose(), [get])
  return null
}

/** Tilts everything with scroll progress and the pointer. */
function Parallax({ progressRef, children }: Progress & { children: ReactNode }) {
  const group = useRef<THREE.Group>(null)
  const pointer = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener("pointermove", onMove, { passive: true })
    return () => window.removeEventListener("pointermove", onMove)
  }, [])
  useFrame((_, delta) => {
    const g = group.current
    if (!g) return
    const p = progressRef.current ?? 0
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, (p - 0.5) * 0.5 + 0.22 * pointer.current.x, 3, delta)
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, 0.08 * pointer.current.y, 3, delta)
  })
  return <group ref={group}>{children}</group>
}

function Logo({ progressRef }: Progress) {
  const group = useRef<THREE.Group>(null)
  const geometry = useMemo(() => {
    const shapes = new SVGLoader()
      .parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${GITHUB_MARK_PATH}"/></svg>`)
      .paths.flatMap((p) => SVGLoader.createShapes(p))
    const g = new THREE.ExtrudeGeometry(shapes, {
      depth: 1.4,
      bevelEnabled: true,
      bevelThickness: 0.3,
      bevelSize: 0.18,
      bevelSegments: 5,
      curveSegments: 28,
    })
    g.center()
    g.rotateX(Math.PI)
    g.scale(0.105, 0.105, 0.105)
    g.computeVertexNormals()
    return g
  }, [])
  useEffect(() => () => geometry.dispose(), [geometry])
  useFrame(({ clock }) => {
    const g = group.current
    if (!g) return
    const t = clock.elapsedTime
    const p = progressRef.current ?? 0
    const s = smooth(0, 1.4, t)
    g.position.y = 1.15 + 0.07 * Math.sin(1.1 * t) - (1 - s) * 0.5
    g.rotation.y = 0.18 * Math.sin(0.35 * t) + (p - 0.5) * 0.9
    g.scale.setScalar(0.7 + 0.3 * s)
  })
  return (
    <group ref={group}>
      <mesh geometry={geometry}>
        <meshPhysicalMaterial color="#c9d1d9" metalness={0.95} roughness={0.26} clearcoat={0.7} clearcoatRoughness={0.2} />
      </mesh>
    </group>
  )
}

function Bars({ progressRef }: Progress) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const geometry = useMemo(() => new THREE.BoxGeometry(0.185, 1, 0.185).translate(0, 0.5, 0), [])
  const last = useRef(-1)
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), c: new THREE.Color() }), [])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => {
    const m = mesh.current
    if (!m) return
    let i = 0
    for (let w = 0; w < WEEKS; w++) for (let d = 0; d < DAYS; d++) m.setColorAt(i++, tmp.c.set(COMMIT_COLORS[CONTRIBUTIONS[w]![d]!]!))
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }, [tmp])
  useFrame(({ clock }) => {
    const m = mesh.current
    if (!m) return
    const grow = smooth(0.05, 0.55, progressRef.current ?? 0) * smooth(0, 1.2, clock.elapsedTime)
    if (Math.abs(grow - last.current) < 1e-4) return
    last.current = grow
    let i = 0
    for (let w = 0; w < WEEKS; w++) {
      const start = (w / WEEKS) * 0.55
      const r = smooth(start, start + 0.45, grow)
      for (let d = 0; d < DAYS; d++) {
        tmp.s.set(1, Math.max(0.001, BAR_HEIGHTS[CONTRIBUTIONS[w]![d]!]! * r), 1)
        m.setMatrixAt(i++, tmp.m.compose(cellPosition(w, d), tmp.q, tmp.s))
      }
    }
    m.instanceMatrix.needsUpdate = true
  })
  return (
    <group position={[0, -1.25, 0]} rotation={[0, -0.42, 0]}>
      <instancedMesh ref={mesh} args={[geometry, undefined, WEEKS * DAYS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.45} metalness={0.15} />
      </instancedMesh>
    </group>
  )
}

/** Green bits flying from the tallest bars up into the logo. */
function Particles({ progressRef }: Progress) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const geometry = useMemo(() => new THREE.BoxGeometry(0.07, 0.07, 0.07), [])
  useEffect(() => () => geometry.dispose(), [geometry])
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), v: new THREE.Vector3(), p: new THREE.Vector3() }), [])
  const particles = useMemo(() => {
    const rand = rng(42)
    const tall: [number, number][] = []
    CONTRIBUTIONS.forEach((days, w) => days.forEach((lvl, d) => lvl >= 3 && tall.push([w, d])))
    const barsTransform = new THREE.Matrix4().compose(
      new THREE.Vector3(0, -1.25, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.42, 0)),
      new THREE.Vector3(1, 1, 1),
    )
    return Array.from({ length: 34 }, () => {
      const [w, d] = tall[Math.floor(rand() * tall.length)]!
      return {
        from: cellPosition(w, d).setY(BAR_HEIGHTS[CONTRIBUTIONS[w]![d]!]!).applyMatrix4(barsTransform),
        phase: rand(),
        speed: 0.18 + 0.16 * rand(),
        sway: (rand() - 0.5) * 1.2,
      }
    })
  }, [])
  useFrame(({ clock }) => {
    const m = mesh.current
    if (!m) return
    const t = clock.elapsedTime
    const show = smooth(0.3, 0.5, progressRef.current ?? 0)
    particles.forEach((pt, i) => {
      const u = (pt.phase + t * pt.speed) % 1
      const ctrl = tmp.v.set(0.4 * pt.from.x + pt.sway, 0.95, 0.4 * pt.from.z)
      const k = 1 - u
      tmp.p.set(
        k * k * pt.from.x + 2 * k * u * ctrl.x + u * u * LOGO_CENTRE.x,
        k * k * pt.from.y + 2 * k * u * ctrl.y + u * u * LOGO_CENTRE.y,
        k * k * pt.from.z + 2 * k * u * ctrl.z + u * u * LOGO_CENTRE.z,
      )
      tmp.s.setScalar(Math.max(0.001, show * Math.sin(Math.PI * u)))
      m.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.s))
    })
    m.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, particles.length]} frustumCulled={false}>
      <meshBasicMaterial color={COMMIT_COLORS[4]} toneMapped={false} />
    </instancedMesh>
  )
}

export default function GitHubScene({ progressRef, active, onReady }: SceneProps) {
  return (
    <Canvas
      aria-hidden="true"
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 2.6, 11.6], fov: 30 }}
      style={{ pointerEvents: "none" }}
      onCreated={({ gl, camera, scene }) => {
        gl.setClearColor(0, 0)
        gl.toneMapping = THREE.ACESFilmicToneMapping
        camera.lookAt(0, 0.35, 0)
        const pmrem = new THREE.PMREMGenerator(gl)
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
        scene.environmentIntensity = 0.55
        pmrem.dispose()
        requestAnimationFrame(onReady)
      }}
    >
      <DisposeEnvironment />
      <ambientLight intensity={0.2} />
      <directionalLight position={[4, 6, 5]} intensity={1.6} />
      <pointLight position={[0, 1.2, -2.2]} color={COMMIT_COLORS[4]} intensity={26} distance={8} decay={1.6} />
      <pointLight position={[-3, -0.5, 2]} color={COMMIT_COLORS[3]} intensity={6} distance={7} />
      <Parallax progressRef={progressRef}>
        <Logo progressRef={progressRef} />
        <Bars progressRef={progressRef} />
        <Particles progressRef={progressRef} />
      </Parallax>
    </Canvas>
  )
}
