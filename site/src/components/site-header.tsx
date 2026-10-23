import Link from "next/link"
import { Mark } from "@/components/brand"
import { ThemeToggle } from "@/components/theme"
import { buttonVariants } from "@/components/ui/button"
import { LUNA, ORC, nav } from "@/content/site"

const chip = "rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground max-lg:hidden"

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-15 max-w-[1120px] items-center gap-5 px-5">
        <Link href="/" aria-label="Luna TUI home" className="flex items-center gap-2.5 text-primary">
          <Mark className="size-7" />
          <span className="font-display-tight text-xl text-foreground">Luna TUI</span>
        </Link>
        <nav aria-label="Main" className="ml-3 flex gap-1 max-md:hidden">
          {nav.map((n) => (
            <a key={n.href} href={n.href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a href={LUNA} className={chip}>Luna for the notch →</a>
          <a href={ORC} className={chip}>runs orc →</a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
