// `pnpm eval` entry: the subcommands of the ground-truth loop and the scorecard, and the replay run by default.
//
//   pnpm eval --pack <p> --engine <e> ...                    replay a pack's cases (run.ts)
//   pnpm eval harvest --pack <decision> [--since <date>] [--with-truth] [--all]
//   pnpm eval dataset push --pack <decision> [--queue <id or name>] [--records]
//   pnpm eval dataset pull --pack <decision>
//   pnpm eval scorecard                       evals/scorecard.md over every decision baseline
//   pnpm eval defaults [--write]              the default per slot by the scorecard's rule; --write updates contracts/src/decision-defaults.json
import { DECISION_DEFAULTS, PACKS, PackId, decisionEngines } from "@hardness/contracts";
import { DecisionLog, machineStateDir } from "@hardness/machine/decisions";
import { buildTelemetry, tracesFromEnv } from "@hardness/machine/telemetry";
import { collectorGate } from "./src/collector.ts";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { decisionPack } from "./src/labels.ts";
import { runHarvest, runPull, runPush } from "./src/loop.ts";
import { type Proposal, buildDefaultsFile, loadBaselines, proposeDefaults, renderScorecard } from "./src/scorecard.ts";

const EVALS = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_FILE = resolve(EVALS, "..", "contracts", "src", "decision-defaults.json");
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
  const gate = await collectorGate(tracesFromEnv());
  if (!gate.ok) fail(gate.line);
  const found = await buildTelemetry(tracesFromEnv());
  if (found.mode === "off") fail("no Laminar: set LMNR_PROJECT_API_KEY (or put the key in ~/.config/hardness/lmnr-project-api-key)");
  return found;
}

if (command === "harvest") {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { pack: { type: "string" }, since: { type: "string" }, "with-truth": { type: "boolean", default: false }, all: { type: "boolean", default: false } } });
  const since = values.since ? new Date(values.since) : undefined;
  if (since && Number.isNaN(since.getTime())) fail("--since must be a date, like 2026-11-01");
  const pack = decisionOf(values.pack);
  const out = await runHarvest(EVALS, pack, log(), { ...(since ? { since } : {}), withTruth: values["with-truth"], all: values.all });
  console.log(`wrote ${out.written.length}: ${out.written.join(", ") || "-"}\nkept (already cases) ${out.kept.length}`);
  for (const r of out.refused) console.log(`refused ${r.id}: ${r.reason}`);
} else if (command === "dataset" && (sub === "push" || sub === "pull")) {
  const { values } = parseArgs({ args: process.argv.slice(4), options: { pack: { type: "string" }, queue: { type: "string" }, records: { type: "boolean", default: false }, all: { type: "boolean", default: false } } });
  const pack = decisionOf(values.pack);
  const t = await telemetry();
  if (sub === "push") {
    const records = values.queue && values.records ? await log().list(pack) : [];
    const out = await runPush(EVALS, pack, t, { ...(values.queue ? { queue: values.queue } : {}), records, all: values.all });
    console.log(`dataset ${out.dataset.name}: ${out.dataset.pushed} datapoint(s) pushed`);
    if (out.queue) console.log(`queue ${out.queue.name}: ${out.queue.pushed} item(s) pushed`);
  } else {
    const out = await runPull(EVALS, pack, t);
    console.log(`wrote ${out.written.length}: ${out.written.join(", ") || "-"}\nkept (already cases) ${out.kept.length}`);
    for (const s of out.skipped) console.log(`skipped ${s.taskId}: ${s.reason}`);
  }
  await t.flush();
} else if (command === "scorecard" || command === "defaults") {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { write: { type: "boolean", default: false } } });
  const cards = loadBaselines(EVALS);
  if (cards.length === 0) fail("no decision baselines under evals/baselines: run `pnpm eval --pack <p> --engine <e> --save-baseline` first");
  const current = (pack: PackId) => decisionEngines(pack);
  const proposals = Object.fromEntries(
    Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => [p.id, proposeDefaults(p.id, cards, { default: current(p.id).default, fallback: current(p.id).fallback })]),
  ) as Partial<Record<PackId, Proposal>>;
  const text = renderScorecard(cards, proposals, new Date());
  if (command === "scorecard") {
    writeFileSync(join(EVALS, "scorecard.md"), text);
    console.log(`evals/scorecard.md written: ${cards.length} baseline(s)`);
  } else {
    const next = buildDefaultsFile(DECISION_DEFAULTS, proposals);
    for (const [pack, p] of Object.entries(proposals)) console.log(`${pack}: ${p!.default}${p!.measured ? "" : " (unmeasured, kept)"} · ${p!.reason}`);
    if (values.write) {
      writeFileSync(DEFAULTS_FILE, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`contracts/src/decision-defaults.json written`);
    } else console.log("dry run: --write writes contracts/src/decision-defaults.json");
  }
} else {
  await import("./run.ts");
}
