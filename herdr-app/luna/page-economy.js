// The Economy page: what the machine learned about one repository's token spend. Facts it
// learned (drop a wrong one), the tool mask each pack runs with (approve a proposal, restore a
// tool), the loop guard's last events, and the cost split. The machine decides all of it; this
// shows it and sends the taps. A machine running with the economy off answers 404 and the page
// says so.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { COMMANDS, page, palette } from "./registry.js";
import { ECONOMY_OFF, canDrop, costLines, economyRepos, economyRows, factLines, flat, proposedUnits, repoName } from "./integrations-model.js";
import { button, chip, groupLabel } from "./ui.js";
import { card, confirmBar, frame, header, notice, pill, scroller } from "./page-kit.js";

const ID = "economy";
const enc = encodeURIComponent;

const st = (app) => {
  const s = app.state(ID);
  s.repo ??= null;
  s.sel ??= null;
  s.ask ??= null;
  return s;
};

const repos = (app) => economyRepos(app.tasks, st(app).known);

function load(app, cx) {
  const s = st(app);
  const list = repos(app);
  if (!s.repo || (list.length && !list.includes(s.repo))) s.repo = list[0] ?? null;
  if (!s.repo) {
    s.data = null;
    cx.notify();
    return;
  }
  const repo = s.repo;
  s.loading = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const data = await app.machine.get(`/economy?repo=${enc(repo)}`);
      if (s.repo === repo) {
        s.data = data ?? {};
        s.off = false;
        s.error = null;
      }
    } catch (e) {
      if (e?.status === 404) {
        s.off = true;
        s.data = null;
        s.error = null;
      } else {
        s.error = e?.message ?? String(e);
      }
    }
    s.loading = false;
    cx.notify();
  });
}

function enter(app, cx) {
  const s = st(app);
  cx.spawn(async (cx) => {
    try {
      s.known = await app.machine.get("/repos");
    } catch {
      s.known = [];
    }
    load(app, cx);
  });
}

function pickRepo(app, repo, cx) {
  const s = st(app);
  s.repo = repo;
  s.sel = null;
  s.ask = null;
  s.data = null;
  load(app, cx);
}

/** One POST to /economy/<path>, then the page reads the economy again and says what happened. */
function post(app, cx, path, extra, field, done, nothing) {
  const s = st(app);
  app.run(cx, `economy-${path.split("/")[0]}`, null, async () => {
    const out = await app.machine.post(`/economy/${path}`, { repo: s.repo, ...extra });
    if (path === "import") app.say(`Imported ${out?.runs ?? 0} runs`);
    else app.say(out?.[field] ? done : nothing);
    try {
      s.data = await app.machine.get(`/economy?repo=${enc(s.repo)}`);
    } catch {
      // the next read shows it
    }
    return out;
  });
}

function rowCard(app, t, r, on) {
  const s = st(app);
  return card(t, `eco-${r.id}`, on)
    .on_click((_e, cx) => {
      s.sel = r.id;
      s.ask = null;
      cx.notify();
    })
    .child(chip(t, r.tag || r.kind, r.tag === "proposed" ? "blocked" : r.tag === "active" || r.tag === "masked" ? "working" : null))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(r.text || "(empty)"))
        .when(Boolean(r.sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(r.sub))),
    );
}

function side(app, t, eco, row) {
  const s = st(app);
  const lines = (list) => list.map((l) => div().text_size(11.5).text_color(t.muted).child(l));
  const ask = (cx, spec) => {
    s.ask = spec;
    cx.notify();
  };
  const actions = [];
  if (row) {
    if (canDrop(row)) {
      actions.push(button(t, "eco-drop", "Drop this fact", "danger", (_e, cx) => ask(cx, { text: "Drop this fact? It is never told again and its key is never learned again.", label: "Drop", danger: true, run: (cx) => post(app, cx, `facts/${enc(row.fact.id)}/drop`, {}, "dropped", "Dropped", "Nothing to drop") }), { small: true }));
    }
    if (row.kind === "proposed") {
      const units = proposedUnits(eco, row.pack);
      actions.push(button(t, "eco-approve", `Approve ${flat(row.pack)}'s mask`, "primary", (_e, cx) => ask(cx, { text: `${flat(row.pack)} will run without: ${units.map(flat).join(", ")}. Its next run starts without them.`, label: "Approve", run: (cx) => post(app, cx, "mask/approve", { pack: row.pack }, "approved", "Approved", "Nothing to approve") }), { small: true }));
    }
    if (row.kind === "proposed" || row.kind === "masked") {
      actions.push(button(t, "eco-restore", "Restore the tool", "plain", (_e, cx) => post(app, cx, "mask/restore", { pack: row.pack, unit: row.unit }, "restored", "Restored", "Nothing to restore"), { small: true, busy: app.busy.has("economy-mask") }));
    }
  }
  const g = row?.guard;
  const detail = !row
    ? []
    : row.kind === "fact"
      ? factLines(row.fact)
      : g
        ? [`${flat(g.action)} on ${flat(g.pack)} after ${g.calls ?? 0} calls`, flat(g.at), `run ${flat(g.runId)}`, ...(g.cause ? [`cause ${flat(g.cause)}`] : []), ...(g.failure ? [`failure ${flat(g.failure)}`] : [])]
        : [row.sub];
  return v_flex()
    .id("eco-side")
    .w(360)
    .flex_none()
    .h_full()
    .min_h(0)
    .overflow_y_scrollbar()
    .border_l(1)
    .border_color(t.border)
    .bg(t.chrome)
    .p(14)
    .gap(10)
    .child(groupLabel(t, "Cost"))
    .child(v_flex().gap(3).children(lines(costLines(eco))))
    .child(groupLabel(t, row ? "Selected" : "Select a row"))
    .when(Boolean(row), (el) => el.child(div().text_size(13).font_semibold().text_color(t.foreground).child(row.text)).children(lines(detail)).child(h_flex().gap(6).flex_wrap().children(actions)));
}

/** The Economy page. */
export function economyPage(app, t) {
  const s = st(app);
  const list = repos(app);
  const eco = s.data;
  const rows = economyRows(eco);
  const row = rows.find((r) => r.id === s.sel) ?? null;
  const clear = (cx) => {
    s.ask = null;
    cx.notify();
  };
  let last = null;
  const body = scroller("eco-list")
    .when(Boolean(s.ask), (el) => el.child(confirmBar(app, t, s.ask ?? {}, clear)))
    .when(!s.repo, (el) => el.child(notice(t, { title: "No repository yet", body: "The economy is per repository. Create a task in one, and pick it here." })))
    .when(Boolean(s.off), (el) => el.child(notice(t, { title: "The economy is off", body: ECONOMY_OFF })))
    .when(Boolean(s.error), (el) => el.child(notice(t, { title: "The machine refused", body: s.error, tone: "error" })))
    .when(Boolean(s.repo) && !s.off && !s.error && !eco, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("Reading the economy…")))
    .when(Boolean(eco) && rows.length === 0, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("Nothing learned yet: no fact, no tool proposal and no guard event. Import past runs to teach the envelopes.")))
    .children(
      rows.flatMap((r) => {
        const out = [];
        if (r.section !== last) out.push(div().pt(10).pb(2).child(groupLabel(t, r.section)));
        last = r.section;
        out.push(rowCard(app, t, r, r.id === s.sel));
        return out;
      }),
    );
  return frame(t)
    .child(
      header(app, t, {
        title: "Economy",
        summary: s.off ? ECONOMY_OFF : s.repo ? `${repoName(s.repo)} · what the machine learned about its token spend` : "Pick a repository",
        tone: s.error ? "error" : null,
        busy: s.loading,
        right: [
          button(t, "eco-import", "Import past runs", "plain", (_e, cx) => {
            s.ask = { text: "Fold the runs already on disk into this repository's economy, once? A run is never folded twice.", label: "Import", run: (cx) => post(app, cx, "import", {}, "runs", "", "") };
            cx.notify();
          }, { small: true, busy: app.busy.has("economy-import") || !s.repo || Boolean(s.off) }),
          button(t, "eco-refresh", "Refresh", "plain", (_e, cx) => load(app, cx), { small: true, iconName: "refresh", busy: s.loading }),
        ],
      }),
    )
    .when(list.length > 1, (el) => el.child(h_flex().px(16).pb(8).gap(6).flex_wrap().children(list.map((r) => pill(t, `eco-repo-${r}`, repoName(r), null, s.repo === r, (_e, cx) => pickRepo(app, r, cx))))))
    .child(h_flex().flex_1().min_h(0).child(body).when(Boolean(eco) && (app.width ?? 1200) >= 960, (el) => el.child(side(app, t, eco, row))));
}

page({
  id: ID,
  label: "Economy",
  icon: "evidence",
  group: "insight",
render: economyPage,
  enter,
  onMessage: (app, _m, cx) => {
    const s = st(app);
    if (app.page === ID && !s.started) {
      s.started = true;
      enter(app, cx);
    }
    return false;
  },
});

COMMANDS.economy = (app, _arg, cx) => app.go(ID, cx);
palette({ id: "go-economy", label: "Open Economy", hint: "token spend per repository", run: (app, cx) => app.go(ID, cx) });
