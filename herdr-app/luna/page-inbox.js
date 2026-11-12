// The Inbox: what needs you, split by why (Approve, Review, Failed, Stale), the one waiting
// longest first. Each row is a ticket with its gate question and its gate actions; `Approve all`
// asks once and approves every ticket in Approve that one yes can approve (the TUI's `A`).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { actionsFor, ago, cardId, cardLine, plainTitle, projectOf } from "./model.js";
import { COMMANDS, page } from "./registry.js";
import { chip, dot, icon, mono, projectColor, spinner } from "./ui.js";
import { INBOX_SPLITS, bulkTargets, bulkWords, inboxCounts, inboxItems } from "./views-model.js";
import { button, frame, note } from "./views-ui.js";

/** Actions the row offers: the gate's own, never the destructive ones (those are in the inspector). */
const ROW_HIDDEN = new Set(["archive", "delete", "abort"]);

/** A ticket row with its question and actions; the Digest draws the same one. */
export function ticketRow(app, t, task, { actions = true, extra = [] } = {}) {
  const line = cardLine(task);
  const busy = Boolean(app.busy?.has(task.id));
  const name = projectOf(task);
  const list = actions ? actionsFor(task).filter((a) => !ROW_HIDDEN.has(a.id)).slice(0, 3) : [];
  const stop = actions && Boolean(task.running);
  return h_flex()
    .id(`tk-${task.id}`)
    .px(14)
    .py(10)
    .gap(12)
    .items_center()
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(t.border)
    .hover((s) => s.border_color(t.input))
    .cursor_pointer()
    .on_click((_e, cx) => {
      app.go("board", cx);
      app.select(task.id, cx);
    })
    .child(icon("hand", 15, line.tone ? t[line.tone] ?? t.muted : t.muted))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(3)
        .child(div().truncate().text_size(12.8).font_medium().text_color(t.foreground).child(plainTitle(task) || "Untitled"))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(dot(projectColor(t, name), 6))
            .child(div().child(name))
            .child(div().font_family(mono()).text_size(10.5).child(cardId(task)))
            .child(div().child(`· ${ago(task.updatedAt) ?? "—"}`)),
        ),
    )
    .child(chip(t, line.text, line.tone, 11))
    .children(extra)
    .child(
      h_flex()
        .gap(6)
        .flex_none()
        .when(busy, (el) => el.child(spinner(t, 12)))
        .children(list.map((a) => button(t, `tka-${task.id}-${a.id}`, a.label, a.kind, (_e, cx) => app.act(task, a.id, cx), { small: true, busy })))
        .when(stop, (el) =>
          el.child(
            button(
              t,
              `tka-${task.id}-stop`,
              "Stop",
              "danger",
              () => app.confirm({ title: "Stop the stage?", body: `${plainTitle(task)} stops where it is. Start it again from the board.`, label: "Stop", danger: true, call: { method: "POST", path: `/tasks/${encodeURIComponent(task.id)}/abort` } }),
              { small: true },
            ),
          ),
        ),
    );
}

function pills(t, counts, st) {
  return h_flex()
    .py(8)
    .gap(6)
    .flex_wrap()
    .children(
      INBOX_SPLITS.map(([id, label]) =>
        h_flex()
          .id(`isplit-${id}`)
          .h(24)
          .px(9)
          .gap(5)
          .items_center()
          .rounded(12)
          .text_size(11.5)
          .cursor_pointer()
          .when(st.split === id, (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold())
          .when(st.split !== id, (el) => el.bg(t.hover).text_color(t.muted))
          .on_click((_e, cx) => {
            st.split = id;
            st.cursor = 0;
            cx.notify();
          })
          .child(label)
          .child(div().text_size(10.5).child(String(counts[id] ?? 0))),
      ),
    );
}

function approveAll(app, cx) {
  const targets = bulkTargets(app.tasks);
  if (!targets.length) {
    app.say("Nothing to approve together: open a ticket to approve it");
    return cx.notify();
  }
  const approver = app.machine?.approver;
  app.dialog(
    {
      kind: "luna_many",
      title: "Approve every ticket in Approve",
      body: `${bulkWords(targets)} get a yes at once. A release or a ship goes out as soon as it is approved.`,
      label: `Approve ${targets.length}`,
      done: "Approved",
      calls: targets.map(({ task }) => ({ method: "POST", path: `/tasks/${encodeURIComponent(task.id)}/decision`, body: { decision: "approved", ...(approver ? { approver } : {}) } })),
    },
    260,
  );
}

function inboxPage(app, t) {
  const st = app.state("inbox");
  st.split ??= "approve";
  st.cursor ??= 0;
  const now = Date.now();
  const tasks = app.tasks ?? [];
  const counts = inboxCounts(tasks, now);
  const items = inboxItems(tasks, st.split, now, app.query);
  st.shown = items.map((x) => x.id);
  const oldest = inboxItems(tasks, "all", now)[0];
  const bulk = bulkTargets(tasks, now).length;
  const offline = !app.loaded && app.link === "offline";
  const summary = offline
    ? app.error ?? "The machine does not answer"
    : counts.all
      ? `${counts.all} need${counts.all === 1 ? "s" : ""} you · the oldest waited ${ago(oldest?.updatedAt)?.replace(" ago", "") ?? "—"}`
      : "Nothing needs you";
  return frame(app, t, {
    id: "inbox-list",
    title: "Inbox",
    summary,
    error: offline,
    actions: [button(t, "inbox-approve-all", bulk ? `Approve all (${bulk})` : "Approve all", "plain", (_e, cx) => approveAll(app, cx), { small: true, iconName: "check", busy: !bulk })],
    below: [h_flex().px(16).child(pills(t, counts, st))],
    body: [
      ...(!app.loaded && !offline ? [h_flex().gap(8).p(12).text_color(t.dim).child(spinner(t, 13)).child("Reading the board…")] : []),
      ...(app.loaded && items.length === 0 ? [note(t, app.query ? "Nothing matches the search." : "Caught up: nothing here needs you.")] : []),
      ...items.map((task, i) => div().rounded(9).when(i === st.cursor, (el) => el.border_1().border_color(t.accent)).child(ticketRow(app, t, task))),
    ],
  });
}

function inboxKey(app, e, cx) {
  const st = app.state("inbox");
  const ids = st.shown ?? [];
  const at = Math.min(st.cursor ?? 0, Math.max(0, ids.length - 1));
  const idx = Math.max(0, INBOX_SPLITS.findIndex(([id]) => id === (st.split ?? "approve")));
  const to = (n) => {
    st.split = INBOX_SPLITS[(n + INBOX_SPLITS.length) % INBOX_SPLITS.length][0];
    st.cursor = 0;
  };
  switch (e.key) {
    case "j": case "down": st.cursor = Math.min(Math.max(0, ids.length - 1), at + 1); break;
    case "k": case "up": st.cursor = Math.max(0, at - 1); break;
    case "l": to(idx + 1); break;
    case "h": to(idx - 1); break;
    case "A": approveAll(app, cx); break;
    case "enter":
      if (!ids[at]) return false;
      app.go("board", cx);
      app.select(ids[at], cx);
      return true;
    case "a": {
      const task = (app.tasks ?? []).find((x) => x.id === ids[at]);
      const a = task && actionsFor(task).find((x) => x.kind === "primary");
      if (!a) return false;
      app.act(task, a.id, cx);
      break;
    }
    default: return false;
  }
  cx.notify();
  return true;
}

page({
  id: "inbox",
  label: "Inbox",
  icon: "hand",
  group: "inbox",
  render: inboxPage,
  key: inboxKey,
  badge: (app) => {
    const n = inboxCounts(app.tasks ?? []).all;
    return n ? { n, tone: "blocked" } : null;
  },
});

COMMANDS.inbox = (app, _arg, cx) => app.go("inbox", cx);
