import { Board } from "@/components/landing/board"
import { Example } from "@/components/landing/example"
import { Faq } from "@/components/landing/faq"
import { Features } from "@/components/landing/features"
import { FinalCta } from "@/components/landing/final-cta"
import { Reveal } from "@/components/landing/fx/reveal"
import { GitHub } from "@/components/landing/github"
import { Hero } from "@/components/landing/hero"
import { How } from "@/components/landing/how"
import { Moments } from "@/components/landing/moments"
import { Factory } from "@/components/landing/factory"
import { Pricing } from "@/components/landing/pricing"
import { Repos } from "@/components/landing/repos"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <How />
        <Reveal>
          <Repos />
        </Reveal>
        <Reveal>
          <GitHub />
        </Reveal>
        <Reveal>
          <Board />
        </Reveal>
        <Reveal>
          <Example />
        </Reveal>
        <Reveal>
          <Features />
        </Reveal>
        <Reveal>
          <Factory />
        </Reveal>
        <Reveal>
          <Moments />
        </Reveal>
        <Reveal>
          <Pricing />
        </Reveal>
        <Reveal>
          <Faq />
        </Reveal>
        <Reveal>
          <FinalCta />
        </Reveal>
      </main>
      <SiteFooter />
    </>
  )
}
