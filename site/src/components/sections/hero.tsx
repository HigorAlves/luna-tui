import { BoardFrame } from "@/components/board-frame"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "cn"

export function Hero() {
  return (
    <section id="top" className="scroll-mt-20 py-16 sm:py-20">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Luna, for the terminal · a software factory for one person · open source
        </p>
        <h1 className="font-display-tight mt-5 text-[clamp(2.25rem,6vw,4rem)] leading-[1.02]">
          Tickets in. Pull requests out.
          <br />
          You approve three times
          <span aria-hidden="true" className="hero-cursor ml-1 inline-block h-[0.85em] w-[0.5em] translate-y-[0.1em] bg-primary" />
        </h1>
        <p className="mt-6 max-w-[60ch] text-[19px] leading-relaxed text-muted-foreground">
          Luna waits on Claude in your notch. Luna TUI runs it: a board in your terminal, each ticket sent through orc&apos;s agents in throwaway
          containers, stopped at the gates you care about, and brought back as a reviewed, tested, evidenced pull request.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a href="#install" className={cn(buttonVariants(), "h-11 px-5 text-base")}>
            Install
          </a>
          <a href="#line" className={cn(buttonVariants({ variant: "ghost" }), "h-11 px-5 text-base")}>
            See the line
          </a>
        </div>
      </div>
      <div className="mt-12 min-w-0">
        <BoardFrame />
      </div>
    </section>
  )
}
