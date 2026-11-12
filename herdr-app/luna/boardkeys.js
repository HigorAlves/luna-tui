// The board's keys, as the TUI has them (board/README.md): columns, rows, folds, order, density,
// the filters, marks and bulk actions. `boardKey` is the board page's `key` hook; the other
// exports are what its clicks and the palette call. State lives in `app.ctl` (controls.js).
import { COLUMNS } from "./model.js";
import {
  BULK, BULK_KEYS, bulkQuestion, bulkTargets, foldKey, getCtl, hopStop, keyName, markColumn, nextDensity, densityLabel, saveCtl, stepColumn, stepRow, toggleMark,
} from "./controls.js";

const ROWS = (app) => app.allCols ?? {};

/** The rows of the focused column, as drawn (empty when it is folded). */
const visible = (app, name) => (app.cols ?? {})[name] ?? [];

/** Puts the focus on `name` and selects the card that column last had (else its first). */
export function focusColumn(app, name, cx, { select = false } = {}) {
  const ctl = getCtl(app);
  ctl.focus = name;
  if (select) {
    const ids = visible(app, name);
    const at = Math.min((ctl.rowAt ??= {})[name] ?? 0, ids.length - 1);
    app.select(ids[at] ?? null, cx);
  }
  cx.notify();
}

/** A rail's click: unfolds the column and focuses it. */
export function unfoldColumn(app, name, cx) {
  const ctl = getCtl(app);
  ctl.focus = name;
  apply(app, foldKey(ctl, "o", Boolean(app.doneOpen)), cx);
}

function apply(app, next, cx) {
  const ctl = getCtl(app);
  ctl.folded = next.folded;
  ctl.foldAll = next.foldAll;
  app.doneOpen = next.doneOpen;
  saveCtl(ctl);
  cx.notify();
}

/** `:fold` and `:unfold` (and zc, zo): folds or unfolds the focused column. */
export function foldFocused(app, c, cx) {
  apply(app, foldKey(getCtl(app), c, Boolean(app.doneOpen)), cx);
}

export function markToggle(app, id, cx) {
  const ctl = getCtl(app);
  ctl.marked = toggleMark(ctl.marked, id);
  cx.notify();
}

/** Sets the order columns use (`stage`, `repo` or `age`). */
export function setGroup(app, group, cx) {
  const ctl = getCtl(app);
  ctl.group = group;
  saveCtl(ctl);
  app.say(`columns by ${group}`);
  cx.notify();
}

/** Asks before a bulk action over `ids`: a dialog listing the tickets it applies to. */
export function bulk(app, action, ids, cx) {
  const items = bulkTargets(app.tasks, ids, action);
  if (!items.length) {
    app.say(ids.length === 1 ? "that ticket cannot take it" : "none of the marked tickets can take that");
    return cx.notify();
  }
  const skipped = ids.length - items.length;
  const rows = Math.min(items.length, 8);
  app.dialog({ kind: "bulk", action, items, skipped, question: bulkQuestion(action, items.length) }, 190 + rows * 24 + (action === "archive" ? 7 * 32 : 0), 520);
}

export function openKeys(app) {
  app.dialog({ kind: "keys", page: app.page }, 520, 560);
}

export function openPalette(app) {
  app.dialog({ kind: "palette" }, 440, 560);
}

function clearAll(app) {
  const ctl = getCtl(app);
  const had = ctl.marked.size > 0 || ctl.needsOnly || Boolean(ctl.thisRepo) || Boolean(app.query?.trim());
  if (!had) return false;
  ctl.marked = new Set();
  ctl.needsOnly = false;
  ctl.thisRepo = null;
  app.query = "";
  try {
    app.search?.set_value?.("");
  } catch {
    // the input is not ready: the query is already clear
  }
  return true;
}

function prefixed(app, prefix, name, cx) {
  const ctl = getCtl(app);
  const done = Boolean(app.doneOpen);
  if (prefix === "z" && ["c", "o", "z"].includes(name)) return apply(app, foldKey(ctl, name, done), cx);
  if (prefix === "g") {
    const group = { s: "stage", r: "repo", a: "age" }[name];
    if (group) return setGroup(app, group, cx);
    if (name === "g") {
      const id = visible(app, ctl.focus)[0];
      (ctl.rowAt ??= {})[ctl.focus] = 0;
      return app.select(id ?? null, cx);
    }
  }
  if (name !== "escape") app.say(`${prefix}${name} is not a key: zc/zo fold, zz folds the others, gs/gr/ga order, gg top`);
  cx.notify();
}

/** The board page's key hook. Answers true when it used the key. */
export function boardKey(app, e, cx) {
  const ctl = getCtl(app);
  const name = keyName(e);
  if (ctl.prefix) {
    const p = ctl.prefix;
    ctl.prefix = null;
    prefixed(app, p.c, name, cx);
    return true;
  }
  const focus = ctl.focus;
  const ids = visible(app, focus);
  const pickRow = (id) => {
    if (id == null) return true;
    (ctl.rowAt ??= {})[focus] = Math.max(0, ids.indexOf(id));
    app.select(id, cx);
    return true;
  };
  if (BULK_KEYS[name]) {
    const action = BULK_KEYS[name];
    if (ctl.marked.size) {
      bulk(app, action, [...ctl.marked], cx);
      return true;
    }
    if (name === "a") return false;
    if (app.selected) {
      bulk(app, action, [app.selected], cx);
      return true;
    }
    return false;
  }
  switch (name) {
    case "h":
    case "left":
      focusColumn(app, stepColumn(focus, -1), cx, { select: true });
      return true;
    case "l":
    case "right":
      focusColumn(app, stepColumn(focus, 1), cx, { select: true });
      return true;
    case "j":
    case "down":
      return pickRow(stepRow(ids, app.selected, 1));
    case "k":
    case "up":
      return pickRow(stepRow(ids, app.selected, -1));
    case "G":
      return pickRow(ids[ids.length - 1] ?? null);
    case "g":
    case "z":
      ctl.prefix = { c: name, at: Date.now() };
      cx.notify();
      return true;
    case "=":
      ctl.density = nextDensity(ctl.density);
      saveCtl(ctl);
      app.say(`cards: ${densityLabel(ctl.density)}`);
      cx.notify();
      return true;
    case "!":
      ctl.needsOnly = !ctl.needsOnly;
      cx.notify();
      return true;
    case "@": {
      if (ctl.thisRepo) ctl.thisRepo = null;
      else {
        const repo = app.tasks.find((t) => t.id === app.selected)?.repoPath;
        if (!repo) app.say("select a ticket first: @ keeps its repo");
        else ctl.thisRepo = repo;
      }
      cx.notify();
      return true;
    }
    case "v":
      if (app.selected) markToggle(app, app.selected, cx);
      return true;
    case "V":
      ctl.marked = markColumn(ctl.marked, ids);
      cx.notify();
      return true;
    case "tab":
    case "]":
    case "shift-tab":
    case "[": {
      const forward = name === "tab" || name === "]";
      const at = ROWS(app)[focus]?.indexOf(app.selected) ?? -1;
      const stop = hopStop(app.stops ?? [], { c: COLUMNS.indexOf(focus), r: Math.max(0, at) }, forward);
      if (!stop) {
        app.say("nothing needs you");
        cx.notify();
        return true;
      }
      ctl.focus = COLUMNS[stop.c];
      if (!(app.cols[ctl.focus] ?? []).includes(stop.id)) apply(app, foldKey(ctl, "o", Boolean(app.doneOpen)), cx);
      (ctl.rowAt ??= {})[ctl.focus] = stop.r;
      app.select(stop.id, cx);
      return true;
    }
    case "escape":
      if (clearAll(app)) {
        cx.notify();
        return true;
      }
      return false;
    case "enter":
      app.primary(cx);
      return true;
    case "P":
      app.go("prs", cx);
      return true;
    default:
      break;
  }
  if (/^[1-8]$/.test(name)) {
    const target = COLUMNS[Number(name) - 1];
    if (target === "Done") {
      app.doneOpen = true;
      ctl.foldAll = false;
    }
    focusColumn(app, target, cx);
    // Selecting waits for the next frame to know the column's cards (Done may have just opened).
    const list = (app.allCols ?? {})[target] ?? [];
    app.select(list[Math.min((ctl.rowAt ??= {})[target] ?? 0, list.length - 1)] ?? null, cx);
    return true;
  }
  return false;
}

export { BULK };
