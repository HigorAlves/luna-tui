export const COMMIT_COLORS = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"] as const

/** "needs you" tickets wait on a person (warning); everything else is a running stage (brand). */
export const accentOf = (detail: string) => (detail.startsWith("needs you") ? "#f5c451" : "#39d353")
