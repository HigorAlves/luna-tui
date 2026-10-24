"use client"

import { type ComponentType, type ReactNode, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { cn } from "cn"
import { canRender3D } from "./scene"
import { ScrollTrigger, useGSAP } from "./gsap"

const noopSubscribe = () => () => {}

export type SceneProps = {
  /** Scroll progress of the container through the viewport, 0..1. */
  progressRef: RefObject<number>
  /** False while the container is off screen; scenes should stop their frame loop. */
  active: boolean
  /** Call once the first frame is drawn, to cross-fade from the fallback. */
  onReady: () => void
}

/** Mounts a 3D scene only when it can render and the container is near the viewport. */
export function useLazyScene(load: () => Promise<unknown>) {
  const visual = useRef<HTMLDivElement>(null)
  const progressRef = useRef(0)
  const can = useSyncExternalStore(noopSubscribe, canRender3D, () => false)
  const [near, setNear] = useState(false)
  const [active, setActive] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!can) return
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(() => void load())
    const el = visual.current
    if (!el) return () => cancel(handle)
    const nearIo = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), { rootMargin: "100% 0px" })
    const visIo = new IntersectionObserver(([e]) => setActive(!!e?.isIntersecting), { rootMargin: "10% 0px" })
    nearIo.observe(el)
    visIo.observe(el)
    return () => {
      cancel(handle)
      nearIo.disconnect()
      visIo.disconnect()
    }
  }, [can, load])

  useGSAP(
    () => {
      if (!can || !visual.current) return
      const st = ScrollTrigger.create({
        trigger: visual.current,
        start: "top bottom",
        end: "bottom top",
        onUpdate: (s) => {
          progressRef.current = s.progress
        },
      })
      progressRef.current = st.progress
      return () => st.kill()
    },
    { dependencies: [can] },
  )

  return { visual, progressRef, mount: can && near, active, ready, onReady: () => setReady(true) }
}

/** The container every 3D section uses: static fallback first, cross-fade to the scene when ready. */
export function SceneSlot({
  load,
  Scene,
  fallback,
  className,
}: {
  load: () => Promise<unknown>
  Scene: ComponentType<SceneProps>
  fallback: ReactNode
  className?: string
}) {
  const { visual, progressRef, mount, active, ready, onReady } = useLazyScene(load)
  return (
    <div ref={visual} data-scene="true" className={cn("relative min-w-0", className)}>
      <div aria-hidden="true" className={cn("absolute inset-0 transition-opacity duration-700", ready && "opacity-0")}>
        {fallback}
      </div>
      {mount && (
        <div aria-hidden="true" className={cn("absolute inset-0 opacity-0 transition-opacity duration-700", ready && "opacity-100")}>
          <Scene progressRef={progressRef} active={active} onReady={onReady} />
        </div>
      )}
    </div>
  )
}
