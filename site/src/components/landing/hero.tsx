import { ArrowDownIcon, CheckIcon } from "lucide-react"
import { cn } from "cn"
import { buttonVariants } from "@/components/ui/button"
import { INSTALL_DOC, cta, hero } from "@/content/landing"
import { CommitCascade } from "./fx/commit-cascade"
import { HeroEquation } from "./hero-equation"

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
      <CommitCascade className="-z-10" opacity={0.3} density={0.5} />
      <div className="mx-auto flex max-w-6xl flex-col items-center px-4 pt-32 pb-20 text-center sm:px-6 md:pt-44 md:pb-28">
        <p className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          <span aria-hidden="true" className="size-2 rounded-[2px] bg-brand" />
          {hero.eyebrow}
        </p>
        <h1 id="hero-title" className="mt-6 max-w-4xl text-[2.6rem] leading-[1.02] font-semibold tracking-tighter text-balance sm:text-6xl md:text-7xl">
          {hero.title}
        </h1>
        <p className="mt-6 max-w-2xl text-base text-pretty text-muted-foreground md:text-lg">{hero.lead}</p>
        <div className="mt-10 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
          <a href={INSTALL_DOC} className={cn(buttonVariants(), "h-11 px-5 text-sm")}>
            {cta.primary}
          </a>
          <a href="#example" className={cn(buttonVariants({ variant: "outline" }), "h-11 bg-transparent px-5 text-sm dark:bg-transparent")}>
            {cta.secondary}
            <ArrowDownIcon />
          </a>
        </div>
        <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 font-mono text-xs text-muted-foreground">
          {hero.checks.map((c) => (
            <li key={c} className="flex items-center gap-1.5">
              <CheckIcon className="size-3 text-brand" />
              {c}
            </li>
          ))}
        </ul>
        <div className="mt-20 md:mt-24">
          <HeroEquation />
        </div>
      </div>
    </section>
  )
}
