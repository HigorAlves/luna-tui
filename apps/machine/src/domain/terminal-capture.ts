// A terminal capture, built from what the card already holds: Build's red-to-green record of each scenario's test and the end of the
// output of the checks Verify ran. Nothing is run again. Pure. Every line is a container's or a test's text: token shapes redacted, control
// characters and ANSI gone, each line cut, the whole capped.
import type { BuildReport } from "@hardness/contracts";

import { redact } from "./evidence-markdown.ts";

export interface CheckOutput {
  name: string;
  cmd: string;
  ok: boolean;
  tail: string;
}

export interface TerminalCaptureInput {
  scenarios: { id?: string | undefined; title: string; test?: string | null | undefined }[];
  tests: BuildReport["tests"];
  checks: CheckOutput[];
}

const LINE_CAP = 400;
const TOTAL_CAP = 64 * 1024;
const CAPTURE_LINES = 40;
const EXCERPT_LINES = 20;

// ESC sequences first (their `[31m` would otherwise stay as noise), then every other control character.
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** One line of someone's text made printable: redacted, no ANSI or control characters, cut at 400. */
function line(text: string): string {
  return redact(text.replace(ANSI, "").replace(/\t/g, " ").replace(CONTROL, "")).trimEnd().slice(0, LINE_CAP);
}

const state = (before: "fail" | "pass" | null | undefined, after: "fail" | "pass" | null | undefined): string => {
  const word = (r: "fail" | "pass" | null | undefined) => (r === "fail" ? "red" : r === "pass" ? "green" : "?");
  return `${word(before)} → ${word(after)}`;
};

function checkBlock(checks: CheckOutput[], lines: number): string[] {
  return checks.flatMap((c) => [
    "",
    line(`$ ${c.cmd}`),
    ...c.tail.split("\n").slice(-lines).map(line),
    line(`${c.name}: ${c.ok ? "ok" : "failed"}`),
  ]);
}

function capped(lines: string[]): string {
  const out: string[] = [];
  let bytes = 0;
  for (const l of lines) {
    const next = Buffer.byteLength(l) + 1;
    if (bytes + next > TOTAL_CAP) break;
    out.push(l);
    bytes += next;
  }
  return `${out.join("\n")}\n`;
}

/** The capture for a change shown by a terminal: one line per scenario (id, title, test file, red → green), then each check's command, the last 40 lines of its output and ok or failed. */
export function terminalCapture(input: TerminalCaptureInput): string {
  const scenarios = input.scenarios.length
    ? input.scenarios.map((s) => {
        const t = input.tests.find((x) => x.scenario === s.id);
        return line(`${s.id ?? "-"} ${s.title} ${t?.file ?? s.test ?? "no test file"} ${state(t?.before, t?.after)}`);
      })
    : ["no scenario was approved for this change"];
  return capped([...scenarios, ...(input.checks.length ? checkBlock(input.checks, CAPTURE_LINES) : ["", "no checks ran"])]);
}

/** The last 20 lines of each check's output: what a text pack lists beside its summary. */
export function checksExcerpt(checks: CheckOutput[]): string {
  return capped(checks.length ? checkBlock(checks, EXCERPT_LINES).slice(1) : ["no checks ran"]);
}
