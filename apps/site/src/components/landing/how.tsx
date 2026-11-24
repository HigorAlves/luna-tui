"use client"

import { FlaskConicalIcon, ListChecksIcon, RocketIcon } from "lucide-react"
import dynamic from "next/dynamic"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { cn } from "cn"
import { how } from "@/content/landing"
import { gsap, ScrollTrigger, useGSAP } from "./fx/gsap"
import { canRender3D } from "./fx/scene"
import { PrSheet } from "./how/pr-sheet"
import { CHECKS_SCORE, STEP_LABEL } from "./how/sheet"

const loadScene = () => import("./scenes/pr-scene")
const PrScene = dynamic(loadScene, { ssr: false })

const icons = [ListChecksIcon, FlaskConicalIcon, RocketIcon]
const DESKTOP = "(min-width: 1024px) and (prefers-reduced-motion: no-preference)"
const noopSubscribe = () => () => {}

function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query)
      mq.addEventListener?.("change", onChange)
      return () => mq.removeEventListener?.("change", onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

export function How() {
  const section = useRef<HTMLElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const visual = useRef<HTMLDivElement>(null)
  const stepNum = useRef<HTMLSpanElement>(null)
  const meter = useRef<HTMLSpanElement>(null)
  const progressRef = useRef(0)
  const desktop = useMediaQuery(DESKTOP)
  const can = useSyncExternalStore(noopSubscribe, canRender3D, () => false)
  const use3D = desktop && can
  const [near, setNear] = useState(false)
  const [active, setActive] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!use3D) return
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(() => void loadScene())
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
  }, [use3D])

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-reveal]", {
          opacity: 0,
          y: 24,
          duration: 0.8,
          ease: "power3.out",
          stagger: 0.12,
          scrollTrigger: { trigger: section.current, start: "top 75%", once: true },
        })
      })

      mm.add("(max-width: 1023.98px) and (prefers-reduced-motion: no-preference)", () => {
        const tl = gsap.timeline({ scrollTrigger: { trigger: "[data-steps]", start: "top 70%", end: "bottom 60%", scrub: 0.6 } })
        how.steps.forEach((_, i) => {
          tl.fromTo(`[data-node-lit="${i}"]`, { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.15 })
          if (i < how.steps.length - 1) tl.fromTo(`[data-rail-fill="${i}"]`, { scaleY: 0 }, { scaleY: 1, ease: "none", duration: 0.5 })
        })
      })

      mm.add(DESKTOP, () => {
        const steps = gsap.utils.toArray<HTMLElement>("[data-step]")
        const n = steps.length
        let current = -1
        const setStep = (i: number) => {
          if (i === current) return
          current = i
          steps.forEach((el, j) => (j === i ? el.setAttribute("aria-current", "step") : el.removeAttribute("aria-current")))
          if (stepNum.current) stepNum.current.textContent = String(i + 1).padStart(2, "0")
        }
        const tl = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: grid.current,
            start: () => `top top+=${document.querySelector<HTMLElement>("body > header, header")?.offsetHeight ?? 64}`,
            end: () => `+=${2.2 * window.innerHeight}`,
            pin: true,
            anticipatePin: 1,
            scrub: 0.4,
            invalidateOnRefresh: true,
            onUpdate: (st) => {
              const p = st.progress
              progressRef.current = p
              setStep(Math.min(n - 1, Math.floor(p * n)))
              const m = gsap.utils.clamp(0, 1, (p - 0.3) / 0.6)
              if (meter.current) meter.current.textContent = `${Math.round(m * CHECKS_SCORE)}%`
            },
          },
        })
        gsap.set("[data-node-lit]", { autoAlpha: 0, scale: 0.4 })
        gsap.set(steps.slice(1), { opacity: 0.35 })
        if (meter.current) meter.current.textContent = "0%"
        setStep(0)
        tl.to('[data-node-lit="0"]', { autoAlpha: 1, scale: 1, duration: 0.03 }, 0)
        for (let t = 0; t < n - 1; t++) {
          const at = (t + 1) / n
          tl.fromTo(`[data-rail-fill="${t}"]`, { scaleY: 0 }, { scaleY: 1, duration: at - 0.06 - t / n }, t / n + 0.04)
          tl.to(`[data-node-lit="${t + 1}"]`, { autoAlpha: 1, scale: 1, duration: 0.03 }, at - 0.02)
          tl.to(steps[t]!, { opacity: 0.35, duration: 0.04 }, at - 0.02)
          tl.to(steps[t + 1]!, { opacity: 1, duration: 0.04 }, at - 0.02)
        }
        tl.to({}, { duration: 0 }, 1)
        return () => {
          steps.forEach((el) => el.removeAttribute("aria-current"))
          progressRef.current = 0
          if (meter.current) meter.current.textContent = `${CHECKS_SCORE}%`
        }
      })

      let alive = true
      document.fonts?.ready.then(() => alive && ScrollTrigger.refresh())
      return () => {
        alive = false
        mm.revert()
      }
    },
    { scope: section },
  )

  return (
    <section
      ref={section}
      id="how"
      tabIndex={-1}
      aria-labelledby="how-title"
      className="scroll-mt-16 border-t border-border py-24 outline-none md:py-32 lg:motion-safe:py-0"
    >
      <div
        ref={grid}
        className="mx-auto grid max-w-6xl grid-cols-1 gap-16 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-20 lg:motion-safe:h-[calc(100svh-4rem)]"
      >
        <div>
          <p data-reveal="true" className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            {how.eyebrow}
          </p>
          <h2 id="how-title" data-reveal="true" className="mt-4 max-w-2xl text-4xl font-semibold tracking-tighter text-balance md:text-5xl">
            {how.title}
          </h2>
          <ol data-steps="true" className="relative mt-14 flex flex-col gap-14 lg:motion-safe:mt-12 lg:motion-safe:gap-10">
            {how.steps.map((step, i) => {
              const Icon = icons[i]!
              return (
                <li key={step.title} data-step="true" className="relative pl-12">
                  {i < how.steps.length - 1 && (
                    <span aria-hidden="true" className="absolute top-[26px] -bottom-[66px] left-[7px] w-px bg-border lg:motion-safe:-bottom-[50px]">
                      <span data-rail-fill={i} className="block size-full origin-top bg-linear-to-b from-commit-2 to-commit-4" />
                    </span>
                  )}
                  <span aria-hidden="true" className="absolute top-[10px] left-0 size-[15px] rounded-[4px] bg-commit-0 ring-4 ring-background">
                    <span data-node-lit={i} className="absolute inset-0 rounded-[4px] bg-commit-4 shadow-[0_0_16px_rgb(57_211_83/0.5)]" />
                  </span>
                  <div data-reveal="true">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                      <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-card/60">
                        <Icon aria-hidden="true" className="size-4 text-foreground" />
                      </span>
                    </div>
                    <h3 className="mt-4 text-lg font-medium tracking-tight">{step.title}</h3>
                    <p className="mt-2 max-w-md text-sm text-pretty text-muted-foreground">{step.body}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
        <div ref={visual} data-reveal="true" aria-hidden="true" className="relative flex items-center justify-center lg:h-[min(74svh,660px)]">
          <div className={cn("flex size-full items-center justify-center transition-opacity duration-500", ready && use3D && "opacity-0")}>
            <PrSheet className="w-full max-w-[320px] -rotate-2 lg:aspect-[1024/1448] lg:h-[84%] lg:w-auto lg:max-w-none" />
          </div>
          {use3D && near && (
            <div className={cn("absolute inset-0 transition-opacity duration-500", ready ? "opacity-100" : "opacity-0")}>
              <PrScene progressRef={progressRef} active={active} onReady={() => setReady(true)} />
            </div>
          )}
          <div className="absolute inset-x-0 top-0 hidden items-baseline justify-between font-mono text-xs tracking-widest text-muted-foreground uppercase lg:motion-safe:flex">
            <p>
              {STEP_LABEL}{" "}
              <span ref={stepNum} className="text-foreground">
                01
              </span>{" "}
              / {String(how.steps.length).padStart(2, "0")}
            </p>
            <p className="flex items-baseline gap-3">
              <span>{how.meter}</span>
              <span ref={meter} className="text-3xl font-medium tracking-tight text-brand tabular-nums">
                {CHECKS_SCORE}%
              </span>
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
