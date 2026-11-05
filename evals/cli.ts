// `pnpm eval` entry: the subcommands of the ground-truth loop and the scorecard, and the replay run by default.
//
//   pnpm eval --pack <p> --engine <e> ...                    replay a pack's cases (run.ts)
//   pnpm eval harvest --pack <decision> [--since <date>] [--with-truth]
//   pnpm eval dataset push --pack <decision> [--queue <name>] [--records]
//   pnpm eval dataset pull --pack <decision>
import { PackId } from "@hardness/contracts";
import { DecisionLog, machineStateDir } from "@hardness/machine/decisions";
import { buildTelemetry, tracesFromEnv } from "@hardness/machine/telemetry";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { decisionPack } from "./src/labels.ts";
import { runHarvest, runPull, runPush } from "./src/loop.ts";

const EVALS = dirname(fileURLToPath(import.meta.url));
const [command, sub] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`eval: ${message}\n`);
  process.exit(2);
}

const decisionOf = (raw: string | undefined): PackId => {
  const pack = PackId.safeParse(raw).data;
  if (!pack || !decisionPack(pack)) fail("--pack must be a decision pack");
  return pack;
};

/** The state dir's log, read by the machine's own rule for where the state dir is. */
const log = () => new DecisionLog({ stateDir: machineStateDir() });

async function telemetry() {
  const found = await buildTelemetry(tracesFromEnv());
  if (found.mode === "off") fail("no Laminar: set LMNR_PROJECT_API_KEY (or put the key in ~/.config/hardness/lmnr-project-api-key)");
  return found;
}

if (command === "harvest") {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { pack: { type: "string" }, since: { type: "string" }, "with-truth": { type: "boolean", default: false } } });
  const since = values.since ? new Date(values.since) : undefined;
  if (since && Number.isNaN(since.getTime())) fail("--since must be a date, like 2026-11-01");
  const pack = decisionOf(values.pack);
  const out = await runHarvest(EVALS, pack, log(), { ...(since ? { since } : {}), withTruth: values["with-truth"] });
  console.log(`wrote ${out.written.length}: ${out.written.join(", ") || "-"}\nkept (already cases) ${out.kept.length}`);
  for (const r of out.refused) console.log(`refused ${r.id}: ${r.reason}`);
} else if (command === "dataset" && (sub === "push" || sub === "pull")) {
  const { values } = parseArgs({ args: process.argv.slice(4), options: { pack: { type: "string" }, queue: { type: "string" }, records: { type: "boolean", default: false } } });
  const pack = decisionOf(values.pack);
  const t = await telemetry();
  if (sub === "push") {
    const records = values.queue && values.records ? await log().list(pack) : [];
    const out = await runPush(EVALS, pack, t, { ...(values.queue ? { queue: values.queue } : {}), records });
    console.log(`dataset ${out.dataset.name}: ${out.dataset.pushed} datapoint(s) pushed`);
    if (out.queue) console.log(`queue ${out.queue.name}: ${out.queue.pushed} item(s) pushed`);
  } else {
    const out = await runPull(EVALS, pack, t);
    console.log(`wrote ${out.written.length}: ${out.written.join(", ") || "-"}\nkept (already cases) ${out.kept.length}`);
    for (const s of out.skipped) console.log(`skipped ${s.taskId}: ${s.reason}`);
  }
  await t.flush();
} else {
  await import("./run.ts");
}
