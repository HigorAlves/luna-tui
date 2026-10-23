// Entry point for `pnpm dev`: migrates the database, recovers tasks a previous run left
// mid-stage, then serves the API on localhost.
import { serve } from "@hono/node-server";
import type { TaskState } from "@hardness/contracts";

import { createApp } from "./api/app.ts";
import { Bus } from "./api/bus.ts";
import { toEvent, toTask } from "./api/serialize.ts";
import { loadConfig } from "./config.ts";
import { createDataSource } from "./db/data-source.ts";
import type { EventRow } from "./db/entities.ts";
import { Watcher } from "./herdr/watch.ts";
import { Pipeline } from "./pipeline/pipeline.ts";
import { loadCredential } from "./sandbox/credentials.ts";
import { imageExists, removeLeftoverContainers } from "./sandbox/docker.ts";
import { agentRunners } from "./stages/agents.ts";
import type { StageRunner } from "./stages/runner.ts";
import { shipRunner } from "./stages/ship.ts";
import { StubStages } from "./stages/stubs.ts";

const config = loadConfig();
const db = createDataSource(config.databaseUrl);
await db.initialize();
const applied = await db.runMigrations();
if (applied.length > 0) {
  console.log(`applied migrations: ${applied.map((m) => m.name).join(", ")}`);
}

const bus = new Bus();
const stubs = new StubStages();
const watcher = new Watcher(config.herdrBin);

/** Real agents for Triage and Implementer when everything they need is there; stubs otherwise. */
async function realStages(): Promise<Partial<Record<TaskState, StageRunner>>> {
  if (!config.agents) {
    console.log("agents off (MACHINE_AGENTS=off): every stage is a stub");
    return {};
  }
  const credential = await loadCredential();
  if (!credential) {
    console.warn("no Claude credential in ~/.config/hardness: every stage is a stub");
    return {};
  }
  if (!(await imageExists(config.runnerImage))) {
    console.warn(`image ${config.runnerImage} is missing (pnpm runner:build): every stage is a stub`);
    return {};
  }
  const removed = await removeLeftoverContainers();
  if (removed > 0) console.log(`removed ${removed} leftover stage container(s)`);
  return agentRunners({
    image: config.runnerImage,
    credential,
    worktreesDir: config.worktreesDir,
    stateDir: config.stateDir,
    watcher,
  });
}

const real = await realStages();
/** Shipping needs only git and gh, not a Claude credential, so it always runs for real. */
const runnerFor = (stage: TaskState): StageRunner =>
  stage === "shipping" ? shipRunner : real[stage] ?? stubs.runnerFor(stage);

/** Streams each logged event, plus the whole task whenever its state may have changed. */
function publish(event: EventRow): void {
  bus.publish({ type: "task.event", event: toEvent(event) });
  if (event.kind === "transition" || event.kind === "task.created") {
    pipeline.get(event.taskId).then(
      (task) => bus.publish({ type: "task.updated", task: toTask(task) }),
      (error: unknown) => console.error("could not publish task update", error),
    );
  }
  if (event.kind === "transition" && event.payload.to === "closed") {
    watcher.close(event.taskId).catch((error: unknown) => console.error("could not close watch tab", error));
  }
}

const pipeline = new Pipeline(db, runnerFor, { onEvent: publish, maxConcurrentTasks: config.maxConcurrentTasks });
const recovered = await pipeline.recover();
if (recovered > 0) console.log(`escalated ${recovered} task(s) left mid-stage by the last run`);

const app = createApp({ pipeline, bus, watcher, stubs });
const server = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  const agents = [...Object.keys(real), "shipping"];
  console.log(
    `machine listening on http://127.0.0.1:${info.port} · real stages: ${agents.join(", ")} · up to ${config.maxConcurrentTasks} task(s) at once`,
  );
});

async function shutdown(): Promise<void> {
  server.close();
  await pipeline.shutdown();
  await db.destroy();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
