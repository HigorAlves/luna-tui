// Pure rules for the inspector's detail tabs: what a ticket's approvals, runs, clocks and
// artifacts say, read the way the TUI reads them (board/src/model.rs, detail.rs). No drawing here,
// so every function is tested as a plain function (test/detail.test.js).
import { duration } from "./model.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const strings = (v) => arr(v).filter((x) => typeof x === "string");

/** The newest approval of a kind (`awaiting_approval` is the plan gate), or null. */
export function latestApproval(detail, kind) {
  return [...arr(detail?.approvals)].reverse().find((a) => a?.kind === kind) ?? null;
}

/** The plan gate's criteria as `{id, text}`: the plan's own ids, else the listed ones numbered C1.. */
export function planCriteria(approval, task) {
  const req = approval?.requested ?? {};
  const planned = arr(req.plan?.acceptance_criteria)
    .filter((c) => c && typeof c.text === "string")
    .map((c) => ({ id: str(c.id), text: c.text }));
  if (planned.length) return planned;
  const listed = strings(req.criteria);
  const own = listed.length ? listed : strings(task?.criteria);
  return own.map((text, i) => ({ id: `C${i + 1}`, text }));
}

/** The newest verifying run's per-case verdicts: `[{title, ok}]`. */
export function caseResults(detail) {
  const run = [...arr(detail?.stageRuns)].reverse().find((r) => r?.stage === "verifying" && arr(r.cases).length);
  return arr(run?.cases);
}

/** The gate that carries test_design's cases: a legacy test check, else the plan gate that holds them. */
export function casesApproval(detail) {
  return latestApproval(detail, "awaiting_test_check") ?? (arr(latestApproval(detail, "awaiting_approval")?.requested?.cases).length ? latestApproval(detail, "awaiting_approval") : null);
}

/** Every test case with verifying's verdict (`true`, `false`, or null: not judged). */
export function testCases(detail) {
  const results = caseResults(detail);
  return arr(casesApproval(detail)?.requested?.cases)
    .filter((c) => c && typeof c.title === "string")
    .map((c) => ({
      id: str(c.id),
      title: c.title,
      type: c.type ?? null,
      layer: c.layer ?? null,
      criterion: c.criterion ?? c.criterion_ref ?? null,
      approach: c.approach ?? null,
      result: results.find((r) => r.title === c.title)?.ok ?? null,
    }));
}

/**
 * The Tests tab's groups: `[{id, text, cases}]`, one per criterion (the plan's, then any case's own
 * criterion the plan does not list), a case under the criterion whose id or text it names.
 */
export function testGroups(task, detail) {
  const approval = latestApproval(detail, "awaiting_approval");
  const criteria = planCriteria(approval, task);
  const cases = testCases(detail);
  const groups = criteria.map((c) => ({ id: c.id, text: c.text, cases: [] }));
  const loose = [];
  for (const c of cases) {
    const g = groups.find((x) => c.criterion != null && (x.text === c.criterion || x.id === c.criterion));
    if (g) g.cases.push(c);
    else loose.push(c);
  }
  if (loose.length) groups.push({ id: "", text: "No criterion named", cases: loose });
  return groups;
}

/** The Overview's criterion rows: `{id, text, planned, cases, verify: {ok, total} | null}`. */
export function criteriaRows(task, detail) {
  const approval = latestApproval(detail, "awaiting_approval");
  const plan = approval ? planCriteria(approval, task) : null;
  const rows = (plan ?? []).map((c) => ({ id: c.id, text: c.text, planned: true }));
  for (const own of strings(task?.criteria)) if (!rows.some((r) => r.text === own)) rows.push({ id: "", text: own, planned: plan ? false : null });
  const cases = testCases(detail);
  return rows.map((r) => {
    const mine = cases.filter((c) => c.criterion != null && (c.criterion === r.text || (r.id && c.criterion === r.id)));
    const judged = mine.filter((c) => c.result != null);
    return { ...r, cases: mine.length, verify: judged.length ? { ok: judged.filter((c) => c.result).length, total: judged.length } : null };
  });
}

/** `12m of 1h`, `overdue 40m`: how a clock reads against its target. */
export function clockLabel(clock, now = Date.now()) {
  const due = Date.parse(clock?.dueAt ?? "");
  if (!Number.isFinite(due)) return null;
  const target = (clock.targetSecs ?? 0) * 1000;
  if (clock.overdue || now > due) return `overdue ${duration(Math.max(0, now - due)) ?? "0s"}`;
  const spent = Math.max(0, now - (due - target));
  return target ? `${duration(spent) ?? "0s"} of ${duration(target)}` : `due in ${duration(due - now)}`;
}

/** `today`, `tomorrow`, a weekday inside a week, else `MM-DD`. */
export function dueDay(iso, now = Date.now()) {
  const due = Date.parse(iso ?? "");
  if (!Number.isFinite(due)) return str(iso).slice(0, 10);
  const day = Math.floor(due / 86400000) - Math.floor(now / 86400000);
  if (day === 0) return "today";
  if (day === 1) return "tomorrow";
  if (day >= 2 && day <= 6) return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][(Math.floor(due / 86400000) + 4) % 7];
  return str(iso).slice(5, 10);
}

/** The SLA clocks as `[{text, tone}]`; tone is `error` (overdue), `blocked` (past 80%) or null. */
export function slaParts(sla, now = Date.now()) {
  if (!sla) return [];
  const tone = (c) => (c.overdue ? "error" : c.warn ? "blocked" : null);
  const parts = [];
  const add = (label, c, text) => {
    const l = text ?? clockLabel(c, now);
    if (l) parts.push({ text: `${label} ${l}`.trim(), tone: tone(c) });
  };
  if (sla.gate) add("gate", sla.gate);
  if (sla.stage) add(`stage ${sla.stage.stage ?? "running"}`, sla.stage);
  if (sla.cycle) add("cycle", sla.cycle);
  if (sla.jiraDue) add("jira due", sla.jiraDue, dueDay(sla.jiraDue.dueAt, now));
  return parts;
}

/** `PLAT-123 · In Progress · due Fri · High`. */
export function jiraSummary(jira, now = Date.now()) {
  if (!jira?.key) return null;
  return [jira.key, jira.status, jira.dueAt ? `due ${dueDay(jira.dueAt, now)}` : null, jira.priority].filter(Boolean).join(" · ");
}

/** What happened to the plan, oldest first: edits, send-backs with their reason, the approval. */
export function planHistory(detail) {
  const out = [];
  for (const a of arr(detail?.approvals).filter((x) => x?.kind === "awaiting_approval")) {
    for (const rev of arr(a.requested?.revisions)) {
      const fields = Object.keys(rev?.after ?? {}).sort();
      out.push({ at: rev?.at ?? null, text: `${rev?.by ? `${rev.by} ` : ""}edited ${fields.join(", ") || "the plan"}`, tone: null });
    }
    if (a.decision) {
      const why = a.reason ? ` · ${a.reason}` : "";
      const who = a.decision === "approved" ? approver(a) : null;
      const text = { sent_back: `sent back${why}`, rejected: `rejected${why}`, approved: `approved${who ? ` by ${who}` : ""}` }[a.decision] ?? str(a.decision).replaceAll("_", " ");
      out.push({ at: a.decidedAt ?? null, text, tone: a.decision === "approved" ? "done" : a.decision === "rejected" ? "error" : "blocked" });
    }
  }
  return out;
}

/** Who approved a gate: `response.approver` (the machine records it there), else the gate's rule. */
export function approver(a) {
  const r = a?.response ?? {};
  return r.approver ?? r.by ?? a?.approver ?? null;
}

/** The run's error, as the activity log recorded it when the run finished. */
export function runError(detail, run) {
  const e = [...arr(detail?.events)].reverse().find((x) => x?.kind === "stage.finished" && x.payload?.stage === run?.stage && x.payload?.attempt === run?.attempt);
  const p = e?.payload ?? {};
  return typeof p.error === "string" ? p.error : typeof p.detail?.error === "string" ? p.detail.error : null;
}

/** `3m`, or how long it has run: from a run's start to its end (else now). */
export function runTook(run, now = Date.now()) {
  const start = Date.parse(run?.startedAt ?? "");
  if (!Number.isFinite(start)) return null;
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  return duration(Math.max(0, end - start));
}

/** The run to show: the one picked and still there, else the latest. */
export function pickedRun(detail, pickedId) {
  const runs = arr(detail?.stageRuns);
  return runs.find((r) => r?.id && r.id === pickedId) ?? runs.at(-1) ?? null;
}

/** The directory of a path (no trailing slash), or null. */
export const dirOf = (p) => {
  const s = str(p);
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : null;
};

/** Artifacts by run, latest run first: `[{run, files}]`; files whose run is unknown go last, under run null. */
export function artifactGroups(detail) {
  const runs = arr(detail?.stageRuns);
  const files = arr(detail?.artifacts).filter((a) => a && a.path);
  const groups = [];
  for (const run of [...runs].reverse()) {
    const mine = files.filter((a) => a.stageRunId && a.stageRunId === run.id);
    if (mine.length) groups.push({ run, files: mine });
  }
  const orphan = files.filter((a) => !a.stageRunId || !runs.some((r) => r.id === a.stageRunId));
  if (orphan.length) groups.push({ run: null, files: orphan });
  return groups;
}

/** The PR for a task: the inbox's (then all repos') row whose head is the task's branch. */
export function prFor(task, prs) {
  const branch = task?.branch;
  if (!branch) return null;
  for (const snap of [prs?.inbox, prs?.all]) {
    const hit = arr(snap?.prs).find((p) => p?.headRef === branch);
    if (hit) return hit;
  }
  return null;
}

/** The url the ship gate or the watch reported, when no PR row matches. */
export function prUrlOf(detail) {
  return detail?.ship?.pr?.url ?? latestApproval(detail, "awaiting_ship")?.requested?.prUrl ?? null;
}

/** The stages a ticket runs: model-calling packs that run in a task, in registry order. */
export function taskPacks(packs) {
  return arr(packs).filter((p) => p && arr(p.states).length > 0 && p.kind !== "script" && arr(p.engines?.allowed).length > 0);
}

/** `[{pack, engine, isDefault, ran, off}]`: what each stage is set to and ran on. */
export function engineRows(task, detail, packs, engines) {
  return taskPacks(packs).map((p) => {
    const set = task?.stages?.[p.id] ?? null;
    const run = [...arr(detail?.stageRuns)].reverse().find((r) => arr(p.states).includes(r?.stage));
    const info = set ? arr(engines).find((e) => e.id === set) : null;
    return {
      pack: p.id,
      engine: set ?? `default: ${p.engines?.default ?? "?"}`,
      isDefault: !set,
      ran: run ? run.engine ?? "–" : null,
      off: info && info.available === false ? "no credential here" : null,
    };
  });
}

/** The picker's choices for one pack: the default first, then each allowed engine (off ones keep their reason). */
export function engineChoices(pack, engines) {
  const rows = [{ engine: null, label: `default (${pack?.engines?.default ?? "?"})`, off: null }];
  for (const id of arr(pack?.engines?.allowed)) {
    const e = arr(engines).find((x) => x.id === id);
    rows.push({ engine: id, label: e?.modelId ? `${id}  ·  ${e.modelId}` : id, off: !e ? "unknown to this machine" : e.available === false ? e.reason ?? "no credential on this machine" : null });
  }
  return rows;
}

/** A unified patch as rows: `{kind: "meta"|"hunk"|"add"|"del"|"ctx", old, new, text}` (line numbers from the hunk headers). */
export function parsePatch(patch) {
  const rows = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const line of str(patch).split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      inHunk = true;
      rows.push({ kind: "hunk", old: null, new: null, text: line });
    } else if (!inHunk) {
      if (line) rows.push({ kind: "meta", old: null, new: null, text: line });
    } else if (line.startsWith("+")) rows.push({ kind: "add", old: null, new: n++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", old: o++, new: null, text: line.slice(1) });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", old: null, new: null, text: line });
    else if (line === "" && rows.length && rows.at(-1).kind !== "ctx") continue;
    else rows.push({ kind: "ctx", old: o++, new: n++, text: line.slice(1) });
  }
  while (rows.length && rows.at(-1).kind === "ctx" && rows.at(-1).text === "") rows.pop();
  return rows;
}

/** The first `max` bytes' worth of a path's folder for Open folder: the worktree file path. */
export const worktreeFile = (task, file) => (task?.worktreePath && file ? `${String(task.worktreePath).replace(/\/+$/, "")}/${file}` : null);
