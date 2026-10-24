"use client"

import { Tabs } from "@base-ui/react/tabs"
import { ArrowRightIcon, HandIcon, PackageIcon, PinIcon, TerminalIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import dynamic from "next/dynamic"
import { type RefObject, createContext, useContext, useRef, useState } from "react"
import { cn } from "cn"
import { CopyButton } from "@/components/copy-button"
import { INSTALL_DOC, orc } from "@/content/landing"
import { type SceneProps, SceneSlot } from "./fx/lazy-scene"

const loadScene = () => import("./scenes/orc-scene")
const OrcScene = dynamic(loadScene, { ssr: false })

const PokeContext = createContext<RefObject<number> | null>(null)

function OrcSceneWithPoke(props: SceneProps) {
  const poke = useContext(PokeContext)!
  return <OrcScene {...props} poke={poke} />
}

/** orc's own mark: a ring with two tusks. */
export function OrcMark({ className }: { className?: string }) {
  return (
    <svg viewBox="6 7 52 52" aria-hidden="true" className={cn("overflow-visible", className)}>
      <circle cx="32" cy="33" r="20" fill="none" stroke="currentColor" strokeWidth="9" />
      <path fill="currentColor" d="M22 47C22 41 23.5 37 26.5 33C26.5 38 27.5 44 28.5 50Z" />
      <path fill="currentColor" d="M42 47C42 41 40.5 37 37.5 33C37.5 38 36.5 44 35.5 50Z" />
    </svg>
  )
}

const featureIcons = [PackageIcon, PinIcon, TerminalIcon]

const lineStyle = {
  prompt: { prefix: "> ", className: "text-foreground" },
  head: { prefix: "⏺ ", className: "text-[#8fbf6a]" },
  sub: { prefix: "  ⎿ ", className: "text-muted-foreground" },
  ok: { prefix: "✓ ", className: "text-brand" },
} as const

function Terminal() {
  const reduced = useReducedMotion()
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-[#0b0c0e] shadow-2xl shadow-black/40">
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-[#ff5f57]/80" />
        <span className="size-2.5 rounded-full bg-[#febc2e]/80" />
        <span className="size-2.5 rounded-full bg-[#28c840]/80" />
        <span className="ml-2 truncate font-mono text-xs text-muted-foreground">{orc.terminal.title}</span>
      </div>
      <motion.ol
        aria-label="Example machine session"
        className="flex flex-col gap-1.5 p-4 font-mono text-[12.5px] leading-relaxed sm:text-[13px]"
        initial="hidden"
        whileInView="shown"
        viewport={{ once: true, margin: "0px 0px -15% 0px" }}
        variants={{ shown: { transition: { staggerChildren: reduced ? 0 : 0.55, delayChildren: 0.2 } } }}
      >
        {orc.terminal.lines.map((line) => {
          const s = lineStyle[line.kind as keyof typeof lineStyle]
          return (
            <motion.li
              key={line.text}
              className={cn("[overflow-wrap:anywhere] whitespace-pre-wrap", s.className)}
              variants={{ hidden: { opacity: 0, x: reduced ? 0 : -6 }, shown: { opacity: 1, x: 0, transition: { duration: 0.35 } } }}
            >
              {s.prefix}
              {line.text}
            </motion.li>
          )
        })}
      </motion.ol>
    </div>
  )
}

function MascotFallback({ pokes }: { pokes: number }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center">
      <div className="relative">
        <div className="absolute inset-0 -z-10 scale-150 rounded-full bg-orc/25 blur-3xl" />
        <div key={pokes} className="text-orc motion-safe:animate-[mascot-hop_0.6s_ease-out]">
          <OrcMark className="w-48 sm:w-56" />
        </div>
      </div>
      <div className="mt-6 h-3 w-40 rounded-[100%] bg-black/50 blur-md" />
    </div>
  )
}

function Mascot() {
  const poke = useRef(0)
  const [pokes, setPokes] = useState(0)
  const reply = pokes > 0 ? orc.mascot.replies[(pokes - 1) % orc.mascot.replies.length] : ""
  return (
    <div className="flex min-w-0 flex-col items-center">
      <PokeContext.Provider value={poke}>
        <SceneSlot load={loadScene} Scene={OrcSceneWithPoke} fallback={<MascotFallback pokes={pokes} />} className="h-[340px] w-full sm:h-[420px] lg:h-[480px]" />
      </PokeContext.Provider>
      <button
        type="button"
        onClick={() => {
          poke.current = performance.now()
          setPokes((n) => n + 1)
        }}
        className="group inline-flex h-11 items-center gap-2 rounded-full border border-orc/40 bg-orc/10 px-5 text-sm font-medium text-[#8fbf6a] transition-colors outline-none hover:bg-orc/20 focus-visible:ring-3 focus-visible:ring-orc/50"
      >
        <HandIcon className="size-4 transition-transform group-hover:-rotate-12 group-active:scale-90" />
        {orc.mascot.button}
      </button>
      <p aria-live="polite" className="mt-2 h-5 text-xs text-muted-foreground">
        {reply}
      </p>
    </div>
  )
}

const tabClass =
  "relative inline-flex h-9 flex-none items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-all outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-active:border-input data-active:bg-input/30 data-active:text-foreground data-active:shadow-sm"

function Setup() {
  return (
    <div className="min-w-0">
      <h3 className="text-2xl font-semibold tracking-tight">{orc.setup.title}</h3>
      <p className="mt-2 text-pretty text-muted-foreground">{orc.setup.lead}</p>
      <Tabs.Root defaultValue={orc.setup.tabs[0]!.id} className="mt-6 flex flex-col gap-5">
        <Tabs.List className="inline-flex h-auto w-full flex-wrap items-center justify-start gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground">
          {orc.setup.tabs.map((tab) => (
            <Tabs.Tab key={tab.id} value={tab.id} className={tabClass}>
              {tab.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {orc.setup.tabs.map((tab) => (
          <Tabs.Panel key={tab.id} value={tab.id} className="min-w-0 flex-1 text-sm outline-none">
            <ol className="grid grid-cols-1 gap-5">
              {tab.commands.map((command, i) => (
                <li key={command} className="flex min-w-0 gap-4">
                  <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-card font-mono text-xs text-brand">
                    {i + 1}
                  </span>
                  <div data-copy-root className="relative min-w-0 flex-1 rounded-xl border border-border bg-card/60">
                    <pre className="py-3 pr-12 pl-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] sm:pr-24">
                      <code data-copy-source>{command}</code>
                    </pre>
                    <CopyButton text={command} label={orc.setup.copy} done={orc.setup.copied} className="absolute top-2 right-2" />
                  </div>
                </li>
              ))}
            </ol>
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </div>
  )
}

export function Orc() {
  return (
    <section id="orc" tabIndex={-1} aria-labelledby="orc-title" className="relative scroll-mt-16 overflow-clip border-t border-border py-24 outline-none md:py-32">
      <div aria-hidden="true" className="pointer-events-none absolute top-24 right-[-10%] -z-10 size-[520px] rounded-full bg-orc/15 blur-[120px]" />
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <div className="min-w-0">
          <p data-reveal="true" className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-muted-foreground uppercase">
            <OrcMark className="h-3.5 w-auto text-orc" />
            {orc.eyebrow}
          </p>
          <h2 id="orc-title" data-reveal="true" className="mt-4 text-4xl font-semibold tracking-tighter text-balance md:text-5xl">
            {orc.title}
          </h2>
          <p data-reveal="true" className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
            {orc.lead}
          </p>
          <ul className="mt-8 grid grid-cols-1 gap-5">
            {orc.features.map((f, i) => {
              const Icon = featureIcons[i]!
              return (
                <li key={f.title} data-reveal="true" className="flex min-w-0 gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-card">
                    <Icon className="size-4 text-brand" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-medium">{f.title}</h3>
                    <p className="mt-1 text-sm text-pretty text-muted-foreground">{f.body}</p>
                  </div>
                </li>
              )
            })}
          </ul>
          <div data-reveal="true" className="mt-8">
            <Terminal />
          </div>
        </div>
        <Mascot />
      </div>

      <div className="mx-auto mt-20 grid max-w-6xl grid-cols-1 gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-16">
        <Setup />
        <div className="min-w-0">
          <h3 className="text-2xl font-semibold tracking-tight">{orc.packsTitle}</h3>
          <ul className="mt-6 grid grid-cols-1 gap-3">
            {orc.packs.map((p) => (
              <li key={p.name} className="min-w-0 rounded-xl border border-border bg-card/60 px-4 py-3">
                <p className="truncate font-mono text-[13px] text-brand">{p.name}</p>
                <p className="mt-1 text-sm text-pretty text-muted-foreground">{p.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-5 text-xs text-pretty text-muted-foreground">{orc.note}</p>
          <a
            href={INSTALL_DOC}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-foreground outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {orc.guide}
            <ArrowRightIcon className="size-4" />
          </a>
        </div>
      </div>
    </section>
  )
}
