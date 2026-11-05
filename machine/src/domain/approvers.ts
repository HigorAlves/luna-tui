// Who must approve a plan, by the level of its risk (the repo's `plan.approvers`), and how a person's edit of that level
// meets the machine's: the machine's level is a floor. Pure.
import type { FactoryConfig, PlanRisk, Risk } from "@hardness/contracts";

import { safe } from "./evidence-markdown.ts";

export type ApproversConfig = FactoryConfig["plan"]["approvers"];

/** Two approver names are the same person's: compared NFKC-normalised, trimmed and lower-cased, so a trailing space or a width variant is no second name. */
export const sameName = (a: string, b: string): boolean => a.normalize("NFKC").trim().toLowerCase() === b.normalize("NFKC").trim().toLowerCase();

/** An owner as the name an approver would give: `@marta` is `marta`, `@org/team` is `org/team`, an email stays. */
const ownerName = (owner: string): string => owner.replace(/^@/, "");

/** What the outside-the-owning-team condition can be checked against. The owners are CODEOWNERS' alone: never a model's word (the code map's `owners` is display only). */
export type OwnersState = { state: "ok"; owners: string[] } | { state: "skipped" } | { state: "not_checked"; reason: string };

/** What `graph.owners` answered, for `ownersStateOf`: null when there is no graph or port, "failed" when the call threw. */
export type OwnersFound = { owners: Array<{ owners: string[] }>; codeowners: boolean; dropped?: number } | null | "failed";

export function ownersStateOf(found: OwnersFound): OwnersState {
  if (found === null || found === "failed") return { state: "not_checked", reason: "the code owners could not be read" };
  if (found.dropped && found.dropped > 0) return { state: "not_checked", reason: `${found.dropped} paths could not be looked up in CODEOWNERS` };
  const owners = [...new Set(found.owners.flatMap((o) => o.owners))];
  return !found.codeowners || owners.length === 0 ? { state: "skipped" } : { state: "ok", owners };
}

export interface ApprovalRule {
  /** Distinct names the plan needs before it is approved. */
  needed: number;
  /** `required`: one of the names must not be among the owners; `skipped`: it would be, but CODEOWNERS names no one for these files; `not_checked`: it would be, but the owners could not be read; `off`: not asked. */
  outside: "required" | "skipped" | "not_checked" | "off";
  /** The rule in the gate's words. */
  text: string;
}

/** An owner string as the machine prints it: flattened, no markup, capped. Ten at most. */
const shown = (owners: readonly string[]): string => owners.slice(0, 10).map((o) => safe(o).slice(0, 60)).join(", ");

export function approvalRule(level: Risk, config: ApproversConfig, owners: OwnersState): ApprovalRule {
  const needed = level === "high" ? config.high : level === "medium" ? config.medium : config.low;
  const wantsOutside = level === "high" && config.outside_owning_team && needed > 1;
  const outside: ApprovalRule["outside"] = !wantsOutside ? "off" : owners.state === "ok" ? "required" : owners.state;
  const base = `Needs ${needed} approver${needed === 1 ? "" : "s"}.`;
  let text = base;
  if (outside === "required" && owners.state === "ok") {
    text = `${base.replace(/\.$/, "")}: at least one must be someone not among the code owners (${shown(owners.owners)}). This is an attestation: the machine takes the names as given and does not check them.`;
    if (owners.owners.every((o) => o.replace(/^@/, "").includes("/"))) text += " The owners are teams: the machine cannot tell whether a name is inside one.";
  } else if (outside === "skipped") text = `${base} No CODEOWNERS rule matches the files of this plan, so the outside-the-owning-team condition is skipped.`;
  else if (outside === "not_checked" && owners.state === "not_checked") text = `${base} The outside-the-owning-team condition could not be checked (${safe(owners.reason).slice(0, 100)}), so it is not enforced.`;
  return { needed, outside, text };
}

/** The files the outside rule asks CODEOWNERS about: the map's change and test files and the plan's step files, once each. */
export const ruleFiles = (map: { files: Array<{ path: string; role: string }> } | null | undefined, stepFiles: readonly string[]): string[] => [...new Set([...(map?.files.filter((f) => f.role !== "read").map((f) => f.path) ?? []), ...stepFiles])];

/** Whether at least one of the names is not among the owners. */
export function outsideSatisfied(names: readonly string[], owners: readonly string[]): boolean {
  return names.some((name) => !owners.some((owner) => sameName(name, ownerName(owner))));
}

const ORDER: readonly Risk[] = ["none", "low", "medium", "high"];

/** A person's level for the plan's risk against the machine's. A level at or above the machine's applies at once; a lower one is kept with its
 *  reason and shown, and `risk.level` (what the approvers rule and Ship read) stays the machine's. `machine` is the machine's own level, kept from the first edit. */
export function applyRiskOverride(current: PlanRisk & { machine?: Risk }, edit: { level: Risk; reason: string }): { risk: PlanRisk & { machine: Risk }; override: { level: Risk; reason: string; applied: boolean } } {
  const machine = current.machine ?? current.level;
  const applied = ORDER.indexOf(edit.level) >= ORDER.indexOf(machine);
  return { risk: { ...current, level: applied ? edit.level : machine, machine }, override: { level: edit.level, reason: edit.reason, applied } };
}
