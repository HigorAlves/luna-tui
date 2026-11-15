// A stand-in for Herdr's UI kit and host API: every element method chains, every child is
// walked, and host reads answer fixed data. Enough to run a render and catch a crash.
export const calls = [];

// What real GPUI refuses or draws wrong, checked strictly: a child is text or an element (never a
// number, an array, null or undefined), a color is a theme color string, a length a finite number.
const LENGTHS = new Set(["p", "px", "py", "pt", "pb", "pl", "pr", "m", "mx", "my", "mt", "mb", "ml", "mr", "w", "h", "min_w", "max_w", "min_h", "max_h", "gap", "gap_x", "gap_y", "size", "rounded", "text_size", "top", "left", "right", "bottom", "border_l", "border_r", "border_t", "border_b"]);
const COLOR_ARGS = new Set(["bg", "text_color", "border_color"]);
const isElement = (c) => c != null && typeof c === "object" && "kids" in c && "kind" in c;

function check(kind, prop, args) {
  const where = `${prop}() on ${kind}`;
  if (prop === "child") {
    const c = args[0];
    if (!(typeof c === "string" || isElement(c))) throw new TypeError(`${where}: a child must be text or an element, got ${Array.isArray(c) ? "an array" : typeof c} ${String(c).slice(0, 40)}`);
  } else if (prop === "children") {
    if (!Array.isArray(args[0])) throw new TypeError(`${where}: expects an array`);
    args[0].forEach((c, i) => {
      if (!(typeof c === "string" || isElement(c))) throw new TypeError(`${where}: child ${i} is ${Array.isArray(c) ? "an array" : typeof c} ${String(c).slice(0, 40)}`);
    });
  } else if (prop === "when") {
    if (typeof args[1] !== "function") throw new TypeError(`${where}: the branch must be a function`);
  } else if (LENGTHS.has(prop)) {
    if (args.length && !(typeof args[0] === "number" && Number.isFinite(args[0]))) throw new TypeError(`${where}: a length must be a finite number, got ${args[0]}`);
  } else if (COLOR_ARGS.has(prop)) {
    if (!(typeof args[0] === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(args[0]))) throw new TypeError(`${where}: a color must be #rrggbb[aa], got ${args[0]}`);
  } else if (prop === "id") {
    if (typeof args[0] !== "string" || !args[0]) throw new TypeError(`${where}: an id must be a non-empty string, got ${args[0]}`);
  } else if (["on_click", "on_key_down", "on_size_change", "on_hover"].includes(prop)) {
    if (typeof args[0] !== "function") throw new TypeError(`${where}: the handler must be a function`);
  }
}

function element(kind) {
  const el = { kind, kids: [], words: [] };
  return new Proxy(el, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      return (...args) => {
        check(kind, prop, args);
        if (prop === "child") {
          const c = args[0];
          if (typeof c === "string") target.words.push(c);
          else target.kids.push(c);
        } else if (prop === "children") {
          for (const c of args[0]) target.kids.push(c);
        } else if (prop === "when") {
          return args[0] ? args[1](new Proxy(target, this)) : new Proxy(target, this);
        } else if (["hover"].includes(prop)) {
          args[0](element("style"));
        }
        return new Proxy(target, this);
      };
    },
  });
}

export const div = () => element("div");
export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const svg = (path) => element(`svg:${path}`);
export const image = (path) => element(`image:${path}`);
export class View {}
export const TextView = { markdown: (id, md) => element(`markdown:${md.slice(0, 20)}`), html: () => element("html") };
export const Input = { new: () => element("input") };
export const Textarea = { new: () => element("textarea") };
// `on` keeps its handlers and `emit` fires them, so a test can focus and blur an input.
export const InputState = { new: () => ({ value: () => "", on(name, fn) { ((this.handlers ??= {})[name] ??= []).push(fn); }, emit(name, ...a) { for (const fn of this.handlers?.[name] ?? []) fn(...a); }, focus() {}, set_value() {} }) };
export const TextareaState = InputState;

const COLORS = ["background", "surface", "canvas", "chrome", "popover", "raised", "hover", "selected", "border", "input", "foreground", "muted", "dim", "accent", "accent_foreground", "solid", "solid_foreground", "selection", "working", "blocked", "done", "idle", "unknown"];
export const theme = () => Object.fromEntries([...COLORS, ...Array.from({ length: 16 }, (_, i) => `ansi${i}`)].map((c) => [c, "#336699"]));
export const settings = () => ({ font: "JetBrains Mono" });
export const props = () => ({});
export const run = (...a) => calls.push(["run", ...a]);
export const notify = (...a) => calls.push(["notify", ...a]);
export const openOverlay = (...a) => calls.push(["openOverlay", ...a]);
export const closeOverlay = () => null;
// Herdr's shared store, kept in a map a test can read and fill.
export const sharedStore = {};
export const setShared = (key, value) => {
  sharedStore[key] = value;
  return null;
};
export const shared = (key) => sharedStore[key] ?? null;
export const exec = async () => ({ code: 1, stdout: "", stderr: "" });
export const readTextFile = async () => null;
export const home = () => "/home/test";
export const appHome = () => "/home/test/.config/herdr-app";
export const pickFolder = async () => null;
export const nextCommand = () => new Promise(() => {});
export const watchFolder = () => new Promise(() => {});
