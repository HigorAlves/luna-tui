"use client"

import { type ReactNode, useEffect, useRef } from "react"

/**
 * Fades and lifts every `[data-reveal]` descendant into place, staggered, the first time
 * the wrapper's top crosses `start`% of the viewport. Does nothing under reduced motion.
 */
export function Reveal({ children, className, start = 80 }: { children: ReactNode; className?: string; start?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (typeof IntersectionObserver === "undefined") return
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"))
    if (!items.length) return
    for (const el of items) el.style.opacity = "0"
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        io.disconnect()
        items.forEach((el, i) => {
          el.style.opacity = ""
          el.animate?.([{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }], {
            duration: 800,
            delay: 80 * i,
            easing: "cubic-bezier(0.215, 0.61, 0.355, 1)",
            fill: "backwards",
          })
        })
      },
      { rootMargin: `0px 0px -${100 - start}% 0px` },
    )
    io.observe(root)
    return () => {
      io.disconnect()
      for (const el of items) el.style.opacity = ""
    }
  }, [start])
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
