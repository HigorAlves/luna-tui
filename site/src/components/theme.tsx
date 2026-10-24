"use client"

import { MoonIcon, SunIcon } from "lucide-react"
import { ThemeProvider as NextThemes, useTheme } from "next-themes"
import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"

// Mocha is the default; the .light class (Latte) is what next-themes toggles to.
export function ThemeProvider(props: ComponentProps<typeof NextThemes>) {
  return <NextThemes attribute="class" value={{ light: "light", dark: "dark" }} defaultTheme="dark" enableSystem={false} disableTransitionOnChange {...props} />
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button variant="outline" size="icon" aria-label="Toggle theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
      <SunIcon className="dark:hidden" />
      <MoonIcon className="hidden dark:block" />
    </Button>
  )
}
