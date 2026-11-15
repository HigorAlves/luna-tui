// Luna for Herdr: the factory's board as a Herdr pane. A client of the machine's HTTP API,
// like the TUI board; it never decides anything the machine decides. The board, the inspector,
// the PR inbox and the dialogs are drawn in their own files; this holds the state, the stream and
// the actions.
import { View } from "gpui-kit";
import { h_flex, InputState } from "gpui-base";
import { appHome, exec, nextCommand, notify, openOverlay, pickFolder, props, readTextFile, setShared, shared, theme, watchFolder } from "herdr";
import * as fs from "fs/promises";

import { Machine } from "./api.js";
import { boardPage, sidebar } from "./board.js";
import { initDialog, renderDialog } from "./dialogs.js";
import { focusColumn, markToggle, openKeys, openPalette, unfoldColumn } from "./boardkeys.js";
import { getCtl, keyName } from "./controls.js";
import { inspector } from "./inspector.js";
import { actionsFor, applyEvent, gateQuestion, needsYou, plainTitle } from "./model.js";
import { PENDING_MS, mergeSnapshot } from "./sync.js";
import { ACTIONS, COMMANDS, DIALOGS, PAGES, TABS } from "./registry.js";
import "./features.js";

const RECONNECT_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const POLL_MS = 30000;
const SHARED_MS = 250;

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
    this.machine = new Machine({ cx });
    this.startedAt = Date.now();
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
    this.focusedInputs = new Set();
    this.tombstones = new Map();
    this.detailFlight = {};
    this.diffFlight = {};
    this.pending = null;
    this.search = InputState.new({ placeholder: "Find a task or PR" });
    this.trackInput(this.search);
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
    // The stream is the source of truth; this only catches up when it is down, or when the first
    // read of the board never came.
    cx.timer.every(POLL_MS, (cx) => {
      if (!this.loaded || this.link !== "live") this.reload(cx);
    });
    // What the dialogs hand back is taken here, never in render.
    cx.timer.every(SHARED_MS, (cx) => this.takeShared(cx));
  }

  /** Marks a text input drawn in the main pane: while one has the keyboard the board's keys stay quiet. */
  trackInput(state) {
    state.on?.("focus", () => this.focusedInputs.add(state));
    state.on?.("blur", () => this.focusedInputs.delete(state));
    return state;
  }

  async close() {
    this.closed = true;
  }

  // ---- data ----

  /**
   * Reads the board again. Runs in its own task, so a handler's `cx` is never used after an await;
   * answers when it is done. One at a time: a call while another runs gets that one.
   */
  reload(cx, loud = false) {
    cx.notify();
    if (this.reloading) return this.reloading;
    this.reloading = new Promise((resolve) => {
      cx.spawn(async (cx) => {
        try {
          await this.readBoard(cx, loud);
        } finally {
          this.reloading = null;
          resolve();
        }
      });
    });
    return this.reloading;
  }

  async readBoard(cx, loud) {
    const since = Date.now();
    try {
      if (loud || this.link === "offline") await this.machine.reconnect().catch(() => null);
      const [tasks, inbox, all] = await Promise.all([this.machine.tasks(), this.machine.prs(false).catch(() => this.prs.inbox), this.machine.prs(true).catch(() => this.prs.all)]);
      // A snapshot never replaces a newer card the stream delivered while it was on its way.
      this.tasks = mergeSnapshot(this.tasks, tasks ?? [], { tombstones: this.tombstones, since });
      for (const [id, at] of this.tombstones) if (at < since - 60000) this.tombstones.delete(id);
      this.prs = { inbox, all };
      this.lastSeq = Math.max(this.lastSeq ?? 0, ...this.tasks.map((t) => t.seq ?? 0));
      this.loaded = true;
      this.error = null;
      if (this.link === "offline") this.link = "polling";
      if (loud) this.say("Board read again");
      if (this.selected) this.loadDetail(this.selected, cx);
    } catch (e) {
      this.error = e?.message ?? String(e);
      if (this.link !== "live") this.link = "offline";
    }
    cx.notify();
  }

  /**
   * Follows the stream for as long as the pane lives. The link says "Live" only while bytes
   * flow: when the stream ends, stalls (no byte, not even a ping, for 40s) or fails, it goes
   * "offline", the board is read again, and the stream is retried after 3s, doubling to 60s.
   */
  follow(cx) {
    cx.spawn(async (cx) => {
      let wait = RECONNECT_MS;
      while (!this.closed) {
        let live = false;
        try {
          if (this.link !== "live") this.link = this.link === "offline" ? "offline" : "connecting";
          await this.machine.follow(
            this.lastSeq,
            (m) => {
              if (m.event === "ready") live = true;
              this.onMessage(m, cx);
            },
            () => !this.closed,
            { onBytes: () => { this.lastByte = Date.now(); } },
          );
          this.streamError = "the machine closed the stream";
        } catch (e) {
          this.streamError = e?.message ?? String(e);
          if (e?.code === "tls") {
            // No stream over https: the poll keeps the board true.
            this.link = "polling";
            this.say(this.streamError, "error");
            cx.notify();
            await this.reload(cx);
            return;
          }
        }
        if (this.closed) return;
        if (live) wait = RECONNECT_MS;
        this.link = "offline";
        cx.notify();
        await later(cx, wait);
        wait = Math.min(wait * 2, RECONNECT_MAX_MS);
        await this.reload(cx);
      }
    });
  }

  onMessage({ event, data }, cx) {
    let changed = true;
    if (event === "ready") {
      this.link = "live";
      this.error = null;
      if (!this.loaded) this.reload(cx);
    } else if (event === "task.updated" || event === "task.deleted") {
      const before = data?.task ? this.tasks.find((t) => t.id === data.task.id) : null;
      this.tasks = applyEvent(this.tasks, event, data);
      if (event === "task.deleted" && data?.id) this.tombstones.set(data.id, Date.now());
      if (data?.seq != null) this.lastSeq = Math.max(this.lastSeq ?? 0, data.seq);
      const after = data?.task;
      if (after && !needsYou(before ?? {}) && needsYou(after) && this.loaded) {
        notify({ title: plainTitle(after), body: gateQuestion(after) ?? "Waiting on you", level: "warning", icon: "mods/luna/icons/hand.svg" });
      }
      const id = after?.id ?? data?.id;
      if (after?.id && this.pending?.id === after.id) this.pending = null;
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
      changed = false;
    }
    // Every page sees every message, after the board applied it (slack.items, budget.alert,
    // task.updated, github.prs, …).
    let used = false;
    for (const p of PAGES) {
      try {
        used = Boolean(p.onMessage?.(this, { event, data }, cx)) || used;
      } catch {
        // a page's handler never stops the stream
      }
    }
    if (changed || used) cx.notify();
  }

  /** Reads a card's detail, one read at a time per card; a call during a read makes it read again. */
  loadDetail(id, cx) {
    const flight = this.detailFlight[id];
    if (flight) {
      flight.again = true;
      return;
    }
    const mine = { again: false };
    this.detailFlight[id] = mine;
    cx.spawn(async (cx) => {
      try {
        do {
          mine.again = false;
          this.details[id] = await this.machine.detail(id);
          cx.notify();
        } while (mine.again);
      } catch {
        // the board still shows what the list knows
      }
      delete this.detailFlight[id];
    });
  }

  /** Reads a card's diff, one read at a time per card, so a slow old answer never lands after a newer one. */
  loadDiff(id, cx) {
    const flight = this.diffFlight[id];
    if (flight) {
      flight.again = true;
      return;
    }
    const mine = { again: false };
    this.diffFlight[id] = mine;
    cx.spawn(async (cx) => {
      do {
        mine.again = false;
        try {
          this.diffs[id] = await this.machine.diff(id);
        } catch (e) {
          this.diffs[id] = { error: e?.code === "no_worktree" ? "No workspace on disk: nothing to diff." : e?.message ?? String(e) };
        }
        cx.notify();
      } while (mine.again);
      delete this.diffFlight[id];
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
    this.focusedInputs.clear();
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
    // A card the stream has not delivered yet (a new ticket) stays selected for a while.
    this.pending = id && !this.tasks.some((t) => t.id === id) ? { id, until: Date.now() + PENDING_MS } : null;
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
        // `call` gets the task's own cx: the handler's is stale after its first await.
        const out = await call(cx);
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
        return this.run(cx, key, null, async (cx) => {
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

  /**
   * What a dialog handed back (`app.handBack(kind, value)` there): a task to select, a command
   * line from the palette, a bulk action's result, a repo to filter the PRs by. Runs on a timer
   * with the task's own cx, never in render. A value older than this pane is ignored (the last
   * one shared stays in Herdr's store), and one pane takes each (the claim).
   */
  takeShared(cx) {
    const take = (kind) => {
      const v = shared(`luna.${kind}`);
      if (!v?.at || v.at < this.startedAt || v.at === this.seenShared[kind]) return null;
      this.seenShared[kind] = v.at;
      if (shared(`luna.claim.${kind}`) === v.at) return null;
      setShared(`luna.claim.${kind}`, v.at);
      return v;
    };
    const pick = take("select");
    if (pick?.id) {
      this.page = "board";
      this.select(pick.id, cx);
    }
    const cmd = take("command");
    if (cmd) {
      try {
        this.inboxCommand(String(cmd.line ?? ""), cx);
      } catch (e) {
        this.say(e?.message ?? String(e), "error");
        cx.notify();
      }
    }
    const bulk = take("bulk");
    if (bulk) {
      const ctl = getCtl(this);
      for (const id of bulk.done ?? []) ctl.marked.delete(id);
      if (bulk.text) this.say(bulk.text, bulk.failed ? "error" : null);
      if (bulk.refreshPrs) this.refreshPrs(cx);
      cx.notify();
    }
    const repo = take("prRepo");
    if (repo) {
      this.prRepo = repo.repo;
      cx.notify();
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
      default:
        if (COMMANDS[c]) return COMMANDS[c](this, "", cx);
        if (PAGES.some((p) => p.id === c)) return this.go(c, cx);
        this.say(`unknown command: ${c}`, "error");
        return cx.notify();
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
    // Typing in an input of the main pane (the search, a page's own) is not the board's keys.
    if (this.focusedInputs.size) {
      if (e.key === "escape") {
        this.focusedInputs.clear();
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
      // Enter and `a` act on the board's selection; on another page they are that page's or nothing.
      if (c === "approve" && this.page !== "board") return;
      this.command(c, cx);
    }
    cx.stop_propagation();
  }

  // ---- drawing ----

  render(cx) {
    const t = theme();
    if (this.isDialog) return renderDialog(this, t);
    if (this.flash && Date.now() - this.flash.at > 8000) this.flash = null;
    const narrow = this.width < 900;
    const inspectorWidth = Math.max(340, Math.min(440, Math.round(this.width * 0.34)));
    const open = this.page === "board" && Boolean(this.selected) && this.tasks.some((x) => x.id === this.selected);
    this.boardWidth = this.width - (!narrow || !open ? 236 : 0) - (open ? inspectorWidth : 0);
    const pane = (this.currentPage()?.render ?? boardPage)(this, t);
    const side = open ? inspector(this, t, inspectorWidth) : null;
    const waiting = this.pending?.id === this.selected && Date.now() < this.pending.until;
    if (this.selected && this.page === "board" && !this.tasks.find((x) => x.id === this.selected) && this.loaded && !waiting) this.selected = null;
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

