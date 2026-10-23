export function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="mb-8 max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{eyebrow}</p>
      <h2 className="font-display-tight mt-2 text-4xl">{title}</h2>
      {children && <p className="mt-4 text-[17px] leading-relaxed text-muted-foreground">{children}</p>}
    </header>
  )
}
