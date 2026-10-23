import { SectionHead } from "@/components/sections/section-head"
import { safety } from "@/content/safety"

export function Safe() {
  return (
    <section id="safe" className="scroll-mt-20 py-16">
      <SectionHead eyebrow="Safety" title="Safe by construction" />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {safety.map((s) => (
          <li key={s.title} className="rounded-xl border bg-card p-5">
            <h3 className="font-display-tight text-xl">{s.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
