import type { SVGProps } from "react"
import { GLYPH, GLYPH_VIEWBOX, MARKS, MARK_VIEWBOX } from "@/components/brand.generated"

type Appearance = keyof typeof MARKS

type MarkProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number; appearance?: Appearance }

/** Luna's Eclipse with Prompt eyes, tile edge to edge. Markup comes from scripts/mark.mjs. */
export function Mark({ size = 28, appearance = "default", ...props }: MarkProps) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      width={size}
      height={size}
      aria-hidden="true"
      {...props}
      dangerouslySetInnerHTML={{ __html: MARKS[appearance] }}
    />
  )
}

/** One-colour crescent with the prompt; follows currentColor. */
export function Glyph(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return (
    <svg
      viewBox={GLYPH_VIEWBOX}
      width={24}
      height={18}
      aria-hidden="true"
      {...props}
      dangerouslySetInnerHTML={{ __html: GLYPH }}
    />
  )
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark size={size} />
      <span className="font-display-tight text-xl text-foreground">Luna TUI</span>
    </span>
  )
}

export function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}
