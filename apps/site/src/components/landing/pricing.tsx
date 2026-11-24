import { CheckIcon } from "lucide-react"
import { cn } from "cn"
import { buttonVariants } from "@/components/ui/button"
import { pricing } from "@/content/landing"
import { Eyebrow, Section, SectionTitle, container } from "./primitives"

export function Pricing() {
  return (
    <Section id="pricing">
      <div className={container}>
        <Eyebrow>{pricing.eyebrow}</Eyebrow>
        <SectionTitle id="pricing-title">{pricing.title}</SectionTitle>
        <p data-reveal="true" className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
          {pricing.lead}
        </p>
        <ul className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          {pricing.plans.map((plan) => {
            const recommended = "recommended" in plan ? plan.recommended : undefined
            return (
              <li
                key={plan.name}
                data-reveal="true"
                className={cn(
                  "flex flex-col gap-6 rounded-2xl border p-6",
                  recommended ? "border-brand/40 bg-brand/[0.04] shadow-[0_0_60px_-30px_rgb(57_211_83/0.6)]" : "border-border bg-card/40",
                )}
              >
                <div className="flex flex-col gap-2">
                  <span className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">{plan.name}</h3>
                    {recommended && (
                      <span className="rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[11px] text-brand">{recommended}</span>
                    )}
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="text-4xl font-semibold tracking-tight tabular-nums">{plan.price}</span>
                    {plan.suffix && <span className="font-mono text-xs text-muted-foreground">{plan.suffix}</span>}
                  </span>
                  <span className="text-sm text-pretty text-muted-foreground">{plan.body}</span>
                </div>
                <ul className="flex flex-col gap-2 text-sm">
                  {plan.items.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-muted-foreground">
                      <CheckIcon className="mt-0.5 size-4 shrink-0 text-brand" />
                      {item}
                    </li>
                  ))}
                </ul>
                <a href={plan.href} className={cn(buttonVariants({ variant: recommended ? "default" : "outline" }), "mt-auto h-11 w-full")}>
                  {plan.cta}
                </a>
              </li>
            )
          })}
        </ul>
        <p data-reveal="true" className="mt-6 text-xs text-pretty text-muted-foreground">
          {pricing.footnote}
        </p>
      </div>
    </Section>
  )
}
