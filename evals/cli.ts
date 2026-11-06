// `pnpm eval` entry: the subcommands of the ground-truth loop and the scorecard, and the replay run by default.
//
//   pnpm eval --pack <p> --engine <e> ...                    replay a pack's cases (run.ts)
//   pnpm eval harvest --pack <decision> [--since <date>] [--with-truth] [--all]
//   pnpm eval dataset push --pack <decision> [--queue <id or name>] [--records]
//   pnpm eval dataset pull --pack <decision>
//   pnpm eval records [--task <id>] [--pack <p>] [--since <date>] [--sizes]   one line per decision record: what the machine did, its state, its truth
//   pnpm eval label --pack <p> --record <id> --set <question>=<value>... [--note <text>]   a person's label, written on this computer
//   pnpm eval label --pack <p> --next                         the oldest record with no person label, and the command to label it
//   pnpm eval label push --queue <queue id> [--pack <p>] [--since <date>]   the records still waiting for a label, to the local labelling queue
//   pnpm eval cases [--pack <p>]                              a table of the cases for a person to read: kind, label, the criterion, the twin, the second reading
//   pnpm eval preflight                                       what a baseline run needs, checked without a model call; exits 1 when a check fails
//   pnpm eval scorecard                       evals/scorecard.md over every decision baseline
//   pnpm eval defaults [--write] [--except <pack>...]              the default per slot by the scorecard's rule; --write updates contracts/src/decision-defaults.json
import { DECISION_DEFAULTS, PACKS, PackId, decisionEngines } from "@hardness/contracts";
import { machineCredentials } from "@hardness/machine/credentials";
import { imageExists } from "@hardness/machine/docker";
import { DecisionLog, machineStateDir } from "@hardness/machine/decisions";
import { buildTelemetry, tracesFromEnv } from "@hardness/machine/telemetry";
import { collectorGate } from "./src/collector.ts";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { decisionPack } from "./src/labels.ts";
import { labelFor, nextToLabel, renderNext, setLabel } from "./src/label.ts";
import { runHarvest, runLabelPush, runPull, runPush } from "./src/loop.ts";
import { casesTable, decisionPackIds, preflight } from "./src/preflight.ts";
import { folderMegabytes, priorityHints, printable, recordsReport } from "./src/records.ts";
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
    const out = await runPull(EVALS, pack, t, log());
    console.log(`wrote ${out.written.length}: ${out.written.join(", ") || "-"}\nkept (already cases) ${out.kept.length}\nlabels written back to records ${out.labelled.length}`);
    for (const s of out.skipped) console.log(`skipped ${s.taskId}: ${s.reason}`);
  }
  await t.flush();
} else if (command === "records") {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { task: { type: "string" }, pack: { type: "string" }, since: { type: "string" }, sizes: { type: "boolean", default: false } } });
  const since = values.since ? new Date(values.since) : undefined;
  if (since && Number.isNaN(since.getTime())) fail("--since must be a date, like 2026-11-01");
  const packs = values.pack ? [decisionOf(values.pack)] : Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);
  const found = (await Promise.all(packs.map((p) => log().list(p, since ? { since } : {})))).flat().filter((r) => !values.task || r.taskId === values.task).sort((a, b) => a.at.localeCompare(b.at));
  for (const line of recordsReport(found).lines) console.log(line);
  if (values.sizes) {
    const state = machineStateDir();
    for (const [name, dir] of [["decisions", join(state, "decisions")], ["ground-truth", join(state, "ground-truth")], ["evals/.runs", join(EVALS, ".runs")]] as const) console.log(`${name}: ${folderMegabytes(dir).toFixed(1)} MB`);
  }
} else if (command === "cases") {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { pack: { type: "string" } } });
  for (const pack of values.pack ? [decisionOf(values.pack)] : decisionPackIds()) {
    console.log(`\n${pack}`);
    for (const row of casesTable(EVALS, pack)) console.log(`  ${row}`);
  }
} else if (command === "preflight") {
  const credentials = machineCredentials();
  const out = await preflight(EVALS, {
    imageExists: (image) => imageExists(image),
    check: (engine) => credentials.check(engine),
    collector: async () => (await collectorGate(tracesFromEnv())).ok,
  }, { image: process.env.RUNNER_IMAGE ?? "hardness-runner:dev" });
  for (const line of out.lines) console.log(line);
  if (!out.ok) process.exit(1);
} else if (command === "label") {
  const rest = process.argv.slice(sub === "push" ? 4 : 3);
  const { values } = parseArgs({ args: rest, options: { pack: { type: "string" }, record: { type: "string" }, set: { type: "string", multiple: true, default: [] }, note: { type: "string" }, next: { type: "boolean", default: false }, queue: { type: "string" }, since: { type: "string" } } });
  const since = values.since ? new Date(values.since) : undefined;
  if (since && Number.isNaN(since.getTime())) fail("--since must be a date, like 2026-11-01");
  if (sub === "push") {
    if (!values.queue) fail("label push needs --queue <queue id>");
    const packs = values.pack ? [decisionOf(values.pack)] : Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);
    const gate = await collectorGate(tracesFromEnv());
    if (!gate.ok) fail(gate.line);
    const t = await telemetry();
    const hints = priorityHints(machineStateDir());
    try {
      const out = await runLabelPush(log(), t, { queue: values.queue, packs, ...(since ? { since } : {}), hintOf: (id) => hints.get(id) });
      console.log(`queue ${values.queue}: ${out.pushed} record(s) pushed`);
      if (out.localOnly.length > 0) console.log(`${out.localOnly.length} record(s) stay on this computer (private or refused by the scrub), label them with \`pnpm eval label --next\`: ${out.localOnly.map((r) => `${r.pack}/${r.id}`).join(", ")}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    await t.flush();
  } else {
    const pack = decisionOf(values.pack);
    if (values.next) {
      const next = nextToLabel(await log().list(pack));
      console.log(next ? renderNext(next).join("\n") : `no ${pack} record is waiting for a person's label`);
    } else {
      if (!values.record) fail("give --record <id> (or --next to find one)");
      const made = labelFor(pack, values.set);
      if (!made.ok) fail(printable(made.reason));
      const out = await setLabel(log(), pack, values.record, values.set, values.note);
      if (!out.ok) fail(printable(out.reason));
      console.log(`labelled ${pack} ${values.record} (person_cli)`);
    }
  }
} else if (command === "scorecard" || command === "defaults") {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { write: { type: "boolean", default: false }, except: { type: "string", multiple: true, default: [] } } });
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
    const next = buildDefaultsFile(DECISION_DEFAULTS, proposals, { except: values.except });
    for (const [pack, p] of Object.entries(proposals)) console.log(values.except.includes(pack) ? `${pack}: left exactly as it is (--except)` : `${pack}: ${p!.default}${p!.measured ? "" : " (unmeasured, kept)"} · ${p!.reason}`);
    if (values.write) {
      writeFileSync(DEFAULTS_FILE, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`contracts/src/decision-defaults.json written`);
    } else console.log("dry run: --write writes contracts/src/decision-defaults.json");
  }
} else {
  await import("./run.ts");
}
