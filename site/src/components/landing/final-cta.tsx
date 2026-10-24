import { ArrowRightIcon } from "lucide-react"
import { cn } from "cn"
import { buttonVariants } from "@/components/ui/button"
import { INSTALL_DOC, cta, finalCta } from "@/content/landing"
import { CommitCascade } from "./fx/commit-cascade"

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="relative isolate overflow-hidden border-t border-border">
      <CommitCascade className="-z-10" vignette="band" opacity={0.16} density={0.35} />
      <div className="mx-auto flex max-w-6xl flex-col items-center px-4 py-28 text-center sm:px-6 md:py-40">
        <h2 id="cta-title" data-reveal="true" className="max-w-3xl text-4xl leading-[1.05] font-semibold tracking-tighter text-balance md:text-6xl">
          {finalCta.title}
        </h2>
        <p data-reveal="true" className="mt-5 max-w-md text-pretty text-muted-foreground md:text-lg">
          {finalCta.lead}
        </p>
        <div data-reveal="true" className="mt-10">
          <a href={INSTALL_DOC} className={cn(buttonVariants(), "group h-11 px-5 text-sm")}>
            {cta.primary}
            <ArrowRightIcon className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </section>
  )
}
