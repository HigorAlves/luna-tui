// What the machine remembers of a card when it closes (RFC 0007, M2): its own records, rendered by a template with no model, one
// short `fact` item each (400 characters at most). The only text taken from a card is its title, flattened and capped (the vector
// shortlist for triage matches on it); everything else is a number, an enum or a path. Pure but for `closeFacts`'s caller.
import { MEMORY_TEXT_MAX, EscalationReason } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import type { MemoryViewer } from "../domain/memory-datasets.ts";
import type { MemoryItemDraft } from "./memory.ts";
import type { RetroFacts } from "./stages/memory.ts";

export interface CloseFactsInput {
  card: { id: string; title: string };
  repo: string;
  /** The card's source as memory names it (`viewerOfCard(...).source`). */
  source: Extract<MemoryViewer, { kind: "card" }>["source"];
  facts: RetroFacts;
  /** Verify's and CI's findings: severity, category and file only (never the title or the body). */
  findings: Array<{ severity: string; category?: string | undefined; path: string }>;
  /** Each time the card escalated: the machine's reason (the enum) and the person's correction when there was one. */
  escalations: Array<{ reason: string | null; correctedTo: string | null }>;
  /** Build's scope reds: the check that failed (the machine's own vocabulary) and the file. */
  scopeReds: Array<{ check: string; path: string | null }>;
  /** The class of each CI failure the card met (`test`, `lint`, `build`, `flake`, `infra`, `drift`, `conflict`). */
  ciClasses: string[];
  /** What intake's dedup said: a related card, or merged into one. */
  dedup: "related" | "merged" | null;
  /** The files the card touched (the plan's touchpoints and the findings' paths) and the commit it ended at. */
  files: string[];
  commit: string | null;
}

const cap = (text: string): string => (text.length > MEMORY_TEXT_MAX ? `${text.slice(0, MEMORY_TEXT_MAX - 1)}…` : text);
const enumOf = (value: string | null): string | null => (value !== null && EscalationReason.safeParse(value).success ? value : null);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const count = <T>(items: T[], key: (item: T) => string): Array<[string, number]> => {
  const seen = new Map<string, number>();
  for (const item of items) seen.set(key(item), (seen.get(key(item)) ?? 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]);
};
const word = (text: string): string => safe(text).replace(/[^A-Za-z0-9_ -]/g, "").slice(0, 40) || "unknown";

/** The facts of a closed card as item drafts. */
export function closeFacts(input: CloseFactsInput): MemoryItemDraft[] {
  const { facts } = input;
  const lines = facts.actual.added + facts.actual.removed;
  const files = [...new Set(input.files)].slice(0, 50);
  const make = (kind: MemoryItemDraft["kind"], text: string, own: string[] = files): MemoryItemDraft => ({
    kind,
    repo: input.repo,
    source: input.source,
    anchors: { files: [...new Set(own)].slice(0, 50), commit: own.length > 0 ? input.commit : null },
    provenance: { by: "machine", card: input.card.id, run: null, pack: null },
    trust: "fact",
    text: cap(text),
  });
  const out: MemoryItemDraft[] = [];

  // The Triage Record against its actuals, and the plan's estimate against the diff: one outcome line, the one triage reads for similar cards.
  const predicted = [`size ${facts.predicted.size ?? "unknown"}`, `risk ${facts.predicted.risk ?? "unknown"}`, ...(facts.predicted.urgency ? [`urgency ${facts.predicted.urgency}`] : []), ...(facts.predicted.estLoc !== null ? [`planned ${facts.predicted.estLoc} lines`] : [])].join(", ");
  const { retries } = facts.actual;
  out.push(
    make(
      "outcome",
      `Card ${word(input.card.title)}: predicted ${predicted}; changed ${lines} lines (+${facts.actual.added} -${facts.actual.removed}), ${plural(retries.total, "retry", "retries")} (verify ${retries.verify}, e2e ${retries.e2e}, ci ${retries.ci}), ${plural(facts.actual.escalations, "escalation")}${facts.actual.format ? `, evidence ${facts.actual.format}` : ""}, ${facts.actual.durationMin ?? "?"} min.`,
    ),
  );

  for (const [key, n] of count(input.findings, (f) => `${f.severity}|${f.category ?? "uncategorised"}|${f.path}`)) {
    const [severity, category, path] = key.split("|") as [string, string, string];
    out.push(make("finding", `Verify raised ${n === 1 ? "a" : `${n}`} ${word(severity)} ${word(category)} finding${n === 1 ? "" : "s"} in ${path.slice(0, 200)}.`, [path]));
  }
  for (const e of input.escalations) {
    const reason = enumOf(e.reason);
    const corrected = enumOf(e.correctedTo);
    out.push(make("escalation", `The card escalated${reason ? ` as ${reason}` : ""}${corrected && corrected !== reason ? `; a person corrected the reason to ${corrected}` : ""}.`));
  }
  for (const [key, n] of count(input.scopeReds, (r) => `${r.check}|${r.path ?? ""}`)) {
    const [check, path] = key.split("|") as [string, string];
    out.push(make("finding", `Build's scope check failed ${plural(n, "time")} on ${word(check)}${path ? ` in ${path.slice(0, 200)}` : ""}.`, path ? [path] : []));
  }
  for (const [cls, n] of count(input.ciClasses, (c) => word(c))) out.push(make("outcome", `CI failed ${plural(n, "time")} with class ${cls}.`));
  if ((facts.actual.reviewRounds ?? 0) > 0) out.push(make("outcome", `The PR took ${plural(facts.actual.reviewRounds!, "review fix round")} across ${plural(facts.actual.reviewThreads ?? 0, "thread")}.`));
  if (input.dedup) out.push(make("decision", `Intake found this card ${input.dedup === "merged" ? "was merged into an existing card" : "related to an existing card"}.`, []));
  return out;
}
