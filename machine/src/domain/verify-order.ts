// The order of the verifying stage, as the diagram draws it: the environment check, the review, and only
// when no blocker stands the checks. Pure: it names the next step from what has already run, and the stage follows it.
export interface VerifyProgress {
  /** The environment Verify has against the one Build recorded. */
  env: "matched" | "mismatch";
  /** `null` until the review ran; `skipped` when agents are off. */
  review: "done" | "skipped" | null;
  /** Blockers the review left standing. */
  blockers: number;
  /** `null` until the checks, the sweep and the coverage ran. */
  checks: "green" | "red" | null;
}

export type VerifyStep = "review" | "checks" | "report" | "fail";

export function verifySteps(state: VerifyProgress): VerifyStep {
  if (state.env === "mismatch") return "fail";
  if (state.review === null) return "review";
  if (state.blockers > 0) return "fail";
  if (state.checks === null) return "checks";
  return state.checks === "green" ? "report" : "fail";
}

/** What runs after the browser run (RFC 0013, Routing). Phase 3 adds `design_parity` when the card has a design reference. */
export type DesignStep = "a11y_audit";

export interface DesignProgress {
  off: boolean;
  cardOff: boolean;
  qa: "web" | "none";
  touchesRendered: boolean;
  hasDesignRef: boolean;
  browserRun: "pass" | "fail" | "skipped";
}

/** The design steps after the browser run, in order. Only a passing browser run is audited: a page that fails its scenarios goes back to Build first. */
export function designSteps(state: DesignProgress): DesignStep[] {
  if (state.off || state.cardOff || state.qa !== "web" || !state.touchesRendered || state.browserRun !== "pass") return [];
  return ["a11y_audit"];
}
