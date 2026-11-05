import { CARD_EVENT_NAMES, type CardEventName } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { PENDING_EVENTS, namesOf } from "./card-events.ts";

const row = (kind: string, payload: Record<string, unknown> = {}) => ({ kind, payload });
const moved = (from: string, to: string, extra: Record<string, unknown> = {}) => row("transition", { event: "stage_done", from, to, ...extra });
const finished = (stage: string, status: string, detail: Record<string, unknown> = {}) => row("stage.finished", { stage, status, outcome: status === "passed" ? "pass" : "fail", detail });

/** One fixture per fact the machine logs today, and the names the diagram gives it. */
const FIXTURES: Array<[string, ReturnType<typeof row>, CardEventName[]]> = [
  ["a task made", row("task.created", { title: "t" }), ["card.created"]],
  ["setup asked", moved("setup", "awaiting_setup"), ["card.setup_needed"]],
  ["setup confirmed", row("transition", { event: "approved", from: "awaiting_setup", to: "triage" }), ["card.setup_done"]],
  ["triage passed", finished("triage", "passed"), ["card.triaged"]],
  ["questions asked", moved("triage", "awaiting_answers"), ["card.answers_needed"]],
  ["questions answered", row("transition", { event: "answered", from: "awaiting_answers", to: "triage" }), ["card.answered"]],
  ["plan stage passed with scenarios", finished("test_design", "passed", { cases: [] }), ["card.planned", "card.tests_designed"]],
  ["plan gate opened", moved("test_design", "awaiting_approval"), ["card.approval_needed"]],
  ["plan approved", row("transition", { event: "approved", from: "awaiting_approval", to: "implementing" }), ["card.approved"]],
  ["archived as rejected", row("transition", { event: "archive", from: "awaiting_approval", to: "archived", archiveReason: "rejected" }), ["card.archived", "card.rejected"]],
  ["archived as duplicate", row("transition", { event: "archive", from: "triage", to: "archived", archiveReason: "duplicate" }), ["card.archived"]],
  ["build started", row("stage.started", { stage: "implementing", attempt: 1 }), ["build.started"]],
  ["a slice committed in the ledger is not a checkpoint: only a push that landed is", row("stage.slice.committed", { id: 1 }), []],
  ["a scenario's red and green are rows of their own, not diagram names", row("scenario.red", { scenario: "S1" }), []],
  ["an escalation from Build names build.escalated, and its row carries the decided reason", row("transition", { from: "implementing", to: "escalated", escalation: "flaky_tests" }), ["build.escalated"]],
  ["a push that landed", row("build.checkpoint", { sha: "a".repeat(40), follows: "red" }), ["build.checkpoint"]],
  ["build paused", row("transition", { event: "rate_limited", from: "implementing", to: "paused_rate_limit" }), ["build.paused"]],
  ["build escalated", moved("implementing", "escalated", { escalation: "too_complex" }), ["build.escalated"]],
  ["build done", finished("implementing", "passed"), ["build.done"]],
  ["verify started", row("stage.started", { stage: "verifying", attempt: 1 }), ["verify.started"]],
  ["findings reported", row("verify.findings", { count: 2 }), ["verify.findings"]],
  ["e2e done", finished("e2e", "passed"), ["verify.e2e_done"]],
  ["pr opened", row("stage.pr.opened", { number: 3 }), ["pr.opened"]],
  ["ci settled", row("ci.status", { state: "green" }), ["ci.status"]],
  ["verify done", finished("ci_watch", "passed"), ["verify.done"]],
  ["evidence started", row("stage.started", { stage: "evidence", attempt: 1 }), ["evidence.started"]],
  ["media ingested", row("stage.evidence.media_ready", { count: 2 }), ["evidence.media_ready"]],
  ["pack published", row("stage.evidence.published", { assets: 1 }), ["evidence.published"]],
  ["head moved", moved("shipping", "escalated", { escalation: "head_moved" }), ["evidence.stale"]],
  ["a review item classified", row("stage.ship.event", { class: "comment" }), ["ship.event"]],
  ["ready to merge", row("stage.ship.ready", {}), ["ship.ready"]],
  ["a person must merge", row("stage.ship.approval_needed", {}), ["ship.approval_needed"]],
  ["merged", row("task.shipped", { number: 3 }), ["ship.merged"]],
  ["closed", row("task.closed", { steps: [] }), ["card.closed"]],
  ["rules applied", row("card.learned", {}), ["card.learned"]],
  ["fast lane taken", row("card.fast_lane", {}), ["card.fast_lane"]],
];

describe("namesOf", () => {
  for (const [fact, event, names] of FIXTURES) {
    it(`names ${fact}`, () => {
      expect(namesOf(event)).toEqual(names);
    });
  }

  it("reads a row a stage result logged (`stage.` in front) the same as one logged directly", () => {
    expect(namesOf(row("stage.verify.findings", { count: 1 }))).toEqual(["verify.findings"]);
  });

  it("never lets a row a stage reported carry a name only the machine may say", () => {
    for (const name of ["ship.merged", "card.closed", "card.approved", "card.rejected", "card.archived", "card.created", "card.triaged", "build.done", "card.learned"]) {
      expect(namesOf(row(`stage.${name}`, {}))).toEqual([]);
    }
    // what a stage may report still reads
    for (const name of ["pr.opened", "ship.event", "ship.ready", "ship.approval_needed", "evidence.published", "verify.findings", "ci.status", "evidence.media_ready"]) {
      expect(namesOf(row(`stage.${name}`, {}))).toEqual([name]);
    }
  });

  it("names nothing the diagram has no name for, and nothing for a failed stage", () => {
    for (const e of [row("stage.note", { note: "x" }), row("stage.engine", {}), row("plan.edited", {}), row("jira.moved", {}), finished("triage", "failed"), finished("implementing", "failed"), moved("triage", "plan"), row("stage.started", { stage: "triage" })]) {
      expect(namesOf(e)).toEqual([]);
    }
  });

  it("does not call a rate limit outside build, or an escalation outside build, a build event", () => {
    expect(namesOf(row("transition", { event: "rate_limited", from: "triage", to: "paused_rate_limit" }))).toEqual([]);
    expect(namesOf(moved("verifying", "escalated", { escalation: "env_broken" }))).toEqual([]);
  });

  it("produces every name of the diagram except the ones listed as pending", () => {
    const produced = new Set(FIXTURES.flatMap(([, event]) => namesOf(event)));
    const missing = CARD_EVENT_NAMES.filter((n) => !produced.has(n));
    expect(missing).toEqual(Object.keys(PENDING_EVENTS));
    for (const name of Object.keys(PENDING_EVENTS)) expect(produced.has(name as CardEventName)).toBe(false);
    expect(PENDING_EVENTS["card.merged"]).toBe(14);
  });
});
