"use client"

import { ArrowRightIcon } from "lucide-react"
import { useEffect, useRef } from "react"
import { cn } from "cn"
import { repos } from "@/content/landing"
import { rng } from "./fx/scene"
import { Eyebrow, Lead, Section, SectionTitle, container } from "./primitives"

const LEVEL_CLASS = ["bg-commit-0", "bg-commit-1", "bg-commit-2", "bg-commit-3", "bg-commit-4"]
const END = Date.UTC(2026, 9, 18)
const START = END - 52 * 7 * 864e5
const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""]

/** 53 weeks × 7 days of fake activity, seeded so server and client agree. */
const WEEKS: number[][] = (() => {
  const rand = rng(852)
  return Array.from({ length: 53 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const weekend = d === 0 || d === 6
      const s = 0.55 + (w / 52) * 0.45
      return rand() > (weekend ? 0.3 : 0.82) * s + 0.1 ? 0 : 1 + Math.floor(rand() * rand() * (weekend ? 4 : 11) * s)
    }),
  )
})()

const level = (count: number) => (count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 5 ? 3 : 4)

/** A month label above the first week that starts in a new month. */
const MONTHS = Array.from({ length: 53 }, (_, w) => {
  if (w === 0 || w > 50) return null
  const date = new Date(START + w * 7 * 864e5)
  const prev = new Date(date.getTime() - 7 * 864e5)
  return date.getUTCMonth() !== prev.getUTCMonth() ? date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) : null
})

/** Narrow screens show the most recent weeks only. */
function weekVisibility(w: number) {
  const fromEnd = 52 - w
  return fromEnd < 20 ? "flex" : fromEnd < 36 ? "hidden sm:flex" : fromEnd < 45 ? "hidden md:flex" : "hidden lg:flex"
}

const cell = "rounded-[2px] outline-1 -outline-offset-1 outline-white/5"

function Heatmap({ className }: { className?: string }) {
  const grid = useRef<HTMLDivElement>(null)
  const scanner = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = grid.current
    const scan = scanner.current
    if (!root || !scan || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (typeof scan.animate !== "function") return
    const weeks = Array.from(root.querySelectorAll<HTMLElement>("[data-week]")).filter((el) => el.offsetParent !== null)
    for (const el of weeks) el.style.opacity = "0.15"
    const anims: Animation[] = []
    let visible = false
    let started = false
    const loop = () => {
      const a = scan.animate(
        [
          { opacity: 0, transform: "translateX(0)" },
          { opacity: 1, transform: "translateX(0)", offset: 0.04 },
          { opacity: 1, transform: "translateX(calc(100% - var(--cell)))", offset: 0.5 },
          { opacity: 0, transform: "translateX(calc(100% - var(--cell)))", offset: 0.55 },
          { opacity: 0, transform: "translateX(calc(100% - var(--cell)))" },
        ],
        { duration: 7200, delay: 1800, iterations: Infinity },
      )
      if (!visible) a.pause()
      anims.push(a)
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = !!entry?.isIntersecting
        if (started) {
          for (const a of anims) {
            if (visible) a.play()
            else a.pause()
          }
          return
        }
        if (!visible) return
        started = true
        weeks.forEach((el, i) => {
          el.style.opacity = ""
          anims.push(
            el.animate([{ opacity: 0.15 }, { opacity: 1 }], {
              duration: 500,
              delay: (i / weeks.length) * 2400,
              easing: "cubic-bezier(0.16, 1, 0.3, 1)",
              fill: "backwards",
            }),
          )
        })
        const first = scan.animate(
          [
            { opacity: 1, transform: "translateX(0)" },
            { opacity: 1, transform: "translateX(calc(100% - var(--cell)))", offset: 0.95 },
            { opacity: 0, transform: "translateX(calc(100% - var(--cell)))" },
          ],
          { duration: 2400, easing: "linear" },
        )
        first.onfinish = loop
        anims.push(first)
      },
      { rootMargin: "0px 0px -20% 0px" },
    )
    io.observe(root)
    return () => {
      io.disconnect()
      for (const a of anims) a.cancel()
      for (const el of weeks) el.style.opacity = ""
    }
  }, [])

  return (
    <figure className={cn("min-w-0 overflow-hidden rounded-md border border-border bg-background p-4", className)}>
      <figcaption className="text-sm text-foreground">{repos.heatmap.title}</figcaption>
      <div className="mt-3 flex gap-1 [--cell:10px] sm:[--cell:11px]" aria-hidden="true">
        <div className="flex flex-col gap-[3px] pt-[19px] text-[10px] leading-none text-muted-foreground">
          {DAY_LABELS.map((label, i) => (
            <span key={i} className="flex h-(--cell) items-center pr-1">
              {label}
            </span>
          ))}
        </div>
        <div ref={grid} className="relative flex gap-[3px]">
          {WEEKS.map((days, w) => (
            <div key={w} data-week="true" className={cn("flex-col gap-[3px]", weekVisibility(w))}>
              <span className="relative h-4 text-[10px] leading-none text-muted-foreground">
                {MONTHS[w] && <span className="absolute top-0 left-0 whitespace-nowrap">{MONTHS[w]}</span>}
              </span>
              {days.map((count, d) => (
                <span key={d} className={cn("size-(--cell)", cell, LEVEL_CLASS[level(count)])} />
              ))}
            </div>
          ))}
          <div ref={scanner} className="pointer-events-none absolute top-[19px] bottom-0 left-0 w-full opacity-0">
            <span className="block h-full w-(--cell) rounded-[3px] bg-brand/30 shadow-[0_0_14px_2px_rgb(57_211_83/0.55)] ring-1 ring-brand" />
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="mt-3 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        <span className="mr-1">{repos.heatmap.less}</span>
        {LEVEL_CLASS.map((c) => (
          <span key={c} className={cn("size-2.5", cell, c)} />
        ))}
        <span className="ml-1">{repos.heatmap.more}</span>
      </div>
    </figure>
  )
}

const TILT: Record<string, Keyframe[]> = {
  job: [
    { opacity: 0, transform: "perspective(900px) translateX(-24px) rotateY(22deg)" },
    { opacity: 1, transform: "none" },
  ],
  arrow: [
    { opacity: 0, transform: "scale(0.6)" },
    { opacity: 1, transform: "none" },
  ],
  pr: [
    { opacity: 0, transform: "perspective(900px) translateX(24px) rotateY(-22deg)" },
    { opacity: 1, transform: "none" },
  ],
}

export function Repos() {
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    const root = list.current
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-tilt]"))
    if (typeof items[0]?.animate !== "function") return
    for (const el of items) el.style.opacity = "0"
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        io.disconnect()
        items.forEach((el, i) => {
          el.style.opacity = ""
          el.animate(TILT[el.dataset.tilt!]!, {
            duration: 900,
            delay: 150 + 140 * Math.floor(i / 3) + (i % 3) * 90,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "backwards",
          })
        })
      },
      { rootMargin: "0px 0px -15% 0px" },
    )
    io.observe(root)
    return () => {
      io.disconnect()
      for (const el of items) el.style.opacity = ""
    }
  }, [])

  return (
    <Section id="repos">
      <div className={container}>
        <Eyebrow>{repos.eyebrow}</Eyebrow>
        <SectionTitle id="repos-title">{repos.title}</SectionTitle>
        <Lead>{repos.lead}</Lead>
        <div data-reveal="true" className="mt-12 lg:mt-16">
          <Heatmap className="mx-auto max-w-fit" />
          <p className="mt-3 text-center font-mono text-xs tracking-widest text-brand uppercase">{repos.heatmap.label}</p>
          <ol ref={list} className="mt-8 flex flex-col gap-6 sm:mt-10 sm:gap-4">
            {repos.rows.map((row) => (
              <li
                key={row.repo}
                className="relative grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-4"
              >
                <div data-tilt="job" className="min-w-0 rounded-lg border border-border bg-background px-4 py-3">
                  <p className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">{`Ticket · ${row.kind}`}</p>
                  <p className="mt-1 truncate font-semibold tracking-tight">{row.repo}</p>
                  <p className="truncate text-sm text-muted-foreground">{row.ticket}</p>
                </div>
                <ArrowRightIcon data-tilt="arrow" aria-hidden="true" className="size-5 justify-self-center text-brand max-sm:rotate-90" />
                <span className="sr-only">becomes the pull request</span>
                <div data-tilt="pr" className="min-w-0 rounded-lg border-l-4 border-[#1a7f37] bg-[#f6f8fa] px-4 py-3 text-neutral-900">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 truncate font-mono text-[13px] font-semibold tracking-tight">{row.pr}</p>
                    <span className="shrink-0 rounded-sm bg-[#dafbe1] px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-[#1a7f37] uppercase">
                      {`PR · ${row.number}`}
                    </span>
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {row.tags.map((tag) => (
                      <li
                        key={tag}
                        className="rounded-full border border-[#1a7f37]/25 bg-[#dafbe1] px-2.5 py-0.5 font-mono text-[11px] text-[#116329]"
                      >
                        {tag}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <p data-reveal="true" className="mt-6 font-mono text-[11px] text-muted-foreground">
          {repos.footnote}
        </p>
      </div>
    </Section>
  )
}
