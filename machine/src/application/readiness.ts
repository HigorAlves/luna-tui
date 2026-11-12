// What keeps the machine from doing its job, said once for `GET /health`: the compose healthcheck, `docker compose up --wait` and
// `make doctor` all read it. A machine started without these still serves the board, then fails every card at its first push or commit
// with a git error that points at the card, so it is told here, at the start.

export interface Readiness {
  /** The GitHub token the machine got (`GH_TOKEN` / `GITHUB_TOKEN`); null when it has none. */
  githubToken: string | null;
  /** `user.name` and `user.email` as git resolves them in the machine; null when either is unset. */
  identity: { name: string; email: string } | null;
  /** Why every stage is a stub (no Claude credential, no runner image, no egress image); null when stages are real, or when agents are off on purpose (`MACHINE_AGENTS=off`). */
  stubReason: string | null;
}

export function readinessProblems(state: Readiness): string[] {
  const problems: string[] = [];
  if (!state.githubToken) {
    problems.push("no GitHub token: GH_TOKEN is empty in the machine, so no card can push or open a PR. Start it with `pnpm start` (a bare `docker compose up` passes neither the token nor the git identity)");
  }
  if (!state.identity) {
    problems.push("git has no identity: LUNA_GIT_NAME and LUNA_GIT_EMAIL were not passed to the machine, so no card can commit. Start it with `pnpm start`, or set both");
  }
  if (state.stubReason) problems.push(`every stage is a stub: ${state.stubReason}`);
  return problems;
}
