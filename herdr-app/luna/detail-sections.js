// Pure rules for the inspector's state sections (Now, Stopped, Result), the Build and Verify
// reports, the plan gate's machine flags and the card's origin and stack, read the way the TUI
// reads them (board/src/pages.rs, detail.rs). No drawing here: test/detail-fixes.test.js.
import { duration } from "./model.js";
import { runError } from "./detail-model.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const strings = (v) => arr(v).filter((x) => typeof x === "string");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Ids in a list of strings or `{id}` rows. */
const ids = (v) => arr(v).map((x) => (typeof x === "string" ? x : x?.id)).filter((x) => typeof x === "string" && x);
/** A stranger's text on one line: control characters become spaces. */
// eslint-disable-next-line no-control-regex
const plain = (v) => str(v).replace(/[\u0000-\u001f]/g, " ").trim();

const STOPPED = ["escalated", "failed", "aborted", "paused_rate_limit"];
const RESULT = ["awaiting_ship", "shipping", "reviewing_memory", "closed", "archived", "done"];

export const isStopped = (task) => STOPPED.includes(task?.state);
export const isResult = (task) => RESULT.includes(task?.state);
const isQuestion = (task) => ["awaiting_setup", "awaiting_answers"].includes(task?.state) || (task?.state === "draft" && task?.waitingOnYou === true);
/** A card a stage works on or waits to work on, that no other section claims. */
export const isRunning = (task) =>
  Boolean(task) && Boolean(task.running || task.queued || task.state === "ci_watch") && task.state !== "awaiting_approval" && !isStopped(task) && !isResult(task) && !isQuestion(task);

/** The tab a ticket opens on, as the TUI opens it: a gate on its question, a stopped card on why, a running one on what it does, a shipped one on its result. */
export function defaultTab(task) {
  if (task?.state === "awaiting_approval") return "plan";
  if (task?.state === "awaiting_test_check") return "tests";
  if (isStopped(task)) return "stopped";
  if (isQuestion(task)) return "details";
  if (isResult(task)) return "result";
  if (isRunning(task)) return "now";
  return "details";
}

const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const trim1 = (n) => String(Math.round(n * 10) / 10);

/** Build's live progress: `{scenarios, green, budget: [{label, used, limit, pct, text}], checkpoint}`, or null without `buildProgress`. */
export function buildProgressView(detail) {
  const p = detail?.buildProgress;
  if (!p || typeof p !== "object") return null;
  const scenarios = arr(p.scenarios).map((s) => ({ id: str(s?.id), green: s?.state === "green", state: str(s?.state) }));
  const b = p.budget ?? {};
  const l = b.limits ?? {};
  const row = (label, used, limit, text) => ({ label, used, limit, pct: used != null && limit ? Math.min(1, used / limit) : null, text });
  const budget = [];
  if (num(b.iterations) != null) budget.push(row("iterations", b.iterations, num(l.max_iterations), `${b.iterations}${l.max_iterations != null ? ` of ${l.max_iterations}` : ""}`));
  budget.push(num(b.tokens) != null ? row("tokens", b.tokens, num(l.max_tokens), `${thousands(b.tokens)}${l.max_tokens != null ? ` of ${thousands(l.max_tokens)}` : ""}`) : row("tokens", null, null, "not counted"));
  if (num(b.minutes) != null) budget.push(row("minutes", b.minutes, num(l.max_minutes), `${trim1(b.minutes)}${l.max_minutes != null ? ` of ${trim1(l.max_minutes)}` : ""}`));
  const cp = p.lastCheckpoint;
  const checkpoint = cp?.sha ? `${str(cp.sha).slice(0, 7)} after ${cp.follows === "red" || cp.follows === "green" ? `a ${cp.follows} scenario` : plain(cp.follows) || "a step"}` : null;
  return { scenarios, green: scenarios.filter((s) => s.green).length, budget, checkpoint };
}

/** The run now going, as `Building #2 · on claude:sonnet`. `words` turns a state into words. */
export function runningLine(task, detail, words) {
  const run = [...arr(detail?.stageRuns)].reverse().find((r) => r?.status === "running");
  return [words(task.state) + (run?.attempt ? ` #${run.attempt}` : ""), run?.engine ? `on ${run.engine}` : null, task.queued && !task.running ? "waiting for a slot" : null].filter(Boolean).join(" · ");
}

/** The newest open (undecided) approval of a kind, or null. */
export function openApproval(detail, kind) {
  return [...arr(detail?.approvals)].reverse().find((a) => a?.kind === kind && !a.decision) ?? null;
}

/** Why a card stopped, from the escalation gate, the task's reason and the failing run. `words` turns an escalation reason into words. */
export function stoppedView(task, detail, words) {
  const gate = openApproval(detail, "escalated");
  const dec = gate?.requested?.escalationDecision ?? null;
  const how = [];
  if (num(dec?.confidence) != null) how.push(`${Math.round(dec.confidence * 100)}% sure`);
  if (dec?.source) how.push({ fact: "settled by a fact", decision: "judged by the escalation check", agent: "from the agent's own word" }[dec.source] ?? `by ${plain(dec.source)}`);
  const corrected = [...arr(detail?.events)].reverse().find((e) => e?.kind === "escalation.corrected")?.payload?.to ?? null;
  const failed = [...arr(detail?.stageRuns)].reverse().find((r) => r?.status === "failed");
  const tail = str(gate?.requested?.outputTail) || (failed ? runError(detail, failed) ?? "" : "");
  return {
    label: dec?.reason ? words(dec.reason) : null,
    sentence: plain(task?.reason) || null,
    how,
    agentSaid: dec?.agentReason ? words(dec.agentReason) : null,
    corrected: corrected ? words(corrected) : null,
    summary: str(gate?.requested?.summary).trim() || null,
    tail: tail.trim() || null,
    sandbox: gate?.requested?.keptSandbox?.path ? { path: str(gate.requested.keptSandbox.path), until: gate.requested.keptSandbox.until ?? null } : null,
  };
}

/** The evidence pack to read the diff summary from: the task's, then a gate's `pack`, then its `evidence`. */
export function evidencePack(task, detail) {
  if (task?.evidence && typeof task.evidence === "object") return task.evidence;
  for (const a of [...arr(detail?.approvals)].reverse()) {
    const r = a?.requested ?? {};
    if (r.pack && typeof r.pack === "object") return r.pack;
    if (r.evidence && typeof r.evidence === "object") return r.evidence;
  }
  return null;
}

const LEVELS = [["blocker", "blocker"], ["should_fix", "should fix"], ["nit", "nit"]];
/** A finding's level by the machine's own table; an unknown word reads as should fix. */
export function findingLevel(f) {
  const w = str(f?.severity).trim().toLowerCase();
  if (["bug", "security", "blocker", "critical", "high", "major", "error"].includes(w)) return "blocker";
  if (["nit", "low", "minor", "style", "info", "nitpick", "suggestion"].includes(w)) return "nit";
  return "should_fix";
}
/** A finding's resolution word (`fixed`, `kept`, `dismissed`), or null while it is open. */
export const resolutionOf = (f) => (f?.resolution == null ? null : typeof f.resolution === "string" ? f.resolution : f.resolution.status ?? "resolved");

/** The Result section: the release question, the summary, open findings by level, the evidence count. */
export function resultView(task, detail) {
  const ship = [...arr(detail?.approvals)].reverse().find((a) => a?.kind === "awaiting_ship" && !a.decision) ?? null;
  const r = ship?.requested ?? {};
  const pack = evidencePack(task, detail);
  const sum = pack?.diffSummary && typeof pack.diffSummary === "object" ? pack.diffSummary : null;
  const open = arr(detail?.reports?.verify?.findings).filter((f) => f && typeof f === "object" && resolutionOf(f) == null);
  return {
    release: ship && !r.pr_review_post ? { question: plain(r.question) || "safe to release now?", high: r.risk === "high", checklist: arr(r.checklist).map((c) => ({ ok: c?.ok === true, text: plain(c?.detail) || plain(c?.id) })) } : null,
    summary: sum ? { what: str(sum.what).trim() || null, why: str(sum.why).trim() || null } : null,
    findings: LEVELS.map(([id, name]) => ({ id, name, items: open.filter((f) => findingLevel(f) === id) })).filter((g) => g.items.length),
    artifacts: arr(detail?.artifacts).length,
  };
}

/** The Build Report (`reports.build`) as rows, or null. */
export function buildReportView(detail) {
  const b = detail?.reports?.build;
  if (!b || typeof b !== "object") return null;
  const l = b.limits ?? {};
  const iters = arr(b.iterations);
  const used = (v, limit, fmt = String) => (num(v) != null ? `${fmt(v)}${num(limit) != null ? ` of ${fmt(limit)}` : ""}` : null);
  const obj = (v) => (v && typeof v === "object" ? v : null);
  const sweep = obj(b.sweep);
  const step = obj(b.testsStep);
  const scope = obj(b.scopeCheck);
  const ds = obj(b.diffSummary);
  const sm = obj(b.summary);
  return {
    branch: b.branch ? str(b.branch) : null,
    base: b.base ? str(b.base) : null,
    head: b.headSha ? str(b.headSha).slice(0, 7) : null,
    iterations: used(iters.length || null, l.max_iterations),
    scenarios: iters.length ? `${iters.filter((i) => i?.kind === "green").length} green of ${new Set(iters.map((i) => i?.ref)).size}` : null,
    tokens: used(b.tokens, l.max_tokens, thousands),
    minutes: used(b.minutes, l.max_minutes, trim1),
    runs: arr(b.runs).map((r) => ({ attempt: r?.attempt ?? null, outcome: str(r?.outcome), engine: str(r?.engine), took: num(r?.durationMs) != null ? duration(r.durationMs) : null })),
    summary: sm ? { what: str(sm.what).trim() || null, why: str(sm.why).trim() || null, files: arr(sm.files).map((f) => ({ path: str(f?.path ?? f), reason: str(f?.reason) })) } : null,
    diff: ds ? { added: num(ds.added), removed: num(ds.removed), files: arr(ds.files).map(str) } : null,
    tests: arr(b.tests).length,
    testsStep: step ? { status: str(step.status), note: str(step.why ?? step.note).replaceAll("_", " ") } : null,
    sweep: sweep ? { status: str(sweep.status), ran: arr(sweep.ran).map((x) => str(x?.name ?? x)), note: str(sweep.note) } : null,
    scope: scope ? { clean: scope.clean === true, issues: arr(scope.issues).map((i) => ({ severity: str(i?.severity), text: str(i?.text ?? i?.title ?? i?.message ?? i?.kind ?? i) })) } : null,
  };
}

/** The Verify Report (`reports.verify`) as rows, or null. */
export function verifyReportView(detail) {
  const v = detail?.reports?.verify;
  if (!v || typeof v !== "object") return null;
  const e2e = v.e2e && typeof v.e2e === "object" ? v.e2e : null;
  const rows = arr(e2e?.rows).length ? arr(e2e.rows) : arr(e2e?.scenarios);
  const t = v.tests && typeof v.tests === "object" ? v.tests : null;
  const rounds = v.rounds && typeof v.rounds === "object" ? v.rounds : null;
  return {
    pr: num(v.prNumber),
    head: v.headSha ? str(v.headSha).slice(0, 7) : null,
    tests: t ? `${t.passed ?? 0} of ${t.total ?? 0} pass` : null,
    testsOk: t ? t.passed === t.total : null,
    coverageDelta: num(v.coverageDelta),
    review: v.review?.engine ? `${str(v.review.engine)}${v.review.family ? ` (${str(v.review.family)} family)` : ""}` : null,
    mutation: v.mutation == null ? null : typeof v.mutation === "object" ? (v.mutation.score != null ? `score ${v.mutation.score}` : JSON.stringify(v.mutation)) : str(v.mutation),
    ciClass: v.ciClass ? str(v.ciClass).replaceAll("_", " ") : null,
    rounds: rounds ? `verify ${rounds.verify ?? 0} · e2e ${rounds.e2e ?? 0} · ci ${rounds.ci ?? 0}` : null,
    env: v.envReproduction ? str(v.envReproduction).replaceAll("_", " ") : null,
    overrides: arr(v.overrides).map((o) => str(typeof o === "string" ? o : o?.text ?? o?.reason ?? JSON.stringify(o))),
    e2e: e2e ? { verdict: e2e.verdict ? str(e2e.verdict) : null, rows: rows.map((r) => ({ id: str(r?.scenario ?? r?.id), title: str(r?.title ?? r?.text), result: str(r?.result), seen: str(r?.seen), artifacts: arr(r?.artifacts).map(str) })) } : null,
    findings: arr(v.findings).filter((f) => f && typeof f === "object").map((f) => ({ level: findingLevel(f), title: str(f.title), place: f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : null, criterion: f.criterion_ref ? str(f.criterion_ref) : null, resolution: resolutionOf(f) })),
  };
}

// ---- the plan gate's machine flags ----

const normal = (s) => str(s).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const namesId = (text, id) => str(text).split(/[^A-Za-z0-9_-]+/).includes(id);

/** The plan stage's verdicts: `{coverage, plan, risk}`, each `proceed`, `flag`, `ask` or `skipped`; absent ones left out. */
export function planChecks(approval) {
  const v = approval?.requested?.verdicts ?? {};
  const out = {};
  for (const n of ["coverage", "plan", "risk"]) if (typeof v[n] === "string") out[n] = v[n];
  return out;
}

/** Why the machine raised the plan's risk after the plan was written, or null. */
export const riskRaisedLine = (approval) => (typeof approval?.requested?.riskRaised === "string" && approval.requested.riskRaised.trim() ? approval.requested.riskRaised.trim() : null);

/** What a person set the risk to at the gate, and whether it applied, or null. */
export function riskOverrideLine(approval) {
  const o = approval?.requested?.overrides?.risk;
  if (!o?.level) return null;
  const reason = o.reason ?? "no reason";
  if (o.applied === true) return `you set ${o.level}: applied (${reason})`;
  const machine = approval.requested.risk?.machine ?? approval.requested.risk?.level ?? "its";
  return `you set ${o.level}, below the machine's ${machine}: kept as ground truth (${reason}); approvers and Ship read ${machine}`;
}

/** The criteria no scenario covers and nobody excused: what the gate asks you to excuse or send back. */
export function openGaps(approval) {
  const r = approval?.requested ?? {};
  const untestable = ids(r.coverageReport?.untestable);
  return ids(r.coverageReport?.gaps ?? r.gaps).filter((g) => !untestable.includes(g));
}

/** The sentences the machine wrote about a plan, each once, in the TUI's order. `criteria` is `[{id, text}]`. */
export function machineFlags(approval, criteria = []) {
  const r = approval?.requested ?? {};
  const textOf = (id) => arr(criteria).find((c) => c.id === id)?.text ?? null;
  const report = r.coverageReport ?? {};
  const untestable = ids(report.untestable);
  const all = [];
  const add = (text, id = null, check = null) => all.push({ text, id, check });
  const issues = strings(r.planIssues);
  issues.forEach((i) => add(`plan: ${i}`));
  for (const id of openGaps(approval)) add(textOf(id) ? `coverage: ${id} has no scenario: ${textOf(id)}` : `coverage: ${id} has no scenario`, id);
  strings(report.open).forEach((n) => add(n.startsWith("coverage") ? n : `coverage: ${n}`));
  for (const id of untestable) add(textOf(id) ? `coverage: ${id} excused as untestable: ${textOf(id)}` : `coverage: ${id} excused as untestable`, id);
  const raised = riskRaisedLine(approval);
  if (raised) add(`risk raised: ${raised}`);
  const over = riskOverrideLine(approval);
  if (over) add(over);
  const stale = r.map?.stale === true;
  if (stale) add(`the code map's graph is ${num(r.map?.behind) ?? "many"} commits behind the default branch`);
  const checks = Object.entries(planChecks(approval)).filter(([, v]) => v === "flag" || v === "ask").map(([n, v]) => [n, v === "ask"]);
  for (const name of strings(r.flagged).filter((f) => !f.startsWith("triage.")).map(plain)) {
    if (["coverage", "plan", "risk"].includes(name)) {
      if (!checks.some(([n]) => n === name)) checks.push([name, false]);
    } else if (name === "map stale" && stale) continue;
    else if (name === "plan outside map" && issues.some((i) => i.includes("code map"))) continue;
    else add(name);
  }
  for (const [name, unsure] of checks) add(unsure ? `${name} check is unsure` : `${name} check flagged`, null, name);
  for (const f of strings(r.flagged).filter((x) => x.startsWith("triage."))) add(`triage ${plain(f.slice(7)).replaceAll("_", " ")} flagged`);
  const normals = all.map((f) => normal(f.text));
  const rank = (f, i) => (f.id != null ? 0 : 1) * 1e6 + i;
  return all
    .filter((f, i) => {
      const key = normals[i];
      const twice = all.some((o, j) => j !== i && normals[j] === key && rank(o, j) < rank(f, i));
      const byId = f.id != null && all.some((o, j) => j !== i && o.id == null && namesId(o.text, f.id));
      const byCheck = f.check != null && normals.some((n) => n.startsWith(`${f.check}:`));
      const byHead = normals.some((n, j) => j !== i && n.length > key.length && n.startsWith(key) && n[key.length] === ":");
      return !(twice || byId || byCheck || byHead);
    })
    .map((f) => f.text);
}

/** Coverage in short: `{bar, score, thin, open, untestable, total}`, or null when the machine wrote no report. */
export function coverageView(approval) {
  const c = approval?.requested?.coverageReport;
  if (!c || typeof c !== "object") return null;
  return { bar: num(c.bar), score: num(c.score), thin: arr(c.thin).length, open: openGaps(approval), untestable: ids(c.untestable), total: arr(c.per).length || null };
}

const WORDS = { 2: "two" }; // as the TUI says it: "two", then digits
/** The approval rule at a plan gate: how many names, the names so far, the rule's text and `first of two approvers` (null for one name). */
export function approvalRuleView(approval) {
  const r = approval?.requested ?? {};
  const needed = num(r.approvalRule?.needed) ?? (r.risk?.level === "high" ? 2 : 1);
  const open = strings(r.approvers);
  const resp = approval?.response ?? null;
  const names = open.length ? open : Array.isArray(resp?.approvers) ? strings(resp.approvers) : typeof resp?.approver === "string" ? [resp.approver] : [];
  const word = WORDS[needed] ?? String(needed);
  const position = needed < 2 ? null : names.length === 0 ? `first of ${word} approvers` : names.length + 1 === needed ? `last of ${word} approvers` : `next of ${word} approvers`;
  return {
    needed,
    names,
    text: typeof r.approvalRule?.text === "string" && r.approvalRule.text.trim() ? r.approvalRule.text.trim() : null,
    position,
    line: names.length ? (needed > 1 ? `${names.length} of ${needed} (${names.join(", ")})` : `approved by ${names.join(", ")}`) : null,
  };
}

// ---- the card's origin and its place in a split or a stack ----

const short = (id) => plain(str(id).slice(0, 8));
const cap = (s, n) => (str(s).length > n ? `${str(s).slice(0, n - 1)}…` : str(s));

/** Where the card came from: `[[label, value]]` for sources, reporter, followers, owners, attachments, merged, merged into, related. */
export function originRows(task) {
  const out = [];
  const LISTED = 5;
  const sources = arr(task?.sources).filter((x) => x && typeof x === "object");
  for (const s of sources.slice(0, LISTED)) {
    const kind = s.kind ?? s.type ?? null;
    out.push(["Source", kind === "github" || kind === "github_pr" ? `GitHub ${cap(plain(s.repo), 60)}#${s.number ?? 0}` : kind === "jira" ? `Jira ${cap(plain(s.key), 60)}` : kind ? cap(plain(kind), 60) : "unknown source"]);
  }
  if (sources.length > LISTED) out.push(["Source", `… and ${sources.length - LISTED} more`]);
  const rep = task?.reporter;
  if (rep && typeof rep === "object") out.push(["Reporter", `${cap(plain(rep.name ?? rep.id), 60)}${rep.channel ? ` (${cap(plain(rep.channel), 30)})` : ""}`]);
  const list = (v) => arr(v).slice(0, LISTED).map((x) => cap(plain(typeof x === "string" ? x : x?.name ?? x?.id), 40)).join(", ");
  if (arr(task?.followers).length) out.push(["Followers", list(task.followers)]);
  if (arr(task?.owners).length) out.push(["Owners", list(task.owners)]);
  for (const a of arr(task?.attachments).slice(0, LISTED)) out.push(["Attached", cap(plain(a?.name), 60)]);
  if (arr(task?.merged).length) out.push(["Merged", arr(task.merged).slice(0, LISTED).map((m) => short(m?.id ?? m)).join(", ")]);
  if (task?.mergedInto) out.push(["Merged into", short(task.mergedInto)]);
  if (arr(task?.related).length) out.push(["Related", arr(task.related).slice(0, LISTED).map(short).join(", ")]);
  return out;
}

/** The `ship.merged` event (who merged it, at which sha), or null while the PR is not merged. */
export function mergedEvent(detail) {
  const e = [...arr(detail?.events)].reverse().find((x) => x?.kind === "ship.merged");
  return e ? { by: e.payload?.by ? str(e.payload.by) : null, sha: e.payload?.mergedSha ? str(e.payload.mergedSha).slice(0, 7) : null, at: e.at ?? null } : null;
}

/** The last `card.held` text when no `card.released` came after it, or null. */
export function heldText(detail) {
  const last = [...arr(detail?.events)].reverse().find((e) => e?.kind === "card.held" || e?.kind === "card.released");
  if (last?.kind !== "card.held") return null;
  return str(last.payload?.text).trim() || null;
}

/** A card's place in a split or a stack, one string per fact (none for a card with neither). `tasks` is the board's list. */
export function stackRows(task, detail, tasks) {
  const find = (id) => arr(tasks).find((t) => t?.id === id);
  const named = (id) => (find(id) ? ` ${plain(find(id).title)}` : "");
  const out = [];
  const part = task?.splitPart;
  if (task?.splitFrom && part) out.push(`Part ${part.n} of ${part.of} of ${short(task.splitFrom)}${named(task.splitFrom)}`);
  for (const dep of arr(task?.dependsOn)) out.push(`Depends on ${short(dep)}${named(dep)}`);
  if (task?.base?.card) out.push(`Stacked on ${short(task.base.card)} (${plain(task.base.branch)})`);
  if (task?.riskFloor && task?.splitFrom) out.push(`Risk floor ${plain(task.riskFloor)} (its origin's: a part is never lower)`);
  if (task?.startWhenReady && task?.state === "draft") out.push(heldText(detail)?.replace(/\n/g, " ") ?? "Waiting: held until its dependencies have an open PR or have merged");
  for (const id of arr(task?.splitInto)) {
    const kid = find(id);
    out.push(kid ? `Split into ${short(id)} ${kid.splitPart ? `part ${kid.splitPart.n}/${kid.splitPart.of} ` : ""}${plain(kid.title)}` : `Split into ${short(id)}`);
  }
  return out;
}
