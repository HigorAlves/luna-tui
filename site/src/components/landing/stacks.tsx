"use client"

import { GitBranchIcon, GitPullRequestArrowIcon, TriangleAlertIcon } from "lucide-react"
import dynamic from "next/dynamic"
import { stacks } from "@/content/landing"
import { SceneSlot } from "./fx/lazy-scene"
import { Eyebrow, IconTile, Lead, Section, SectionTitle, container } from "./primitives"

const loadScene = () => import("./scenes/github-scene")
const GitHubScene = dynamic(loadScene, { ssr: false })

const icons = [GitBranchIcon, GitPullRequestArrowIcon, TriangleAlertIcon]

function Fallback() {
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-3">
      {stacks.visual.rows.map((row, i) => (
        <div
          key={row}
          className="rounded-xl border border-[#30363d] bg-[#0d1117] px-5 py-4 font-mono text-sm text-[#e6edf3]"
          style={{ marginLeft: `${8 * i}%`, opacity: 1 - 0.12 * i }}
        >
          {row}
        </div>
      ))}
    </div>
  )
}

export function Stacks() {
  return (
    <Section id={stacks.id} className="relative overflow-hidden">
      <div className={`${container} grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16`}>
        <SceneSlot load={loadScene} Scene={GitHubScene} fallback={<Fallback />} className="order-last h-[360px] sm:h-[440px] lg:order-first lg:h-[520px]" />
        <div className="min-w-0">
          <Eyebrow>{stacks.eyebrow}</Eyebrow>
          <SectionTitle id={`${stacks.id}-title`}>{stacks.title}</SectionTitle>
          <Lead className="text-lg">{stacks.lead}</Lead>
          <ul className="mt-10 grid grid-cols-1 gap-6">
            {stacks.steps.map((s, i) => {
              const Icon = icons[i]!
              return (
                <li key={s.title} data-reveal="true" className="flex min-w-0 flex-col gap-2">
                  <IconTile>
                    <Icon className="size-4 text-brand" />
                  </IconTile>
                  <h3 className="font-medium">{s.title}</h3>
                  <p className="text-sm text-pretty text-muted-foreground">{s.body}</p>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </Section>
  )
}
