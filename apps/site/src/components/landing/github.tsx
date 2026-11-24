"use client"

import { GitMergeIcon, GitPullRequestDraftIcon, RefreshCcwIcon, TagIcon } from "lucide-react"
import dynamic from "next/dynamic"
import { GitHubIcon } from "@/components/brand"
import { github } from "@/content/landing"
import { SceneSlot } from "./fx/lazy-scene"
import { Eyebrow, Section, SectionTitle } from "./primitives"
import { COMMIT_COLORS, CONTRIBUTIONS } from "./scenes/github-data"

const load = () => import("./scenes/github-scene")
const GitHubScene = dynamic(load, { ssr: false })

const icons = [TagIcon, GitPullRequestDraftIcon, RefreshCcwIcon, GitMergeIcon]

function Fallback() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-10">
      <div className="relative">
        <div className="absolute inset-0 -z-10 rounded-full bg-brand/20 blur-3xl" />
        <GitHubIcon className="size-36 text-[#c9d1d9] drop-shadow-[0_0_30px_rgb(57_211_83/0.35)] sm:size-44" />
      </div>
      <div className="grid grid-flow-col grid-rows-7 gap-[3px] [transform:perspective(700px)_rotateX(38deg)]">
        {CONTRIBUTIONS.flatMap((days, w) =>
          days.map((lvl, d) => (
            <span key={`${w}-${d}`} data-voxel="true" className="size-2.5 rounded-[2px] sm:size-3" style={{ backgroundColor: COMMIT_COLORS[lvl] }} />
          )),
        )}
      </div>
    </div>
  )
}

export function GitHub() {
  return (
    <Section id="github" className="relative overflow-hidden">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
        <div className="min-w-0">
          <Eyebrow className="inline-flex items-center gap-2">
            <GitHubIcon className="size-3.5" />
            {github.eyebrow}
          </Eyebrow>
          <SectionTitle id="github-title" className="max-w-none">
            {github.title}
          </SectionTitle>
          <p data-reveal="true" className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
            {github.lead}
          </p>
          <ul className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
            {github.features.map((f, i) => {
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
        <SceneSlot load={load} Scene={GitHubScene} fallback={<Fallback />} className="h-[360px] sm:h-[440px] lg:h-[520px]" />
      </div>
    </Section>
  )
}
