// Parts the Inbox, Digest, Floor, Backlog and Tickets pages share: the page frame (the PR page's
// look: a 56px header with a title and a dim summary line, then the content), a section heading,
// a note, and the dialog that asks once before several calls.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { DIALOGS } from "./registry.js";
import { button, spinner, toneColor } from "./ui.js";

/**
 * A page: `title`, a dim `summary` (an error shows red), `actions` (buttons at the right), then
 * the scrolling `body` (an array of elements) under the unique `id`.
 */
export function frame(app, t, { id, title, summary, error = false, busy = false, actions = [], below = [], body }) {
  return v_flex()
    .flex_1()
    .min_w(0)
    .h_full()
    .bg(t.canvas)
    .child(
      h_flex()
        .h(56)
        .flex_none()
        .px(16)
        .gap(10)
        .items_center()
        .child(
          v_flex()
            .min_w(0)
            .child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
            .child(div().text_size(11).truncate().text_color(error ? toneColor(t, "error") : t.dim).child(summary ?? "")),
        )
        .child(div().flex_1())
        .when(Boolean(app.flash), (el) => el.child(div().max_w(380).truncate().text_size(11.5).text_color(app.flash.tone ? toneColor(t, app.flash.tone) : t.muted).child(app.flash.text)))
        .when(busy, (el) => el.child(spinner(t, 13)))
        .children(actions),
    )
    .children(below)
    .child(v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(14).gap(6).children(body));
}

/** A grey line for an empty list, a wait or an error. */
export function note(t, text, tone = null) {
  return div().p(12).text_size(12.5).text_color(tone ? toneColor(t, tone) : t.dim).child(text);
}

/** A small label over a block of the page. */
export function section(t, text) {
  return div().pt(14).pb(2).text_size(11).font_semibold().text_color(t.dim).child(String(text).toUpperCase());
}

/** A bordered tile, as a PR row is. */
export function tile(t, id) {
  return v_flex().id(id).px(14).py(10).gap(6).rounded(9).bg(t.background).border_1().border_color(t.border);
}

export { button };

// Asks once before several calls: `app.dialog({kind: "luna_many", title, body, label, danger,
// calls: [{method, path, body}]})`. It sends them in turn and counts the refusals.
DIALOGS.luna_many = {
  title: "Are you sure?",
  height: 240,
  body: (app, t, d) => [div().pt(8).text_size(12.5).text_color(t.foreground).child(d.body ?? "")],
  primary: (app, d) => ({ label: d.label ?? "Go on", kind: d.danger ? "danger" : "primary" }),
  submit: (app, cx, d) =>
    app.send(cx, async () => {
      let done = 0;
      let last = null;
      for (const c of d.calls ?? []) {
        try {
          await app.machine.call(c.method ?? "POST", c.path, c.body);
          done += 1;
        } catch (e) {
          last = e?.message ?? String(e);
        }
      }
      const total = (d.calls ?? []).length;
      if (done < total) throw new Error(`${d.done ?? "Done"} ${done} of ${total}; ${total - done} refused${last ? `: ${last}` : ""}`);
      return null;
    }),
};
