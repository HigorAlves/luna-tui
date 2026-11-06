// A policy store for tests that walk a card through Evidence to its approval gate: since wave 12b the gate exists only with `ship.preview: on`.
import { DEFAULT_POLICY, type Policy } from "../domain/policy.ts";

export const PREVIEW_ON: Policy = { ...DEFAULT_POLICY, factory: { ...DEFAULT_POLICY.factory, ship: { ...DEFAULT_POLICY.factory.ship, preview: "on" } } };
export const previewOn: { for: () => Promise<Policy> } = { for: async () => PREVIEW_ON };
