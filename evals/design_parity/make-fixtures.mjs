// Regenerates the design_parity eval cases (RFC 0013): `node evals/design_parity/make-fixtures.mjs`. Offline and deterministic: a checkout card is drawn with pngjs
// (no browser, no fonts, no network), once as the Figma frame's render and once per case as the build's capture. The Figma answers are written as replay files in
// the layout `recordingMcp` reads (`mcp/figma/<tool>/<sha256(canonical args)>.json`); nothing is recorded live.
// pngjs is machine's dependency: it is read through machine's own package.json, so evals gains no dependency of its own.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { PNG } = createRequire(resolve(HERE, "../../apps/machine/package.json"))("pngjs");
const OUT = join(HERE, "cases");
const FILE = "Qx7LmP2vR9sTa";

const REF = { primary: "#1B5E20", hoverPrimary: "#144A18", surface: "#FFFFFF", text: "#1A1A1A", gap: 16, radius: 8, font: 16, wrap: false };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** The card, drawn: surface, a heading bar, two item rows `gap` apart and the pay button (rounded, with a label bar; two bars when the label wraps). */
function draw(w, h, v, state) {
  const png = new PNG({ width: w, height: h });
  const rect = (x, y, rw, rh, color, radius = 0) => {
    const [r, g, b] = hex(color);
    for (let py = y; py < Math.min(h, y + rh); py++)
      for (let px = x; px < Math.min(w, x + rw); px++) {
        const cx = px < x + radius ? x + radius : px >= x + rw - radius ? x + rw - radius - 1 : px;
        const cy = py < y + radius ? y + radius : py >= y + rh - radius ? y + rh - radius - 1 : py;
        if ((px - cx) ** 2 + (py - cy) ** 2 > radius * radius) continue;
        const i = (w * py + px) << 2;
        png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
      }
  };
  const cardW = Math.min(w - 32, 480);
  const x0 = Math.floor((w - cardW) / 2);
  rect(0, 0, w, h, "#EEEEEE");
  rect(x0, 40, cardW, 420, v.surface);
  rect(x0 + 24, 64, Math.round(v.font * 9), v.font + 8, v.text);
  rect(x0 + 24, 120, cardW - 48, 40, "#E0E0E0");
  rect(x0 + 24, 120 + 40 + v.gap, cardW - 48, 40, "#E0E0E0");
  const btnW = v.wrap ? 120 : cardW - 48;
  const btnH = v.wrap ? 72 : 48;
  const top = 120 + 80 + v.gap + 32;
  rect(x0 + 24, top, btnW, btnH, state === "hover" ? v.hoverPrimary : v.primary, v.radius);
  const labelW = Math.round(v.font * 3.2);
  if (v.wrap) {
    rect(x0 + 24 + 16, top + 14, labelW, v.font, "#FFFFFF");
    rect(x0 + 24 + 16, top + 14 + v.font + 6, labelW, v.font, "#FFFFFF");
  } else rect(x0 + 24 + Math.round((btnW - labelW) / 2), top + Math.round((btnH - v.font) / 2), labelW, v.font, "#FFFFFF");
  return { png: PNG.sync.write(png, { colorType: 6 }), layout: { x0, cardW, top, btnW, btnH } };
}

/** What `qa-capture` would record: the computed styles of the card's elements. */
function styles(v, l) {
  const base = { text: "", color: v.text, background: "rgba(0, 0, 0, 0)", fontFamily: "Inter", fontSize: `${v.font}px`, fontWeight: "400", lineHeight: `${v.font + 8}px`, letterSpacing: "0px", padding: "0px", margin: "0px", gap: "0px", borderRadius: "0px" };
  return [
    { ...base, selector: "main > h1", text: "Checkout", fontSize: "24px", fontWeight: "600", lineHeight: "32px", rect: { x: l.x0 + 24, y: 64, w: 216, h: 32 } },
    { ...base, selector: "ul.items", gap: `${v.gap}px`, rect: { x: l.x0 + 24, y: 120, w: l.cardW - 48, h: 80 + v.gap } },
    { ...base, selector: "ul.items > li", text: "2 items", fontSize: `${v.font}px`, rect: { x: l.x0 + 24, y: 120, w: l.cardW - 48, h: 40 } },
    { ...base, selector: "button.pay", text: "Pay now", color: "rgb(255, 255, 255)", background: v.primary, fontSize: `${v.font}px`, padding: "16px", borderRadius: `${v.radius}px`, rect: { x: l.x0 + 24, y: l.top, w: l.btnW, h: l.btnH } },
  ];
}

const canonical = (a) => `{${Object.keys(a).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(a[k])}`).join(",")}}`;
const key = (a) => createHash("sha256").update(canonical(a)).digest("hex");
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`); };

const TOOLS = ["get_metadata", "get_design_context", "get_variable_defs", "get_screenshot"].map((tool) => ({ server: "figma", tool, description: `Figma ${tool}`, inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } }));
const VARIABLES = { "color/primary": REF.primary, "color/primary-hover": REF.hoverPrimary, "color/surface": REF.surface, "color/text": REF.text, "type/heading": "Inter 24/32 600", "type/body": "Inter 16/24 400", "space/4": "16", "radius/md": "8" };

const DESKTOP = { name: "1440x900", width: 1440, height: 900 };
const MOBILE = { name: "390x844", width: 390, height: 844 };
const rubricOf = (what) => `${what} Every finding names the frame, the Figma node and the build element, with the expected and the actual value. No finding is invented where the build matches the frame: the machine drops none of them, so an invented difference reaches a person as a blocker. Pixel noise is a nit at most. A frame with no capture is answered not_compared with its reason, never a pass.`;

const find = (path, min = 1) => ({ kind: "count", path, min });
const CASES = [
  { id: "token-swap", variant: { primary: "#C62828" }, expect: [find("findings[frame=12:34]"), find("findings[kind=token]"), { kind: "mentions", path: "findings[].actual", words: ["#C62828", "rgb(198, 40, 40)"], any: true }], rubric: "The pay button's fill is #C62828 in the build and the frame's color/primary is #1B5E20: a token swap on the primary action, so a blocker or should_fix at node 12:40." },
  { id: "spacing-drift", variant: { gap: 20 }, expect: [find("findings[frame=12:34]"), { kind: "mentions", path: "findings[].actual", words: ["20"] }], rubric: "The gap between the item rows is 20px; the frame's space/4 is 16. A should_fix at most, naming the list and both values." },
  { id: "radius", variant: { radius: 4 }, expect: [find("findings[frame=12:34]"), find("findings[kind=token]"), { kind: "mentions", path: "findings[].actual", words: ["4"] }], rubric: "The pay button's corner radius is 4px; the frame's radius/md is 8." },
  { id: "type-size", variant: { font: 15 }, expect: [find("findings[frame=12:34]"), { kind: "mentions", path: "findings[].actual", words: ["15"] }], rubric: "The body text is 15px; the frame's type/body is Inter 16/24. A should_fix or nit naming the font size." },
  { id: "layout-wrap", variant: { wrap: true }, expect: [find("findings[frame=12:34]"), find("findings[kind=layout]")], rubric: "At the frame's width the build's pay button is a narrow box and its label wraps onto two lines; the frame has one line on a full-width button: a layout break." },
  { id: "missing-hover", variant: {}, hover: true, expect: [{ kind: "equals", path: "frames[state=hover].status", value: "not_compared" }, { kind: "equals", path: "frames[state=default].status", value: "compared" }, { kind: "count", path: "findings[level=blocker]", max: 0 }], rubric: "The default capture matches the frame; the scenario also cites the hover state but the browser run took no hover capture. The hover frame is answered not_compared with that reason, and the pass is never claimed for it." },
  { id: "clean-desktop", variant: {}, expect: [{ kind: "count", path: "findings[level=blocker]", max: 0 }, { kind: "count", path: "findings[level=should_fix]", max: 0 }, { kind: "equals", path: "frames[].status", value: "compared" }], rubric: "The build matches the frame exactly at 1440x900." },
  { id: "clean-mobile", mobile: true, variant: {}, expect: [{ kind: "count", path: "findings[level=blocker]", max: 0 }, { kind: "count", path: "findings[level=should_fix]", max: 0 }, { kind: "equals", path: "frames[].status", value: "compared" }], rubric: "The build matches the frame exactly at 390x844." },
];

rmSync(OUT, { recursive: true, force: true });
for (const c of CASES) {
  const vp = c.mobile ? MOBILE : DESKTOP;
  const frameId = c.mobile ? "12:50" : "12:34";
  const hoverId = "12:35";
  const dir = join(OUT, c.id);
  const build = { ...REF, ...c.variant };
  const states = c.hover ? ["default", "hover"] : ["default"];
  // The frame's renders (the reference) as the recorded get_screenshot answers; the build's captures under the mounted /evidence/parity.
  for (const st of states) {
    const node = st === "hover" ? hoverId : frameId;
    const ref = draw(vp.width, vp.height, REF, st);
    write(join(dir, "mcp/figma/get_screenshot", `${key({ fileKey: FILE, nodeId: node })}.json`), { ok: true, text: `Screenshot of ${node}`, images: [{ mime: "image/png", base64: ref.png.toString("base64") }], truncated: false });
    write(join(dir, "mcp/figma/get_design_context", `${key({ fileKey: FILE, nodeId: node })}.json`), { ok: true, text: `Frame "Checkout${st === "hover" ? " / pay hover" : ""}" ${vp.width}x${vp.height}. Surface: color/surface. Title: type/heading. Items: gap space/4. Pay button (instance PayButton, node 12:40): fill ${st === "hover" ? "color/primary-hover" : "color/primary"}, radius radius/md, padding space/4, label type/body.`, images: [], truncated: false });
    write(join(dir, "mcp/figma/get_variable_defs", `${key({ fileKey: FILE, nodeId: node })}.json`), { ok: true, text: JSON.stringify(VARIABLES), images: [], truncated: false });
    write(join(dir, "mcp/figma/get_metadata", `${key({ fileKey: FILE, nodeId: node })}.json`), { ok: true, text: `<frame id="${node}" name="Checkout" width="${vp.width}" height="${vp.height}"/>`, images: [], truncated: false });
  }
  write(join(dir, "mcp/figma/tools.json"), TOOLS);
  const shot = draw(vp.width, vp.height, build, "default");
  const base = `S1/${vp.name}-default`;
  write(join(dir, `mounts/evidence/parity/${base}.png`), shot.png);
  const rows = styles(build, shot.layout);
  write(join(dir, `mounts/evidence/parity/${base}.styles.json`), rows);
  const captures = [{ scenario: "S1", frame: frameId, viewport: vp.name, state: "default", image: `/evidence/parity/${base}.png`, styles: `/evidence/parity/${base}.styles.json`, elements: rows.length }];
  const targets = states.map((st) => ({ scenario: "S1", frame: frameId, viewport: vp, state: st }));
  const spec = {
    frames: [{ id: frameId, name: "Checkout", viewport: { width: vp.width, height: vp.height }, states: states.map((st) => ({ state: st, nodeId: st === "hover" ? hoverId : frameId, suggestion: null })) }],
    tokens: { color: [{ name: "primary", value: REF.primary, variable: "color/primary", nodeId: null }, { name: "surface", value: REF.surface, variable: "color/surface", nodeId: null }], type: [{ name: "body", value: "Inter 16/24 400", variable: "type/body", nodeId: null }], spacing: [{ name: "space-4", value: "16", variable: "space/4", nodeId: null }], radius: [{ name: "md", value: "8", variable: "radius/md", nodeId: null }] },
    components: [{ name: "PayButton", nodeId: "12:40", codeConnect: null }],
    a11yNotes: [],
    missing: [],
    confidence: 0.9,
  };
  write(join(dir, "stage.json"), {
    schema: 3, stage: "design_parity", pack: "design_parity", attempt: 1,
    task: { id: `eval-parity-${c.id}`, title: "Restyle the checkout page to the new design", description: "Checkout follows the Figma frame.", criteria: ["The checkout page matches the Figma frame"], repoPath: "fixtures/golden-web", branch: `task/eval-parity-${c.id}`, source: null },
    plan: null, decisions: [], bridge: [], priorFindings: [],
    context: { projectContext: null, design: { refs: [{ fileKey: FILE, nodeIds: [frameId], page: null, from: "issue" }] }, parity: { plan: { targets, uncited: [], notes: [] }, captures, spec } },
    limits: { maxTurns: 0, timeoutMs: 0 }, env: { LUNA_FACTORY: "1" },
  });
  write(join(dir, "expect.json"), { schema: 1, outcome: "pass", checks: c.expect, rubric: rubricOf(c.rubric) });
  // A hand-written good answer: the offline test grades it against the checks (the checks can be met), never a model's output.
  const frames = states.map((st) => ({ frame: frameId, scenario: "S1", viewport: vp.name, state: st, ...(st === "hover" ? { status: "not_compared", reason: "no capture for the hover state", capture: null, render: null } : { status: "compared", capture: `/evidence/parity/${base}.png`, render: "/design/1-0.png" }) }));
  const finding = (level, kind, element, expected, actual, title) => ({ level, kind, frame: frameId, node: "12:40", element, viewport: vp.name, state: "default", expected, actual, title, why: title, confidence: 0.9 });
  const FINDINGS = {
    "token-swap": [finding("blocker", "token", "button.pay", "#1B5E20", "#C62828", "Pay button fill is not color/primary")],
    "spacing-drift": [finding("should_fix", "token", "ul.items", "16", "20", "Item gap is 20 not 16")],
    radius: [finding("should_fix", "token", "button.pay", "8", "4", "Pay button radius is 4 not 8")],
    "type-size": [finding("should_fix", "token", "ul.items > li", "16", "15", "Body text is 15 not 16")],
    "layout-wrap": [finding("blocker", "layout", "button.pay", "one line, full width", "label wraps on a 120px button", "Pay label wraps")],
  };
  write(join(dir, "good-answer.json"), { frames, findings: FINDINGS[c.id] ?? [], designInput: "complete", confidence: 0.9, summary: c.id });
}
console.log(`wrote ${CASES.length} cases under ${OUT}`);
