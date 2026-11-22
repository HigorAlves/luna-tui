// Regenerates the ui_design eval cases (RFC 0013, phase 5): `node evals/ui_design/make-fixtures.mjs`. Offline and deterministic: nothing is recorded live.
// The Figma answers are HAND-WRITTEN, in the layout `recordingMcp` reads (`mcp/figma/<tool>/<sha256(canonical args)>.json`), until a Figma account exists to record them.
// Each case is one pure UI slice of fixtures/golden-ui, with the design spec the plan stage would have approved (`context.plan.designSpec`).
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "cases");
const TOOLS = join(HERE, "..", "design_spec", "cases", "missing-states", "mcp", "figma", "tools.json");
const FILE = "Hv4RnT6qWc8Ld";
const BASE = "0".repeat(39) + "1";

const canonical = (a) => `{${Object.keys(a).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(a[k])}`).join(",")}}`;
const key = (a) => createHash("sha256").update(canonical(a)).digest("hex");
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const tok = (name, value, variable) => ({ name, value, variable, nodeId: null });
const state = (s, nodeId) => ({ state: s, nodeId, suggestion: null });

const TOKENS = {
  color: [tok("color/primary", "#1B5E20", "color/primary"), tok("color/primary-hover", "#144A18", "color/primary-hover"), tok("color/surface", "#FFFFFF", "color/surface"), tok("color/text", "#1A1A1A", "color/text"), tok("color/error", "#B3261E", "color/error")],
  type: [],
  spacing: [tok("space/4", "16", "space/4")],
  radius: [tok("radius/md", "8", "radius/md")],
};
const VARIABLES = { "color/primary": "#1B5E20", "color/primary-hover": "#144A18", "color/surface": "#FFFFFF", "color/text": "#1A1A1A", "color/error": "#B3261E", "space/4": "16", "radius/md": "8", "focus/ring": "2px solid #1B5E20, offset 2" };

const CASES = [
  {
    id: "card-hover-focus",
    title: "Product card: hover and focus",
    description: "The product card follows the Figma frame, with its hover and keyboard focus states.",
    criteria: ["The card has the hover and focus states the design draws"],
    slice: { id: 1, title: "Product card with hover and focus states", est_loc: 60, touchpoints: ["src/ui/ProductCard.ts"], acceptance: ["the card shows the name and the price", "hover and focus-visible use the design's tokens"] },
    theirs: ["src/cart/total.ts"],
    message: "Build the product card. I own the cart total; do not touch it.",
    test: "test/ui/product-card.test.ts",
    frames: [{ id: "12:34", name: "Product card", viewport: { width: 320, height: 200 }, states: [state("default", "12:34"), state("hover", "12:35"), state("focus", "12:36")] }],
    components: [{ name: "ProductCard", nodeId: "12:34", codeConnect: { path: "src/ui/ProductCard.ts", name: "ProductCard" } }],
    a11yNotes: [{ frame: "12:36", note: "Focus shows a 2px ring in color/primary, offset 2, and is never removed." }],
    figma: { "12:34": "Frame \"Product card / default\" 320x200. A name, a price and a surface (color/surface), 16 padding, radius 8.", "12:35": "Frame \"Product card / hover\" 320x200. The same card; the border and the title use color/primary-hover.", "12:36": "Frame \"Product card / focus\" 320x200. The same card with a 2px ring in color/primary, offset 2." },
    summaryWords: ["hover", "focus"],
    tokenWords: ["--color-primary-hover", "--focus-ring"],
    rubric: "The slice builds the product card with the two states the spec draws: hover (the border and the title in color/primary-hover) and keyboard focus (a visible 2px ring in color/primary, offset 2). A good answer names the files it changed, which are only src/ui/ProductCard.ts, and says the scenario tests in test/ui/product-card.test.ts pass. It uses the spec's token names (the CSS variables --color-primary-hover and --focus-ring) and writes no raw colour or size of its own. A real error is an invented value the spec does not give, a state the spec lacks, a state of the spec left out, a change to src/cart/total.ts, package.json or the test file, or an escalation for a slice the spec fully covers. Do not credit anything the answer does not say.",
  },
  {
    id: "panel-empty-error",
    title: "Cart panel: empty and error",
    description: "The cart panel follows the Figma frames: the empty cart and the cart that failed to load.",
    criteria: ["The panel shows the empty and error states the design names"],
    slice: { id: 2, title: "Cart panel with empty and error states", est_loc: 70, touchpoints: ["src/ui/CartPanel.ts"], acceptance: ["an empty cart says so with role status", "an error is announced with role alert in the error colour"] },
    theirs: ["src/cart/total.ts", "src/ui/ProductCard.ts"],
    message: "Build the cart panel states. ProductCard is another slice's.",
    test: "test/ui/cart-panel.test.ts",
    frames: [{ id: "21:10", name: "Cart panel", viewport: { width: 360, height: 520 }, states: [state("default", "21:10"), state("empty", "21:20"), state("error", "21:30")] }],
    components: [{ name: "CartPanel", nodeId: "21:10", codeConnect: { path: "src/ui/CartPanel.ts", name: "CartPanel" } }],
    a11yNotes: [{ frame: "21:30", note: "The error message is announced (role alert) and drawn in color/error." }, { frame: "21:20", note: "The empty message is a status, not an alert." }],
    figma: { "21:10": "Frame \"Cart panel / default\" 360x520. A list of lines and a total.", "21:20": "Frame \"Cart panel / empty\" 360x520. The text \"Your cart is empty\" in color/text, centred.", "21:30": "Frame \"Cart panel / error\" 360x520. The text \"We could not load your cart\" in color/error." },
    summaryWords: ["empty", "error"],
    tokenWords: ["--color-error", "--color-text"],
    rubric: "The slice builds the empty state (the text 'Your cart is empty' as a polite status) and the error state ('We could not load your cart' as an alert, in the error colour) that the spec draws. A good answer names only src/ui/CartPanel.ts, says the scenario tests pass, and uses the spec's token names (--color-error, --color-text). A real error is an invented state (a loading or a disabled state the spec does not draw), an invented message or colour, a change to a locked file (src/cart/total.ts, src/ui/ProductCard.ts), or an escalation for a fully specified slice. Do not credit anything the answer does not say.",
  },
  {
    id: "field-a11y",
    title: "Email field: accessibility note",
    description: "The checkout email field follows the Figma frame and its accessibility note.",
    criteria: ["The email field is labelled, described and announces its error"],
    slice: { id: 3, title: "Email field with label, hint and error", est_loc: 50, touchpoints: ["src/ui/EmailField.ts"], acceptance: ["the label is tied to the input", "the hint and the error describe the input", "an error marks the input invalid and is announced"] },
    theirs: ["src/cart/total.ts"],
    message: "Build the email field from the spec; its a11y note is part of the acceptance.",
    test: "test/ui/email-field.test.ts",
    frames: [{ id: "31:10", name: "Email field", viewport: { width: 360, height: 96 }, states: [state("default", "31:10"), state("error", "31:20")] }],
    components: [{ name: "EmailField", nodeId: "31:10", codeConnect: { path: "src/ui/EmailField.ts", name: "EmailField" } }],
    a11yNotes: [{ frame: "31:20", note: "The input is aria-invalid, described by the hint and the error, and the error is a role alert in color/error." }],
    figma: { "31:10": "Frame \"Email field / default\" 360x96. A label, an input and a hint, 16 apart.", "31:20": "Frame \"Email field / error\" 360x96. The same field; the border and the message use color/error." },
    summaryWords: ["aria", "label"],
    tokenWords: ["--color-error", "--space-4"],
    rubric: "The slice builds the email field and its accessibility note: the label tied to the input (for/id), aria-describedby naming the hint and, on error, the error, aria-invalid, and the error as a role alert in the error colour. A good answer names only src/ui/EmailField.ts, says the scenario tests pass, and uses the spec's token names (--color-error, --space-4) with no raw value. A real error is dropping the a11y note, an invented value or state, a change to a locked file (src/cart/total.ts) or to the test, or an escalation for a fully specified slice. Do not credit anything the answer does not say.",
  },
];

rmSync(OUT, { recursive: true, force: true });
for (const c of CASES) {
  const dir = join(OUT, c.id);
  const figma = join(dir, "mcp", "figma");
  const put = (tool, args, text) => {
    mkdirSync(join(figma, tool), { recursive: true });
    writeFileSync(join(figma, tool, `${key(args)}.json`), json({ ok: true, text, images: [], truncated: false }));
  };
  cpSync(TOOLS, join(figma, "tools.json"));
  for (const [nodeId, text] of Object.entries(c.figma)) {
    put("get_design_context", { fileKey: FILE, nodeId }, text);
    put("get_metadata", { fileKey: FILE, nodeId }, text);
  }
  const first = c.frames[0].id;
  put("get_variable_defs", { fileKey: FILE, nodeId: first }, JSON.stringify(VARIABLES));
  put("get_code_connect_map", { fileKey: FILE, nodeId: first }, JSON.stringify({ [first]: { codeConnectSrc: c.components[0].codeConnect.path, codeConnectName: c.components[0].name } }));

  const spec = { frames: c.frames, tokens: TOKENS, components: c.components, a11yNotes: c.a11yNotes, missing: [], confidence: 0.9 };
  const stage = {
    schema: 3,
    stage: "implementing",
    pack: "ui_design",
    attempt: 1,
    task: { id: `eval-ui-${c.id}`, title: c.title, description: c.description, criteria: c.criteria, repoPath: "fixtures/golden-ui", branch: `luna-helper-${c.slice.id}`, source: null },
    plan: null,
    decisions: [],
    bridge: [],
    priorFindings: [],
    context: {
      projectContext: null,
      ledger: { schema: 1, slices: [{ id: c.slice.id, title: c.slice.title, status: "pending", commit: null }] },
      design: { refs: [{ fileKey: FILE, nodeIds: [first], page: null, from: "issue" }] },
      plan: { record: null, brief: c.description, criteria: c.criteria, assumptions: [], slices: [c.slice], designSpec: spec },
      scenarioTests: [{ scenario: c.criteria[0], file: c.test }],
      helper: { slice: { id: c.slice.id, title: c.slice.title, touchpoints: c.slice.touchpoints, acceptance: c.slice.acceptance }, message: c.message, base: BASE, locks: { mine: c.slice.touchpoints, theirs: c.theirs }, attempt: 1 },
    },
    limits: { maxTurns: 0, timeoutMs: 0 },
    env: { LUNA_FACTORY: "1" },
  };
  const mine = c.slice.touchpoints[0];
  const expectJson = {
    schema: 1,
    outcome: "pass",
    checks: [
      { kind: "count", path: "commits", min: 1 },
      { kind: "count", path: "escalation", max: 0 },
      { kind: "mentions", path: "files[]", words: [mine] },
      { kind: "avoids", path: "files[]", words: [...c.theirs, "package.json", c.test] },
      { kind: "mentions", path: "summary", words: c.summaryWords, any: true },
      { kind: "mentions", path: "summary", words: c.tokenWords, any: true },
    ],
    rubric: c.rubric,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stage.json"), json(stage));
  writeFileSync(join(dir, "expect.json"), json(expectJson));
}
console.log(`wrote ${CASES.length} cases under ${resolve(OUT)}`);
