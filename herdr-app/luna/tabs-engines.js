// The Engines tab: each stage the ticket runs, the engine it is set to (else the default) and the
// one it ran on. A click opens a picker dialog; PATCH /tasks/:id/stages sets or clears the engine.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { stageWords } from "./model.js";
import { button, toneColor } from "./ui.js";
import { DIALOGS, tab } from "./registry.js";
import { engineChoices, engineRows, taskPacks } from "./detail-model.js";
import { note, ownState } from "./tabs-detail.js";

/** Reads /packs and /engines into `ownState(app, "engines")`; kept after the first read, read again on each visit. */
function load(app, cx) {
  const st = ownState(app, "engines");
  if (st.loading) return;
  st.loading = true;
  cx.spawn(async (cx) => {
    try {
      const [packs, engines] = await Promise.all([app.machine.get("/packs"), app.machine.get("/engines")]);
      Object.assign(st, { packs, engines, error: null });
    } catch (e) {
      st.error = e?.status === 404 ? "This machine does not offer engines." : e?.message ?? String(e);
    }
    st.loading = false;
    cx.notify();
  });
}

function engines(app, t, task, detail) {
  const st = ownState(app, "engines");
  if (st.error && !st.packs) return note(t, st.error);
  if (!st.packs) return note(t, "Reading the engines…");
  const rows = engineRows(task, detail, st.packs, st.engines);
  if (!rows.length) return note(t, "This machine lists no stage that runs a model.");
  const packs = taskPacks(st.packs);
  const el = v_flex().gap(2).child(div().pb(6).text_size(11.5).text_color(t.dim).child("What each stage runs on, for this ticket. A stage that already ran keeps its engine."));
  rows.forEach((r, i) => {
    const pack = packs.find((p) => p.id === r.pack);
    el.child(
      h_flex()
        .id(`engine-${r.pack}`)
        .gap(8)
        .items_center()
        .min_h(30)
        .px(6)
        .rounded(6)
        .hover((x) => x.bg(t.hover))
        .child(div().w(110).flex_none().truncate().text_size(12).font_semibold().text_color(t.foreground).child(stageWords(r.pack)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(r.isDefault ? t.muted : t.blocked).child(r.engine))
        .when(Boolean(r.off), (x) => x.child(div().flex_none().text_size(10.5).text_color(toneColor(t, "error")).child(r.off)))
        .child(div().w(90).flex_none().truncate().text_size(10.5).text_color(t.dim).child(r.ran ? `ran on ${r.ran}` : ""))
        .child(
          button(t, `engine-pick-${r.pack}`, "Change", "plain", () =>
            app.dialog({ kind: "engine", taskId: task.id, pack: r.pack, current: task.stages?.[r.pack] ?? null, choices: engineChoices(pack, st.engines), ran: Boolean(r.ran), subtitle: `${stageWords(r.pack)} runs on ${r.engine}` }, Math.min(520, 190 + (pack?.engines?.allowed?.length ?? 0) * 40)),
            { small: true }),
        ),
    );
  });
  return el;
}

tab({ id: "engines", label: "Engines", order: 80, enter: (app, task, cx) => load(app, cx), render: engines });

// The picker: the default, then each engine the stage allows. One that has no credential here is
// dim, shows why, and cannot be picked. Picking sends the change and closes.
DIALOGS.engine = {
  title: "Pick the engine",
  height: 340,
  body: (app, t, d) => [
    ...(d.ran ? [div().pt(6).pb(4).text_size(11.5).text_color(t.blocked).child("This stage already ran on the ticket: the machine will refuse a change.")] : []),
    ...(d.choices ?? []).map((c, i) => {
      const on = (c.engine ?? null) === (d.current ?? null);
      const off = Boolean(c.off);
      return h_flex()
        .id(`eng-${i}`)
        .gap(9)
        .px(10)
        .min_h(36)
        .py(4)
        .items_center()
        .rounded(7)
        .when(on, (x) => x.bg(t.selected))
        .when(off, (x) => x.opacity(0.5))
        .when(!off, (x) =>
          x
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => app.send(cx, () => pick(app, d, c.engine))),
        )
        .child(div().w(12).flex_none().text_color(t.accent).child(on ? "●" : ""))
        .child(v_flex().flex_1().min_w(0).child(div().text_size(12.5).text_color(t.foreground).child(c.label)).when(off, (x) => x.child(div().text_size(10.5).text_color(toneColor(t, "error")).child(String(c.off)))));
    }),
  ],
  primary: () => null,
};

async function pick(app, d, engine) {
  try {
    await app.machine.patch(`/tasks/${encodeURIComponent(d.taskId)}/stages`, { stages: { [d.pack]: engine } });
  } catch (e) {
    if (e?.code === "stage_started") throw new Error("That stage has already run on this ticket, so it keeps its engine.");
    throw e;
  }
}
