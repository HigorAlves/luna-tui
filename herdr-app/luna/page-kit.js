// Parts the Slack, Economy and Jira pages share, in the look of the PR page: a 56px header with
// a title and a dim summary, split pills, cards on the background with a border, and an inline
// "are you sure" bar (the page makes the call itself, so it can read the answer).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { button, icon, spinner, toneColor } from "./ui.js";

/** The page header: title, a dim one-line summary (error tone with `tone`), the flash, and buttons. */
export function header(app, t, { title, summary, tone = null, busy = false, right = [] }) {
  return h_flex()
    .h(56)
    .flex_none()
    .px(16)
    .gap(10)
    .items_center()
    .child(
      v_flex()
        .min_w(0)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(tone ? toneColor(t, tone) : t.dim).truncate().child(summary ?? "")),
    )
    .child(div().flex_1())
    .when(Boolean(app.flash), (el) => el.child(div().max_w(420).truncate().text_size(11.5).text_color(app.flash.tone ? toneColor(t, app.flash.tone) : t.muted).child(app.flash.text)))
    .when(busy, (el) => el.child(spinner(t, 13)))
    .children(right);
}

/** A split pill with its count. */
export function pill(t, id, label, n, on, onClick) {
  return h_flex()
    .id(id)
    .h(24)
    .px(9)
    .gap(5)
    .items_center()
    .rounded(12)
    .text_size(11.5)
    .cursor_pointer()
    .when(on, (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold())
    .when(!on, (el) => el.bg(t.hover).text_color(t.muted).hover((s) => s.text_color(t.foreground)))
    .on_click(onClick)
    .child(label)
    .when(n != null, (el) => el.child(div().text_size(10.5).child(String(n))));
}

/** A tab with the accent underline. */
export function tabItem(t, id, label, on, onClick) {
  return h_flex()
    .id(id)
    .h(34)
    .items_center()
    .border_b(2)
    .border_color(on ? t.accent : t.canvas)
    .text_size(12.5)
    .cursor_pointer()
    .text_color(on ? t.foreground : t.muted)
    .when(on, (el) => el.font_semibold())
    .on_click(onClick)
    .child(label);
}

export function tabBar(t, tabs) {
  return h_flex().gap(18).px(16).items_end().border_b(1).border_color(t.border).children(tabs);
}

/** A card for what a page cannot show: what the machine says, and how to set it up. */
export function notice(t, { title, body, setup = false, tone = null }) {
  return v_flex()
    .gap(6)
    .p(14)
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(t.border)
    .child(h_flex().gap(8).items_center().child(icon("alert", 14, tone ? toneColor(t, tone) : t.dim)).child(div().text_size(13).font_semibold().text_color(t.foreground).child(title)))
    .when(Boolean(body), (el) => el.child(div().text_size(12).text_color(t.muted).child(body)))
    .when(setup, (el) => el.child(div().text_size(12).text_color(t.muted).child("To set it up, run `make integrations` in the Luna repository: it asks for the tokens and restarts the machine.")));
}

/** The inline confirmation: what will happen, and Yes / No. `ask` is {text, label, danger, run}. */
export function confirmBar(app, t, ask, clear) {
  return h_flex()
    .gap(8)
    .items_center()
    .px(12)
    .py(8)
    .rounded(8)
    .bg(t.hover)
    .border_1()
    .border_color(ask.danger ? toneColor(t, "error") : t.border)
    .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(ask.text))
    .child(button(t, "ask-no", "Cancel", "plain", (_e, cx) => clear(cx), { small: true }))
    .child(
      button(t, "ask-yes", ask.label ?? "Go on", ask.danger ? "destructive" : "primary", (_e, cx) => {
        clear(cx);
        ask.run(cx);
      }, { small: true }),
    );
}

/** A list scroller with the page's padding and gap. */
export function scroller(id) {
  return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(12).gap(6);
}

/** A page's frame: canvas background, full height. */
export function frame(t) {
  return v_flex().flex_1().min_w(0).h_full().bg(t.canvas);
}

/** A card row's base. */
export function card(t, id, selected = false) {
  return h_flex()
    .id(id)
    .px(14)
    .py(10)
    .gap(12)
    .items_center()
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(selected ? t.accent : t.border)
    .hover((s) => s.border_color(selected ? t.accent : t.input));
}

/** `fn` once per page-state, guarded by a flag, so a load starts at most once at a time. */
export function once(st, flag, fn) {
  if (st[flag]) return;
  st[flag] = true;
  fn();
}
