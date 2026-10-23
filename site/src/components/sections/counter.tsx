import { SectionHead } from "@/components/sections/section-head"
import { checks } from "@/content/checks"

export function Counter() {
  return (
    <section id="counter" className="scroll-mt-20 border-y bg-term py-16">
      <div className="mx-auto grid max-w-[1120px] items-center gap-10 px-5 lg:grid-cols-2">
        {/* The band stays crust in both themes, so its text uses the terminal tokens. */}
        <div className="text-term-foreground [&_h2]:text-term-foreground [&_p]:text-term-muted">
          <SectionHead eyebrow="Proof" title="The counter on the wall">
            Press F on the board: cycle time per stage, first-pass rate, escalations, cost per task, slot use. Numbers from your own machine, 7
            and 30 days.
          </SectionHead>
          <p className="-mt-4 font-mono text-xs text-muted-foreground">[Floor screenshot from the first credentialed run goes here]</p>
        </div>
        <ul className="rounded-[10px] border border-term-border bg-term-card p-4 font-mono text-[13px] text-term-foreground">
          {checks.map((c) => (
            <li key={c.command} className="flex gap-3 py-1.5">
              <span aria-hidden="true" className="text-term-green">✓</span>
              <span>
                <code className="block">{c.command}</code>
                <span className="text-term-muted">{c.note}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
