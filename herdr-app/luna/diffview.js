// The Changes tab: the branch's files; click one to load its patch and read it as diff rows
// (hunk headers, added lines on a done wash, removed on an error wash, line numbers, monospace).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec } from "herdr";

import { alpha, button, chip, mono, toneColor } from "./ui.js";
import { tab } from "./registry.js";
import { parsePatch, worktreeFile } from "./detail-model.js";
import { note, ownState } from "./tabs-detail.js";

/** Patches run to 512 KB, so only this many rows are drawn until the person asks for more. */
export const ROWS_AT_FIRST = 400;
const STATUS = { A: ["added", "done"], D: ["deleted", "error"], R: ["renamed", null] };

/** The tab's state for a task: `{file, patch, truncated, error, loading, shown}`. */
const stateOf = (app, id) => (ownState(app, "changes")[id] ??= {});

function loadPatch(app, task, file, cx) {
  const st = stateOf(app, task.id);
  Object.assign(st, { file, patch: null, truncated: false, error: null, loading: true, shown: ROWS_AT_FIRST });
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const out = await app.machine.diff(task.id, file);
      if (st.file === file) Object.assign(st, { patch: out?.patch ?? "", truncated: Boolean(out?.truncated), loading: false });
    } catch (e) {
      if (st.file === file) Object.assign(st, { error: e?.message ?? String(e), loading: false });
    }
    cx.notify();
  });
}

function patchRows(t, rows, shown) {
  const num = (n) => div().w(34).flex_none().text_right().text_size(10).text_color(t.dim).child(n == null ? "" : String(n));
  return v_flex().children(
    rows.slice(0, shown).map((r, i) => {
      const add = r.kind === "add";
      const del = r.kind === "del";
      const hunk = r.kind === "hunk";
      const wash = add ? alpha(toneColor(t, "done"), 0.16) : del ? alpha(toneColor(t, "error"), 0.16) : hunk ? t.hover : null;
      let el = h_flex().id(`dl-${i}`).gap(6).px(4).items_start().font_family(mono()).text_size(11);
      if (wash) el = el.bg(wash);
      return el
        .child(num(r.old))
        .child(num(r.new))
        .child(div().w(10).flex_none().text_color(add ? toneColor(t, "done") : del ? toneColor(t, "error") : t.dim).child(add ? "+" : del ? "−" : ""))
        .child(div().flex_1().min_w(0).whitespace_nowrap().text_color(hunk ? t.accent : r.kind === "meta" ? t.dim : t.foreground).child(r.text === "" ? " " : r.text));
    }),
  );
}

function changes(app, t, task) {
  const d = app.diffs[task.id];
  if (!d) return note(t, "Reading…");
  if (d.error) return note(t, d.error);
  const files = Array.isArray(d.files) ? d.files : [];
  if (!files.length) return note(t, `No changes against ${d.base ?? "its base"} yet.`);
  const st = stateOf(app, task.id);
  const el = v_flex().gap(1).child(div().pb(6).text_size(11.5).text_color(t.dim).child(`${files.length} file${files.length === 1 ? "" : "s"} against ${d.base ?? "its base"}`));
  files.forEach((f) => {
    const on = st.file === f.path;
    el.child(
      h_flex()
        .id(`file-${f.path}`)
        .gap(8)
        .h(24)
        .px(6)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(on, (x) => x.bg(t.selected))
        .hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => loadPatch(app, task, f.path, cx))
        .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(t.foreground).child(f.path))
        .when(Boolean(STATUS[f.status]), (x) => x.child(chip(t, STATUS[f.status][0], STATUS[f.status][1])))
        .child(div().text_size(11).text_color(t.done).child(`+${f.added ?? 0}`))
        .child(div().text_size(11).text_color(toneColor(t, "error")).child(`−${f.removed ?? 0}`)),
    );
  });
  if (!st.file) return el.child(div().pt(8).text_size(12).text_color(t.dim).child("Click a file to read its patch."));
  const path = worktreeFile(task, st.file);
  el.child(
    h_flex()
      .pt(10)
      .pb(4)
      .gap(8)
      .items_center()
      .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11.5).font_semibold().text_color(t.foreground).child(st.file))
      .child(button(t, "open-file", "Open file", "plain", () => path && exec("open", [path]).catch(() => null), { iconName: "external", small: true, busy: !path })),
  );
  if (st.loading) return el.child(note(t, "Reading the patch…"));
  if (st.error) return el.child(note(t, st.error));
  const rows = parsePatch(st.patch ?? "");
  if (!rows.length) return el.child(note(t, "No patch for this file: it may be binary."));
  const shown = st.shown ?? ROWS_AT_FIRST;
  el.child(div().rounded(7).border_1().border_color(t.border).bg(t.background).py(4).child(patchRows(t, rows, shown)));
  if (rows.length > shown) {
    el.child(
      button(t, "more-rows", `Show ${Math.min(ROWS_AT_FIRST, rows.length - shown)} more of ${rows.length - shown} lines`, "quiet", (_e, cx) => {
        st.shown = shown + ROWS_AT_FIRST;
        cx.notify();
      }, { small: true }),
    );
  }
  if (st.truncated) el.child(div().pt(4).text_size(11.5).text_color(t.blocked).child("… cut: the machine sends at most 512 KB of a patch."));
  return el;
}

tab({ id: "changes", label: "Changes", order: 50, count: (app, task) => app.diffs[task.id]?.files?.length, enter: (app, task, cx) => app.loadDiff(task.id, cx), render: changes });
