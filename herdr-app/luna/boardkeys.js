// The board's keys, as the TUI has them (board/README.md): columns, rows, folds, order, density,
// the filters, marks and bulk actions. `boardKey` is the board page's `key` hook; the other
// exports are what its clicks and the palette call. State lives in `app.ctl` (controls.js).
import { canCorrectRecord, canEditPlan, canEditTicket, canMerge, canUnmerge, canWatch, atMemoryReview, jiraOn } from "./actions-rules.js";
import { COLUMNS } from "./model.js";
import {
  BULK, BULK_KEYS, PREFIX_MS, gateKey, approveManyQuestion, bulkApprovePlan, bulkQuestion, bulkTargets, canSendBack, editRefusal, foldKey, getCtl, heldReason, hopStop, keyName, livePrefix,
  markColumn, nextDensity, densityLabel, openGaps, rejectKind, saveCtl, stepColumn, stepRow, toggleMark,
} from "./controls.js";
import { COMMANDS } from "./registry.js";

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
  if (action === "approve") return bulkApprove(app, ids, cx);
  const items = bulkTargets(app.tasks, ids, action);
  if (!items.length) {
    app.say(ids.length === 1 ? "that ticket cannot take it" : "none of the marked tickets can take that");
    return cx.notify();
  }
  const skipped = ids.length - items.length;
  const rows = Math.min(items.length, 8);
  app.dialog({ kind: "bulk", action, items, skipped, question: bulkQuestion(action, items.length) }, 190 + rows * 24 + (action === "archive" ? 7 * 32 : 0), 520);
}

/**
 * `a` over the marks (the TUI's `bulk_key`): a draft starts and a paused card resumes now; the plans,
 * splits, ships and releases wait for one yes, named in the question; replies, archives, setups,
 * tests, escalations, review posts and answers are left alone and counted.
 */
export function bulkApprove(app, ids, cx) {
  const ctl = getCtl(app);
  const plan = bulkApprovePlan(app.tasks, ids);
  const rest = plan.immediate.length + plan.skipped;
  const restIds = new Set([...plan.immediate.map((i) => i.id), ...ids.filter((id) => !plan.committing.some((c) => c.id === id))]);
  if (plan.immediate.length) {
    cx.spawn(async (cx2) => {
      let done = 0;
      for (const item of plan.immediate) {
        try {
          await (item.step === "start" ? app.machine.start(item.id) : app.machine.resume(item.id));
          done++;
        } catch {
          // counted as not advanced
        }
      }
      const skip = plan.skipped ? `; ${plan.skipped} need words from you or are running` : "";
      app.say(`advanced ${done} of ${plan.immediate.length}${skip}`, done < plan.immediate.length ? "error" : null);
      cx2.notify();
    });
  } else if (!plan.committing.length) {
    app.say(`advanced 0 of ${rest}${rest ? `; ${plan.skipped} need words from you or are running` : ""}`);
  }
  if (!plan.committing.length) ctl.marked = new Set();
  else for (const id of restIds) ctl.marked.delete(id);
  if (plan.committing.length) {
    const rows = Math.min(plan.committing.length, 8);
    app.dialog({ kind: "bulk", action: "approve", items: plan.committing, skipped: 0, question: approveManyQuestion(plan.committing) }, 190 + rows * 24, 520);
  }
  cx.notify();
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

const VIEW_KEYS = { F: "floor", I: "inbox", D: "digest", B: "backlog", $: "economy", K: "tickets", S: "slack", P: "prs" };

const say = (app, text, cx) => {
  app.say(text);
  cx.notify();
  return true;
};

/** `x` then a key: the TUI's actions menu keys that are not the inspector's buttons. */
function menuKey(app, name, cx) {
  const task = app.tasks.find((t) => t.id === app.selected);
  switch (name) {
    case "S":
      if (task?.state === "awaiting_ship" && task.waitingOnYou) return app.act(task, "approve", cx);
      return say(app, task?.state === "awaiting_ship" ? "the machine is watching the PR; nothing to ship yet" : "nothing waiting to ship on this ticket", cx);
    case "P": return COMMANDS.resume?.(app, "paused", cx);
    case "D": return COMMANDS.drain?.(app, "", cx);
    case "+":
    case "-": {
      const max = app.state?.("floor")?.health?.slots?.max;
      if (!max) return say(app, "open the Floor first: it reads how many slots there are", cx);
      return COMMANDS.slots?.(app, String(Math.max(1, max + (name === "+" ? 1 : -1))), cx);
    }
    case "x":
      app.moreOpen = !app.moreOpen;
      return cx.notify();
    case "escape": return cx.notify();
    default: return say(app, `x ${name} is not a key: S ship, P resume paused, D drain, + - slots, x the More menu`, cx);
  }
}

function prefixed(app, prefix, name, cx) {
  const ctl = getCtl(app);
  const done = Boolean(app.doneOpen);
  if (prefix === "x") return menuKey(app, name, cx);
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

/** The ticket keys of the TUI's board (README: Gate, Ticket), each to the ACTIONS id it runs, with the TUI's words when it does not apply. */
function ticketKey(app, name, task, cx) {
  const detail = app.details?.[task.id] ?? null;
  const act = (id) => {
    app.act(task, id, cx);
    return true;
  };
  switch (name) {
    case "T": return canCorrectRecord(task) ? act("edit_record") : say(app, "the triage record is corrected at triage's questions or at the plan gate", cx);
    case "p": return task.state === "awaiting_answers" ? act("post_questions") : say(app, "no questions are waiting on this ticket", cx);
    case "A":
      if (atMemoryReview(task)) return act("memory_skip_rules");
      return say(app, task.state === "reviewing_memory" ? "the retro is still running" : "no memory review waiting on this ticket", cx);
    case "N": {
      const kind = rejectKind(task, detail);
      if (kind === "release") return act("reject_release");
      if (kind === "plan") return act("reject");
      return say(app, "only the plan gate and the release question reject", cx);
    }
    case "u": {
      if (task.state !== "awaiting_approval") return say(app, "excusing coverage gaps answers a plan gate; this card is not at one", cx);
      if (!detail) return say(app, "still reading this card; press again in a moment", cx);
      const gaps = openGaps(task, detail);
      if (!gaps.length) return say(app, "the plan has no open coverage gaps", cx);
      app.dialog({ kind: "excuse", taskId: task.id, gaps, expect: gateKey(task) }, Math.min(560, 220 + gaps.length * 34));
      return true;
    }
    case "r": return canSendBack(task) ? act("send_back") : say(app, "only a setup, a plan or tests waiting for you can be sent back", cx);
    case "C": return task.state === "escalated" ? act("escalation_reason") : say(app, "this ticket is not escalated", cx);
    case "e": {
      const why = editRefusal(task, detail);
      if (why) return say(app, why, cx);
      if (!canEditTicket(task)) return say(app, "this ticket is closed", cx);
      return act(canEditPlan(task, detail) ? "edit_plan" : "edit_ticket");
    }
    case "f": return canWatch(task) ? act("watch") : say(app, "nothing is running on this ticket to watch", cx);
    case "J":
      if (task.jira) return act("jira_unlink");
      return jiraOn(app) ? act("jira_link") : say(app, "Jira is not configured on the machine", cx);
    case "R": return act("set_repo");
    case "o": return act("open_issue");
    case "O": return act("open_pr");
    case "M": return canMerge(task) ? act("merge_into") : say(app, "this ticket is already merged", cx);
    case "U": return canUnmerge(task) ? act("unmerge") : say(app, "this ticket was not merged into another", cx);
    default: return false;
  }
}

/** The board page's key hook. Answers true when it used the key. */
export function boardKey(app, e, cx) {
  const ctl = getCtl(app);
  const name = keyName(e);
  const live = livePrefix(ctl, app.page ?? "board");
  if (live) {
    ctl.prefix = null;
    prefixed(app, live.c, name, cx);
    return true;
  }
  if (e?.modifiers?.control || e?.modifiers?.alt || e?.modifiers?.platform) {
    if (name === "ctrl-r" || name === "ctrl-l") {
      app.reload?.(cx, true);
      return true;
    }
    return false;
  }
  const picked = app.tasks.find((t) => t.id === app.selected) ?? null;
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
    if (name === "a") {
      if (!picked) return say(app, "no ticket selected", cx);
      const why = heldReason(picked, app.details?.[picked.id]);
      if (why) return say(app, `held: ${why}`, cx);
      app.primary(cx);
      return true;
    }
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
    case "x":
      ctl.prefix = { c: name, at: Date.now(), page: app.page ?? "board" };
      // Redraw when it lapses, so the hint goes with it.
      cx.timer?.after?.(PREFIX_MS + 60, (c2) => c2.notify());
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
    case "enter": {
      // Enter opens the ticket (the inspector); `a` is the one that acts.
      const id = app.selected ?? ids[0] ?? null;
      if (!id) return say(app, "no ticket to open", cx);
      app.select(id, cx);
      return true;
    }
    default:
      break;
  }
  if (VIEW_KEYS[name]) {
    app.go(VIEW_KEYS[name], cx);
    return true;
  }
  if (/^[A-Za-z]$/.test(name) && "TpANurCefJRoOMU".includes(name)) {
    if (!picked) return say(app, "no ticket selected", cx);
    if (ticketKey(app, name, picked, cx)) return true;
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
