import { SectionHead } from "@/components/sections/section-head"
import { stations, type StationKind } from "@/content/stations"

const pill: Record<StationKind, string> = {
  orc: "bg-status-orc/15 text-status-orc",
  host: "bg-status-host/15 text-status-host",
  you: "bg-status-you/15 text-status-you",
}

export function Line() {
  return (
    <section id="line" className="scroll-mt-20 py-16">
      <SectionHead eyebrow="How it runs" title="Eleven stations, one state machine">
        Green stations run an orc stage pack inside a container. Blue ones are host steps: git, gh, the suite. Peach is you. Retry caps: three
        per loop, six implementer runs, then it stops and asks.
      </SectionHead>
      <ol className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(196px,1fr))]">
        {stations.map((s) => (
          <li
            key={s.name}
            className={`rounded-xl border p-4 ${s.gate ? "border-status-you/40 bg-status-you/10" : "bg-card"}`}
          >
            <p className="font-mono text-xs text-muted-foreground">{s.num ?? "gate"}</p>
            <h3 className="font-display-tight mt-1 text-xl">{s.name}</h3>
            <span className={`mt-2 inline-block rounded px-1.5 py-0.5 font-mono text-[10.5px] ${pill[s.kind]}`}>{s.kindLabel}</span>
            <p className="mt-2 text-[13px] leading-snug text-muted-foreground">{s.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
