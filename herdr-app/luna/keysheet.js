// The keys sheet (`?`): every key of the board and of the page that has the keyboard, grouped as
// the TUI's sheet is. Pages add their own groups with `keys: [{name, rows: [[keys, does]]}]`.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, props } from "herdr";

import { sheetGroups } from "./controls.js";
import { keyName } from "./controls.js";
import { PAGES, DIALOGS } from "./registry.js";
import { mono } from "./ui.js";

DIALOGS.keys = {
  title: "Keys",
  height: 560,
  width: 520,
  body: (app, t, d) => {
    const extra = PAGES.find((p) => p.id === d.page)?.keys ?? [];
    const out = [];
    for (const g of sheetGroups(d.page, extra)) {
      out.push(div().pt(12).pb(4).text_size(10).font_bold().text_color(t.dim).child(g.name.toUpperCase()));
      for (const [keys, does] of g.rows) {
        out.push(
          h_flex()
            .gap(10)
            .py(2)
            .items_start()
            .child(div().w(122).flex_none().font_family(mono()).text_size(11.5).text_color(t.accent).child(keys))
            .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(does)),
        );
      }
    }
    out.push(v_flex().pt(12).child(div().text_size(11).text_color(t.dim).child("After g or z the board waits for the second key. Inside a dialog, esc closes it.")));
    return out;
  },
  primary: () => null,
  key: (app, e) => {
    const k = keyName(e);
    if (k === "q" || k === "?") {
      closeOverlay(props().overlay);
      return true;
    }
    return false;
  },
};
