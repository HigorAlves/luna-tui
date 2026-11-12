// The Jira page: whether the machine reaches Jira (GET /jira/status), a search over its issues
// (GET /jira/search?q=, your open ones first, from the third character) and, for the ticket
// selected on the board, linking an issue, unlinking it or creating one from it. The machine
// syncs the linked issue; this shows the link and sends the taps.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";

import { COMMANDS, page, palette } from "./registry.js";
import { flat, hit, isJiraKey, jiraSummary } from "./integrations-model.js";
import { button, chip, icon } from "./ui.js";
import { card, confirmBar, frame, header, notice, scroller } from "./page-kit.js";

const ID = "jira";
const enc = encodeURIComponent;

const st = (app) => {
  const s = app.state(ID);
  s.hits ??= [];
  s.q ??= "";
  s.seq ??= 0;
  s.ask ??= null;
  return s;
};

/** The ticket selected on the board, the one a link goes to. */
const selectedTask = (app) => (app.tasks ?? []).find((t) => t.id === app.selected) ?? null;

function loadStatus(app, cx) {
  const s = st(app);
  s.loading = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      s.status = await app.machine.get("/jira/status");
      s.absent = false;
      s.error = null;
    } catch (e) {
      if (e?.status === 404) s.absent = true;
      else s.error = e?.message ?? String(e);
    }
    s.loading = false;
    cx.notify();
  });
}

function search(app, cx, q) {
  const s = st(app);
  const seq = ++s.seq;
  if (q.trim().length < 3) {
    s.hits = [];
    s.searchError = null;
    s.searching = false;
    return cx.notify();
  }
  s.searching = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const out = await app.machine.get(`/jira/search?q=${enc(q.trim())}`);
      if (seq === s.seq) {
        s.hits = (Array.isArray(out) ? out : []).map(hit).filter((h) => h.key);
        s.searchError = null;
      }
    } catch (e) {
      if (seq === s.seq) {
        s.hits = [];
        s.searchError = e?.message ?? String(e);
      }
    }
    if (seq === s.seq) s.searching = false;
    cx.notify();
  });
}

/** Makes the search input and reads the status, once. Needs a handler's `cx`. */
function ensure(app, cx) {
  const s = st(app);
  if (!s.input) {
    s.input = InputState.new({ placeholder: "A Jira key (PLAT-123) or a few words" });
    s.input.on("change", (_e, cx) => {
      s.q = s.input.value();
      search(app, cx, s.q);
    });
  }
  if (!s.started) {
    s.started = true;
    loadStatus(app, cx);
  }
}

function link(app, cx, task, key) {
  app.run(cx, `jira-${task.id}`, `${key} linked`, () => app.machine.post(`/tasks/${enc(task.id)}/jira`, { key }));
}

function resultRow(app, t, h, task) {
  const linked = task?.jira?.key === h.key;
  return card(t, `jira-${h.key}`)
    .child(chip(t, h.key, "accent", 11))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().truncate().text_size(12.8).font_medium().text_color(t.foreground).child(h.summary || "(no summary)"))
        .child(div().text_size(11).text_color(t.dim).child([h.status, h.issueType].filter(Boolean).join(" · ") || "no status")),
    )
    .child(
      h_flex()
        .gap(6)
        .flex_none()
        .when(Boolean(h.url), (el) => el.child(button(t, `jira-open-${h.key}`, "Open", "plain", () => app.openUrl(h.url), { small: true, iconName: "external" })))
        .when(Boolean(task) && !linked, (el) => el.child(button(t, `jira-link-${h.key}`, "Link to the ticket", "primary", (_e, cx) => link(app, cx, task, h.key), { small: true, busy: app.busy.has(`jira-${task.id}`) })))
        .when(linked, (el) => el.child(chip(t, "linked", "done"))),
    );
}

function ticketCard(app, t, task) {
  const s = st(app);
  const key = `jira-${task.id}`;
  const ask = (cx, spec) => {
    s.ask = spec;
    cx.notify();
  };
  const busy = app.busy.has(key);
  return v_flex()
    .gap(8)
    .p(12)
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(t.border)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(icon("board", 14, t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(`Selected ticket: ${flat(task.title)}`))
        .when(Boolean(task.jira?.key), (el) => el.child(chip(t, `${task.jira.key}${task.jira.status ? ` · ${flat(task.jira.status)}` : ""}`, "accent", 11))),
    )
    .when(Boolean(task.jira?.blocked), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(`blocked: ${flat(task.jira.blocked.why ?? `no transition to "${task.jira.blocked.wanted}"`)}`)))
    .child(
      h_flex()
        .gap(6)
        .when(Boolean(task.jira?.key), (el) =>
          el
            .child(button(t, "jira-open-linked", "Open", "plain", () => task.jira.url && app.openUrl(task.jira.url), { small: true, iconName: "external", busy: !task.jira.url }))
            .child(button(t, "jira-unlink", "Unlink", "danger", (_e, cx) => ask(cx, { text: `Unlink ${task.jira.key}? The link goes; the issue is left alone.`, label: "Unlink", danger: true, run: (cx) => app.run(cx, key, "Unlinked", () => app.machine.del(`/tasks/${enc(task.id)}/jira`)) }), { small: true, busy })),
        )
        .when(!task.jira?.key, (el) =>
          el.child(button(t, "jira-create", "Create an issue from it", "plain", (_e, cx) => ask(cx, { text: "Create a Jira issue from this ticket, in its repository's project, and link it?", label: "Create", run: (cx) => app.run(cx, key, "Issue created and linked", () => app.machine.post(`/tasks/${enc(task.id)}/jira/create`, {})) }), { small: true, busy })),
        ),
    );
}

/** The Jira page. */
export function jiraPage(app, t) {
  const s = st(app);
  const sum = jiraSummary(s.status, s.absent, s.error);
  const task = selectedTask(app);
  const clear = (cx) => {
    s.ask = null;
    cx.notify();
  };
  const q = s.q.trim();
  const typedKey = isJiraKey(q) && !s.hits.some((h) => h.key === q) ? q : null;
  const usable = sum.configured !== false;
  return frame(t)
    .child(
      header(app, t, {
        title: "Jira",
        summary: sum.text,
        tone: sum.tone,
        busy: s.loading || s.searching,
        right: [button(t, "jira-refresh", "Check", "plain", (_e, cx) => loadStatus(app, cx), { small: true, iconName: "refresh", busy: s.loading })],
      }),
    )
    .when(usable, (el) =>
      el.child(
        h_flex()
          .mx(16)
          .mb(10)
          .h(32)
          .px(10)
          .gap(7)
          .items_center()
          .rounded(8)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .child(icon("search", 13, t.dim))
          .when(Boolean(s.input), (e) => e.child(Input.new(s.input).flex_1().text_size(12.5).text_color(t.foreground)))
          .when(!s.input, (e) => e.child(button(t, "jira-start", "Search Jira", "quiet", (_e, cx) => ensure(app, cx), { small: true }))),
      ),
    )
    .child(
      scroller("jira-list")
        .when(Boolean(s.ask), (el) => el.child(confirmBar(app, t, s.ask ?? {}, clear)))
        .when(Boolean(task) && usable, (el) => el.child(ticketCard(app, t, task)))
        .when(sum.configured === false, (el) =>
          el.child(notice(t, { title: s.absent ? "Jira is not set up on this machine" : s.error ? "The machine did not answer for Jira" : "Jira is not configured", body: s.error ?? (s.status?.error ? flat(s.status.error) : "The machine reaches Jira with an Atlassian token. Without it, tickets carry no issue and search finds nothing."), setup: true, tone: s.error ? "error" : null })),
        )
        .when(usable && Boolean(typedKey) && Boolean(task), (el) =>
          el.child(card(t, "jira-typed").child(chip(t, typedKey, "accent", 11)).child(div().flex_1().text_size(12.5).text_color(t.muted).child("Link this key as typed")).child(button(t, "jira-link-typed", "Link to the ticket", "primary", (_e, cx) => link(app, cx, task, typedKey), { small: true }))),
        )
        .when(usable && Boolean(s.searchError), (el) => el.child(notice(t, { title: "The search failed", body: s.searchError, tone: "error" })))
        .when(usable && q.length >= 3 && !s.searching && !s.searchError && s.hits.length === 0, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("No issue matches.")))
        .when(usable && q.length < 3 && !task, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("Type three characters or more: a key, or a few words. Select a ticket on the board to link an issue to it.")))
        .when(usable && Boolean(task) && q.length < 3, (el) => el.child(div().px(4).text_size(12).text_color(t.dim).child("Search for the issue to link to this ticket.")))
        .children(s.hits.slice(0, 50).map((h) => resultRow(app, t, h, task))),
    );
}

page({
  id: ID,
  label: "Jira",
  icon: "intake",
  group: "inbox",
  render: jiraPage,
  enter: (app, cx) => ensure(app, cx),
  onMessage: (app, _m, cx) => {
    if (app.page === ID && !st(app).input) ensure(app, cx);
    return false;
  },
});

COMMANDS.jira = (app, _arg, cx) => app.go(ID, cx);
palette({ id: "go-jira", label: "Open Jira", hint: "search issues, link one to the ticket", run: (app, cx) => app.go(ID, cx) });
