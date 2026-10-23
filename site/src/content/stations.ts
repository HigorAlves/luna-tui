export type StationKind = "orc" | "host" | "you"

export type Station = { num?: string; name: string; kind: StationKind; kindLabel: string; detail: string; gate?: boolean }

export const stations: Station[] = [
  { num: "01", name: "Intake", kind: "host", kindLabel: "host", detail: "GitHub poller · /orc:triage" },
  { num: "02", name: "Triage", kind: "orc", kindLabel: "orc pack", detail: "orc-prd-analyzer · read-only" },
  { name: "Plan", kind: "you", kindLabel: "you", detail: "a approve · r send back", gate: true },
  { num: "03", name: "Test design", kind: "orc", kindLabel: "orc pack", detail: "orc-test-author · tests locked after" },
  { name: "Tests", kind: "you", kindLabel: "you", detail: "file list on the card", gate: true },
  { num: "04", name: "Implementing", kind: "orc", kindLabel: "orc pack", detail: "orc-implementer · one commit per slice" },
  { num: "05", name: "Verifying", kind: "host", kindLabel: "host + then orc", detail: "suite · lint · typecheck · review pack" },
  { num: "06", name: "E2E", kind: "orc", kindLabel: "orc pack", detail: "orc-qa-validator · QA image" },
  { num: "07", name: "Delivering", kind: "host", kindLabel: "host", detail: "push · draft PR · Closes #N" },
  { num: "08", name: "CI watch", kind: "host", kindLabel: "host + orc on red", detail: "fixable · flake · infra" },
  { num: "09", name: "Evidence", kind: "host", kindLabel: "host", detail: "qa-manifest → artifacts" },
  { name: "Ship", kind: "you", kindLabel: "you", detail: "evidence · rules · a / A", gate: true },
  { num: "10", name: "Shipping", kind: "host", kindLabel: "host + retro", detail: "PR ready · proposed rules" },
  { num: "11", name: "Close", kind: "host", kindLabel: "host", detail: "rules commit · orc-state close" },
]
