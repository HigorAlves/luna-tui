// The postmortem page of a resolved incident (RFC 0008, wave 5). The facts and the breach clocks are the machine's; the `postmortem`
// pack only writes the reading and the follow-up. Pure: this renders the page, its path and its one-line summary.

import type { PostmortemAnswer, PostmortemContext } from "@hardness/contracts";

import type { Incident } from "./incident.ts";

/** What the writer is shown: the incident without addresses, and the clocks of a successful breach assessment. */
export function postmortemContext(incident: Incident): PostmortemContext {
  const breach = incident.breach && !("error" in incident.breach) ? incident.breach : null;
  return {
    incident: {
      title: incident.title,
      severity: incident.severity,
      service: incident.service,
      startedAt: incident.startedAt,
      resolvedAt: incident.resolvedAt,
      timeline: incident.timeline.map(({ at, source, text }) => ({ at, source, text })),
      signals: incident.signals.slice(0, 20).map(({ source, title, severity, status, summary }) => ({ source, title, severity, status, summary })),
    },
    breach: breach ? { regimes: breach.regimes, clocks: breach.clocks as Record<string, string> } : null,
  };
}

const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "") || "incident";

/** `Incidents/YYYY-MM-DD-<slug>.md`, dated by when the incident started (UTC). */
export const postmortemPath = (incident: Pick<Incident, "title" | "startedAt">): string => `Incidents/${incident.startedAt.slice(0, 10)}-${slugOf(incident.title)}.md`;

const clocksOf = (incident: Incident): Array<[string, string]> => {
  const breach = incident.breach && !("error" in incident.breach) ? incident.breach : null;
  return breach ? Object.entries(breach.clocks as Record<string, string>).sort((a, b) => a[1].localeCompare(b[1])) : [];
};

/** `<severity> · <n> action items`, then the nearest clock when there is one. */
export function postmortemSummary(incident: Incident, answer: PostmortemAnswer): string {
  const n = answer.actionItems.length;
  const nearest = clocksOf(incident)[0];
  return `${incident.severity} · ${n} action item${n === 1 ? "" : "s"}${nearest ? ` · ⏱ ${nearest[0]} by ${nearest[1].slice(0, 10)}` : ""}`;
}

const list = (items: string[], none: string): string => (items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : none);

/** The page: the writer's text under the machine's own headings. The breach section is there only when an assessment found regimes. */
export function postmortemPage(incident: Incident, answer: PostmortemAnswer): string {
  const clocks = clocksOf(incident);
  const sections = [
    `# Postmortem: ${incident.title}`,
    [`Severity ${incident.severity}${incident.service ? `, service ${incident.service}` : ""}. Started ${incident.startedAt}${incident.resolvedAt ? `, resolved ${incident.resolvedAt}` : ""}.`, ""].join("\n"),
    `## Summary\n\n${answer.summary}`,
    `## Impact\n\n${answer.impact}`,
    ...(clocks.length > 0 ? [`## Breach and notification deadlines\n\n${clocks.map(([regime, due]) => `- ${regime}: by ${due}`).join("\n")}${answer.breachNotes ? `\n\n${answer.breachNotes}` : ""}`] : []),
    `## Timeline\n\n${list(answer.timeline.map((t) => `${t.at}: ${t.text}`), "Nothing was recorded.")}`,
    `## Root causes\n\n${list(answer.rootCauses, "Not known yet.")}`,
    `## Contributing factors\n\n${list(answer.contributingFactors, "None found.")}`,
    `## Action items\n\n${answer.actionItems.length > 0 ? answer.actionItems.map((a) => `- [ ] ${a.title} (owner: ${a.owner ?? "unassigned"}, due: ${a.due ?? "none"})`).join("\n") : "None."}`,
  ];
  return `${sections.join("\n\n")}\n`;
}
