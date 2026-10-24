import { Mark } from "@/components/brand"
import { footer } from "@/content/landing"

const link =
  "rounded-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 py-12 sm:grid-cols-2 sm:px-6 md:grid-cols-[1fr_auto_auto_auto] md:gap-14">
        <div>
          <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
            <Mark size={24} className="size-6" />
            <span>Luna TUI</span>
          </span>
          <p className="mt-3 font-mono text-xs text-muted-foreground">{footer.tagline}</p>
        </div>
        {footer.columns.map((column) => {
          const id = `footer-${column.title.toLowerCase()}`
          return (
            <nav key={column.title} aria-labelledby={id} className="flex flex-col gap-3">
              <h2 id={id} className="text-xs font-medium tracking-wide text-foreground uppercase">
                {column.title}
              </h2>
              <ul className="flex flex-col gap-2 text-sm">
                {column.links.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} className={link}>
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )
        })}
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-5 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
          <p className="font-mono">{footer.facts}</p>
          <p>{footer.rights}</p>
        </div>
      </div>
    </footer>
  )
}
