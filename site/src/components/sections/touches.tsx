import { SectionHead } from "@/components/sections/section-head"
import { touches } from "@/content/touches"

export function Touches() {
  return (
    <section id="touches" className="scroll-mt-20 py-16">
      <SectionHead eyebrow="What you do" title="Three touches per ticket" />
      <ul className="grid gap-4 md:grid-cols-3">
        {touches.map((t) => (
          <li key={t.title} className="rounded-xl border bg-card p-5">
            <p className="font-mono text-sm text-primary">{t.num}</p>
            <h3 className="font-display-tight mt-3 text-2xl">{t.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{t.body}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
