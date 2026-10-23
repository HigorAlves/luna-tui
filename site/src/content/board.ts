export type BadgeTone = "muted" | "you" | "orc"

export type BoardCard = {
  title: string
  badge?: { text: string; tone: BadgeTone }
  dim?: boolean
  /** slides to the next column and back on a loop */
  slides?: boolean
}

export type BoardColumn = { name: string; count: number; cards: BoardCard[] }

export const board: BoardColumn[] = [
  { name: "Backlog", count: 2, cards: [{ title: "#45 Export CSV from reports" }, { title: "#46 Retry on 429 in sync job" }] },
  { name: "Intake", count: 1, cards: [{ title: "#44 Empty-cart message", badge: { text: "draft", tone: "muted" } }] },
  { name: "Triage", count: 1, cards: [{ title: "#43 Login error copy", badge: { text: "needs you · plan", tone: "you" }, slides: true }] },
  { name: "Approved", count: 0, cards: [] },
  { name: "Build", count: 1, cards: [{ title: "#39 Totals ignore quantity", badge: { text: "implementing · slice 2/3", tone: "orc" } }] },
  { name: "Verify", count: 1, cards: [{ title: "#37 Rate-limit backoff", badge: { text: "verifying · suite", tone: "orc" } }] },
  { name: "Evidence", count: 0, cards: [] },
  { name: "Ship", count: 1, cards: [{ title: "#35 Dark-mode toggle", badge: { text: "needs you · ship", tone: "you" } }] },
  { name: "Done", count: 3, cards: [{ title: "#31 Footer links", dim: true }, { title: "#30 Health endpoint", dim: true }] },
]

export const boardMachine = { address: "127.0.0.1:4317", status: "online", slots: "2/4 slots" }

export const boardKeys = [
  { key: "a", label: "approve" },
  { key: "r", label: "send back" },
  { key: "f", label: "watch" },
  { key: "o", label: "issue" },
  { key: "F", label: "floor" },
  { key: "X", label: "abort" },
]
