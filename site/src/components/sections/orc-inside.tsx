import { ORC } from "@/content/site"

const ADR = "https://github.com/HigorAlves/orc/blob/main/docs/adr/0009-factory-mode-and-stage-contract.md"

function Arrow() {
  return (
    <span aria-hidden="true" className="self-center text-center font-mono text-term-muted max-lg:rotate-90">
      →
    </span>
  )
}

export function OrcInside() {
  return (
    <section id="orc-inside" className="scroll-mt-20 border-y bg-card py-16">
      <div className="mx-auto grid max-w-[1120px] items-center gap-10 px-5 lg:grid-cols-2">
        <div>
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">orc inside</p>
          <h2 className="font-display-tight mt-2 text-4xl">Luna TUI decides when. orc decides how.</h2>
          <p className="mt-4 text-[17px] leading-relaxed text-muted-foreground">
            Every agent stage is an orc stage pack: which agent, which tools, which doctrine, what JSON it must answer. The machine writes one
            file in, orc writes three out. Nothing else crosses.
          </p>
          <p className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <a href={ORC} className="text-primary underline-offset-4 hover:underline">orc, the Claude Code plugin →</a>
            <a href={ADR} className="text-primary underline-offset-4 hover:underline">ADR 0009, the contract →</a>
          </p>
        </div>
        <div className="grid gap-3 font-mono text-xs lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <div className="rounded-lg border border-term-border bg-term p-3 text-term-foreground">
            <p>/in/</p>
            <p className="mt-1 text-term-muted">stage.json — task · plan · decisions / priorFindings · limits</p>
          </div>
          <Arrow />
          <div className="rounded-lg border border-status-orc/40 bg-status-orc/10 p-3 text-status-orc">
            <p>container — orc-stage run</p>
            <p className="mt-1">ORC_FACTORY=1</p>
            <p>read-only rootfs</p>
          </div>
          <Arrow />
          <div className="rounded-lg border border-term-border bg-term p-3 text-term-foreground">
            <p>/out/</p>
            <p className="mt-1 text-term-muted">result.json / events.jsonl / files/qa/…</p>
          </div>
        </div>
      </div>
    </section>
  )
}
