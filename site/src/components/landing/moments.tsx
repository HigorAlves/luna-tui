import { ArchiveIcon, ArrowRightIcon, BugIcon, GitForkIcon, MoonStarIcon, ScanSearchIcon, UserIcon } from "lucide-react"
import { INSTALL_DOC, moments } from "@/content/landing"
import { Eyebrow, Lead, Section, SectionTitle, container } from "./primitives"

const icons = [UserIcon, MoonStarIcon, GitForkIcon, BugIcon, ArchiveIcon]

const card =
  "group flex h-full flex-col rounded-2xl border border-border bg-card/40 p-6 transition-colors outline-none hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50"

function More({ children }: { children: string }) {
  return (
    <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium">
      {children}
      <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
    </span>
  )
}

export function Moments() {
  return (
    <Section id="moments">
      <div className={container}>
        <Eyebrow>{moments.eyebrow}</Eyebrow>
        <SectionTitle id="moments-title" className="max-w-3xl">
          {moments.title}
        </SectionTitle>
        <Lead className="max-w-2xl md:text-lg">{moments.lead}</Lead>
        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 md:mt-16 lg:grid-cols-3">
          {moments.cards.map((m, i) => {
            const Icon = icons[i]!
            return (
              <li key={m.title} data-reveal="true" className="min-w-0">
                <a href="#how" className={card}>
                  <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-background">
                    <Icon className="size-5 text-brand" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold tracking-tight">{m.title}</h3>
                  <p className="mt-2 flex-1 text-[15px] leading-relaxed text-pretty text-muted-foreground">{`"${m.quote}"`}</p>
                  <More>{moments.link}</More>
                </a>
              </li>
            )
          })}
          <li data-reveal="true" className="min-w-0">
            <a href={INSTALL_DOC} className={`${card} border-dashed bg-transparent`}>
              <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-background">
                <ScanSearchIcon className="size-5 text-muted-foreground" />
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-tight">{moments.start.title}</h3>
              <p className="mt-2 flex-1 text-[15px] leading-relaxed text-pretty text-muted-foreground">{moments.start.body}</p>
              <More>{moments.start.link}</More>
            </a>
          </li>
        </ul>
      </div>
    </Section>
  )
}
