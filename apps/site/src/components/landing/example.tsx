"use client"

import { CheckIcon, WorkflowIcon } from "lucide-react"
import { useState } from "react"
import { cn } from "cn"
import { example } from "@/content/landing"
import { Eyebrow, Lead, Section, SectionTitle, container } from "./primitives"

type Bullet = (typeof example.bullets)[number]

function Commits({ bullet, dark }: { bullet: Bullet; dark?: boolean }) {
  if (!dark) {
    return (
      <>
        {bullet.commits.map((c) => (
          <div key={c.hash} className="font-mono text-[11px] leading-snug">
            <p>
              <span className="text-[#1a7f37]">{c.hash}</span>
              <span className="text-neutral-500"> · {c.date}</span>
            </p>
            <p className="mt-0.5 text-neutral-700">{c.message}</p>
          </div>
        ))}
      </>
    )
  }
  return (
    <ol key={bullet.text} className="relative animate-in space-y-5 duration-300 fade-in slide-in-from-top-1">
      <span aria-hidden="true" className="absolute top-2 bottom-2 left-[3px] w-px bg-border" />
      {bullet.commits.map((c) => (
        <li key={c.hash} className="relative pl-6">
          <span aria-hidden="true" className="absolute top-1.5 left-0 size-[7px] rounded-[2px] bg-commit-4" />
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-xs">
            <span className="text-brand">{c.hash}</span>
            <span className="text-muted-foreground">{example.pr.meta.split(" · ")[0]}</span>
            <time className="ml-auto text-muted-foreground">{c.date}</time>
          </div>
          <p className="mt-1 font-mono text-[13px] leading-snug text-pretty text-foreground/90">{c.message}</p>
        </li>
      ))}
    </ol>
  )
}

function Ring({ value }: { value: number }) {
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <div className="relative size-20 shrink-0">
      <svg viewBox="0 0 80 80" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" className="stroke-white/10" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value / 100)}
          className="stroke-brand transition-[stroke-dashoffset] duration-1000 ease-out"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-lg font-medium tabular-nums">{value}%</span>
    </div>
  )
}

const pill = "rounded-full border px-2.5 py-0.5 font-mono text-[11px]"

export function Example() {
  const [active, setActive] = useState(0)
  const bullet = example.bullets[active]!

  return (
    <Section id="example">
      <div className={container}>
        <Eyebrow>{example.eyebrow}</Eyebrow>
        <SectionTitle id="example-title">{example.title}</SectionTitle>
        <Lead>{example.lead}</Lead>
        <div className="mt-12 grid grid-cols-1 items-start gap-6 lg:mt-16 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <article
            data-reveal="true"
            aria-label="Excerpt of a pull request description"
            className="rounded-xl bg-white p-5 text-neutral-900 shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_30px_80px_-30px_rgb(0_0_0/0.8)] sm:p-8"
          >
            <h3 className="border-b border-neutral-900 pb-1 text-[15px] font-bold">{example.pr.heading}</h3>
            <div className="mt-3 flex flex-col gap-x-4 gap-y-0.5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 text-[13px] leading-snug">
                <p className="font-mono font-bold">{example.pr.title}</p>
                <p className="text-neutral-600">{example.pr.meta}</p>
              </div>
              <p className="shrink-0 text-[13px] text-neutral-700 sm:text-right">{example.pr.status}</p>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-neutral-800">{example.pr.intro}</p>
            <ul className="-mx-2 mt-2 space-y-0.5">
              {example.bullets.map((b, i) => {
                const on = i === active
                return (
                  <li key={b.text}>
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-controls="proof-evidence"
                      aria-describedby="proof-hint"
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onClick={() => setActive(i)}
                      className={cn(
                        "group relative flex w-full gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-relaxed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#1a7f37]",
                        on ? "bg-[#dafbe1]" : "hover:bg-neutral-100",
                      )}
                    >
                      <span aria-hidden="true">•</span>
                      <span className="min-w-0 flex-1">{b.text}</span>
                      <span
                        aria-hidden="true"
                        className={cn("absolute top-2 -right-1 size-2 rounded-[2px] bg-[#1a7f37] transition-opacity sm:-right-2", on ? "opacity-100" : "opacity-0")}
                      />
                    </button>
                    {on && (
                      <div aria-hidden="true" className="mx-2 mt-1 mb-2 animate-in space-y-2 border-l-2 border-[#1a7f37] pl-3 duration-300 fade-in slide-in-from-top-1 lg:hidden">
                        <Commits bullet={b} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <span id="proof-hint" className="sr-only">
              Show the evidence for this line
            </span>
            <p className="mt-2 text-[13px] leading-relaxed">
              <span className="font-bold">{example.pr.footer}</span> {example.pr.footerValue}
            </p>
          </article>

          <div className="flex flex-col gap-6">
            <div data-reveal="true" id="proof-evidence" aria-live="polite" className="rounded-xl border border-border bg-card/60 p-5 sm:p-6">
              <div className="hidden lg:block">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">{example.evidence.label}</p>
                  <p className="font-mono text-xs text-brand">{example.evidence.commits(bullet.commits.length)}</p>
                </div>
                <div className="mt-5 min-h-[180px]">
                  <Commits bullet={bullet} dark />
                </div>
              </div>
              <div className="lg:mt-5 lg:border-t lg:border-border lg:pt-5">
                <p className="flex items-center gap-2 font-mono text-xs tracking-widest text-muted-foreground uppercase">
                  <WorkflowIcon className="size-3.5 text-brand" />
                  {example.evidence.run}
                </p>
                <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                  <p className="font-medium">{`${bullet.stage} · ${bullet.attempt}`}</p>
                  <p className="font-mono text-xs text-muted-foreground">{bullet.commits[0]!.date}</p>
                </div>
                <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                  <CheckIcon className="mt-px size-3.5 shrink-0 text-brand" />
                  {example.evidence.ok}
                </p>
              </div>
            </div>

            <div data-reveal="true" className="rounded-xl border border-border bg-card/60 p-5 sm:p-6">
              <div className="flex items-center gap-5">
                <Ring value={example.acceptance.score} />
                <div className="min-w-0">
                  <p className="text-base font-medium tracking-tight">{example.acceptance.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{example.acceptance.sub}</p>
                </div>
              </div>
              <div className="mt-6 space-y-4">
                <div>
                  <p className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">{example.acceptance.met}</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {example.acceptance.metItems.map((m) => (
                      <li key={m} className={cn(pill, "border-brand/25 bg-brand/10 text-brand")}>
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">{example.acceptance.out}</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {example.acceptance.outItems.map((m) => (
                      <li key={m} className={cn(pill, "border-border text-muted-foreground")}>
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p data-reveal="true" className="mt-6 font-mono text-[11px] text-muted-foreground">
          {example.footnote}
        </p>
      </div>
    </Section>
  )
}
