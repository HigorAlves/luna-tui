#!/usr/bin/env node
// qa-axe --url <url> --out <file> [--level AA|AAA]: opens the page in the QA image's chromium, injects axe-core, runs it with the WCAG 2.2 tags and writes
// the violations as JSON under the run's evidence folder, one line per violation on stdout. `qa-axe --inject` prints where axe.min.js is, for a Playwright
// script that injects it itself. Exit 0 with or without violations, 2 on a usage error, 1 when the page cannot be loaded.
// The machine reads the JSON (`a11y_audit` cites it as evidence); the helper keeps only the fields the audit needs, never a node's HTML.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// The image sets QA_AXE_SCRIPT to where `npm install -g` put axe-core (npm's global root there is /opt/luna/lib/node_modules).
const AXE = process.env.QA_AXE_SCRIPT || "/opt/luna/lib/node_modules/axe-core/axe.min.js";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SUMMARY_MAX = 200;

const fail = (message, code = 2) => {
  process.stderr.write(`qa-axe: ${message}\n`);
  process.exit(code);
};

const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--inject") flags.set("inject", true);
  else if (arg === "--url" || arg === "--out" || arg === "--level") flags.set(arg.slice(2), args[++i]);
  else fail(`unknown argument ${arg}`);
}

if (flags.get("inject")) {
  process.stdout.write(`${AXE}\n`);
  process.exit(0);
}

const url = flags.get("url");
const out = flags.get("out");
const level = flags.get("level") ?? "AA";
if (!url || !out) fail("usage: qa-axe --url <url> --out <file> [--level AA|AAA] | qa-axe --inject");
if (!/^(https?|file):\/\//.test(url)) fail("the url must start with http://, https:// or file://");
if (level !== "AA" && level !== "AAA") fail("the level is AA or AAA");
const root = resolve(process.env.QA_AXE_OUT_ROOT || "/out/files/a11y");
const target = resolve(out);
if (!target.startsWith(root + sep)) fail(`--out must be a file under ${root}`);

/** The default driver: Playwright's chromium (the QA image's wrapper, behind the egress proxy), axe injected from its script. */
async function browserDriver(pageUrl, { tags }) {
  // A global package is not on an ES module's path: load it from where `npm install -g` put it.
  const { chromium } = createRequire(import.meta.url)(join(dirname(dirname(AXE)), "playwright"));
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  // A browser given a proxy ignores NO_PROXY: the names the machine exempts (the app on the QA network) are handed over as the bypass list.
  const bypass = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((name) => name.trim()).filter(Boolean).join(",");
  const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium-qa", ...(proxy ? { proxy: { server: proxy, ...(bypass ? { bypass } : {}) } } : {}) });
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: "load", timeout: 60_000 });
    await page.addScriptTag({ path: AXE });
    return await page.evaluate((values) => globalThis.axe.run(document, { runOnly: { type: "tag", values } }), tags);
  } finally {
    await browser.close();
  }
}

const driver = process.env.QA_AXE_DRIVER ? (await import(pathToFileURL(resolve(process.env.QA_AXE_DRIVER)).href)).default : browserDriver;
let raw;
try {
  raw = await driver(url, { tags: level === "AAA" ? [...TAGS, "wcag2aaa"] : TAGS });
} catch (error) {
  fail(`could not load ${url}: ${error instanceof Error ? error.message : String(error)}`, 1);
}

const violations = (raw?.violations ?? []).map((v) => ({
  id: String(v.id),
  impact: v.impact ?? null,
  tags: Array.isArray(v.tags) ? v.tags.map(String) : [],
  nodes: (v.nodes ?? []).map((n) => ({ target: (Array.isArray(n.target) ? n.target : []).map((t) => String(Array.isArray(t) ? t.join(" ") : t)), failureSummary: String(n.failureSummary ?? "").slice(0, SUMMARY_MAX) })),
}));

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify({ url, level, violations }, null, 2)}\n`);
for (const v of violations) {
  const first = v.nodes[0]?.target.join(" ") ?? "(no node)";
  process.stdout.write(`${v.impact ?? "unknown"} ${v.id} ${first}${v.nodes.length > 1 ? ` (+${v.nodes.length - 1} more)` : ""}\n`);
}
process.stdout.write(`${violations.length} violation${violations.length === 1 ? "" : "s"} written to ${target}\n`);
