"use client"

import { Columns3Icon, KanbanSquareIcon, KeyboardIcon, MonitorPlayIcon, WifiOffIcon } from "lucide-react"
import dynamic from "next/dynamic"
import { board } from "@/content/landing"
import { SceneSlot } from "./fx/lazy-scene"
import { rng } from "./fx/scene"
import { Section } from "./primitives"
import { COMMIT_COLORS, accentOf } from "./scenes/board-data"

const loadScene = () => import("./scenes/board-scene")
const BoardScene = dynamic(loadScene, { ssr: false })

const icons = [Columns3Icon, KeyboardIcon, MonitorPlayIcon, WifiOffIcon]

function Fallback() {
  const rand = rng(7)
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-4 [perspective:900px]">
      {board.cards.map((card, i) => (
        <div
          key={card.title}
          className="relative flex w-[88%] items-start justify-between gap-4 overflow-hidden rounded-xl border border-[#30363d] bg-[#0d1117] py-4 pr-4 pl-6"
          style={{ transform: `translateX(${6 * i}%) rotateY(-10deg)`, opacity: 1 - 0.12 * i }}
        >
          <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: accentOf(card.detail) }} />
          <div className="min-w-0">
            <p className="truncate font-semibold text-[#e6edf3]">{card.title}</p>
            <p className="mt-2 font-mono text-xs text-[#9ba3ad]">{`${card.stage} · ${card.detail}`}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className="font-mono text-xs text-brand">{`${card.runs} runs`}</span>
            <div className="grid grid-flow-row grid-cols-8 gap-[3px]">
              {Array.from({ length: card.runs }, (_, k) => (
                <span key={k} className="size-2.5 rounded-[2px]" style={{ backgroundColor: COMMIT_COLORS[2 + Math.floor(3 * rand())] }} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function Board() {
  return (
    <Section id="board" className="relative overflow-hidden">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
        <SceneSlot
          load={loadScene}
          Scene={BoardScene}
          fallback={<Fallback />}
          className="order-last h-[360px] sm:h-[440px] lg:order-first lg:h-[520px]"
        />
        <div className="min-w-0">
          <p data-reveal="true" className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-muted-foreground uppercase">
            <KanbanSquareIcon className="size-3.5" />
            {board.eyebrow}
          </p>
          <h2 id="board-title" data-reveal="true" className="mt-4 text-4xl font-semibold tracking-tighter text-balance md:text-5xl">
            {board.title}
          </h2>
          <p data-reveal="true" className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
            {board.lead}
          </p>
          <ul className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
            {board.features.map((f, i) => {
              const Icon = icons[i]!
              return (
                <li key={f.title} data-reveal="true" className="flex min-w-0 flex-col gap-2">
                  <span className="grid size-9 place-items-center rounded-lg border border-border bg-card">
                    <Icon className="size-4 text-brand" />
                  </span>
                  <h3 className="font-medium">{f.title}</h3>
                  <p className="text-sm text-pretty text-muted-foreground">{f.body}</p>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </Section>
  )
}
