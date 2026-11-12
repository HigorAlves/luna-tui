// The Floor: the factory's numbers over 7 and 30 days (GET /metrics), per repository and per
// engine, the stage pool (GET /health `slots`) with its controls, and the base images waiting for
// your yes (GET /repos). Every control asks first. The numbers load when the page opens and on
// Refresh; the stream's `task.metrics` keeps the 7d column fresh, and the pool is read again
// every 15 seconds while the page is open.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { ago } from "./model.js";
import { COMMANDS, page } from "./registry.js";
import { chip, mono, spinner, toneColor } from "./ui.js";
import { engineRows, floorRows, latchedWords, num, pausedTasks, pct, pendingBases, plain, span, stageRows, usd } from "./views-model.js";
import { button, frame, note, section, tile } from "./views-ui.js";

const POOL_POLL_MS = 15000;

const enc = encodeURIComponent;

/** Reads everything the Floor shows; a failed read keeps what was there and says why. */
export function loadFloor(app, cx, { quiet = false } = {}) {
  const st = app.state("floor");
  if (st.loading) return;
  st.loading = true;
  if (!quiet) st.errors = {};
  cx.notify();
  const m = app.machine;
  const read = (key, path, set) =>
    m
      .get(path)
      .then((v) => {
        set(v);
        delete st.errors?.[key];
      })
      .catch((e) => {
        st.errors ??= {};
        st.errors[key] = e?.message ?? String(e);
      });
  const calls = [
    m.health().then((v) => {
      st.health = v;
      delete st.errors?.health;
    }).catch((e) => {
      st.errors ??= {};
      st.errors.health = e?.message ?? String(e);
    }),
    ...(quiet
      ? []
      : [
          read("7d", "/metrics?since=7d&groupBy=repo", (v) => (st.m7 = v)),
          read("30d", "/metrics?since=30d&groupBy=repo", (v) => (st.m30 = v)),
          read("engines", "/metrics?since=7d&groupBy=engine", (v) => (st.engineMetrics = v)),
          read("caps", "/engines", (v) => (st.engines = v)),
          read("repos", "/repos", (v) => (st.repos = v)),
        ]),
  ];
  // /health answers 503 with the pool when the machine has problems: m.health() still gives the pool.
  cx.spawn(async (cx) => {
    await Promise.all(calls);
    st.loading = false;
    st.at = Date.now();
    cx.notify();
  });
}

function enter(app, cx) {
  const st = app.state("floor");
  loadFloor(app, cx);
  if (!st.timer) {
    st.timer = true;
    cx.timer.every(POOL_POLL_MS, (cx) => {
      if (app.page === "floor") loadFloor(app, cx, { quiet: true });
    });
  }
}

function onMessage(app, { event, data }) {
  const st = app.state("floor");
  if (event === "task.metrics") {
    const incoming = data?.metrics ?? data;
    if (incoming && typeof incoming === "object") st.m7 = { ...(st.m7 ?? {}), ...incoming, byRepo: st.m7?.byRepo };
    return true;
  }
  if (event === "budget.alert") {
    const a = data?.alert ?? data ?? {};
    st.alerts = [{ ...a, at: Date.now() }, ...(st.alerts ?? [])].slice(0, 5);
    app.say(`${plain(a.engine ?? a.repo ?? a.scope ?? "A budget")} passed ${a.pct ?? "?"}% of its ceiling`, "error");
    return true;
  }
  return false;
}

// ---- the pool's controls: each asks first ----

function drain(app, draining) {
  app.confirm(
    draining
      ? { title: "Carry on?", body: "The queue is picked up again at once.", label: "Carry on", call: { method: "POST", path: "/resume" } }
      : { title: "Drain the pool?", body: "Running stages finish. Nothing new is claimed until you carry on.", label: "Drain", danger: true, call: { method: "POST", path: "/drain" } },
  );
}

function resize(app, max, to) {
  if (to < 1) return app.say("Already at one slot", "error");
  app.confirm({ title: `${to > max ? "One more" : "One fewer"} slot?`, body: `The pool goes from ${max} to ${to} slot${to === 1 ? "" : "s"}.`, label: `Use ${to}`, call: { method: "PATCH", path: "/slots", body: { max: to } } });
}

function resumeAll(app) {
  const paused = pausedTasks(app.tasks);
  if (!paused.length) return app.say("Nothing is paused");
  app.dialog({
    kind: "luna_many",
    title: "Resume every paused ticket",
    body: `${paused.length} ticket${paused.length === 1 ? "" : "s"} paused on the usage limit run the stage again. If the limit is still on, they pause again.`,
    label: `Resume ${paused.length}`,
    done: "Resumed",
    calls: paused.map((t) => ({ method: "POST", path: `/tasks/${enc(t.id)}/resume` })),
  });
}

function approveBase(app, b) {
  app.confirm({
    title: "Approve the base image?",
    body: `${b.repo} builds its sandbox from ${b.base}. An approved base is trusted with the stage's credential, like code you run yourself.`,
    label: "Approve",
    call: { method: "POST", path: "/repos/base/approve", body: { repo: b.repo, base: b.base } },
  });
}

// ---- drawing ----

const W = [210, 200, 200];

function table(t, id, head, rows) {
  const cell = (text, w, strong = false, color = null) => div().w(w).flex_none().truncate().text_size(11.5).text_color(color ?? (strong ? t.foreground : t.muted)).child(String(text));
  return v_flex()
    .id(id)
    .px(12)
    .py(8)
    .gap(4)
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(t.border)
    .child(h_flex().gap(10).children(head.map((h, i) => cell(h, W[i] ?? 120, false, t.dim))))
    .children(rows.map((r, n) => h_flex().gap(10).children(r.map((c, i) => cell(c, W[i] ?? 120, i === 0)))));
}

function wide(t, id, widths, head, rows, colorAt = () => null) {
  const cell = (text, w, color, strong) => div().w(w).flex_none().truncate().text_size(11.5).text_color(color ?? (strong ? t.foreground : t.muted)).child(String(text));
  return v_flex()
    .id(id)
    .px(12)
    .py(8)
    .gap(4)
    .rounded(9)
    .bg(t.background)
    .border_1()
    .border_color(t.border)
    .child(h_flex().gap(10).children(head.map((h, i) => cell(h, widths[i], t.dim))))
    .children(rows.map((r, n) => h_flex().gap(10).children(r.map((c, i) => cell(c, widths[i], colorAt(n, i), i === 0)))));
}

function poolTile(app, t, st) {
  const s = st.health?.slots;
  const paused = pausedTasks(app.tasks).length;
  if (!s) return tile(t, "pool").child(div().text_size(12.5).text_color(t.dim).child(st.errors?.health ? `Pool unknown: ${st.errors.health}` : "Reading the pool…"));
  const latched = Array.isArray(s.latched) ? s.latched : [];
  return tile(t, "pool")
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().text_size(12.8).font_medium().text_color(t.foreground).child(`${s.active ?? 0} of ${s.max ?? "?"} slots busy`))
        .when(Boolean(s.draining), (el) => el.child(chip(t, "draining", "blocked")))
        .children(latched.map((l) => chip(t, `usage limit: ${latchedWords(l)}`, "blocked"))),
    )
    .child(div().text_size(11).text_color(t.dim).child(s.draining ? "Running stages finish; nothing new is claimed." : "Stages are claimed as slots free up."))
    .child(
      h_flex()
        .gap(6)
        .flex_wrap()
        .child(button(t, "pool-drain", s.draining ? "Carry on" : "Drain", s.draining ? "primary" : "plain", () => drain(app, Boolean(s.draining)), { small: true, iconName: s.draining ? "play" : "stop" }))
        .child(button(t, "pool-more", "One more slot", "plain", () => resize(app, s.max ?? 1, (s.max ?? 1) + 1), { small: true, iconName: "plus" }))
        .child(button(t, "pool-fewer", "One fewer", "plain", () => resize(app, s.max ?? 1, (s.max ?? 1) - 1), { small: true, busy: (s.max ?? 1) <= 1 }))
        .child(button(t, "pool-resume", paused ? `Resume ${paused} paused` : "Resume paused", "plain", () => resumeAll(app), { small: true, iconName: "refresh", busy: !paused })),
    );
}

function floorPage(app, t) {
  const st = app.state("floor");
  const errors = Object.values(st.errors ?? {});
  const hasNumbers = Boolean(st.m7 || st.m30);
  const body = [];
  body.push(section(t, "Stage pool"), poolTile(app, t, st));
  const bases = pendingBases(st.repos);
  if (bases.length) {
    body.push(section(t, "Base images waiting for you"));
    for (const b of bases) {
      body.push(
        tile(t, `base-${b.repo}`).child(
          h_flex()
            .gap(10)
            .items_center()
            .child(v_flex().flex_1().min_w(0).child(div().truncate().text_size(12.5).text_color(t.foreground).child(b.repo)).child(div().font_family(mono()).text_size(11).text_color(t.dim).child(b.base)))
            .child(button(t, `base-ok-${b.repo}`, "Approve", "primary", () => approveBase(app, b), { small: true, iconName: "check" })),
        ),
      );
    }
  }
  if (st.alerts?.length) {
    body.push(section(t, "Budget alerts"));
    for (const a of st.alerts) body.push(div().text_size(11.5).text_color(toneColor(t, "error")).child(`${plain(a.engine ?? a.repo ?? a.scope)}: ${a.pct}% of ${usd(a.limitUsd)} (${usd(a.spentUsd)} spent) · ${ago(new Date(a.at).toISOString())}`));
  }
  if (!hasNumbers) body.push(note(t, st.loading ? "Reading the numbers…" : errors[0] ?? "No numbers yet: Refresh reads them.", errors.length && !st.loading ? "error" : null));
  if (hasNumbers) {
    body.push(section(t, "Numbers"));
    body.push(table(t, "floor-numbers", ["", "7 days", "30 days"], floorRows(st.m7, st.m30).map((r) => [r.label, r.d7, r.d30])));
    const repos = new Map();
    for (const r of st.m7?.byRepo ?? []) repos.set(r.repo, { repo: r.repo, d7: r });
    for (const r of st.m30?.byRepo ?? []) repos.set(r.repo, { ...(repos.get(r.repo) ?? { repo: r.repo }), d30: r });
    body.push(section(t, "Per repository"));
    if (!repos.size) body.push(note(t, "No repository ran in these windows."));
    else {
      const rows = [...repos.values()].map((r) => [
        plain(r.repo).split("/").slice(-2).join("/"),
        r.d7 ? `${r.d7.tasks?.closed ?? 0}/${r.d7.tasks?.created ?? 0}` : "–",
        r.d7 ? pct(r.d7.escalationRate) : "–",
        r.d7 ? pct(r.d7.firstPassVerifying) : "–",
        r.d7 ? usd(r.d7.costUsd) : "–",
        r.d30 ? usd(r.d30.costUsd) : "–",
      ]);
      body.push(wide(t, "floor-repos", [200, 110, 90, 100, 90, 90], ["Repository", "7d closed/new", "Escalated", "First pass", "7d cost", "30d cost"], rows));
    }
    body.push(section(t, "Per engine (7 days) and this month"));
    const engines = engineRows(st.engineMetrics, st.engines);
    if (!st.engineMetrics && !st.engines) body.push(note(t, "The machine does not report engines."));
    else
      body.push(
        wide(
          t,
          "floor-engines",
          [150, 70, 80, 90, 90, 80, 150],
          ["Engine", "Runs", "First pass", "Escalated", "Rate limited", "Turns", "Month"],
          engines.map((e) => [e.name, String(e.stageRuns ?? 0), pct(e.firstPassRate), String(e.escalations ?? "–"), String(e.rateLimited ?? "–"), num(e.meanTurns), `${usd(e.month)} / ${typeof e.cap === "number" ? usd(e.cap) : "no cap"}`]),
          (n, i) => (engines[n]?.over && i === 6 ? toneColor(t, "error") : null),
        ),
      );
    const stages = stageRows(st.m7);
    if (stages.length)
      body.push(
        section(t, "Per stage (7 days)"),
        wide(t, "floor-stages", [180, 70, 100, 100, 90], ["Stage", "Runs", "Median", "p90", "Cost"], stages.map((s) => [s.stage.replaceAll("_", " "), String(s.runs), span(s.median), span(s.p90), usd(s.cost)])),
      );
  }
  const loadedAt = st.at ? `read ${ago(new Date(st.at).toISOString())}` : "not read yet";
  return frame(app, t, {
    id: "floor-body",
    title: "Floor",
    summary: errors.length ? errors[0] : `7 and 30 days · ${loadedAt}`,
    error: errors.length > 0,
    busy: Boolean(st.loading),
    actions: [button(t, "floor-refresh", "Refresh", "plain", (_e, cx) => loadFloor(app, cx), { iconName: "refresh", small: true, busy: Boolean(st.loading) })],
    body,
  });
}

page({
  id: "floor",
  label: "Floor",
  icon: "build",
  group: "insight",
  render: floorPage,
  enter,
  onMessage,
  badge: (app) => {
    const n = pausedTasks(app.tasks ?? []).length;
    return n ? { n, tone: "blocked" } : null;
  },
});

COMMANDS.floor = (app, _arg, cx) => app.go("floor", cx);
COMMANDS.drain = (app, _arg, cx) => {
  drain(app, Boolean(app.state("floor").health?.slots?.draining));
  cx.notify();
};
COMMANDS.resume = (app, arg, cx) => {
  // `resume` carries on after a drain; `resume paused` resumes the tickets paused on a usage limit.
  if (arg === "paused") resumeAll(app);
  else drain(app, true);
  cx.notify();
};
COMMANDS.slots = (app, arg, cx) => {
  const n = Number.parseInt(arg, 10);
  const max = app.state("floor").health?.slots?.max;
  if (!Number.isFinite(n) || n < 1) app.say("slots <n>: the number of slots, at least 1", "error");
  else resize(app, max ?? n, n);
  cx.notify();
};
