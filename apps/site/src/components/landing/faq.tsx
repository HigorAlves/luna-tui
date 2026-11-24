"use client"

import { Accordion } from "@base-ui/react/accordion"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { faq } from "@/content/landing"
import { Eyebrow, Section, SectionTitle } from "./primitives"

export function Faq() {
  return (
    <Section id="faq">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 sm:px-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-16">
        <div>
          <Eyebrow>{faq.eyebrow}</Eyebrow>
          <SectionTitle id="faq-title">{faq.title}</SectionTitle>
          <p data-reveal="true" className="mt-4 max-w-sm text-pretty text-muted-foreground">
            {faq.lead}
          </p>
        </div>
        <div data-reveal="true">
          <Accordion.Root className="flex w-full flex-col border-t border-border">
            {faq.items.map((item) => (
              <Accordion.Item key={item.q} className="border-b border-border">
                <Accordion.Header className="flex">
                  <Accordion.Trigger className="group/trigger relative flex flex-1 items-center justify-between rounded-lg border border-transparent py-5 text-left text-base font-medium transition-all outline-none hover:text-foreground/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                    {item.q}
                    <ChevronDownIcon aria-hidden="true" className="pointer-events-none ml-4 size-4 shrink-0 text-muted-foreground group-aria-expanded/trigger:hidden" />
                    <ChevronUpIcon aria-hidden="true" className="pointer-events-none ml-4 hidden size-4 shrink-0 text-muted-foreground group-aria-expanded/trigger:inline" />
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Panel className="h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0">
                  <p className="pb-5 leading-relaxed text-pretty text-muted-foreground">{item.a}</p>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion.Root>
        </div>
      </div>
    </Section>
  )
}
