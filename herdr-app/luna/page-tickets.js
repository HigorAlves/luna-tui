// Tickets: the ticket machine's view (GET /tickets): each Jira or GitHub ticket with its status,
// scores and the drafts waiting on you. Approve posts the draft, "Post my text" posts yours
// instead, Ignore keeps it unposted, then make a card or put it in the backlog. Every tap sends the
// draft's hash, so a draft that changed since it was read is refused by the machine. The page
// offers an action only where the TUI does.
import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState } from "gpui-base";

import { COMMANDS, DIALOGS, page } from "./registry.js";
import { area } from "./dialogs.js";
import { chip, mono, spinner, toneColor } from "./ui.js";
import { encodeKey, overdueClocks, plain, scoreLine, splitLines, ticketActions, ticketDetail, waitingDrafts } from "./views-model.js";
import { button, frame, note } from "./views-ui.js";

const POLL_MS = 15000;

export function loadTickets(app, cx, { quiet = false } = {}) {
  const st = app.state("tickets");
  if (st.loading) return;
  st.loading = true;
  if (!quiet) cx.notify();
  cx.spawn(async (cx) => {
    try {
      const items = await app.machine.get("/tickets");
      st.items = Array.isArray(items) ? items : [];
      st.error = null;
    } catch (e) {
      st.error = e?.message ?? String(e);
    }
    st.loading = false;
    cx.notify();
  });
}

function enter(app, cx) {
  const st = app.state("tickets");
  loadTickets(app, cx);
  if (!st.timer) {
    st.timer = true;
    cx.timer.every(POLL_MS, (cx) => {
      if (app.page === "tickets") loadTickets(app, cx, { quiet: true });
    });
  }
}

const url = (key, action) => `/tickets/${encodeKey(key)}/${action}`;

/** Runs one tap on a ticket; the list is read again after. */
function tap(app, ticket, id, cx) {
  const draft = waitingDrafts(ticket)[0] ?? null;
  const run = (done, action, body) =>
    app.run(cx, `tk-${ticket.key}`, done, async () => {
      const out = await app.machine.post(url(ticket.key, action), body);
      loadTickets(app, cx, { quiet: true });
      return out;
    });
  switch (id) {
    case "approve":
      if (!draft) return app.say("No draft is waiting on it", "error");
      return app.confirm({
        title: draft.kind === "split" ? "Approve the split?" : "Post the draft?",
        body: draft.kind === "split" ? splitLines(ticket, draft).join("\n") : `This is posted to ${plain(ticket.key)} as it stands:\n\n${plain(draft.text).slice(0, 600)}`,
        label: "Approve",
        height: draft.kind === "split" ? 360 : 300,
        call: { method: "POST", path: url(ticket.key, "approve"), body: { draft: draft.id, hash: draft.hash } },
      });
    case "edit":
      if (!draft) return app.say("No draft is waiting on it", "error");
      return app.dialog({ kind: "ticket_edit", ticketKey: ticket.key, draft: draft.id, hash: draft.hash, original: plain(draft.text), subtitle: `${plain(ticket.key)}: your text replaces the draft` }, 380);
    case "ignore":
      if (!draft) return app.say("No draft is waiting on it", "error");
      return run("Ignored: kept, not posted", "ignore", { draft: draft.id });
    case "card":
      return run("Made a ticket on the board", "card", {});
    case "backlog":
      return run("Sent to the backlog", "backlog", {});
    default:
      return null;
  }
}

function row(app, t, ticket, st) {
  const open = st.selected === ticket.key;
  const score = scoreLine(ticket);
  const waits = waitingDrafts(ticket).length;
  const late = overdueClocks(ticket);
  const busy = Boolean(app.busy?.has(`tk-${ticket.key}`));
  const actions = ticketActions(ticket);
  const lines = open ? ticketDetail(ticket) : [];
  return v_flex()
    .id(`tkm-${ticket.key}`)
    .px(14)
    .py(10)
    .gap(6)
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(open ? t.accent : t.border)
    .cursor_pointer()
    .on_click((_e, cx) => {
      st.selected = open ? null : ticket.key;
      cx.notify();
    })
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().flex_none().font_family(mono()).text_size(11).text_color(t.dim).child(plain(ticket.key)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.8).font_medium().text_color(t.foreground).child(plain(ticket.canonical?.title) || "Untitled"))
        .child(chip(t, plain(ticket.status ?? "new").replaceAll("_", " "), null, 10.5))
        .when(Boolean(score), (el) => el.child(chip(t, score, "accent", 10.5)))
        .when(waits > 0, (el) => el.child(chip(t, `${waits} draft${waits === 1 ? "" : "s"} waiting`, "blocked", 10.5)))
        .when(late.length > 0, (el) => el.child(chip(t, `overdue: ${late.join(", ")}`, "error", 10.5)))
        .when(Boolean(ticket.cardId), (el) => el.child(chip(t, "has a card", "done", 10.5))),
    )
    .when(open, (el) =>
      el
        .children(lines.map((l) => div().pl(4).text_size(11.5).text_color(t.muted).child(l)))
        .children(
          waitingDrafts(ticket).map((d) =>
            v_flex()
              .gap(2)
              .px(10)
              .py(8)
              .rounded(7)
              .bg(t.hover)
              .child(div().text_size(10.5).text_color(t.dim).child(`Draft (${plain(d.kind)}), ${plain(d.status)}`))
              .children((d.kind === "split" && (d.children ?? []).length ? splitLines(ticket, d) : [plain(d.text)]).map((l) => div().text_size(11.5).text_color(t.foreground).child(l))),
          ),
        )
        .child(
          h_flex()
            .gap(6)
            .pt(4)
            .when(busy, (e) => e.child(spinner(t, 12)))
            .when(actions.length === 0, (e) => e.child(div().text_size(11.5).text_color(t.dim).child("Nothing to do here: no draft waits and it has a card.")))
            .children(actions.map((a) => button(t, `tkt-${ticket.key}-${a.id}`, a.label, a.kind, (_e, cx) => tap(app, ticket, a.id, cx), { small: true, busy }))),
        ),
    );
}

function ticketsPage(app, t) {
  const st = app.state("tickets");
  const q = String(app.query ?? "").trim().toLowerCase();
  const all = st.items ?? null;
  const items = (all ?? []).filter((x) => !q || `${x.key} ${x.canonical?.title ?? ""} ${x.status ?? ""}`.toLowerCase().includes(q));
  const waiting = (all ?? []).filter((x) => waitingDrafts(x).length).length;
  const body = [];
  if (!all && !st.error) body.push(h_flex().gap(8).p(12).text_color(t.dim).child(spinner(t, 13)).child("Reading the tickets…"));
  if (st.error) body.push(note(t, `tickets: ${st.error}`, "error"));
  if (all && items.length === 0) body.push(note(t, all.length ? "Nothing matches the search." : "The ticket machine holds no ticket."));
  items.forEach((x) => body.push(row(app, t, x, st)));
  return frame(app, t, {
    id: "tickets-list",
    title: "Tickets",
    summary: all ? `${all.length} ticket${all.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} with a draft waiting` : ""}` : st.error ? "Could not read the tickets" : "Not read yet",
    error: Boolean(st.error) && !all,
    busy: Boolean(st.loading),
    actions: [button(t, "tickets-refresh", "Refresh", "plain", (_e, cx) => loadTickets(app, cx), { iconName: "refresh", small: true, busy: Boolean(st.loading) })],
    body,
  });
}

page({
  id: "tickets",
  label: "Tickets",
  icon: "intake",
  group: "insight",
  render: ticketsPage,
  enter,
  badge: (app) => {
    const n = (app.state("tickets").items ?? []).filter((x) => waitingDrafts(x).length).length;
    return n ? { n, tone: "blocked" } : null;
  },
});

COMMANDS.tickets = (app, _arg, cx) => app.go("tickets", cx);

// The dialog for "Post my text": the person's own words go to the ticket instead of the draft.
DIALOGS.ticket_edit = {
  title: "Post my text",
  height: 380,
  init: (app, cx, d) => {
    app.text = TextareaState.new({ placeholder: "What to post on the ticket", rows: 8, value: "" });
  },
  body: (app, t, d) => [
    div().pt(8).text_size(11.5).text_color(t.dim).truncate().child(`The draft: ${d.original ?? ""}`),
    ...area(t, "Your text", app.text, 150),
  ],
  primary: () => ({ label: "Post it", kind: "primary" }),
  submit: (app, cx, d) => {
    const text = app.text.value().trim();
    if (!text) return app.fail(cx, "Write what to post.");
    return app.send(cx, () => app.machine.post(url(d.ticketKey, "edit"), { draft: d.draft, hash: d.hash, text }));
  },
};
