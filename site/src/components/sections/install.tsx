import { CopyButton } from "@/components/copy-button"
import { SectionHead } from "@/components/sections/section-head"
import { installCommands, installOutput } from "@/content/install"
import { HERDR } from "@/content/site"

export function Install() {
  return (
    <section id="install" className="scroll-mt-20 py-16">
      <SectionHead eyebrow="Install" title="Five commands, then open the board">
        Needs Docker, Node 24, pnpm, Rust for the board, and{" "}
        <a href={HERDR} className="text-primary underline-offset-4 hover:underline">herdr</a>. A Claude credential in ~/.config/hardness/ turns the
        agent stages on; without one every stage runs as a stub so you can see the graph. Luna for the notch is a separate install and optional.
      </SectionHead>
      <div data-copy-root className="rounded-[10px] border border-term-border bg-term text-term-foreground">
        <div className="flex items-center justify-between border-b border-term-border px-3 py-1.5 font-mono text-xs text-term-muted">
          <span>terminal</span>
          <CopyButton text={installCommands.join("\n")} />
        </div>
        <div data-copy-source className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
          {installCommands.map((c) => (
            <p key={c} className="whitespace-pre">
              <span aria-hidden="true" className="select-none text-term-muted">$ </span>
              {c}
            </p>
          ))}
          <p className="mt-3 whitespace-pre text-term-green">{installOutput}</p>
        </div>
      </div>
    </section>
  )
}
