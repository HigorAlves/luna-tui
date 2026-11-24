import { describe, expect, it } from "vitest";

import { NO_RETRIES, type Snapshot, transition } from "./transition.ts";

const at = (state: Snapshot["state"], overrides: Partial<Snapshot> = {}): Snapshot => ({ state, retries: { ...NO_RETRIES }, resumeTo: null, route: "feature", ...overrides });

describe("the setup gate", () => {
  it("starts with setup instead of triage when the start says the repo needs one", () => {
    expect(transition(at("draft"), { type: "start", setup: true })).toMatchObject({ state: "setup", effect: { kind: "run", stage: "setup" } });
    expect(transition(at("draft"), { type: "start" })).toMatchObject({ state: "triage" });
  });

  it("waits for you with the proposal, escalates when setup fails, and re-runs setup when sent back", () => {
    expect(transition(at("setup"), { type: "stage_done", outcome: "pass" })).toMatchObject({ state: "awaiting_setup", effect: { kind: "wait", gate: "awaiting_setup" } });
    expect(transition(at("setup"), { type: "stage_done", outcome: "fail" })).toMatchObject({ state: "escalated", resumeTo: "setup", reason: "setup failed" });
    expect(transition(at("awaiting_setup"), { type: "sent_back" })).toMatchObject({ state: "setup", effect: { kind: "run", stage: "setup" } });
  });

  it("goes on to triage once the config is approved, or closes a setup-only task", () => {
    expect(transition(at("awaiting_setup"), { type: "approved" })).toMatchObject({ state: "triage", effect: { kind: "run", stage: "triage" } });
    expect(transition(at("awaiting_setup", { route: "setup" }), { type: "approved" })).toMatchObject({ state: "closed", effect: { kind: "done" } });
  });

  it("resumes an escalated setup at setup", () => {
    expect(transition(at("escalated", { resumeTo: "setup" }), { type: "approved" })).toMatchObject({ state: "setup" });
  });
});
