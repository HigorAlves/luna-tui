// The states a CI check may be in, in GitHub's own vocabulary (uppercase), shared by the CI stage and the change evidence.

/** A check that has not ended. */
export const PENDING_CHECK_STATES: ReadonlySet<string> = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
/** A check that ended red. */
export const FAILED_CHECK_STATES: ReadonlySet<string> = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE"]);
