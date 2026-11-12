// A stand-in for Herdr's UI kit and host API: every element method chains, every child is
// walked, and host reads answer fixed data. Enough to run a render and catch a crash.
export const calls = [];

function element(kind) {
  const el = { kind, kids: [], words: [] };
  return new Proxy(el, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      return (...args) => {
        if (prop === "child") {
          const c = args[0];
          if (c == null) throw new TypeError(`child(${c}) on ${kind}`);
          if (typeof c === "string" || typeof c === "number") target.words.push(String(c));
          else target.kids.push(c);
        } else if (prop === "children") {
          for (const c of args[0]) {
            if (c == null) throw new TypeError(`a null child in children() on ${kind}`);
            target.kids.push(c);
          }
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
export const InputState = { new: () => ({ value: () => "", on() {}, focus() {}, set_value() {} }) };
export const TextareaState = InputState;

const COLORS = ["background", "surface", "canvas", "chrome", "popover", "raised", "hover", "selected", "border", "input", "foreground", "muted", "dim", "accent", "accent_foreground", "solid", "solid_foreground", "selection", "working", "blocked", "done", "idle", "unknown"];
export const theme = () => Object.fromEntries([...COLORS, ...Array.from({ length: 16 }, (_, i) => `ansi${i}`)].map((c) => [c, "#336699"]));
export const settings = () => ({ font: "JetBrains Mono" });
export const props = () => ({});
export const run = (...a) => calls.push(["run", ...a]);
export const notify = (...a) => calls.push(["notify", ...a]);
export const openOverlay = (...a) => calls.push(["openOverlay", ...a]);
export const closeOverlay = () => null;
export const setShared = () => null;
export const shared = () => null;
export const exec = async () => ({ code: 1, stdout: "", stderr: "" });
export const readTextFile = async () => null;
export const home = () => "/home/test";
export const appHome = () => "/home/test/.config/herdr-app";
export const pickFolder = async () => null;
export const nextCommand = () => new Promise(() => {});
export const watchFolder = () => new Promise(() => {});
