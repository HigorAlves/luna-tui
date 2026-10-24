"use client"

import { CircleDotIcon, FolderGit2Icon } from "lucide-react"
import { MotionConfig, type Variants, motion } from "motion/react"
import type { ReactNode } from "react"
import { cn } from "cn"
import { hero } from "@/content/landing"
import { EASE_OUT_EXPO } from "./fx/scene"

const ease = [...EASE_OUT_EXPO] as [number, number, number, number]

const container: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.12, delayChildren: 0.25 } } }
const tile: Variants = { hidden: { opacity: 0, y: 14, scale: 0.94 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.55, ease } } }
const operator: Variants = { hidden: { opacity: 0, scale: 0.5 }, show: { opacity: 1, scale: 1, transition: { duration: 0.35, ease } } }
const draw: Variants = { hidden: { pathLength: 0, opacity: 0 }, show: { pathLength: 1, opacity: 1, transition: { duration: 0.6, ease } } }
const result: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.94 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.55, ease, when: "beforeChildren", staggerChildren: 0.09 } },
}
const bar: Variants = { hidden: { scaleX: 0 }, show: { scaleX: 1, transition: { duration: 0.45, ease } } }
const pop: Variants = { hidden: { opacity: 0, scale: 0 }, show: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 420, damping: 18, delay: 0.15 } } }

/** The orc mark: a ring with two tusks. */
function OrcMark({ className }: { className?: string }) {
  return (
    <svg viewBox="6 7 52 52" aria-hidden="true" className={className}>
      <circle cx="32" cy="33" r="20" fill="none" stroke="currentColor" strokeWidth="9" />
      <path fill="currentColor" d="M22 47C22 41 23.5 37 26.5 33C26.5 38 27.5 44 28.5 50Z" />
      <path fill="currentColor" d="M42 47C42 41 40.5 37 37.5 33C37.5 38 36.5 44 35.5 50Z" />
    </svg>
  )
}

const tiles: { icon: ReactNode; halo: string }[] = [
  { icon: <CircleDotIcon className="size-8 text-foreground" />, halo: "bg-white/[0.06]" },
  { icon: <FolderGit2Icon className="size-8 text-muted-foreground" />, halo: "bg-white/[0.06]" },
  { icon: <OrcMark className="size-8 text-orc" />, halo: "bg-orc/20" },
]

function Tile({ index, icon, halo }: { index: number; icon: ReactNode; halo: string }) {
  return (
    <motion.div variants={tile} className={cn("relative row-start-1", ["col-start-1", "col-start-3", "col-start-5"][index])}>
      <div aria-hidden="true" className={cn("absolute -inset-3 -z-10 rounded-3xl blur-2xl", halo)} />
      <div className="rounded-2xl bg-gradient-to-b from-white/20 via-white/[0.07] to-white/[0.03] p-px">
        <div className="flex size-[76px] items-center justify-center rounded-[15px] bg-[#0d1117] shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] sm:size-[84px]">
          {icon}
        </div>
      </div>
    </motion.div>
  )
}

function Operator({ symbol, strong, className }: { symbol: string; strong?: boolean; className: string }) {
  return (
    <motion.div variants={operator} aria-hidden="true" className={cn("relative h-[78px] w-9 items-center justify-center sm:h-[86px] sm:w-14", className)}>
      <div className={cn("absolute inset-x-0 h-px", strong ? "bg-gradient-to-r from-white/15 to-commit-4/50" : "bg-white/12")} />
      <span
        className={cn(
          "relative z-10 grid size-6 place-items-center rounded-full border bg-background font-mono text-xs",
          strong ? "border-commit-4/40 text-commit-4" : "border-white/15 text-muted-foreground",
        )}
      >
        {symbol}
      </span>
    </motion.div>
  )
}

function Label({ name, tag, className }: { name: string; tag: string; className: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-0.5 whitespace-nowrap", className)}>
      <span className="text-[13px] font-medium text-foreground">{name}</span>
      <span className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">{tag}</span>
    </div>
  )
}

const Bar = ({ className, style }: { className: string; style?: React.CSSProperties }) => (
  <motion.div variants={bar} className={cn("origin-left rounded-full", className)} style={style} />
)

export function HeroEquation() {
  const [ticket, repo, orc] = hero.equation
  return (
    <MotionConfig reducedMotion="user">
      <motion.figure
        variants={container}
        initial="hidden"
        animate="show"
        aria-label={hero.figureLabel}
        className="grid grid-cols-[repeat(5,auto)] items-center justify-center justify-items-center gap-y-3 sm:grid-cols-[repeat(7,auto)]"
      >
        <Tile index={0} {...tiles[0]!} />
        <Operator symbol="+" className="col-start-2 row-start-1 flex" />
        <Tile index={1} {...tiles[1]!} />
        <Operator symbol="+" className="col-start-4 row-start-1 flex" />
        <Tile index={2} {...tiles[2]!} />

        <Label name={ticket!.name} tag={ticket!.tag} className="col-start-1 row-start-2" />
        <Label name={repo!.name} tag={repo!.tag} className="col-start-3 row-start-2" />
        <Label name={orc!.name} tag={orc!.tag} className="col-start-5 row-start-2" />

        {/* Mobile: the three tiles merge into one line down to the result. */}
        <div aria-hidden="true" className="relative col-span-5 col-start-1 row-start-3 h-[76px] w-[306px] sm:hidden">
          <svg viewBox="0 0 306 90" className="absolute inset-0 size-full overflow-visible" fill="none">
            <defs>
              <linearGradient id="hero-merge" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgb(57 211 83 / 0.45)" />
                <stop offset="1" stopColor="rgb(57 211 83 / 0.85)" />
              </linearGradient>
            </defs>
            {["M39 0 C39 30 153 22 153 46", "M153 0 L153 46", "M267 0 C267 30 153 22 153 46"].map((d) => (
              <motion.path key={d} variants={draw} d={d} stroke="rgb(255 255 255 / 0.14)" strokeWidth="1" />
            ))}
            <motion.path variants={draw} d="M153 58 L153 88" stroke="url(#hero-merge)" strokeWidth="1" />
          </svg>
          <motion.div variants={operator} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: 153, top: 46 }}>
            <span className="relative z-10 grid size-6 place-items-center rounded-full border border-commit-4/40 bg-background font-mono text-xs text-commit-4">=</span>
          </motion.div>
        </div>

        <Operator symbol="=" strong className="hidden sm:col-start-6 sm:row-start-1 sm:flex" />

        <motion.div variants={result} className="col-span-5 col-start-1 row-start-4 sm:col-span-1 sm:col-start-7 sm:row-start-1">
          <div className="relative">
            <div aria-hidden="true" className="absolute -inset-4 -z-10 rounded-3xl bg-commit-4/15 blur-2xl" />
            <div className="relative w-[112px] rounded-xl bg-white p-3 shadow-[0_0_0_1px_rgb(255_255_255/0.12),0_24px_60px_-16px_rgb(57_211_83/0.35)] sm:w-[124px]">
              <Bar className="h-1.5 w-3/5 bg-neutral-800" />
              <Bar className="mt-1.5 h-1 w-4/5 bg-neutral-300" />
              <motion.div variants={bar} className="mt-2.5 h-px origin-left bg-neutral-800" />
              <div className="mt-2.5 space-y-2">
                <div className="flex items-center gap-1.5">
                  <motion.span variants={pop} className="size-1.5 shrink-0 rounded-[2px] bg-commit-3" />
                  <Bar className="h-1 flex-1 bg-neutral-500" />
                </div>
                <motion.div variants={pop} className="flex">
                  <span className="rounded-[3px] bg-commit-4/15 px-1 font-mono text-[8px] leading-3 text-[#116329]">{hero.result.commit}</span>
                </motion.div>
                <div className="flex items-center gap-1.5">
                  <span className="size-1.5 shrink-0 rounded-[2px] bg-neutral-300" />
                  <Bar className="h-1 bg-neutral-300" style={{ width: "90%" }} />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="size-1.5 shrink-0 rounded-[2px] bg-neutral-300" />
                  <Bar className="h-1 bg-neutral-300" style={{ width: "70%" }} />
                </div>
              </div>
              <Bar className="mt-2.5 h-1 w-2/3 bg-neutral-300" />
            </div>
          </div>
        </motion.div>
        <Label name={hero.result.name} tag={hero.result.tag} className="col-span-5 col-start-1 row-start-5 sm:col-span-1 sm:col-start-7 sm:row-start-2" />
      </motion.figure>
    </MotionConfig>
  )
}
