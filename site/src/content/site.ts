import facts from "./facts.json"

export { facts }

export const REPO = "https://github.com/HigorAlves/tui-harness"
export const LUNA = "https://luna-sigma-nine.vercel.app/"
export const ORC = "https://orc.higoralves.dev"
export const HERDR = "https://herdr.dev"

export const nav = [
  { label: "How it runs", href: "#line" },
  { label: "Safety", href: "#safe" },
  { label: "Install", href: "#install" },
  { label: "GitHub", href: REPO },
]

export const factsLine = `facts from the repo · ${facts.states} states · ${facts.packs} packs · ${facts.images} images`
