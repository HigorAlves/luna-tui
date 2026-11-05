// Who must approve a plan, by the level of its risk (the repo's `plan.approvers`), and how a person's edit of that level
// meets the machine's: the machine's level is a floor. Pure.
import type { FactoryConfig, PlanRisk, Risk } from "@hardness/contracts";

export type ApproversConfig = FactoryConfig["plan"]["approvers"];

/** Two approver names are the same person's: compared NFKC-normalised, trimmed and lower-cased, so a trailing space or a width variant is no second name. */
export const sameName = (a: string, b: string): boolean => a.normalize("NFKC").trim().toLowerCase() === b.normalize("NFKC").trim().toLowerCase();

/** An owner as the name an approver would give: `@marta` is `marta`, `@org/team` is `org/team`, an email stays. */
const ownerName = (owner: string): string => owner.replace(/^@/, "");

export interface ApprovalRule {
  /** Distinct names the plan needs before it is approved. */
  needed: number;
  /** `required`: one of the names must not be among the owners; `skipped`: it would be, but no owners are known; `off`: not asked. */
  outside: "required" | "skipped" | "off";
  /** The rule in the gate's words. */
  text: string;
}

export function approvalRule(level: Risk, config: ApproversConfig, owners: readonly string[]): ApprovalRule {
  const needed = level === "high" ? config.high : level === "medium" ? config.medium : config.low;
  const wantsOutside = level === "high" && config.outside_owning_team && needed > 1;
  const outside: ApprovalRule["outside"] = !wantsOutside ? "off" : owners.length === 0 ? "skipped" : "required";
  const base = `Needs ${needed} approver${needed === 1 ? "" : "s"}.`;
  const text =
    outside === "required"
      ? `${base.replace(/\.$/, "")}: at least one must be someone not among the code map's owners (${owners.join(", ")}). This is an attestation: the machine takes the names as given and does not check them.`
      : outside === "skipped"
        ? `${base} No owners were found for this repo, so the outside-the-owning-team condition is skipped.`
        : base;
  return { needed, outside, text };
}

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
