// Small parts every view of the mod draws with: icons, chips, buttons, labels. Colors are
// always Herdr's theme (`theme()`), so the board follows the person's light or dark theme.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { settings } from "herdr";

const ICONS = "mods/luna/icons";

/** A line icon from icons/, tinted with `color` (else the text color). */
export function icon(name, size = 14, color = null) {
  const el = svg(`${ICONS}/${name}.svg`).size(size).flex_none();
  return color ? el.text_color(color) : el;
}

/** `color` at `a` (0..1) opacity: `#rrggbb` or `#rrggbbaa` in, `#rrggbbaa` out. */
export function alpha(color, a) {
  if (typeof color !== "string" || !color.startsWith("#")) return color;
  const hex = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
  return `${color.slice(0, 7)}${hex}`;
}

/** A tone name (`working`, `blocked`, `done`, `error`, or null) as a theme color. */
export function toneColor(t, tone) {
  if (tone === "error") return t.ansi1 ?? t.blocked;
  if (tone === "accent") return t.accent;
  return t[tone] ?? t.muted;
}

/** The terminal font, for ids, paths and code. */
export const mono = () => settings()?.font ?? "JetBrains Mono";

/** A small rounded chip: muted on a faint tile, or the tone's color on its own wash. */
export function chip(t, text, tone = null, size = 10.5) {
  const c = tone ? toneColor(t, tone) : null;
  return div()
    .flex_none()
    .px(6)
    .h(17)
    .flex()
    .items_center()
    .rounded(9)
    .text_size(size)
    .whitespace_nowrap()
    .bg(c ? alpha(c, 0.15) : t.hover)
    .text_color(c ?? t.muted)
    .child(text);
}

/**
 * A button. `kind`: `primary` (the accent), `destructive` (filled red), `danger` (red text),
 * `plain` (a raised tile) or `quiet` (text only). `busy` dims it and ignores clicks.
 */
export function button(t, id, label, kind, onClick, { small = false, iconName = null, busy = false, grow = false } = {}) {
  const h = small ? 22 : 28;
  const primary = kind === "primary" || kind === "destructive";
  const bg = kind === "destructive" ? toneColor(t, "error") : primary ? t.accent : kind === "quiet" || kind === "danger" ? null : t.raised;
  const fg = kind === "destructive" ? t.background : primary ? t.accent_foreground : kind === "danger" ? toneColor(t, "error") : t.foreground;
  let el = h_flex()
    .id(id)
    .h(h)
    .px(small ? 8 : 12)
    .gap(6)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(small ? 6 : 7)
    .text_size(small ? 11 : 12)
    .whitespace_nowrap()
    .text_color(fg)
    .cursor_pointer();
  if (grow) el = el.flex_1();
  if (primary) el = el.font_semibold();
  if (bg) el = el.bg(bg);
  if (kind === "plain") el = el.border_1().border_color(t.border);
  el = busy ? el.opacity(0.55) : el.hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover))).on_click((e, cx) => {
    cx.stop_propagation();
    onClick(e, cx);
  });
  if (iconName) el = el.child(icon(iconName, small ? 11 : 13));
  return el.child(label);
}

/** An uppercase section label in the accent: `PLAN`. */
export function groupLabel(t, text) {
  return div().text_size(10).font_bold().text_color(t.dim).child(text.toUpperCase());
}

/** A small grey heading over a list: `Views`, `Projects`. */
export function heading(t, text) {
  return div().px(10).pt(12).pb(4).text_size(11).font_medium().text_color(t.dim).child(text);
}

/** A colored dot for a project: one of the theme's ANSI colors, picked from its name so it stays put. */
export function projectColor(t, name) {
  const palette = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi12, t.ansi13, t.ansi14].filter(Boolean);
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return palette[h % palette.length] ?? t.accent;
}

export function dot(color, size = 7) {
  return div().size(size).flex_none().rounded(size).bg(color);
}

/** A spinner that turns on its own (no timer), in the working color. */
export function spinner(t, size = 12) {
  return svg(`${ICONS}/spinner.svg`).size(size).flex_none().text_color(t.working).spin(900);
}

/** A key-value cell for a facts grid. */
export function fact(t, key, value, { monoValue = false } = {}) {
  let v = div().text_size(12.5).text_color(t.foreground).truncate().child(value ?? "—");
  if (monoValue) v = v.font_family(mono()).text_size(11.5);
  return div().flex().flex_col().min_w(0).px(8).py(5).rounded(7).child(div().text_size(10.5).text_color(t.dim).child(key)).child(v);
}
