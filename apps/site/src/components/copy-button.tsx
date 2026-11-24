"use client"

import { CheckIcon, CopyIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { cn } from "cn"

/** Select the text of the nearest `[data-copy-source]` so the user can copy by hand. */
function selectFallback(el: HTMLElement | null) {
  const source = el?.closest("[data-copy-root]")?.querySelector("[data-copy-source]")
  if (!source) return
  const range = document.createRange()
  range.selectNodeContents(source)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

export function CopyButton({ text, label = "Copy", done = "Copied", className }: { text: string; label?: string; done?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function onClick(e: React.MouseEvent<HTMLButtonElement>) {
    const target = e.currentTarget
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      selectFallback(target)
      return
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      {copied ? <CheckIcon className="size-3.5 text-brand" /> : <CopyIcon className="size-3.5" />}
      <span aria-live="polite" className="max-sm:sr-only">
        {copied ? done : label}
      </span>
    </button>
  )
}
