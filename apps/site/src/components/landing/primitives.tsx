import type { ComponentProps, ReactNode } from "react"
import { cn } from "cn"

export const container = "mx-auto max-w-6xl px-4 sm:px-6"

export function Section({ id, labelledBy, className, children }: { id: string; labelledBy?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} tabIndex={-1} aria-labelledby={labelledBy ?? `${id}-title`} className={cn("scroll-mt-16 border-t border-border py-24 outline-none md:py-32", className)}>
      {children}
    </section>
  )
}

export function Eyebrow({ className, children, ...props }: ComponentProps<"p">) {
  return (
    <p data-reveal="true" className={cn("font-mono text-xs tracking-widest text-muted-foreground uppercase", className)} {...props}>
      {children}
    </p>
  )
}

export function SectionTitle({ className, children, ...props }: ComponentProps<"h2">) {
  return (
    <h2 data-reveal="true" className={cn("mt-4 max-w-2xl text-4xl font-semibold tracking-tighter text-balance md:text-5xl", className)} {...props}>
      {children}
    </h2>
  )
}

export function Lead({ className, children, ...props }: ComponentProps<"p">) {
  return (
    <p data-reveal="true" className={cn("mt-4 max-w-xl text-pretty text-muted-foreground", className)} {...props}>
      {children}
    </p>
  )
}

/** A small rounded icon tile used by feature lists. */
export function IconTile({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("flex size-9 items-center justify-center rounded-lg border border-border bg-background/60", className)}>{children}</span>
}
