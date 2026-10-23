import { Hero } from "@/components/sections/hero"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"

// Real content lands in slices 35-36; these are the anchors the header links to.
const sections = [
  { id: "touches", title: "Three touches" },
  { id: "line", title: "How it runs" },
  { id: "orc-inside", title: "orc inside" },
  { id: "safe", title: "Safe by construction" },
  { id: "counter", title: "The counter" },
  { id: "install", title: "Install" },
]

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[1120px] flex-1 px-5">
        <Hero />
        {sections.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-20 py-16">
            <h2 className="font-display-tight text-3xl">{s.title}</h2>
          </section>
        ))}
      </main>
      <SiteFooter />
    </>
  )
}
