// The Backlog: candidates that are not tickets yet, from every source, ranked by the machine
// (cost of delay over cost of doing). The page only shows them in the machine's order. Promote
// makes a ticket, bump counts one more report, decline drops it (asks first). Every text is a
// stranger's and is flattened to one line before it is drawn.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { ago } from "./model.js";
import { COMMANDS, page } from "./registry.js";
import { chip, mono, spinner, toneColor } from "./ui.js";
import { backlogChips, blockedLines, plain, refusalText, sourceLines } from "./views-model.js";
import { button, frame, note } from "./views-ui.js";

const POLL_MS = 10000;
const enc = encodeURIComponent;

export function loadBacklog(app, cx, { quiet = false } = {}) {
  const st = app.state("backlog");
  if (st.loading) return;
  st.loading = true;
  if (!quiet) cx.notify();
  cx.spawn(async (cx) => {
    try {
      const items = await app.machine.get("/backlog");
      st.items = Array.isArray(items) ? items : [];
      st.error = null;
      st.at = Date.now();
    } catch (e) {
      st.error = e?.message ?? String(e);
    }
    st.loading = false;
    cx.notify();
  });
}

function enter(app, cx) {
  const st = app.state("backlog");
  loadBacklog(app, cx);
  if (!st.timer) {
    st.timer = true;
    cx.timer.every(POLL_MS, (cx) => {
      if (app.page === "backlog") loadBacklog(app, cx, { quiet: true });
    });
  }
}

function promote(app, item, cx) {
  app.run(cx, `bl-${item.id}`, "Made a ticket", async () => {
    try {
      const task = await app.machine.post(`/backlog/${enc(item.id)}/promote`);
      loadBacklog(app, cx, { quiet: true });
      return task;
    } catch (e) {
      // 409 not_schedulable names what the item waits for.
      if (e?.code === "not_schedulable") throw new Error(refusalText(e.body));
      throw e;
    }
  });
}

function bump(app, item, cx) {
  app.run(cx, `bl-${item.id}`, "Counted one more report", async () => {
    const out = await app.machine.post(`/backlog/${enc(item.id)}/bump`);
    loadBacklog(app, cx, { quiet: true });
    return out;
  });
}

function decline(app, item) {
  app.confirm({
    title: "Decline this item?",
    body: `"${plain(item.title)}" leaves the backlog. Nothing is made from it.`,
    label: "Decline",
    danger: true,
    call: { method: "POST", path: `/backlog/${enc(item.id)}/decline` },
  });
}

function card(app, t, item, rank) {
  const busy = Boolean(app.busy?.has(`bl-${item.id}`));
  const sources = sourceLines(item);
  const blocked = blockedLines(item);
  return v_flex()
    .id(`bl-${item.id}`)
    .px(14)
    .py(10)
    .gap(6)
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(t.border)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().w(22).flex_none().text_size(11).font_family(mono()).text_color(t.dim).child(String(rank)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.8).font_medium().text_color(t.foreground).child(plain(item.title) || "Untitled"))
        .children(backlogChips(item).map((c) => chip(t, c.text, c.tone, 10.5)))
        .child(
          h_flex()
            .gap(6)
            .flex_none()
            .when(busy, (el) => el.child(spinner(t, 12)))
            .child(button(t, `bl-promote-${item.id}`, "Promote", "primary", (_e, cx) => promote(app, item, cx), { small: true, busy }))
            .child(button(t, `bl-bump-${item.id}`, "Bump", "plain", (_e, cx) => bump(app, item, cx), { small: true, busy }))
            .child(button(t, `bl-decline-${item.id}`, "Decline", "danger", () => decline(app, item), { small: true, busy })),
        ),
    )
    .when(Boolean(plain(item.text)), (el) => el.child(div().pl(32).text_size(11.5).text_color(t.muted).truncate().child(plain(item.text))))
    .child(
      h_flex()
        .pl(32)
        .gap(8)
        .flex_wrap()
        .text_size(11)
        .text_color(t.dim)
        .child(div().child(item.repo ? plain(item.repo) : "no repository"))
        .child(div().child(`· added ${ago(item.addedAt) ?? "—"}`))
        .children(sources.map((s) => div().child(`· ${s}`))),
    )
    .children(blocked.map((b) => div().pl(32).text_size(11).text_color(toneColor(t, "error")).child(b)));
}

function backlogPage(app, t) {
  const st = app.state("backlog");
  const q = String(app.query ?? "").trim().toLowerCase();
  const all = st.items ?? null;
  const items = (all ?? []).filter((i) => !q || `${i.title ?? ""} ${i.text ?? ""} ${i.repo ?? ""}`.toLowerCase().includes(q));
  const body = [];
  if (!all && !st.error) body.push(h_flex().gap(8).p(12).text_color(t.dim).child(spinner(t, 13)).child("Reading the backlog…"));
  if (st.error) body.push(note(t, st.error, "error"));
  if (all && items.length === 0) body.push(note(t, all.length ? "Nothing matches the search." : "The backlog is empty: nothing waits to become a ticket."));
  items.forEach((item, i) => body.push(card(app, t, item, i + 1)));
  const stale = (all ?? []).filter((i) => i.stale).length;
  return frame(app, t, {
    id: "backlog-list",
    title: "Backlog",
    summary: st.error ? st.error : all ? `${all.length} candidate${all.length === 1 ? "" : "s"}, ranked by the machine${stale ? ` · ${stale} stale` : ""}` : "Not read yet",
    error: Boolean(st.error) && !all,
    busy: Boolean(st.loading),
    actions: [button(t, "backlog-refresh", "Refresh", "plain", (_e, cx) => loadBacklog(app, cx), { iconName: "refresh", small: true, busy: Boolean(st.loading) })],
    body,
  });
}

page({
  id: "backlog",
  label: "Backlog",
  icon: "plan",
  group: "insight",
  render: backlogPage,
  enter,
  badge: (app) => {
    const n = app.state("backlog").items?.length ?? 0;
    return n ? { n, tone: null } : null;
  },
});

COMMANDS.backlog = (app, _arg, cx) => app.go("backlog", cx);
