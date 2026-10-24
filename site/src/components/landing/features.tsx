import { BoxIcon, CheckIcon, GaugeIcon, KeyRoundIcon, LayersIcon, LockIcon, SendIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "cn"
import { features } from "@/content/landing"
import { Eyebrow, IconTile, Section, SectionTitle, container } from "./primitives"

const icons = [BoxIcon, KeyRoundIcon, LockIcon, SendIcon, LayersIcon, GaugeIcon]

type Card = (typeof features.cards)[number]

function Footer({ footer }: { footer: Card["footer"] }) {
  switch (footer.kind) {
    case "check":
      return (
        <span className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 text-brand" />
          {footer.text}
        </span>
      )
    case "pills":
      return (
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          {footer.items.map((item, i) => (
            <span
              key={item}
              className={cn(
                "rounded-full border px-2.5 py-0.5",
                i === footer.active ? "border-brand/25 bg-brand/10 text-brand" : "border-border text-muted-foreground",
              )}
            >
              {item}
            </span>
          ))}
          <span aria-hidden="true" className="text-muted-foreground">→</span>
          <span className="text-muted-foreground">{footer.tail}</span>
        </div>
      )
    case "commit":
      return (
        <p className="flex min-w-0 items-baseline gap-2 font-mono text-xs">
          <span className="shrink-0 text-brand">{footer.hash}</span>
          <span className="truncate text-muted-foreground">{footer.text}</span>
        </p>
      )
    case "list":
      return (
        <ul className="space-y-1.5 text-xs">
          {footer.items.map((item) => (
            <li key={item.text} className={cn("flex items-center gap-2", item.ok ? "text-muted-foreground" : "text-warning")}>
              {item.ok ? <CheckIcon className="size-3.5 text-brand" /> : <TriangleAlertIcon className="size-3.5" />}
              {item.text}
            </li>
          ))}
        </ul>
      )
    case "stamp":
      return (
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-muted-foreground">{footer.text}</span>
          <span aria-hidden="true" className="text-muted-foreground">→</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-brand">
            <CheckIcon className="size-3" />
            {footer.badge}
          </span>
        </p>
      )
  }
}

export function Features() {
  return (
    <Section id="features">
      <div className={container}>
        <Eyebrow>{features.eyebrow}</Eyebrow>
        <SectionTitle id="features-title">{features.title}</SectionTitle>
        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 md:mt-16">
          {features.cards.map((card, i) => {
            const Icon = icons[i]!
            return (
              <li
                key={card.title}
                data-reveal="true"
                className="flex min-w-0 flex-col rounded-xl border border-border bg-card/60 p-6 transition-colors duration-200 hover:border-white/15 sm:p-7"
              >
                <IconTile>
                  <Icon className="size-4 text-foreground" />
                </IconTile>
                <h3 className="mt-6 text-lg font-medium tracking-tight">{card.title}</h3>
                <p className="mt-2 mb-6 max-w-sm text-sm text-pretty text-muted-foreground">{card.body}</p>
                <div className="mt-auto border-t border-border pt-5">
                  <Footer footer={card.footer} />
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </Section>
  )
}
