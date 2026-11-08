import { BoxIcon, GlobeLockIcon, KeyRoundIcon, UserRoundXIcon } from "lucide-react"
import { sandbox } from "@/content/landing"
import { CommitCascade } from "./fx/commit-cascade"
import { Eyebrow, IconTile, Lead, Section, SectionTitle, container } from "./primitives"

const icons = [BoxIcon, GlobeLockIcon, KeyRoundIcon, UserRoundXIcon]

export function Sandbox() {
  return (
    <Section id={sandbox.id} className="relative isolate overflow-hidden">
      <CommitCascade className="-z-10" vignette="band" opacity={0.14} density={0.3} />
      <div className={container}>
        <Eyebrow>{sandbox.eyebrow}</Eyebrow> <SectionTitle id={`${sandbox.id}-title`}>{sandbox.title}</SectionTitle>{" "}
        <Lead className="text-lg">{sandbox.lead}</Lead>{" "}
        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {sandbox.steps.map((s, i) => {
            const Icon = icons[i]!
            return (
              <li key={s.title} data-reveal="true" className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card/60 p-6">
                <IconTile>
                  <Icon className="size-4 text-brand" />
                </IconTile>
                <h3 className="mt-4 font-medium">{s.title}</h3> <p className="text-sm text-pretty text-muted-foreground">{s.body}</p>{" "}
              </li>
            )
          })}
        </ul>
      </div>
    </Section>
  )
}
