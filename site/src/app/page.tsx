import { Hero } from "@/components/sections/hero"
import { Counter } from "@/components/sections/counter"
import { Install } from "@/components/sections/install"
import { Line } from "@/components/sections/line"
import { OrcInside } from "@/components/sections/orc-inside"
import { Safe } from "@/components/sections/safe"
import { Touches } from "@/components/sections/touches"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"

const wrap = "mx-auto w-full max-w-[1120px] px-5"

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <div className={wrap}>
          <Hero />
          <Touches />
          <Line />
        </div>
        <OrcInside />
        <div className={wrap}>
          <Safe />
        </div>
        <Counter />
        <div className={wrap}>
          <Install />
        </div>
      </main>
      <SiteFooter />
    </>
  )
}
