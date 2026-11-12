// Luna for Herdr: the factory's board as a Herdr pane. A client of the machine's HTTP API,
// like the TUI board; it never decides anything the machine decides. The board, the inspector,
// the PR inbox and the dialogs are drawn in their own files; this holds the state, the stream and
// the actions.
import { View } from "gpui-kit";
import { h_flex, InputState } from "gpui-base";
import { appHome, exec, nextCommand, notify, openOverlay, pickFolder, props, readTextFile, shared, theme, watchFolder } from "herdr";
import * as fs from "fs/promises";

import { Machine } from "./api.js";
import { boardPage, sidebar } from "./board.js";
import { initDialog, renderDialog } from "./dialogs.js";
import { focusColumn, markToggle, openKeys, openPalette, unfoldColumn } from "./boardkeys.js";
import { getCtl, keyName } from "./controls.js";
import { inspector } from "./inspector.js";
import { actionsFor, applyEvent, gateQuestion, needsYou, plainTitle } from "./model.js";
import { ACTIONS, COMMANDS, DIALOGS, PAGES, TABS } from "./registry.js";
import "./features.js";

const RECONNECT_MS = 3000;
const POLL_MS = 30000;

const later = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not kept: fine
  }
}

function stored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export default class Luna extends View {
  init(_props, cx) {
    this.machine = new Machine();
    if (props()?.dialog) {
      this.isDialog = true;
      initDialog(this, cx);
      return;
    }
    this.tasks = [];
    this.loaded = false;
    this.error = null;
    this.link = "connecting";
    this.lastSeq = null;
    this.page = stored("page", "board");
    this.view = "all";
    this.project = null;
    this.query = "";
    this.selected = stored("selected", null);
    this.tab = "details";
    this.details = {};
    this.diffs = {};
    this.doneOpen = false;
    this.prs = { inbox: null, all: null };
    this.prList = stored("prList", "inbox");
    this.prSplit = null;
    this.prRepo = null;
    this.prRefreshing = false;
    this.busy = new Set();
    this.flash = null;
    this.width = 1200;
    this.seenShared = {};
    this.search = InputState.new({ placeholder: "Find a task or PR" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value();
      cx.notify();
    });
    this.search.on("focus", (_e, cx) => {
      this.searchFocused = true;
      cx.notify();
    });
    this.search.on("blur", (_e, cx) => {
      this.searchFocused = false;
      cx.notify();
    });
    this.handle = cx.focus_handle();
    this.states = {};
    cx.spawn(async (cx) => {
      try {
        await this.machine.connect();
      } catch (e) {
        this.error = e?.message ?? String(e);
        this.link = "offline";
        cx.notify();
      }
      await this.reload(cx);
      // A page restored from the last session loads its own data, as a visit would.
      try {
        this.currentPage()?.enter?.(this, cx);
      } catch (e) {
        this.say(e?.message ?? String(e), "error");
      }
      this.follow(cx);
    });
    // Keys bound in keys.json (`"mod:luna"`) and `pane.go`'s focus arrive here.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
    this.inbox(cx);
    // The stream is the source of truth; this only catches up when it is down.
    cx.timer.every(POLL_MS, (cx) => {
      if (this.link !== "live") this.reload(cx);
    });
  }

  async close() {
    this.closed = true;
  }

  // ---- data ----

  async reload(cx, loud = false) {
    try {
      if (loud || this.link === "offline") await this.machine.reconnect().catch(() => null);
      const [tasks, inbox, all] = await Promise.all([this.machine.tasks(), this.machine.prs(false).catch(() => this.prs.inbox), this.machine.prs(true).catch(() => this.prs.all)]);
      this.tasks = tasks ?? [];
      this.prs = { inbox, all };
      this.lastSeq = Math.max(0, ...this.tasks.map((t) => t.seq ?? 0));
      this.loaded = true;
      this.error = null;
      if (this.link === "offline") this.link = "polling";
      if (loud) this.say("Board read again");
      if (this.selected) this.loadDetail(this.selected, cx);
    } catch (e) {
      this.error = e?.message ?? String(e);
      this.link = "offline";
    }
    cx.notify();
  }

  /** Follows the stream for as long as the pane lives, reconnecting when the machine goes away. */
  follow(cx) {
    cx.spawn(async (cx) => {
      while (!this.closed) {
        try {
          if (this.link !== "live") this.link = this.link === "offline" ? "offline" : "connecting";
          await this.machine.follow(this.lastSeq, (m) => this.onMessage(m, cx), () => !this.closed);
        } catch (e) {
          this.streamError = e?.message ?? String(e);
        }
        if (this.closed) return;
        this.link = "offline";
        cx.notify();
        await later(cx, RECONNECT_MS);
        await this.reload(cx);
      }
    });
  }

  onMessage({ event, data }, cx) {
    if (event === "ready") {
      this.link = "live";
      this.error = null;
    } else if (event === "task.updated" || event === "task.deleted") {
      const before = data?.task ? this.tasks.find((t) => t.id === data.task.id) : null;
      this.tasks = applyEvent(this.tasks, event, data);
      if (data?.seq != null) this.lastSeq = Math.max(this.lastSeq ?? 0, data.seq);
      const after = data?.task;
      if (after && !needsYou(before ?? {}) && needsYou(after) && this.loaded) {
        notify({ title: plainTitle(after), body: gateQuestion(after) ?? "Waiting on you", level: "warning", icon: "mods/luna/icons/hand.svg" });
      }
      const id = after?.id ?? data?.id;
      if (id && id === this.selected) {
        this.loadDetail(id, cx);
        const task = this.tasks.find((t) => t.id === id);
        if (task) TABS.find((x) => x.id === this.tab)?.enter?.(this, task, cx);
      }
    } else if (event === "task.event") {
      if (data?.event?.taskId === this.selected) this.loadDetail(this.selected, cx);
    } else if (event === "github.prs") {
      this.prs = { ...this.prs, inbox: data?.snapshot ?? this.prs.inbox };
    } else if (event === "github.prs.all") {
      this.prs = { ...this.prs, all: data?.snapshot ?? this.prs.all };
      this.prRefreshing = false;
    } else {
      // Every page sees the rest (slack.items, budget.alert, task.metrics, …).
      let used = false;
      for (const p of PAGES) {
        try {
          used = Boolean(p.onMessage?.(this, { event, data }, cx)) || used;
        } catch {
          // a page's handler never stops the stream
        }
      }
      if (!used) return;
    }
    cx.notify();
  }

  loadDetail(id, cx) {
    if (this.loadingDetail === id) {
      this.detailAgain = true;
      return;
    }
    this.loadingDetail = id;
    cx.spawn(async (cx) => {
      try {
        do {
          this.detailAgain = false;
          this.details[id] = await this.machine.detail(id);
          cx.notify();
        } while (this.detailAgain);
      } catch {
        // the board still shows what the list knows
      }
      this.loadingDetail = null;
    });
  }

  loadDiff(id, cx) {
    cx.spawn(async (cx) => {
      try {
        this.diffs[id] = await this.machine.diff(id);
      } catch (e) {
        this.diffs[id] = { error: e?.code === "no_worktree" ? "No workspace on disk: nothing to diff." : e?.message ?? String(e) };
      }
      cx.notify();
    });
  }

  // ---- navigation ----

  /** A feature's own state, kept on the pane for as long as it lives. */
  state(id) {
    this.states[id] ??= {};
    return this.states[id];
  }

  currentPage() {
    return PAGES.find((p) => p.id === this.page) ?? PAGES[0];
  }

  go(page, cx) {
    if (!PAGES.some((p) => p.id === page)) return;
    this.page = page;
    store("page", page);
    try {
      this.currentPage().enter?.(this, cx);
    } catch (e) {
      this.say(e?.message ?? String(e), "error");
    }
    cx.notify();
  }

  select(id, cx) {
    this.selected = id;
    store("selected", id ?? "");
    this.moreOpen = false;
    if (id) {
      this.loadDetail(id, cx);
      const task = this.tasks.find((t) => t.id === id);
      if (task) TABS.find((x) => x.id === this.tab)?.enter?.(this, task, cx);
    }
    cx.notify();
  }

  setTab(id, cx) {
    this.tab = id;
    const task = this.tasks.find((t) => t.id === this.selected);
    if (task) TABS.find((x) => x.id === id)?.enter?.(this, task, cx);
    cx.notify();
  }

  showPrList(id, cx) {
    this.prList = id;
    this.prSplit = null;
    store("prList", id);
    cx.notify();
  }

  say(text, tone = null) {
    this.flash = { text, tone, at: Date.now() };
  }

  openUrl(url) {
    exec("open", [url]).catch(() => null);
  }

  dialog(spec, height, width) {
    const kind = DIALOGS[spec.kind];
    openOverlay({ mod: "luna", kind: "dialog", width: width ?? kind?.width ?? 460, height: height ?? kind?.height ?? 320, props: { dialog: spec } });
  }

  /**
   * Asks before a call: `{title, body, label, danger, call: {method, path, body}, done}`. The
   * dialog makes the call; the board sees the result on the stream.
   */
  confirm(spec) {
    this.dialog({ kind: "confirm", ...spec }, spec.height ?? 230);
  }

  // The board's clicks and the keys that open a dialog; the rules are in controls.js and boardkeys.js.
  toggleMark(id, cx) { markToggle(this, id, cx); }
  unfold(name, cx) { unfoldColumn(this, name, cx); }
  focusColumn(name, cx) { focusColumn(this, name, cx); }
  palette() { openPalette(this); }
  keysSheet() { openKeys(this); }

  newTask() {
    const repos = [...new Set(this.tasks.map((t) => t.repoPath).filter(Boolean))];
    const current = this.tasks.find((t) => t.id === this.selected)?.repoPath ?? repos[0] ?? "";
    this.dialog({ kind: "new_task", repos, repoPath: current }, 600, 520);
  }

  pickRepo(repos) {
    this.dialog({ kind: "repos", repos, current: this.prRepo }, Math.min(520, 120 + repos.length * 32), 420);
  }

  // ---- actions ----

  /** Runs a machine call for `key` (a task id, a PR), keeping its button busy and saying what happened. */
  run(cx, key, done, call) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await call();
        if (out?.id && out?.state) this.tasks = applyEvent(this.tasks, "task.updated", { task: out });
        if (done) this.say(done);
      } catch (e) {
        if (!this.refused(e, key)) this.say(e?.message ?? String(e), "error");
      }
      this.busy.delete(key);
      cx.notify();
    });
  }

  /** A refusal the board answers with a dialog instead of an error line. */
  refused(e, key) {
    if (e?.code === "coverage_gaps") {
      const gaps = e.body?.gaps ?? [];
      this.dialog({ kind: "excuse", taskId: key, gaps }, Math.min(560, 220 + gaps.length * 34));
      return true;
    }
    return false;
  }

  act(task, id, cx) {
    if (ACTIONS[id]) return ACTIONS[id](this, task, cx);
    const m = this.machine;
    const r = task.gate?.requested ?? {};
    const sub = plainTitle(task);
    switch (id) {
      case "start": return this.run(cx, task.id, "Started", () => m.start(task.id));
      case "approve": return this.run(cx, task.id, task.state === "escalated" ? "Running it again" : "Approved", () => m.decide(task.id, "approved"));
      case "keep_whole": return this.run(cx, task.id, "Kept whole: planning again", () => m.decide(task.id, "approved", { keepWhole: true }));
      case "resume": return this.run(cx, task.id, "Resumed", () => m.resume(task.id));
      case "abort": return this.run(cx, task.id, "Stopped", () => m.abort(task.id));
      case "post_questions": return this.run(cx, task.id, "Questions posted", () => m.postQuestions(task.id));
      case "send_back": return this.dialog({ kind: "send_back", taskId: task.id, subtitle: sub, title: task.route === "review" && task.state === "awaiting_ship" ? "Drop the review" : null });
      case "reject": return this.dialog({ kind: "reject", taskId: task.id, subtitle: sub });
      case "archive": return this.dialog({ kind: "archive", taskId: task.id, subtitle: sub }, 400);
      case "delete": return this.dialog({ kind: "delete", taskId: task.id, subtitle: sub }, 220);
      case "answer": {
        const questions = (r.questions ?? []).map((q) => (typeof q === "string" ? q : q?.question ?? q?.text ?? JSON.stringify(q)));
        return this.dialog({ kind: "answer", taskId: task.id, questions, subtitle: sub }, Math.min(640, 200 + questions.length * 90));
      }
      case "context": return this.dialog({ kind: "context", taskId: task.id, repoPath: task.repoPath, subtitle: sub }, 380);
      case "dedup": return this.dialog({ kind: "dedup", taskId: task.id, candidates: r.candidates ?? [], subtitle: sub }, 360);
      default: return null;
    }
  }

  prAct(pr, id, cx) {
    const key = `${pr.repo}#${pr.number}`;
    const m = this.machine;
    switch (id) {
      case "browser": return this.openUrl(pr.url);
      case "open_task":
        this.go("board", cx);
        return this.select(pr.task.id, cx);
      case "merge": return this.dialog({ kind: "merge", repo: pr.repo, number: pr.number, subtitle: pr.title }, 230);
      case "clone":
        return cx.spawn(async (cx) => {
          const folder = await pickFolder({ prompt: `Clone ${pr.repo} here` });
          if (!folder) return;
          const dest = `${folder.replace(/\/+$/, "")}/${pr.repo.split("/")[1]}`;
          this.run(cx, key, `Cloning ${pr.repo} into ${dest}`, () => m.clone(pr.repo, dest));
        });
      default:
        return this.run(cx, key, null, async () => {
          const task = await m.prAction(pr.repo, pr.number, id);
          if (task?.id) {
            this.go("board", cx);
            this.select(task.id, cx);
            this.say(`${{ review: "Review", ci_fix: "CI fix", address: "Address" }[id]} started`);
          }
          return task;
        });
    }
  }

  refreshPrs(cx) {
    const all = this.prList === "all";
    this.prRefreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const snap = await this.machine.refreshPrs(all);
        this.prs = { ...this.prs, [all ? "all" : "inbox"]: snap };
        // The all-repos read goes on in the background; its result comes on the stream.
        if (!all) this.prRefreshing = false;
      } catch (e) {
        this.say(e?.message ?? String(e), "error");
        this.prRefreshing = false;
      }
      cx.notify();
    });
  }

  /** Shared values the dialogs leave: a task to select, a repo to filter the PRs by. */
  takeShared(cx) {
    const pick = shared("luna.select");
    if (pick?.at && pick.at !== this.seenShared.select) {
      this.seenShared.select = pick.at;
      this.page = "board";
      this.selected = pick.id;
      this.loadDetail(pick.id, cx);
    }
    // What a dialog leaves behind: a command line from the palette, the result of a bulk action.
    const cmd = shared("luna.command");
    if (cmd?.at && cmd.at !== this.seenShared.command) {
      this.seenShared.command = cmd.at;
      try {
        this.inboxCommand(String(cmd.line ?? ""), cx);
      } catch (e) {
        this.say(e?.message ?? String(e), "error");
      }
    }
    const bulk = shared("luna.bulk");
    if (bulk?.at && bulk.at !== this.seenShared.bulk) {
      this.seenShared.bulk = bulk.at;
      const ctl = getCtl(this);
      for (const id of bulk.done ?? []) ctl.marked.delete(id);
      if (bulk.text) this.say(bulk.text, bulk.failed ? "error" : null);
      if (bulk.refreshPrs) this.refreshPrs(cx);
    }
    const repo = shared("luna.prRepo");
    if (repo?.at && repo.at !== this.seenShared.repo) {
      this.seenShared.repo = repo.at;
      this.prRepo = repo.repo;
    }
  }

  // ---- keys ----

  /** Moves the selection along the board's order by `step` cards. */
  move(step, cx) {
    const order = this.order ?? [];
    if (!order.length) return;
    const at = order.indexOf(this.selected);
    const next = at < 0 ? (step > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + step));
    this.select(order[next], cx);
  }

  /** The selected card's first primary action (Start, Approve, Retry, Resume). */
  primary(cx) {
    const task = this.tasks.find((t) => t.id === this.selected);
    const a = task && actionsFor(task).find((x) => x.kind === "primary");
    if (a) this.act(task, a.id, cx);
  }

  command(c, cx) {
    switch (c) {
      case "focus": return this.handle.focus();
      case "next": return this.move(1, cx);
      case "prev": return this.move(-1, cx);
      case "close": return this.select(null, cx);
      case "refresh": return this.reload(cx, true);
      case "new": return this.newTask();
      case "approve": return this.primary(cx);
      case "search": return this.search.focus();
      default: return null;
    }
  }

  /**
   * Commands dropped as files in `<app home>/luna-inbox/` (one command per file: `prs`,
   * `select <task id>`, `tab runs`, `list all`, `new`), so a script or an agent can drive the
   * board as keys do. Each file is read once and removed.
   */
  inbox(cx) {
    const dir = `${appHome()}/luna-inbox`;
    cx.spawn(async (cx) => {
      await fs.mkdir(dir, { recursive: true }).catch((e) => { this.inboxError = `mkdir: ${e?.message ?? e}`; });
      while (!this.closed) {
        try {
          for (const name of (await fs.readdir(dir)).sort()) {
            const path = `${dir}/${name}`;
            const text = (await readTextFile(path)) ?? "";
            await fs.unlink(path).catch(() => null);
            for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) this.inboxCommand(line, cx);
          }
          cx.notify();
          await watchFolder(dir);
        } catch (e) {
          this.inboxError = e?.message ?? String(e);
          this.say(`inbox: ${this.inboxError}`, "error");
          cx.notify();
          await later(cx, 5000);
        }
      }
    });
  }

  inboxCommand(line, cx) {
    const [verb, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    if (verb === "select") return this.select(this.tasks.find((t) => t.id === arg || t.id.startsWith(arg))?.id ?? null, cx);
    if (verb === "tab") return this.setTab(arg, cx);
    if (verb === "list") return this.showPrList(arg === "all" ? "all" : "inbox", cx);
    if (verb === "act") {
      const task = this.tasks.find((t) => t.id === this.selected);
      return task ? this.act(task, arg, cx) : null;
    }
    if (verb === "page") return this.go(arg, cx);
    if (COMMANDS[verb]) return COMMANDS[verb](this, arg, cx);
    if (verb === "done") {
      this.doneOpen = arg !== "off";
      return cx.notify();
    }
    return this.command(verb, cx);
  }

  key(e, cx) {
    if (this.searchFocused) {
      if (e.key === "escape") {
        this.handle.focus();
        cx.stop_propagation();
      }
      return;
    }
    try {
      if (this.currentPage().key?.(this, e, cx)) return cx.stop_propagation();
    } catch {
      // fall through to the app's keys
    }
    const name = keyName(e);
    if (name === "?") openKeys(this);
    else if (name === ":") openPalette(this);
    else if (name === "b" && this.page !== "board") this.go("board", cx);
    else if (name === "P" && this.page !== "prs") this.go("prs", cx);
    else {
      const keys = { j: "next", down: "next", k: "prev", up: "prev", escape: "close", r: "refresh", n: "new", "/": "search", enter: "approve", a: "approve" };
      const c = keys[name];
      if (!c || (c === "close" && !this.selected)) return;
      this.command(c, cx);
    }
    cx.stop_propagation();
  }

  // ---- drawing ----

  render(cx) {
    const t = theme();
    if (this.isDialog) return renderDialog(this, t);
    this.takeShared(cx);
    if (this.flash && Date.now() - this.flash.at > 8000) this.flash = null;
    const narrow = this.width < 900;
    const inspectorWidth = Math.max(340, Math.min(440, Math.round(this.width * 0.34)));
    const open = this.page === "board" && Boolean(this.selected) && this.tasks.some((x) => x.id === this.selected);
    this.boardWidth = this.width - (!narrow || !open ? 236 : 0) - (open ? inspectorWidth : 0);
    const pane = (this.currentPage()?.render ?? boardPage)(this, t);
    const side = open ? inspector(this, t, inspectorWidth) : null;
    if (this.selected && this.page === "board" && !this.tasks.find((x) => x.id === this.selected) && this.loaded) this.selected = null;
    return h_flex()
      .id("luna")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        this.width = size.width;
        cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.canvas)
      .text_color(t.foreground)
      .text_size(13)
      .when(!narrow || !side, (el) => el.child(sidebar(this, t)))
      .child(pane)
      .when(Boolean(side), (el) => el.child(side));
  }
}

