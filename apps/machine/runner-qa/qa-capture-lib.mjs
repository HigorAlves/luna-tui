// The capture library behind `qa-capture` (CLI over agent-browser) and a Playwright script (RFC 0013, phase 3): it sets the frame's viewport, takes the screenshot
// and records the computed styles of what is on screen, in one fixed format. The e2e agent decides when to capture; this code decides how, so the reviewer compares
// computed values, never an agent's description of them. `capture(page, args, { dir })` takes anything shaped like a Playwright page (`setViewportSize`, `screenshot`,
// `evaluate`). Outputs under `<dir>/<scenario>/<viewport>-<state>.png` and `.styles.json`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATES = ["default", "hover", "focus", "disabled", "loading", "empty", "error"];
export const MAX_ELEMENTS = 300;
export const SETTLE_MS = 250;
const STRING_MAX = 200;

/** An error string for a bad argument, else null. Scenario, viewport and state end up in a file name, so each is checked by pattern. */
export function checkArgs({ scenario, viewport, state, width, height } = {}) {
  if (typeof scenario !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(scenario)) return "the scenario id is 1-40 letters, digits, - or _";
  if (typeof viewport !== "string" || !/^[a-z0-9-]{1,20}$/.test(viewport)) return "the viewport name is 1-20 lowercase letters, digits or -";
  if (!STATES.includes(state)) return `the state is one of ${STATES.join(", ")}`;
  for (const [name, value] of [["width", width], ["height", height]]) if (!Number.isInteger(value) || value < 200 || value > 4000) return `the ${name} is an integer from 200 to 4000`;
  return null;
}

/**
 * Runs in the page: serialisable, no closures. Walks `body *` and keeps what is displayed, visible, inside the viewport and worth comparing (own text, a background, a
 * radius or a border, or a media/form element), with the computed values the reviewer checks tokens and layout against.
 */
export function STYLE_PROBE() {
  const MAX = 300;
  const rows = [];
  const media = /^(img|svg|button|input|select|textarea|a)$/;
  const selectorOf = (el) => {
    if (el.id) return `#${el.id}`;
    const testid = el.getAttribute("data-testid");
    if (testid) return `[data-testid="${testid}"]`;
    const path = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.body && path.length < 4; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const same = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName) : [node];
      path.unshift(`${tag}:nth-of-type(${same.indexOf(node) + 1})`);
    }
    return path.join(" > ");
  };
  for (const el of document.querySelectorAll("body *")) {
    if (rows.length >= MAX) break;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
    const hasBackground = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
    const hasRadius = parseFloat(cs.borderTopLeftRadius) > 0;
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
    if (!(ownText || hasBackground || hasRadius || hasBorder || media.test(el.tagName.toLowerCase()))) continue;
    rows.push({
      selector: selectorOf(el),
      text: ownText.slice(0, 80),
      color: cs.color,
      background: cs.backgroundColor,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      padding: cs.padding,
      margin: cs.margin,
      gap: cs.gap,
      borderRadius: cs.borderRadius,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return rows;
}

const clip = (value) => (typeof value === "string" ? value.slice(0, STRING_MAX) : value);
const shaped = (row) => Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, k === "rect" ? v : clip(v)]));

/** Captures one scenario state: viewport, screenshot, then styles (written only after the screenshot succeeded). Answers `{ elements }`. */
export async function capture(page, args, { dir }) {
  const bad = checkArgs(args);
  if (bad) throw new Error(bad);
  const { scenario, viewport, state, width, height } = args;
  const folder = join(dir, scenario);
  const base = join(folder, `${viewport}-${state}`);
  await page.setViewportSize({ width, height });
  // A page may settle in its own way (agent-browser waits inside the page); a Playwright page has `waitForTimeout`.
  if (typeof page.waitForTimeout === "function") await page.waitForTimeout(SETTLE_MS);
  else await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: `${base}.png`, fullPage: false });
  const rows = (await page.evaluate(STYLE_PROBE)).slice(0, MAX_ELEMENTS).map(shaped);
  writeFileSync(`${base}.styles.json`, `${JSON.stringify(rows)}\n`);
  return { elements: rows.length };
}
