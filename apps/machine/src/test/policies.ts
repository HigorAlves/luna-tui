// A policy store for tests that walk a card through Evidence to its approval gate: since wave 12b the gate exists only with `ship.preview: on`.
import { DEFAULT_POLICY, type Policy } from "../domain/policy.ts";

// The approvers rule is pinned to the two-names High rule: these tests exercise it, and the default is one name.
export const PREVIEW_ON: Policy = { ...DEFAULT_POLICY, factory: { ...DEFAULT_POLICY.factory, plan: { ...DEFAULT_POLICY.factory.plan, approvers: { ...DEFAULT_POLICY.factory.plan.approvers, high: 2 } }, ship: { ...DEFAULT_POLICY.factory.ship, preview: "on" } } };
export const previewOn: { for: () => Promise<Policy> } = { for: async () => PREVIEW_ON };
