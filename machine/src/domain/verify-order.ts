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
