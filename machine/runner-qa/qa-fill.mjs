#!/usr/bin/env node
// qa-fill <selector> <VARIABLE>: fills a field of the page the browser run has open with the value of an environment variable the machine
// set for this run's QA target, so the agent names the variable and never writes, reads or prints the value (a value the model types is
// sent to its provider). The variable must be one the machine listed in LUNA_QA_CREDENTIALS: the engine's own key, in the same environment,
// is refused. The driver's output is printed with the value replaced.
import { spawnSync } from "node:child_process";

const [selector, name] = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(`qa-fill: ${message}\n`);
  process.exit(2);
};
if (!selector || selector.length > 300 || /[\r\n\u0000]/.test(selector)) fail("give a selector of at most 300 characters on one line");
if (!name || !/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) fail("give the name of the variable, in upper case, never its value");
const allowed = (process.env.LUNA_QA_CREDENTIALS ?? "").split(",").filter(Boolean);
if (!allowed.includes(name)) fail(`${name} is not a QA credential of this run`);
const value = process.env[name];
if (!value) fail(`${name} is not set`);

const driver = process.env.QA_FILL_DRIVER || "agent-browser";
const result = spawnSync(driver, ["fill", selector, value], { encoding: "utf8", env: { ...process.env, ...Object.fromEntries(allowed.map((n) => [n, ""])) } });
const clean = (text) => (text ?? "").split(value).join(`[secret:${name}]`).split(encodeURIComponent(value)).join(`[secret:${name}]`).split(Buffer.from(value).toString("base64")).join(`[secret:${name}]`);
const out = clean(`${result.stdout}${result.stderr}`).trim().slice(0, 500);
process.stdout.write(`filled ${selector} from ${name}${out ? `\n${out}` : ""}\n`);
process.exit(result.status ?? 1);
