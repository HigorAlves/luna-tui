import { Separator } from "@/components/ui/separator"
import { HERDR, LUNA, ORC, REPO, factsLine } from "@/content/site"

const links = [
  ["GitHub", REPO],
  ["Luna", LUNA],
  ["orc", ORC],
  ["herdr", HERDR],
  ["License", `${REPO}/blob/main/LICENSE`],
]

export function SiteFooter() {
  return (
    <footer className="mt-18 border-t">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-5 px-5 pt-10 pb-14">
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {links.map(([label, href]) => (
            <a key={label} href={href} className="hover:text-accent-foreground">{label}</a>
          ))}
        </nav>
        <Separator />
        <p className="font-mono text-xs text-muted-foreground">{factsLine}</p>
      </div>
    </footer>
  )
}
