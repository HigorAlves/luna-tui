// Harvest of design parity (RFC 0013): a waiver a person gave at the design sign-off becomes a parity eval case. The machine keeps
// `ground-truth/design_parity/<task>-<finding>.json`; the sub-run it points at (`runs/<runId>-parity/`) holds the stage input the
// reviewer read and the frame renders it fetched, and the e2e run beside it (`runs/<runId>/parity/`) the build's captures. The case
// is the same layout as the hand-made ones: `stage.json`, `expect.json`, `mounts/evidence/parity/…` and a replayed `mcp/figma/…`.
// Offline: nothing is connected and no model runs. The text is scrubbed as `harvest.ts` scrubs; a token-shaped string refuses the
// bundle, and a case that exists is never written again.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { StageInput } from "@hardness/contracts";

import type { Expect } from "./expect.ts";
import { type HarvestReport } from "./harvest.ts";
import { TOKEN_SHAPE, scrubContext } from "./scrub.ts";

/** What a waiver file holds, as `Pipeline.waiveDesignFinding` writes it (only the fields read here). */
export interface Waiver {
  taskId: string;
  kind: "not_a_difference" | "accepted";
  reason: string;
  at?: string;
  parityRunId?: string | null;
  finding: { id: string; severity?: string; design?: { node?: string; frame?: string } };
  frame?: { frame?: string; scenario?: string | null; viewport?: string; state?: string; capture?: string | null; render?: string | null } | null;
}

const NODE = /^[A-Za-z0-9:;_-]{1,40}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** One file is read only to this size: the machine's own caps are below it. */
const FILE_MAX = 8 * 1024 * 1024;

/** The case a waiver makes. A pure function of the waiver; `stage` is whatever the caller built from the sub-run (null until then). */
export function caseFromWaiver(waiver: Waiver, stage: StageInput | null = null): { stage: StageInput | null; expect: Expect } {
  const node = waiver.finding.design?.node;
  if (waiver.kind === "not_a_difference") {
    if (node === undefined || !NODE.test(node)) throw new Error(`the finding's node is not a plain Figma node id: ${JSON.stringify(node)}`);
    return {
      stage,
      expect: {
        schema: 1,
        checks: [{ kind: "count", path: `findings[node=${node}]`, max: 0 }],
        rubric: `A person said the reported difference at node ${node} was no difference (${waiver.reason}). The review reports no finding on that node.`,
        review: true,
      },
    };
  }
  return {
    stage,
    expect: {
      schema: 1,
      checks: [{ kind: "count", path: "findings[level=blocker]", max: 0 }],
      rubric: `A person accepted the difference at node ${node ?? "(none)"} as it is: ${waiver.reason}. No finding of this kind is a blocker; it is at most a nit.`,
      review: true,
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A regular file (never a link), at most `FILE_MAX` bytes; null otherwise. */
function regular(path: string): Buffer | null {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size <= FILE_MAX ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

/** `scrubContext` takes `name` for a person's login. Here it is a frame's or a token's name, so it is set aside while the scrub runs. */
const KEEP = "\u0001name";
const rename = (value: unknown, from: string, to: string): unknown =>
  Array.isArray(value) ? value.map((v) => rename(v, from, to)) : isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k === from ? to : k, rename(v, from, to)])) : value;
function scrubKeepingNames(value: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const scrubbed = scrubContext(rename(value, "name", KEEP) as Record<string, unknown>);
  return scrubbed.ok ? { ok: true, value: rename(scrubbed.value, KEEP, "name") as Record<string, unknown> } : scrubbed;
}

const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : isObject(value) ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : (JSON.stringify(value) ?? "null");

const TOOLS = ["get_metadata", "get_design_context", "get_variable_defs", "get_screenshot"].map((tool) => ({ server: "figma", tool, description: `Figma ${tool}`, inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } }));

const FRAME_IMAGE = /^\/evidence\/parity\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.png$/;
const STYLES_NAME = /^[A-Za-z0-9._-]+\.styles\.json$/;

type Built = { ok: true; id: string; files: Map<string, Buffer | string> } | { ok: false; reason: string };

/** Everything one case holds, or why it cannot be made. Reads files; writes none. */
function buildCase(stateDir: string, waiver: Waiver): Built {
  const refuse = (reason: string): Built => ({ ok: false, reason });
  const runId = waiver.parityRunId;
  if (typeof runId !== "string" || !SAFE_NAME.test(runId) || !runId.endsWith("-parity")) return refuse("the waiver names no parity sub-run");
  const frame = waiver.frame;
  if (!frame || typeof frame.scenario !== "string" || !frame.viewport || !frame.state || !frame.frame) return refuse("the waiver holds no compared frame");
  const sub = join(stateDir, "runs", runId);
  const rawStage = regular(join(sub, "in", "stage.json"));
  if (!rawStage) return refuse("the sub-run's in/stage.json is missing");
  const read = StageInput.safeParse(safeJson(rawStage.toString("utf8")));
  if (!read.success) return refuse(`the sub-run's stage.json is off the schema: ${read.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const parsed = read.data;
  const parity = parsed.context.parity;
  if (!parity) return refuse("the sub-run's stage carries no parity input");
  const capture = parity.captures.find((c) => c.scenario === frame.scenario && c.frame === frame.frame && c.viewport === frame.viewport && c.state === frame.state);
  const matched = capture ? FRAME_IMAGE.exec(capture.image) : null;
  if (!capture || !matched) return refuse("the waived frame is not among the sub-run's captures");

  // The render: a plain file in the sub-run's own design folder, nowhere else.
  const renderName = typeof frame.render === "string" ? frame.render.split("/").pop() : undefined;
  if (!renderName || !/^[A-Za-z0-9_-]+\.png$/.test(renderName) || resolve(frame.render!) !== resolve(join(sub, "design", renderName))) return refuse("the waiver's render is not a file of the sub-run's design folder");
  const render = regular(join(sub, "design", renderName));
  if (!render) return refuse("the frame's render is missing or not a regular file");
  // The capture: a plain file in the e2e run's parity folder.
  const parityDir = join(stateDir, "runs", runId.slice(0, -"-parity".length), "parity");
  const captureHost = typeof frame.capture === "string" ? resolve(frame.capture) : "";
  if (!captureHost.startsWith(`${resolve(parityDir)}/`)) return refuse("the waiver's capture is not a file of the run's parity folder");
  const png = regular(captureHost);
  if (!png) return refuse("the frame's capture is missing or not a regular file");

  const fileKey = parsed.context.design?.refs.find((r) => r.fileKey)?.fileKey;
  const node = frame.frame;
  if (!fileKey || !NODE.test(node)) return refuse("the card names no Figma file for the frame");

  // The stage: the waived frame alone, as the machine built it, with no engine and no repo of its own.
  const stylesHost = `${captureHost.slice(0, -".png".length)}.styles.json`;
  const stylesRaw = STYLES_NAME.test(stylesHost.split("/").pop()!) ? regular(stylesHost) : null;
  const target = parity.plan.targets.filter((t) => t.scenario === frame.scenario && t.frame === frame.frame && t.viewport.name === frame.viewport && t.state === frame.state);
  const spec = parity.spec ? { ...parity.spec, frames: parity.spec.frames.filter((f) => f.id === frame.frame) } : null;
  const caseId = `waiver-${createHash("sha256").update(`${waiver.taskId}${waiver.finding.id}`).digest("hex").slice(0, 8)}`;
  const stage = {
    schema: parsed.schema, stage: parsed.stage, pack: parsed.pack, attempt: 1,
    task: { id: `eval-${caseId}`, title: parsed.task.title, description: parsed.task.description, criteria: parsed.task.criteria, repoPath: "", branch: `task/eval-${caseId}`, source: null },
    plan: null, decisions: [], bridge: [], priorFindings: [],
    context: { projectContext: null, design: parsed.context.design ?? null, parity: { plan: { targets: target, uncited: [], notes: [] }, captures: [capture], spec } },
    limits: { maxTurns: 0, timeoutMs: 0 },
    env: { LUNA_FACTORY: "1" },
  };
  const scrubbed = scrubKeepingNames(stage);
  if (!scrubbed.ok) return refuse(scrubbed.reason);
  const styles = stylesRaw ? safeJson(stylesRaw.toString("utf8")) : undefined;
  if (stylesRaw && styles === undefined) return refuse("the capture's styles file is not JSON");
  const scrubbedStyles = styles === undefined ? null : scrubKeepingNames({ styles });
  if (scrubbedStyles && !scrubbedStyles.ok) return refuse(scrubbedStyles.reason);
  const made = caseFromWaiver(waiver, null);
  const text = scrubContext({ reason: waiver.reason, id: waiver.finding.id });
  if (!text.ok) return refuse(text.reason);
  if (TOKEN_SHAPE.test(made.expect.rubric)) return refuse("a token-shaped string in the rubric");
  const expect = { ...made.expect, rubric: made.expect.rubric.replace(waiver.reason, String(text.value.reason)) };

  const files = new Map<string, Buffer | string>();
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  files.set("stage.json", json(scrubbed.value));
  files.set("expect.json", json(expect));
  files.set(`mounts/evidence/parity/${matched[1]}/${matched[2]}.png`, png);
  if (scrubbedStyles?.ok) files.set(`mounts/evidence/parity/${matched[1]}/${matched[2]}.styles.json`, json(scrubbedStyles.value.styles));
  const args = { fileKey, nodeId: node };
  files.set(`mcp/figma/get_screenshot/${createHash("sha256").update(canonical(args)).digest("hex")}.json`, json({ ok: true, text: `Screenshot of ${node}`, images: [{ mime: "image/png", base64: render.toString("base64") }], truncated: false }));
  files.set("mcp/figma/tools.json", json(TOOLS));
  return { ok: true, id: caseId, files };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) ?? null;
  } catch {
    return undefined;
  }
}

/** Turns each waiver file under `<stateDir>/ground-truth/design_parity/` (from `since` on) into a case under `<out>/design_parity/cases/`. */
export function harvestParity(options: { stateDir: string; out: string; since?: Date }): HarvestReport {
  const report: HarvestReport = { written: [], kept: [], refused: [] };
  const truth = join(options.stateDir, "ground-truth", "design_parity");
  const names = existsSync(truth) ? readdirSync(truth).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort() : [];
  for (const name of names) {
    const raw = regular(join(truth, name));
    const body = raw ? safeJson(raw.toString("utf8")) : undefined;
    // A sign-off file is no waiver: only one that says how the finding was waived is read.
    if (!isObject(body) || (body.kind !== "not_a_difference" && body.kind !== "accepted") || !isObject(body.finding)) continue;
    const at = typeof body.at === "string" ? new Date(body.at) : null;
    if (options.since && (!at || at < options.since)) continue;
    const waiver = body as unknown as Waiver;
    if (typeof waiver.reason !== "string" || typeof waiver.taskId !== "string" || typeof waiver.finding.id !== "string") {
      report.refused.push({ id: name, reason: "the waiver is missing its task, finding or reason" });
      continue;
    }
    let built: Built;
    try {
      built = buildCase(options.stateDir, waiver);
    } catch (error) {
      built = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!built.ok) {
      report.refused.push({ id: name, reason: built.reason });
      continue;
    }
    const dir = join(options.out, "design_parity", "cases", built.id);
    if (existsSync(dir)) {
      report.kept.push(built.id);
      continue;
    }
    for (const [file, content] of built.files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    report.written.push(built.id);
  }
  return report;
}
