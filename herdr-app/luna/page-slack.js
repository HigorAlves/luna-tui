// The Slack page: the inbox the machine builds from your conversations (GET /slack/items, and
// the `slack.items` stream event), split as the TUI splits it, with the actions on one thread
// and the watches. The machine reads Slack and posts nothing until you tap; this only shows its
// snapshot and sends your taps.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, TextareaState } from "gpui-base";

import { DIALOGS, COMMANDS, page, palette } from "./registry.js";
import { field, area, option as optionRow } from "./dialogs.js";
import {
  DISMISS_REASONS, KINDS, NUDGE_TEXT, SLACK_SPLITS, SNOOZE_OPTIONS, blocker, channelLabel, conversationLines, doneBody, draftRef, draftText, dueLabel, dueSoon, flat,
  guessRepo, itemPath, localOffset, nextFloor, overdueCount, plain, priorityStep, relationChoices, replyBody, slackBadge, slackCounts, slackItems, slackSetup, slaTargets,
  snoozeUntil, summaryOf, taskRepos, urgent, age, watchInput, watchMatches, watchScope,
} from "./integrations-model.js";
import { button, chip, dot, icon, mono, projectColor, toneColor } from "./ui.js";
import { ago } from "./model.js";
import { card, frame, header, notice, pill, scroller, tabBar, tabItem } from "./page-kit.js";

const ID = "slack";

const st = (app) => {
  const s = app.state(ID);
  s.split ??= "needs_reply";
  s.view ??= "inbox";
  s.sel ??= null;
  s.ask ??= null;
  s.pick ??= null;
  return s;
};

/** Reads the inbox. Quiet when it fails: the page says what the machine said. */
function load(app, cx, loud = false) {
  const s = st(app);
  if (s.loading) return;
  s.loading = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      s.snap = await app.machine.get("/slack/items");
      s.error = null;
      if (loud) app.say("Slack read again");
    } catch (e) {
      s.error = e?.status === 404 ? "This machine has no Slack inbox (the route is absent)." : e?.message ?? String(e);
    }
    s.loading = false;
    cx.notify();
  });
}

function ensure(app, cx) {
  const s = st(app);
  if (s.started) return;
  s.started = true;
  load(app, cx);
}

/** Runs one call for an item, then reads the inbox again so the page moves at once. */
function act(app, cx, key, done, call) {
  const s = st(app);
  app.run(cx, key, done, async () => {
    const out = await call();
    try {
      s.snap = await app.machine.get("/slack/items");
    } catch {
      // the stream brings it
    }
    return out;
  });
}

function pollNow(app, cx) {
  const s = st(app);
  s.polling = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      s.snap = await app.machine.post("/slack/refresh", {});
      s.error = null;
      app.say("Polled Slack");
    } catch (e) {
      app.say(e?.message ?? String(e), "error");
    }
    s.polling = false;
    cx.notify();
  });
}

function openTicket(app, item, cx) {
  const id = item.linked?.taskId;
  if (!id) return;
  app.go("board", cx);
  app.select(id, cx);
}

// ---- the item's actions ----

function actions(app, item) {
  const s = st(app);
  const key = `slack-${item.id}`;
  const ask = (id) => blocker(item, id);
  const patch = (cx, body, done) => act(app, cx, key, done, () => app.machine.patch(itemPath(item.id), body));
  const out = [];
  const add = (id, label, kind, run, iconName = null) => out.push({ id, label, kind, run, iconName });
  const wide = item.split === "done" || item.split === "snoozed";
  add("reply", "Reply", wide ? "plain" : "primary", (cx) => replyDialog(app, item, false), "comment");
  if (item.linked?.taskId && app.tasks?.some((t) => t.id === item.linked.taskId)) add("ticket-open", "Open ticket", "plain", (cx) => openTicket(app, item, cx), "board");
  if (!ask("task")) add("task", "Ticket", "plain", () => taskDialog(app, item), "plus");
  if (!ask("done")) add("done", "Done", "plain", (cx) => (item.draft ? ((s.pick = { kind: "dismiss", id: item.id }), cx.notify()) : patch(cx, doneBody(null), "Done")), "check");
  if (wide) add("reopen", "Reopen", "plain", (cx) => patch(cx, { done: false, snoozedUntil: null }, "Reopened"), "refresh");
  add("snooze", "Snooze", "plain", (cx) => ((s.pick = { kind: "snooze", id: item.id }), cx.notify()), "clock");
  if (item.permalink) add("open", "Open in Slack", "plain", () => app.openUrl(item.permalink), "external");
  if (!ask("nudge")) add("nudge", "Nudge", "plain", () => replyDialog(app, item, true));
  if (!ask("up")) add("up", "Priority up", "quiet", (cx) => patch(cx, { priority: priorityStep(item.triage.priority, true) }, `${item.triage.priority} → ${priorityStep(item.triage.priority, true)}`));
  if (!ask("down")) add("down", "Priority down", "quiet", (cx) => patch(cx, { priority: priorityStep(item.triage.priority, false) }, `${item.triage.priority} → ${priorityStep(item.triage.priority, false)}`));
  if (!ask("kind")) add("kind", "Kind", "quiet", (cx) => ((s.pick = { kind: "kind", id: item.id }), cx.notify()));
  if (!ask("relation")) add("relation", "Link to work", "quiet", (cx) => ((s.pick = { kind: "relation", id: item.id }), cx.notify()));
  return out;
}

function replyDialog(app, item, nudge) {
  app.dialog(
    {
      kind: "slack_reply",
      itemId: item.id,
      nudge,
      text: nudge ? NUDGE_TEXT : draftText(item),
      draft: nudge ? null : draftRef(item),
      subtitle: `${channelLabel(item)} · ${flat(item.author?.name)}`,
      context: [...(item.context ?? []).slice(-3).map((m) => `${flat(m.user?.name)}: ${flat(m.text)}`), `${flat(item.author?.name)}: ${flat(item.text)}`].map((l) => (l.length > 220 ? `${l.slice(0, 220)}…` : l)),
    },
    480,
    520,
  );
}

function taskDialog(app, item) {
  const repos = taskRepos(app.tasks);
  app.dialog({ kind: "slack_task", itemId: item.id, title: summaryOf(item), repo: guessRepo(item.channel?.name, app.tasks), repos, subtitle: `${channelLabel(item)} · ${flat(item.author?.name)}` }, 440 + Math.min(repos.length, 6) * 32, 480);
}

// ---- drawing ----

function row(app, t, item, selected, now) {
  const s = st(app);
  const p = item.triage?.priority ?? null;
  const overdue = item.overdue && !["snoozed", "done"].includes(item.split);
  const tone = overdue ? "error" : null;
  const dueTone = dueSoon(item, now) ? "blocked" : null;
  const tags = [item.count > 1 ? `×${item.count}` : null, item.thread_ts || item.threadTs ? "thread" : null, item.linked?.taskId ? "ticket" : null, item.reopenedAt ? "came back" : null].filter(Boolean);
  return card(t, `sl-${item.id}`, selected)
    .on_click((_e, cx) => {
      s.sel = item.id;
      s.pick = null;
      s.ask = null;
      cx.notify();
    })
    .child(chip(t, p ?? "--", p === "P0" ? "error" : p === "P1" ? "blocked" : null, 10.5))
    .child(dot(projectColor(t, item.channel?.name ?? item.channel?.kind ?? "dm"), 6))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(3)
        .child(div().truncate().text_size(12.8).font_medium().text_color(tone ? toneColor(t, tone) : t.foreground).child(summaryOf(item) || "(no text)"))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(div().child(channelLabel(item)))
            .child(div().truncate().child(`· ${flat(item.author?.name) || "someone"}`))
            .when(tags.length > 0, (el) => el.child(div().child(`· ${tags.join(" · ")}`))),
        ),
    )
    .child(div().flex_none().text_size(11).text_color(tone ? toneColor(t, tone) : dueTone ? toneColor(t, dueTone) : t.dim).when(overdue, (el) => el.font_semibold()).child(`${overdue ? "overdue " : ""}${age(item.ts, now)}`));
}

function line(t, name, text, tone = null) {
  return h_flex()
    .gap(10)
    .items_start()
    .child(div().w(72).flex_none().text_size(11).text_color(t.dim).child(name))
    .child(div().flex_1().min_w(0).text_size(12).text_color(tone ? toneColor(t, tone) : t.foreground).child(text));
}

function picker(app, t, item) {
  const s = st(app);
  const key = `slack-${item.id}`;
  const close = (cx) => {
    s.pick = null;
    cx.notify();
  };
  const choose = (cx, done, call) => {
    close(cx);
    act(app, cx, key, done, call);
  };
  const o = (id, text, run) => optionRow(t, id, text, false, (_e, cx) => run(cx));
  let title;
  let rows;
  switch (s.pick.kind) {
    case "snooze":
      title = "Snooze until";
      rows = SNOOZE_OPTIONS.map((label, i) => o(`snz-${i}`, label, (cx) => choose(cx, `Snoozed until ${label}`, () => app.machine.patch(itemPath(item.id), { snoozedUntil: new Date(snoozeUntil(i, Math.floor(Date.now() / 1000), localOffset()) * 1000).toISOString() }))));
      break;
    case "dismiss":
      title = "Why is the draft not sent?";
      rows = DISMISS_REASONS.map(([reason, label], i) => o(`dis-${i}`, label, (cx) => choose(cx, "Done", () => app.machine.patch(itemPath(item.id), doneBody(reason)))));
      break;
    case "kind":
      title = "What the thread is";
      rows = KINDS.map((k) => o(`kind-${k}`, k, (cx) => choose(cx, `Kind: ${k}`, () => app.machine.patch(itemPath(item.id), { kind: k }))));
      break;
    default:
      title = "The work it is about";
      rows = relationChoices(item).map((c, i) => o(`rel-${i}`, c.label, (cx) => choose(cx, "Link saved", () => app.machine.post(itemPath(item.id, "/relation"), { relation: c.relation, target: c.target }))));
  }
  return v_flex()
    .gap(2)
    .p(8)
    .rounded(9)
    .bg(t.hover)
    .child(h_flex().items_center().child(div().flex_1().px(6).text_size(12).font_semibold().text_color(t.foreground).child(title)).child(button(t, "pick-close", "", "quiet", (_e, cx) => close(cx), { small: true, iconName: "close" })))
    .children(rows);
}

function detail(app, t, item, now) {
  const s = st(app);
  const busy = app.busy.has(`slack-${item.id}`);
  const tri = item.triage;
  const pr = item.linked?.pr;
  const lines = conversationLines(item, now);
  const due = dueLabel(item, now);
  return v_flex()
    .id("slack-detail")
    .w(400)
    .flex_none()
    .h_full()
    .min_h(0)
    .overflow_y_scrollbar()
    .border_l(1)
    .border_color(t.border)
    .bg(t.chrome)
    .p(14)
    .gap(10)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(chip(t, tri?.priority ?? "no priority", tri?.priority === "P0" ? "error" : tri?.priority === "P1" ? "blocked" : null))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(`${channelLabel(item)} · ${flat(item.author?.name)} · ${age(item.ts, now)} ago`))
        .child(button(t, "sl-detail-close", "", "quiet", (_e, cx) => ((s.sel = null), cx.notify()), { small: true, iconName: "close" })),
    )
    .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(summaryOf(item) || "(no text)"))
    .when(Boolean(item.reopenedAt), (el) => el.child(div().text_size(11.5).text_color(toneColor(t, "blocked")).child("new since you cleared it")))
    .when(Boolean(due), (el) => el.child(div().text_size(11.5).text_color(item.overdue ? toneColor(t, "error") : t.muted).child(`${due} (${tri?.priority ?? "?"} · ${slaTargets(s.snap?.sla)} SLA)`)))
    .children((item.context ?? []).slice(-4).map((m) => div().text_size(11.5).text_color(t.dim).child(`${flat(m.user?.name)}: ${flat(m.text).slice(0, 240)}`)))
    .child(div().p(10).rounded(8).bg(t.background).border_1().border_color(t.border).text_size(12.5).text_color(t.foreground).child(plain(item.text).slice(0, 1500) || "(empty)"))
    .when(Boolean(tri), (el) =>
      el.child(
        v_flex()
          .gap(5)
          .child(line(t, "triage", `${tri.priority} · ${flat(tri.category)}${tri.expectsReply ? " · reply expected" : ""}${tri.overridden ? " · set by you" : ""}`))
          .when(Boolean(tri.why), (e) => e.child(line(t, "why", flat(tri.why))))
          .when(Boolean(tri.deadline), (e) => e.child(line(t, "deadline", flat(tri.deadline))))
          .when((tri.refs ?? []).length > 0, (e) => e.child(line(t, "refs", tri.refs.map((r) => flat(r.ref)).join(", ")))),
      ),
    )
    .when(!tri, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Triage has not read this yet.")))
    .when(Boolean(pr), (el) => el.child(line(t, "pull request", `${flat(pr.repo)}#${pr.number} (${flat(pr.split)})`)))
    .when((item.matched ?? []).length > 0, (el) => el.child(line(t, "in your inbox", item.matched.map(flat).join(", "))))
    .children(lines.map(([name, text]) => line(t, name, text)))
    .when(Boolean(item.draft?.text || tri?.draft), (el) => el.child(v_flex().gap(3).child(div().text_size(11).text_color(t.dim).child(item.draft ? "Draft waiting for you" : "Triage's draft")).child(div().p(10).rounded(8).bg(t.background).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(plain(draftText(item)).slice(0, 600)))))
    .when(Boolean(s.pick && s.pick.id === item.id), (el) => el.child(picker(app, t, item)))
    .when(!(s.pick && s.pick.id === item.id), (el) =>
      el.child(h_flex().gap(6).flex_wrap().children(actions(app, item).map((a) => button(t, `sla-${a.id}`, a.label, a.kind, (_e, cx) => a.run(cx), { small: true, busy, iconName: a.iconName })))),
    );
}

function watchesView(app, t, snap) {
  const watches = snap?.watches ?? [];
  return scroller("slack-watches")
    .child(div().pb(4).text_size(12).text_color(t.dim).child("A watch is anything beyond your own handle that the inbox treats as addressed to you. The broadcasts ship on: you can switch them off, not delete them. Watches live in the machine, so every board shares them."))
    .when(watches.length === 0, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("No watch yet.")))
    .children(
      watches.map((w) => {
        const key = `watch-${w.id}`;
        const busy = app.busy.has(key);
        const call = (cx, done, fn) => act(app, cx, key, done, fn);
        return card(t, `w-${w.id}`)
          .child(icon(w.kind === "channel" ? "comment" : "alert", 14, w.enabled ? t.accent : t.dim))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(div().truncate().text_size(12.8).font_medium().text_color(w.enabled ? t.foreground : t.dim).child(flat(w.label || w.value)))
              .child(div().text_size(11).text_color(t.dim).child([flat(w.kind), watchScope(w), w.builtin ? "built in" : null, w.enabled ? null : "off"].filter(Boolean).join(" · "))),
          )
          .child(
            h_flex()
              .gap(6)
              .flex_none()
              .child(button(t, `w-on-${w.id}`, w.enabled ? "Switch off" : "Switch on", "plain", (_e, cx) => call(cx, w.enabled ? "Switched off" : "Switched on", () => app.machine.patch(`/slack/watches/${encodeURIComponent(w.id)}`, { enabled: !w.enabled })), { small: true, busy }))
              .child(button(t, `w-floor-${w.id}`, w.priority ? `Floor ${w.priority}` : "No floor", "plain", (_e, cx) => {
                const next = nextFloor(w.priority);
                call(cx, next ? `At least ${next}` : "No priority floor", () => app.machine.patch(`/slack/watches/${encodeURIComponent(w.id)}`, { priority: next }));
              }, { small: true, busy }))
              .when(!w.builtin, (el) => el.child(button(t, `w-del-${w.id}`, "Delete", "danger", (_e, cx) => call(cx, `Removed ${w.label}`, () => app.machine.del(`/slack/watches/${encodeURIComponent(w.id)}`)), { small: true, busy }))),
          );
      }),
    );
}

/** The Slack page. */
export function slackPage(app, t) {
  const s = st(app);
  const snap = s.snap;
  const now = Date.now();
  const items = snap?.items ?? [];
  const counts = slackCounts(items);
  const overdue = overdueCount(items);
  const shown = slackItems(items, s.split).filter((i) => !app.query || `${summaryOf(i)} ${i.text} ${i.author?.name} ${i.channel?.name}`.toLowerCase().includes(app.query.toLowerCase()));
  const selected = items.find((i) => i.id === s.sel && (s.view === "inbox"));
  const setup = slackSetup(snap, s.error);
  const summary = s.error && !snap
    ? s.error
    : snap
      ? [snap.polledAt ? `polled ${ago(snap.polledAt)}` : "not polled yet", snap.socket === "connected" ? "live" : snap.socket === "off" ? "socket off" : `socket ${flat(snap.socket)}`, overdue ? `${overdue} overdue` : null, snap.sla ? `SLA ${slaTargets(snap.sla)}` : null].filter(Boolean).join(" · ")
      : "Reading Slack…";
  const body = s.view === "watches"
    ? watchesView(app, t, snap)
    : scroller("slack-list")
        .when(!snap && !s.error, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("Reading the inbox…")))
        .when(Boolean(setup), (el) => el.child(notice(t, { ...setup, tone: snap?.error || s.error ? "error" : null })))
        .when(Boolean(snap) && !setup && shown.length === 0, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child(items.length ? "Nothing in this split." : "Nothing in your inbox.")))
        .children(shown.slice(0, 200).map((i) => row(app, t, i, i.id === s.sel, now)));
  return frame(t)
    .child(
      header(app, t, {
        title: "Slack",
        summary,
        tone: (snap?.error || s.error) ? "error" : overdue ? "error" : null,
        busy: s.polling || s.loading,
        right: [
          button(t, "slack-watches", s.view === "watches" ? "Inbox" : "Watches", "plain", (_e, cx) => ((s.view = s.view === "watches" ? "inbox" : "watches"), cx.notify()), { small: true, iconName: "filter" }),
          button(t, "slack-poll", "Poll now", "plain", (_e, cx) => pollNow(app, cx), { small: true, iconName: "refresh", busy: s.polling }),
        ],
      }),
    )
    .child(
      tabBar(t, [tabItem(t, "slack-tab-inbox", "Inbox", s.view === "inbox", (_e, cx) => ((s.view = "inbox"), cx.notify())), tabItem(t, "slack-tab-watches", `Watches${snap?.watches?.length ? ` · ${snap.watches.length}` : ""}`, s.view === "watches", (_e, cx) => ((s.view = "watches"), cx.notify()))]),
    )
    .when(s.view === "inbox", (el) =>
      el.child(
        h_flex()
          .px(16)
          .py(10)
          .gap(6)
          .flex_wrap()
          .items_center()
          .children(SLACK_SPLITS.map(([id, label]) => pill(t, `sl-split-${id}`, label, counts[id], s.split === id, (_e, cx) => ((s.split = id), (s.sel = null), (s.pick = null), cx.notify())))),
      ),
    )
    .when(s.view === "watches", (el) =>
      el.child(h_flex().px(16).py(10).child(button(t, "watch-add", "Add a watch", "primary", () => app.dialog({ kind: "slack_watch" }, 420, 480), { small: true, iconName: "plus" }))),
    )
    .child(
      h_flex()
        .flex_1()
        .min_h(0)
        .child(body)
        .when(Boolean(selected) && (app.width ?? 1200) >= 960, (el) => el.child(detail(app, t, selected, now))),
    );
}

page({
  id: ID,
  label: "Slack",
  icon: "comment",
  group: "inbox",
  render: slackPage,
  enter: (app, cx) => {
    const s = st(app);
    s.started = true;
    load(app, cx);
  },
  onMessage: (app, { event, data }, cx) => {
    ensure(app, cx);
    if (event !== "slack.items") return false;
    const s = st(app);
    if (data?.snapshot) {
      s.snap = data.snapshot;
      s.error = null;
    }
    return true;
  },
  badge: (app) => slackBadge(app.state(ID).snap),
});

COMMANDS.slack = (app, _arg, cx) => app.go(ID, cx);
palette({ id: "go-slack", label: "Open Slack", hint: "the inbox", run: (app, cx) => app.go(ID, cx) });

// ---- dialogs ----

DIALOGS.slack_reply = {
  title: "Reply in Slack",
  height: 480,
  width: 520,
  init: (app, cx, d) => {
    app.reply = TextareaState.new({ placeholder: "Your reply", rows: 6, value: d.text ?? "" });
    cx.timer.after(300, () => app.reply.focus?.());
  },
  body: (app, t, d) => [
    ...(d.context ?? []).map((l) => div().text_size(11.5).text_color(t.dim).child(l)),
    ...area(t, d.nudge ? "Nudge (the machine adds a mention of the author)" : d.draft ? "The draft waiting for you: edit it, then Post" : "Reply", app.reply, 110),
    div().pt(8).text_size(11.5).text_color(t.dim).child("It posts as you, in the thread, once you press Post. Nothing is sent before."),
  ],
  primary: () => ({ label: "Post as me", kind: "primary" }),
  submit: (app, cx, d) => {
    const text = app.reply.value().trim();
    if (!text) return app.fail(cx, "Nothing to send.");
    return app.send(cx, async () => {
      try {
        return await app.machine.post(itemPath(d.itemId, "/reply"), replyBody(text, d.nudge, d.draft));
      } catch (e) {
        if (e?.code === "no_token") throw new Error("Replying needs your Slack user token on the machine (MACHINE_SLACK_USER_TOKEN). Run `make integrations` to add it.");
        throw e;
      }
    });
  },
};

DIALOGS.slack_task = {
  title: "A ticket from this thread",
  height: 480,
  width: 480,
  init: (app, cx, d) => {
    app.ticketTitle = InputState.new({ placeholder: "Title", value: d.title ?? "" });
    app.repoPick = d.repo ?? null;
  },
  body: (app, t, d) => [
    ...field(t, "Title", app.ticketTitle),
    div().pt(12).pb(4).text_size(11.5).text_color(t.dim).child("Repository (the one whose name matches the channel is picked)"),
    optionRow(t, "tk-none", "Decide later", app.repoPick == null, (_e, cx) => ((app.repoPick = null), cx.notify())),
    ...(d.repos ?? []).slice(0, 8).map((r, i) => optionRow(t, `tk-${i}`, r, app.repoPick === r, (_e, cx) => ((app.repoPick = r), cx.notify()))),
  ],
  primary: () => ({ label: "Make the ticket", kind: "primary" }),
  submit: (app, cx, d) => {
    const title = app.ticketTitle.value().trim();
    if (!title) return app.fail(cx, "Give it a title.");
    return app.send(cx, async () => {
      const task = await app.machine.post(itemPath(d.itemId, "/task"), { title, repoPath: app.repoPick });
      return { select: task?.id };
    });
  },
};

DIALOGS.slack_watch = {
  title: "Add a watch",
  height: 480,
  width: 480,
  init: (app, cx) => {
    app.watchQuery = InputState.new({ placeholder: "@usergroup, #channel or a word" });
    app.watchQuery.on("change", (_e, cx) => {
      app.picked = 0;
      cx.notify();
    });
    app.picked = 0;
    app.catalog = { groups: null, channels: null };
    cx.spawn(async (cx) => {
      const [groups, channels] = await Promise.all([app.machine.get("/slack/usergroups").catch(() => []), app.machine.get("/slack/channels").catch(() => [])]);
      app.catalog = { groups: Array.isArray(groups) ? groups : [], channels: Array.isArray(channels) ? channels : [] };
      cx.notify();
    });
    cx.timer.after(300, () => app.watchQuery.focus());
  },
  body: (app, t) => {
    const q = app.watchQuery.value();
    const loading = app.catalog.groups == null;
    const matches = loading ? [] : watchMatches(q, app.catalog);
    return [
      ...field(t, "Type @ for a user group, # for a channel, anything else is a keyword", app.watchQuery),
      ...(loading && /^[@#]/.test(q.trim()) ? [div().pt(8).text_size(12).text_color(t.dim).child("Loading the workspace's groups and channels…")] : []),
      ...matches.slice(0, 8).map((m, i) => optionRow(t, `wm-${i}`, `${m.label}${m.hint ? `  ${m.hint}` : ""}`, app.picked === i, (_e, cx) => ((app.picked = i), cx.notify()))),
      ...(q.trim().length > 1 && !loading && /^[@#]/.test(q.trim()) && matches.length === 0 ? [div().pt(8).text_size(12).text_color(t.dim).child("Nothing matches.")] : []),
    ];
  },
  primary: () => ({ label: "Watch it", kind: "primary" }),
  submit: (app, cx) => {
    const q = app.watchQuery.value();
    const r = watchInput(q, app.catalog.groups == null ? [] : watchMatches(q, app.catalog), app.picked);
    if (r.error) return app.fail(cx, r.error);
    return app.send(cx, () => app.machine.post("/slack/watches", r.body));
  },
};
