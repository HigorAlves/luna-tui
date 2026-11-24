"use client"

import { MenuIcon, XIcon } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { cn } from "cn"
import { Mark } from "@/components/brand"
import { buttonVariants } from "@/components/ui/button"
import { INSTALL_DOC, REPO, cta, nav } from "@/content/landing"

const navLink =
  "relative block rounded-md px-2 py-2 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 border-b transition-colors duration-200",
        scrolled || open ? "border-border bg-background/80 backdrop-blur-md" : "border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link aria-label="Luna TUI, home" href="/" className="-m-1 rounded-md p-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
            <Mark size={24} className="size-6" />
            <span>Luna TUI</span>
          </span>
        </Link>
        <nav aria-label="Main" className="hidden xl:block">
          <ul className="flex items-center">
            {nav.map((n) => (
              <li key={n.href}>
                <a href={n.href} className={navLink}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a href={REPO} className={cn(buttonVariants({ variant: "ghost" }), "hidden h-9 px-3 lg:inline-flex")}>
            {cta.github}
          </a>
          <a href={INSTALL_DOC} className={cn(buttonVariants(), "h-9 px-3")}>
            {cta.primary}
          </a>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
            className="-mr-2 inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 xl:hidden"
          >
            {open ? <XIcon className="size-5" /> : <MenuIcon className="size-5" />}
          </button>
        </div>
      </div>
      {open && (
        <nav id="mobile-menu" aria-label="Mobile" className="border-t border-border bg-background/95 backdrop-blur-md xl:hidden">
          <ul className="mx-auto flex max-w-6xl flex-col px-4 py-3 sm:px-6">
            {nav.map((n) => (
              <li key={n.href}>
                <a href={n.href} onClick={() => setOpen(false)} className={cn(navLink, "px-0 py-2.5 text-base")}>
                  {n.label}
                </a>
              </li>
            ))}
            <li className="mt-2 border-t border-border pt-3">
              <a href={REPO} className={cn(navLink, "px-0 py-2.5 text-base")}>
                {cta.github}
              </a>
            </li>
            <li>
              <a href={INSTALL_DOC} className={cn(buttonVariants(), "mt-2 h-11 w-full")}>
                {cta.primary}
              </a>
            </li>
          </ul>
        </nav>
      )}
    </header>
  )
}
