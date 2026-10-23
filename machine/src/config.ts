import { homedir } from "node:os";
import { join } from "node:path";

/** Settings read from the environment. Defaults match compose.dev.yml and herdr's config. */
export interface Config {
  databaseUrl: string;
  port: number;
  /** Run Triage and Implementer as real agents. Off: every stage is a stub. */
  agents: boolean;
  /** Docker image for stage containers, built by `runner:build`. */
  runnerImage: string;
  /** Task worktrees go in `<worktreesDir>/<repo>/<branch>`, like `herdr worktree`. */
  worktreesDir: string;
  /** Run inputs, outputs and transcripts. */
  stateDir: string;
  herdrBin: string;
}

export const DEFAULT_DATABASE_URL = "postgres://hardness:hardness@127.0.0.1:5433/hardness";
export const DEFAULT_PORT = 4317;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.MACHINE_PORT === undefined ? DEFAULT_PORT : Number(env.MACHINE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MACHINE_PORT must be a port number, got "${env.MACHINE_PORT}"`);
  }
  const home = env.HOME ?? homedir();
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    port,
    agents: env.MACHINE_AGENTS !== "off",
    runnerImage: env.RUNNER_IMAGE ?? "hardness-runner:dev",
    worktreesDir: env.WORKTREES_DIR ?? join(home, "Developer", "worktrees"),
    stateDir: env.MACHINE_STATE_DIR ?? join(home, ".local", "state", "hardness"),
    herdrBin: env.HERDR_BIN ?? "herdr",
  };
}
