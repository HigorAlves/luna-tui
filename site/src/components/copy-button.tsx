"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"

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

export function CopyButton({ text }: { text: string }) {
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
    <Button type="button" variant="ghost" className="font-mono text-xs" onClick={onClick} aria-live="polite">
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}
