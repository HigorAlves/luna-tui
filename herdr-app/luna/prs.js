// The PR page: the inbox (yours and those asking your review) and every open PR in your repos,
// split as the machine splits them, with the actions the machine takes (review, fix CI, address,
// merge, clone). The machine polls GitHub; this reads its snapshot and the stream's updates.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { PR_SPLITS, ago, filterPrs, prActions, prStatus } from "./model.js";
import { button, chip, dot, icon, mono, projectColor, spinner, toneColor } from "./ui.js";

function tabs(app, t) {
  const tab = (id, label) =>
    h_flex()
      .id(`prlist-${id}`)
      .h(34)
      .items_center()
      .border_b(2)
      .border_color(app.prList === id ? t.accent : t.canvas)
      .text_size(12.5)
      .cursor_pointer()
      .text_color(app.prList === id ? t.foreground : t.muted)
      .when(app.prList === id, (el) => el.font_semibold())
      .on_click((_e, cx) => app.showPrList(id, cx))
      .child(label);
  return h_flex().gap(18).px(16).items_end().border_b(1).border_color(t.border).child(tab("inbox", "Involving you")).child(tab("all", "All repos"));
}

function splitBar(app, t, prs) {
  const pill = (id, label, n) =>
    h_flex()
      .id(`split-${id ?? "all"}`)
      .h(24)
      .px(9)
      .gap(5)
      .items_center()
      .rounded(12)
      .text_size(11.5)
      .cursor_pointer()
      .when(app.prSplit === id, (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold())
      .when(app.prSplit !== id, (el) => el.bg(t.hover).text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => {
        app.prSplit = id;
        cx.notify();
      })
      .child(label)
      .child(div().text_size(10.5).child(String(n)));
  const repos = [...new Set(prs.map((p) => p.repo))].sort();
  return h_flex()
    .px(16)
    .py(10)
    .gap(6)
    .flex_wrap()
    .items_center()
    .child(pill(null, "All", prs.length))
    .children(PR_SPLITS.map(([id, label]) => [id, label, prs.filter((p) => p.split === id).length]).filter(([, , n]) => n > 0).map(([id, label, n]) => pill(id, label, n)))
    .child(div().flex_1())
    .when(repos.length > 1, (el) =>
      el.child(
        button(t, "repo-filter", app.prRepo ?? `All ${repos.length} repos`, "plain", (_e, cx) => app.pickRepo(repos, cx), { iconName: "filter", small: true }),
      ),
    )
    .when(Boolean(app.prRepo), (el) => el.child(button(t, "repo-clear", "", "quiet", (_e, cx) => { app.prRepo = null; cx.notify(); }, { iconName: "close", small: true })));
}

function row(app, t, pr, cloning) {
  const status = prStatus(pr);
  const actions = prActions(pr);
  const busy = app.busy.has(`${pr.repo}#${pr.number}`) || Boolean(cloning);
  const name = pr.repo.split("/")[1] ?? pr.repo;
  return h_flex()
    .id(`pr-${pr.repo}-${pr.number}`)
    .px(14)
    .py(10)
    .gap(12)
    .items_center()
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(t.border)
    .hover((s) => s.border_color(t.input))
    .child(icon("pr", 15, pr.isDraft ? t.dim : pr.mine ? t.accent : t.done))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(3)
        .child(div().truncate().text_size(12.8).font_medium().text_color(t.foreground).child(pr.title))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(dot(projectColor(t, name), 6))
            .child(div().font_family(mono()).text_size(10.5).child(`${pr.repo}#${pr.number}`))
            .child(div().child(`· ${pr.mine ? "you" : pr.author}`))
            .child(div().child(`· ${ago(pr.updatedAt) ?? ""}`))
            .when(pr.unresolvedThreads > 0, (el) => el.child(div().child(`· ${pr.unresolvedThreads} unresolved`)))
            .when(!pr.localPath, (el) => el.child(chip(t, cloning ? "cloning…" : "not cloned"))),
        ),
    )
    .child(chip(t, status.text, status.tone, 11))
    .child(
      h_flex()
        .gap(6)
        .flex_none()
        .when(Boolean(cloning), (el) => el.child(spinner(t, 12)))
        .children(actions.map((a) => button(t, `pra-${pr.repo}-${pr.number}-${a.id}`, a.label, a.kind, (_e, cx) => app.prAct(pr, a.id, cx), { small: true, busy, iconName: a.id === "browser" ? "external" : null }))),
    );
}

/** The PR page. */
export function prsPage(app, t) {
  const snap = app.prList === "all" ? app.prs.all : app.prs.inbox;
  const all = snap?.prs ?? [];
  const shown = filterPrs(all, { split: app.prSplit, repo: app.prRepo, query: app.query });
  const clones = new Map((snap?.clones ?? []).filter((c) => c.state === "cloning").map((c) => [c.repo, c]));
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
            .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Pull requests"))
            .child(div().text_size(11).text_color(snap?.error ? toneColor(t, "error") : t.dim).truncate().child(snap?.error ?? (snap?.polledAt ? `${all.length} open · read from GitHub ${ago(snap.polledAt)}` : "Not read yet"))),
        )
        .child(div().flex_1())
        .when(Boolean(app.flash), (el) => el.child(div().max_w(420).truncate().text_size(11.5).text_color(app.flash.tone ? toneColor(t, app.flash.tone) : t.muted).child(app.flash.text)))
        .when(app.prRefreshing, (el) => el.child(spinner(t, 13)))
        .child(button(t, "pr-refresh", "Refresh", "plain", (_e, cx) => app.refreshPrs(cx), { iconName: "refresh", small: true, busy: app.prRefreshing })),
    )
    .child(tabs(app, t))
    .child(splitBar(app, t, all))
    .child(
      v_flex()
        .id(`pr-list-${app.prList}`)
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .px(16)
        .pb(12)
        .gap(6)
        .when(!snap, (el) => el.child(h_flex().gap(8).p(12).text_color(t.dim).child(spinner(t, 13)).child("Reading the PRs…")))
        .when(Boolean(snap) && shown.length === 0, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child(all.length ? "No PR in this split." : app.prList === "all" ? "The machine has not read your repos yet: it polls them every 15 minutes, Refresh starts it now." : "No open PR involves you.")))
        .children(shown.slice(0, 200).map((pr) => row(app, t, pr, clones.get(pr.repo)))),
    );
}
