import { cn } from "cn"
import { how } from "@/content/landing"
import { BAR, BULLETS, CHECKS_SCORE, HIGHLIGHTS, PILLS, SHEET, pct } from "./sheet"

const inset = `${(SHEET.margin / SHEET.w) * 100}%`

/** The PR sheet in its finished state, as DOM: the fallback before (or instead of) the 3D scene. */
export function PrSheet({ className }: { className?: string }) {
  return (
    <div data-pr-sheet="true" className={cn("relative", className)} aria-hidden="true">
      <div className="absolute inset-0 translate-x-3 translate-y-4 rounded-sm bg-black/50 blur-md" />
      <div
        className="relative w-full overflow-hidden rounded-sm bg-[#f4f4f5] text-[#08090a] [container-type:inline-size]"
        style={{ aspectRatio: `${SHEET.w} / ${SHEET.h}` }}
      >
        <span className="absolute top-[10.6%] font-sans text-[4.8cqw] leading-none font-semibold tracking-tight whitespace-nowrap" style={{ left: inset }}>
          {how.paper.title}
        </span>
        <span className="absolute top-[10.8%] size-[2.55cqw] rounded-[0.6cqw] bg-brand" style={{ right: inset }} />
        <span className="absolute top-[15.6%] font-mono text-[2.3cqw] font-medium whitespace-pre text-[#71717a]" style={{ left: inset }}>
          {how.paper.sub}
        </span>
        <span className="absolute top-[20%] h-[2px] bg-[#08090a]" style={{ left: inset, right: inset }} />
        <span className="absolute top-[23.4%] font-mono text-[2.15cqw] font-medium text-commit-2" style={{ left: inset }}>
          {how.paper.slices}
        </span>
        {BULLETS.map((b, i) => (
          <div key={i}>
            <span className="absolute bg-[#08090a]" style={pct(b.marker)} />
            <span className="absolute bg-[#08090a]" style={pct(b.line1)} />
            <span className="absolute bg-[#d4d4d8]" style={pct(b.line2)} />
            <span
              className="absolute flex items-center justify-center rounded-full bg-brand font-mono text-[2cqw] font-medium text-brand-foreground"
              style={pct(b.slot)}
            >
              {how.paper.commits[i]}
            </span>
          </div>
        ))}
        {HIGHLIGHTS.map((h, i) => (
          <span key={i} className="absolute bg-brand/50" style={pct(h)} />
        ))}
        <span className="absolute top-[77.2%] font-mono text-[2.15cqw] font-medium text-commit-2" style={{ left: inset }}>
          {how.paper.checks}
        </span>
        {PILLS.map((p) => (
          <span
            key={p.label}
            className="absolute flex items-center justify-center rounded-full bg-brand font-mono text-[1.75cqw] font-semibold text-brand-foreground"
            style={pct(p)}
          >
            {p.label}
          </span>
        ))}
        <span className="absolute top-[89%] h-[2px] bg-[#08090a]" style={{ left: inset, right: inset }} />
        <span className="absolute top-[93%] font-mono text-[2.15cqw] font-medium text-[#71717a]" style={{ left: inset }}>
          {how.paper.footer}
        </span>
        <span className="absolute bg-[#d4d4d8]" style={pct(BAR)}>
          <span className="block h-full bg-commit-3" style={{ width: `${CHECKS_SCORE}%` }} />
        </span>
        <span className="absolute top-[90.2%] font-sans text-[7.8cqw] leading-none font-semibold text-commit-2" style={{ right: inset }}>
          {CHECKS_SCORE}%
        </span>
      </div>
    </div>
  )
}
