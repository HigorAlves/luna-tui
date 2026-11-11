//! The task view's first pages, one per job: Review at the plan gate, Now while a stage runs, Why it stopped,
//! Result, and the page of a gate that asks a question. Each is a main text and its reference groups.

use ratatui::text::{Line, Span};
use serde_json::Value;

use crate::{
    detail::{
        assumptions_group, card_group, checks_group, criteria_table, gate_blocks, gate_main_facts, gate_question, gate_ref_group, intake_gate_lines, map_group, muted, origin_lines, plain, pr_for, pr_url,
        record_group, run_error, ship_risk_is_high, slice_progress,
    },
    model::{Approval, PullRequest, Task, TaskDetail, criteria_summary, questions_of, ESCALATION_REASONS},
    reference::{Page, RefGroup},
    text::{self, ellipsis, truncate_middle},
    theme,
};

/// A heading line of a page: bold in the terminal's own colour.
fn title(text: &str) -> Line<'static> {
    Line::from(Span::styled(text.to_string(), theme::heading()))
}

/// `prefix` then `text` wrapped under itself: the first line starts with the prefix spans, the rest with as many spaces.
pub(crate) fn hanging(prefix: Vec<Span<'static>>, text: &str, width: usize) -> Vec<Line<'static>> {
    let used: usize = prefix.iter().map(|s| text::cells(&s.content)).sum();
    let parts = text::wrap(&plain(text), width.saturating_sub(used).max(10), 0);
    let mut out = Vec::new();
    for (i, part) in parts.into_iter().enumerate() {
        let lead = if i == 0 { prefix.clone() } else { vec![Span::raw(" ".repeat(used))] };
        let mut spans = lead;
        spans.push(Span::raw(part.trim_start().to_string()));
        out.push(Line::from(spans));
    }
    out
}

/// A flag line: `⚑ ` and the words, in the flag style, wrapped under the glyph.
fn flag_line(text: &str, width: usize) -> Vec<Line<'static>> {
    text::wrap(&plain(text), width.saturating_sub(2).max(10), 0)
        .into_iter()
        .enumerate()
        .map(|(i, part)| Line::from(Span::styled(format!("{}{}", if i == 0 { "⚑ " } else { "  " }, part.trim_start()), theme::flag())))
        .collect()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(plain)).collect()).unwrap_or_default()
}

/// What the plan gate flags, one line each with the machine's reason where it gave one: the plan check's issues and the planner's
/// own flags, a coverage check's open notes and criteria excused as untestable, an unsure risk, a stale code map, a raised or
/// overridden risk, a triage field to correct. A flagged check with no reason is named: `⚑ plan check flagged`.
fn flags(approval: &Approval, width: usize) -> Vec<Line<'static>> {
    let r = &approval.requested;
    let mut out = Vec::new();
    let mut explained: Vec<&str> = Vec::new();
    let issues: Vec<String> = strings(&r["planIssues"]).into_iter().chain(strings(&r["plan"]["flags"])).collect();
    if !issues.is_empty() {
        explained.push("plan");
        for issue in &issues {
            out.extend(flag_line(&format!("plan: {issue}"), width));
        }
    }
    let coverage: Vec<String> = ["open", "gaps"].iter().flat_map(|k| strings(&r["coverageReport"][*k])).collect();
    if !coverage.is_empty() {
        explained.push("coverage");
        for note in &coverage {
            out.extend(flag_line(&format!("coverage: {note}"), width));
        }
    }
    for untestable in strings(&r["coverageReport"]["untestable"]) {
        out.extend(flag_line(&format!("excused as untestable: {untestable}"), width));
    }
    let named: Vec<String> = r["flagged"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|f| !f.starts_with("triage.")).map(plain).collect();
    let mut checks: Vec<(String, bool)> = approval.checks().into_iter().filter(|(_, v)| matches!(v.as_str(), "flag" | "ask")).map(|(n, v)| (n, v == "ask")).collect();
    for name in named {
        if !checks.iter().any(|(n, _)| *n == name) {
            checks.push((name, false));
        }
    }
    for (name, unsure) in checks {
        if !explained.contains(&name.as_str()) {
            out.extend(flag_line(&if unsure { format!("{name} check is unsure") } else { format!("{name} check flagged") }, width));
        }
    }
    for field in r["flagged"].as_array().into_iter().flatten().filter_map(Value::as_str).filter_map(|f| f.strip_prefix("triage.")) {
        out.extend(flag_line(&format!("triage {} flagged · T corrects the record", plain(field)), width));
    }
    if r["map"]["stale"].as_bool() == Some(true) {
        let behind = r["map"]["behind"].as_u64().map_or("many".to_string(), |n| n.to_string());
        out.extend(flag_line(&format!("the code map's graph is {behind} commits behind the default branch"), width));
    }
    if let Some(line) = approval.risk_raised_line() {
        out.extend(flag_line(&format!("risk raised: {line}"), width));
    }
    if let Some(line) = approval.risk_override_line() {
        out.extend(flag_line(&line, width));
    }
    if r["keptWhole"].as_bool() == Some(true) {
        out.extend(flag_line("kept whole: you chose not to split this plan", width));
    }
    out
}

/// One of the plan's scenarios, read off the gate's cases.
pub(crate) struct Scenario {
    pub id: String,
    pub kind: String,
    pub layer: String,
    pub title: String,
    pub approach: String,
    pub criterion: Option<String>,
}

impl Scenario {
    /// `S1 happy · unit`
    pub(crate) fn tag(&self) -> String {
        let mut tag = format!("{} {}", self.id, self.kind);
        if !self.layer.is_empty() {
            tag.push_str(&format!(" · {}", self.layer));
        }
        tag
    }
}

pub(crate) fn scenarios(detail: Option<&TaskDetail>) -> Vec<Scenario> {
    let Some(gate) = detail.and_then(TaskDetail::cases_approval) else { return Vec::new() };
    gate.requested["cases"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, c)| {
            Some(Scenario {
                id: c["id"].as_str().map_or(format!("S{}", i + 1), plain),
                kind: c["type"].as_str().map_or("happy".to_string(), plain),
                layer: c["layer"].as_str().map(plain).unwrap_or_default(),
                title: plain(c["title"].as_str()?),
                approach: c["approach"].as_str().or_else(|| c["test"].as_str()).map(plain).unwrap_or_default(),
                criterion: c["criterion"].as_str().map(str::to_string),
            })
        })
        .collect()
}

/// The criteria with their ids: the plan's own (`plan.acceptance_criteria`, `C1`…), else the gate's list numbered in order.
pub(crate) fn criteria(approval: &Approval, task: &Task) -> Vec<(String, String)> {
    let planned: Vec<(String, String)> = approval.requested["plan"]["acceptance_criteria"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| Some((c["id"].as_str().map(plain)?, plain(c["text"].as_str()?))))
        .collect();
    if !planned.is_empty() {
        return planned;
    }
    let listed = strings(&approval.requested["criteria"]);
    let listed = if listed.is_empty() { task.criteria.iter().map(|c| plain(c)).collect() } else { listed };
    listed.into_iter().enumerate().map(|(i, text)| (format!("C{}", i + 1), text)).collect()
}

/// The plan's steps: number, description, and what it touches. Falls back to the gate's slices.
fn steps(approval: &Approval, width: usize) -> Vec<Line<'static>> {
    let r = &approval.requested;
    let items = match r["plan"]["steps"].as_array().filter(|a| !a.is_empty()) {
        Some(steps) => steps,
        None => match r["slices"].as_array() {
            Some(slices) => slices,
            None => return Vec::new(),
        },
    };
    let mut out = vec![title("Steps")];
    for (i, step) in items.iter().enumerate() {
        let Some(text) = step["description"].as_str().or_else(|| step["title"].as_str()) else { continue };
        let number = format!("  {:<3}", i + 1);
        out.extend(hanging(vec![Span::styled(number, theme::label())], text, width));
        let files: Vec<String> = ["files", "touchpoints"].iter().flat_map(|k| strings(&step[*k])).collect();
        let shown: Vec<String> = files.iter().take(2).map(|f| truncate_middle(f, 36)).collect();
        let mut meta = Vec::new();
        if let Some(loc) = step["est_loc"].as_u64() {
            meta.push(format!("~{loc} lines"));
        }
        if !shown.is_empty() {
            meta.push(format!("{}{}", shown.join(", "), if files.len() > 2 { format!(" +{}", files.len() - 2) } else { String::new() }));
        }
        if !meta.is_empty() {
            out.push(Line::from(Span::styled(format!("     {}", ellipsis(&meta.join(" · "), width.saturating_sub(5))), theme::dim())));
        }
    }
    out
}

/// A short block with a title: nothing when `text` is empty.
fn block(name: &str, text: &str, width: usize) -> Vec<Line<'static>> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let mut out = vec![Line::default(), title(name)];
    out.extend(text::markdown(text, width, 2));
    out
}

/// The plan's decision material, the same on the Review page and in the Plan section after the gate: the brief, each criterion once
/// with its id, the steps with their size and files, rollback, out of scope and migration. With `with_scenarios` each criterion lists
/// the scenarios that prove it; when it has more than two they go to the second value, `(criterion id, "tag  title")`, for a reference group.
pub(crate) fn plan_material(task: &Task, approval: &Approval, detail: Option<&TaskDetail>, width: usize, with_scenarios: bool) -> (Vec<Line<'static>>, Vec<(String, String)>) {
    let r = &approval.requested;
    let mut main = vec![title("Brief")];
    match r["brief"].as_str().filter(|b| !b.trim().is_empty()) {
        Some(brief) => main.extend(text::markdown(brief, width, 2)),
        None => main.push(muted("  (none)".into())),
    }

    let all = if with_scenarios { scenarios(detail) } else { Vec::new() };
    let mut long: Vec<(String, String)> = Vec::new();
    let rows = criteria(approval, task);
    if !rows.is_empty() {
        main.extend([Line::default(), title("Criteria")]);
    }
    for (id, text) in &rows {
        main.extend(hanging(vec![Span::raw("  "), Span::styled(format!("{id:<4}"), theme::label())], text, width));
        if !with_scenarios {
            continue;
        }
        let mine: Vec<&Scenario> = all.iter().filter(|s| s.criterion.as_deref() == Some(text.as_str())).collect();
        let indent = Span::raw("      ");
        match mine.len() {
            0 => main.push(Line::from(vec![indent, Span::styled("⚑ no scenario", theme::flag())])),
            1..=2 => {
                for s in &mine {
                    main.extend(hanging(vec![indent.clone(), Span::styled(format!("{}  ", s.tag()), theme::label())], &s.title, width));
                }
            }
            n => {
                main.push(Line::from(vec![indent, Span::styled(format!("✓ {n} scenarios"), theme::label())]));
                long.extend(mine.into_iter().map(|s| (id.clone(), format!("{}  {}", s.tag(), s.title))));
            }
        }
    }

    let steps = steps(approval, width);
    if !steps.is_empty() {
        main.push(Line::default());
        main.extend(steps);
    }
    let rollback = r["rollback"].as_str().or_else(|| r["plan"]["rollback"].as_str()).unwrap_or_default();
    main.extend(block("Rollback", rollback, width));
    let out_of_scope = strings(&r["plan"]["out_of_scope"]);
    if !out_of_scope.is_empty() {
        main.extend(block("Out of scope", &out_of_scope.iter().map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n"), width));
    }
    main.extend(block("Migration", r["plan"]["migration"].as_str().or_else(|| r["migration"].as_str()).unwrap_or_default(), width));
    (main, long)
}

/// The plan gate's page: what to look at first (flags), then the decision material (brief, criteria with their scenarios, steps, rollback),
/// with the triage record, risk, checks, code map, assumptions and the card's facts as reference.
pub(crate) fn review_page(task: &Task, detail: Option<&TaskDetail>, width: usize, ref_width: usize) -> Page {
    let Some(d) = detail else { return Page::of(vec![title("Review"), Line::default(), muted("  loading…".into())]) };
    let Some(approval) = d.latest_approval("awaiting_approval") else {
        return Page::of(vec![title("Review"), Line::default(), muted("  no plan yet: triage and the planner write one once the ticket starts".into())]);
    };
    let r = &approval.requested;
    let mut main = flags(approval, width);
    // What this gate is really asking when it is not the plan itself: a split, a reply, an archive.
    let ask = gate_main_facts(approval);
    if let Some(reply) = approval.reply() {
        main.extend(block("Reply (a posts it where the ticket came from and closes it)", &reply, width));
    }
    if approval.outcome() == Some("archive") {
        main.extend(block("Archive (a archives the ticket)", &approval.archive_reason().unwrap_or_else(|| "no reason given".into()), width));
    }
    if !ask.is_empty() {
        if !main.is_empty() {
            main.push(Line::default());
        }
        main.extend(ask);
    }
    if !main.is_empty() {
        main.push(Line::default());
    }
    let (material, long) = plan_material(task, approval, detail, width, true);
    main.extend(material);
    if approval.names_needed() > 1 || approval.rule_line().is_some() {
        let given = approval.approvers();
        let names = if given.is_empty() { String::new() } else { format!(" ({})", plain(&given.join(", "))) };
        main.push(Line::default());
        main.push(Line::from(vec![Span::styled(format!("{:<11}", "Approvals"), theme::label()), Span::raw(format!("{} of {} given{names}", given.len(), approval.names_needed()))]));
    }

    let mut groups = Vec::new();
    groups.extend(gate_ref_group(approval, ref_width));
    groups.extend(record_group(task, r, ref_width));
    groups.extend(checks_group(approval));
    if !long.is_empty() {
        let lines: Vec<Line<'static>> = long
            .iter()
            .map(|(id, text)| Line::from(vec![Span::styled(format!("{id:<4}"), theme::label()), Span::raw(ellipsis(text, ref_width.saturating_sub(4)))]))
            .collect();
        groups.push(RefGroup::new("scenarios", "Scenarios", format!("{} listed", long.len()), lines));
    }
    groups.extend(map_group(r, ref_width));
    groups.extend(assumptions_group(r, ref_width));
    groups.push(card_group(task, detail, ref_width, crate::model::now_secs()));
    Page { main, groups }
}

/// `52k`, `1.5k`, `640`.
fn thousands(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        _ if n.is_multiple_of(1000) => format!("{}k", n / 1000),
        _ => format!("{:.1}k", n as f64 / 1000.0),
    }
}

/// `7.5` or `45`.
fn number(n: f64) -> String {
    if n.fract() == 0.0 { format!("{n:.0}") } else { format!("{n:.1}") }
}

/// `iterations ████░░░░░░ 4 of 12`: a ten-cell bar of `used` against `max`, in the flag style from 80%.
fn budget_row(label: &str, used: f64, max: f64, text: String) -> Line<'static> {
    let share = if max > 0.0 { (used / max).clamp(0.0, 1.0) } else { 0.0 };
    let filled = (share * 10.0).round() as usize;
    let style = if share >= 0.8 { theme::flag() } else { theme::text() };
    Line::from(vec![
        Span::styled(format!("  {label:<10} "), theme::label()),
        Span::styled(format!("{}{}", "█".repeat(filled), "░".repeat(10 - filled)), style),
        Span::styled(format!(" {text}"), style),
    ])
}

/// A running card: the stage and step, the slices, the budget against its limits, the checkpoint and the latest activity, then the
/// criteria. The board holds a run's transcript only in the watch pane, so the last lines here are the activity log's.
pub(crate) fn now_page(task: &Task, detail: Option<&TaskDetail>, width: usize, ref_width: usize, now: u64) -> Page {
    let mut main = Vec::new();
    let run = detail.and_then(|d| d.stage_runs.iter().rev().find(|r| r.status == "running"));
    let mut parts = vec![task.status_label() + &run.map(|r| format!(" #{}", r.attempt)).unwrap_or_default()];
    parts.extend(slice_progress(detail));
    parts.extend(detail.and_then(TaskDetail::running_engine).map(|e| format!("on {}", plain(e))));
    main.push(Line::from(vec![Span::styled(format!("{:<11}", "Stage"), theme::label()), Span::styled(parts.join(" · "), theme::heading())]));
    let Some(d) = detail else { return Page::of(main) };
    if let Some(p) = &d.build_progress {
        main.extend([Line::default(), title("Build")]);
        for s in &p.scenarios {
            let (glyph, style) = if s.state == "green" { ("●", theme::done()) } else { ("○", theme::label()) };
            main.push(Line::from(vec![Span::styled(format!("  {glyph} "), style), Span::raw(format!("{:<8}", ellipsis(&plain(&s.id), 8))), Span::styled(plain(&s.state), style)]));
        }
        let b = &p.budget;
        main.extend([Line::default(), title("Budget")]);
        main.push(budget_row("iterations", b.iterations as f64, b.limits.max_iterations as f64, format!("{} of {}", b.iterations, b.limits.max_iterations)));
        match b.tokens {
            Some(t) => main.push(budget_row("tokens", t as f64, b.limits.max_tokens as f64, format!("{} of {}", thousands(t), thousands(b.limits.max_tokens)))),
            None => main.push(muted("  tokens     not counted".into())),
        }
        main.push(budget_row("minutes", b.minutes, b.limits.max_minutes, format!("{} of {}", number(b.minutes), number(b.limits.max_minutes))));
        if let Some(cp) = &p.last_checkpoint {
            main.push(Line::default());
            main.push(Line::from(vec![Span::styled(format!("{:<11}", "checkpoint"), theme::label()), Span::raw(format!("{} after a {}", plain(&cp.sha).chars().take(7).collect::<String>(), plain(&cp.follows)))]));
        }
    }
    main.extend([Line::default(), title("Latest activity")]);
    main.push(Line::from(Span::styled("  from the activity log; f follows the live run", theme::dim())));
    let events: Vec<_> = d.events.iter().rev().take(5).collect();
    for e in events.into_iter().rev() {
        main.push(Line::from(Span::styled(format!("  {}", ellipsis(&plain(&crate::ui::describe(e)), width.saturating_sub(2))), theme::label())));
    }
    let table = criteria_table(&criteria_summary(d), width);
    if !table.is_empty() {
        main.push(Line::default());
        main.extend(table);
    }
    Page { main, groups: vec![card_group(task, detail, ref_width, now)] }
}

/// The keys that apply, each with what it does.
fn can_do(can: &[(String, String)]) -> Vec<Line<'static>> {
    if can.is_empty() {
        return Vec::new();
    }
    let mut out = vec![Line::default(), title("What you can do")];
    out.extend(can.iter().map(|(k, l)| Line::from(vec![Span::raw("  "), Span::styled(format!("{k:<8}"), theme::heading()), Span::styled(l.clone(), theme::label())])));
    out
}

/// A card that stopped: why (the reason, how sure the machine is, what it summed up), what can be done, and the failing output's tail.
pub(crate) fn stopped_page(task: &Task, detail: Option<&TaskDetail>, can: &[(String, String)], width: usize, ref_width: usize) -> Page {
    const SHOWN: usize = 20;
    let gate = detail.and_then(|d| d.approvals.iter().rev().find(|a| a.kind_or_guess() == "escalated" && a.decision.is_none()));
    let decision = gate.map(|g| &g.requested["escalationDecision"]);
    let reason = decision.and_then(|d| d["reason"].as_str()).or(task.reason.as_deref());
    let head = match reason {
        Some(r) => format!("✗ {} · {}", task.status_label(), plain(r)),
        None => format!("✗ {}", task.status_label()),
    };
    let mut main = vec![Line::from(Span::styled(head, theme::lost().add_modifier(ratatui::style::Modifier::BOLD)))];
    if let Some(known) = reason.and_then(|r| ESCALATION_REASONS.iter().find(|(id, _)| *id == r)) {
        main.push(Line::from(Span::styled(format!("  {}", known.1), theme::label())));
    }
    if let Some(d) = decision {
        let mut how = Vec::new();
        if let Some(conf) = d["confidence"].as_f64() {
            how.push(format!("{:.0}% sure", conf * 100.0));
        }
        if let Some(source) = d["source"].as_str() {
            how.push(format!("by {}", plain(source)));
        }
        if !how.is_empty() {
            main.push(Line::from(Span::styled(format!("  {}", how.join(" · ")), theme::label())));
        }
        if let Some(agent) = d["agentReason"].as_str() {
            main.push(Line::from(Span::styled(format!("  the agent said: {}", plain(agent)), theme::label())));
        }
    }
    if let Some(to) = detail.and_then(|d| d.events.iter().rev().find(|e| e.kind == "escalation.corrected")).and_then(|e| e.payload["to"].as_str()) {
        main.push(Line::from(Span::styled(format!("  corrected to {}", plain(to)), theme::done())));
    }
    if let Some(summary) = gate.and_then(|g| g.requested["summary"].as_str()).filter(|s| !s.trim().is_empty()) {
        main.push(Line::default());
        main.extend(text::markdown(summary, width, 2));
    }
    main.extend(can_do(can));
    let tail = gate
        .and_then(|g| g.requested["outputTail"].as_str().map(str::to_string))
        .or_else(|| detail.and_then(|d| d.stage_runs.iter().rev().find(|r| r.status == "failed").and_then(|r| run_error(d, r))))
        .filter(|t| !t.trim().is_empty());
    let mut groups = Vec::new();
    if let Some(tail) = tail {
        let rows: Vec<String> = plain(&tail).lines().map(|l| ellipsis(l, width.saturating_sub(4))).collect();
        let hidden = rows.len().saturating_sub(SHOWN);
        main.extend([Line::default(), title("Output")]);
        if hidden > 0 {
            main.push(Line::from(Span::styled(format!("  ▸ {hidden} more lines (Earlier output, in the reference)"), theme::dim())));
            groups.push(RefGroup::new("earlier", "Earlier output", format!("{hidden} lines"), rows[..hidden].iter().map(|l| Line::from(Span::styled(l.clone(), theme::code()))).collect()));
        }
        main.extend(rows[hidden..].iter().map(|l| Line::from(Span::styled(format!("  {l}"), theme::code()))));
    }
    if let Some(path) = gate.and_then(|g| g.requested["keptSandbox"]["path"].as_str()) {
        let until = gate.and_then(|g| g.requested["keptSandbox"]["until"].as_str()).map(|u| format!(" until {}", plain(u))).unwrap_or_default();
        groups.push(RefGroup::new("sandbox", "Sandbox", "kept", vec![Line::from(format!("sandbox kept at {}{until}", plain(path)))]));
    }
    groups.push(card_group(task, detail, ref_width, crate::model::now_secs()));
    Page { main, groups }
}

fn evidence_pack(d: &TaskDetail) -> Option<&Value> {
    match d.latest_approval("awaiting_ship") {
        Some(a) if a.requested["evidence"].is_object() => Some(&a.requested["evidence"]),
        _ => d.task.evidence.as_ref(),
    }
}

/// A card at or past shipping: the release question first when there is one, then what changed and why, what review found by
/// level, the PR, the evidence and the ship checklist.
pub(crate) fn result_page(task: &Task, detail: Option<&TaskDetail>, prs: &[PullRequest], can: &[(String, String)], width: usize, ref_width: usize, now: u64) -> Page {
    let Some(d) = detail else { return Page::of(vec![title("Result"), Line::default(), muted("  loading…".into())]) };
    let mut main = Vec::new();
    let open = d.open_approval();
    if let Some(a) = open.filter(|a| a.is_ship_approval()) {
        let question = plain(a.requested["question"].as_str().unwrap_or("safe to release now?"));
        if a.requested["risk"].as_str() == Some("high") || ship_risk_is_high(detail) {
            main.push(Line::from(Span::styled(format!("⚑ release owner: {question}"), theme::flag())));
        } else {
            main.push(title(&format!("Release question: {question}")));
        }
        for item in a.requested["checklist"].as_array().into_iter().flatten() {
            let ok = item["ok"].as_bool().unwrap_or(false);
            main.push(Line::from(vec![
                Span::styled(format!("  {} ", if ok { "✓" } else { "✗" }), if ok { theme::done() } else { theme::lost() }),
                Span::raw(plain(item["detail"].as_str().unwrap_or(item["id"].as_str().unwrap_or("")))),
            ]));
        }
        main.push(Line::default());
    } else if let Some(a) = open.filter(|a| a.kind_or_guess() == "reviewing_memory") {
        let blocks = gate_blocks(a, width);
        if !blocks.is_empty() {
            main.extend(blocks);
            main.push(Line::default());
        }
    }
    let pack = evidence_pack(d);
    if let Some(summary) = pack.map(|p| &p["diffSummary"]).filter(|s| s.is_object()) {
        main.push(title("Summary"));
        if let Some(what) = summary["what"].as_str() {
            main.extend(text::markdown(what, width, 2));
        }
        if let Some(why) = summary["why"].as_str() {
            main.extend(hanging(vec![Span::styled("  Why  ", theme::label())], why, width));
        }
        main.push(Line::default());
    }
    let open_findings: Vec<_> = d.reports.as_ref().and_then(|r| r.verify.as_ref()).map(|v| v.findings.iter().filter(|f| f.resolution.is_none()).collect()).unwrap_or_default();
    if !open_findings.is_empty() {
        let levels = [("blocker", "blocker"), ("should_fix", "should fix"), ("nit", "nit")];
        let counts: Vec<String> = levels.iter().filter_map(|(id, name)| Some(open_findings.iter().filter(|f| f.level() == *id).count()).filter(|n| *n > 0).map(|n| format!("{n} {name}"))).collect();
        main.extend([title("Findings"), Line::from(Span::styled(format!("  {}", counts.join(" · ")), theme::label()))]);
        for (id, name) in levels {
            for f in open_findings.iter().filter(|f| f.level() == id) {
                let place = if f.path.is_empty() { String::new() } else { format!("  {}:{}", truncate_middle(&plain(&f.path), 50), f.line) };
                main.extend(hanging(vec![Span::raw("  "), Span::styled(format!("{name:<11}"), if id == "blocker" { theme::lost() } else { theme::label() })], &format!("{}{place}", plain(&f.title)), width));
            }
        }
        main.push(Line::default());
    }
    let pr = match (pr_for(task, prs), d.ship.as_ref().filter(|s| s.pr.number > 0)) {
        (Some(pr), _) => Some(format!("{} · checks {} · {}", pr.key(), pr.checks_label(), pr.review_label())),
        (None, Some(ship)) => Some(format!("#{} · {}", ship.pr.number, if ship.ready { "every item passes" } else { "waiting on the items below" })),
        _ => pr_url(d),
    };
    if let Some(pr) = pr {
        main.push(Line::from(vec![Span::styled(format!("{:<11}", "PR"), theme::label()), Span::raw(plain(&pr))]));
    }
    if !d.artifacts.is_empty() {
        let mut line = vec![Span::styled(format!("{:<11}", "Evidence"), theme::label()), Span::raw(format!("{} file{}", d.artifacts.len(), if d.artifacts.len() == 1 { "" } else { "s" }))];
        if crate::open::opener().is_some() {
            line.push(Span::styled(" · o opens the folder", theme::label()));
        }
        main.push(Line::from(line));
    }
    if let Some(ship) = d.ship.as_ref().filter(|s| !s.checklist.is_empty()) {
        main.extend([Line::default(), title("Ship checklist")]);
        for item in &ship.checklist {
            main.push(Line::from(vec![
                Span::styled(format!("  {} ", if item.ok { "✓" } else { "✗" }), if item.ok { theme::done() } else { theme::lost() }),
                Span::raw(format!("{:<10}", plain(&item.id).replace('_', " "))),
                Span::styled(plain(&item.detail), theme::label()),
            ]));
        }
    }
    main.extend(can_do(can));
    let mut groups = Vec::new();
    if let Some(pack) = pack {
        let lines: Vec<Line<'static>> = crate::ui::pack_lines(pack).iter().map(|l| Line::from(ellipsis(l, ref_width))).collect();
        if !lines.is_empty() {
            groups.push(RefGroup::new("pack", "Evidence pack", format!("{} lines", lines.len()), lines));
        }
    }
    groups.push(card_group(task, detail, ref_width, now));
    Page { main, groups }
}

/// A gate that asks a question: the question and its choices first (the triage questions numbered, each with the machine's
/// suggested answer; the intake candidates; the proposed setup), then where the card came from as reference.
pub(crate) fn gate_page(task: &Task, detail: Option<&TaskDetail>, can: &[(String, String)], width: usize, ref_width: usize, now: u64) -> Page {
    let mut main = vec![title(&gate_question(task, detail).unwrap_or_else(|| task.status_label()))];
    if let Some(approval) = detail.and_then(TaskDetail::open_approval) {
        for (i, (question, suggested)) in questions_of(approval).into_iter().enumerate() {
            main.push(Line::default());
            main.extend(hanging(vec![Span::raw("  "), Span::styled(format!("{}. ", i + 1), theme::label())], &question, width));
            if !suggested.is_empty() {
                main.push(Line::from(Span::styled(format!("     suggested: {}", plain(&suggested)), theme::dim())));
            }
        }
        main.extend(gate_blocks(approval, width));
    }
    let intake = intake_gate_lines(detail);
    if !intake.is_empty() {
        main.push(Line::default());
        main.extend(intake);
    }
    main.extend(can_do(can));
    let mut groups = Vec::new();
    let origin = origin_lines(task, detail);
    if !origin.is_empty() {
        let n = origin.len();
        groups.push(RefGroup::new("origin", "Origin", format!("{n} lines"), origin));
    }
    groups.push(card_group(task, detail, ref_width, now));
    Page { main, groups }
}

#[cfg(test)]
mod tests {
    use crate::{
        detail::Section,
        testkit::{plan_gate_app, render},
    };

    fn open_review() -> crate::app::App {
        let mut app = plan_gate_app();
        app.detail_section = Section::Review;
        app
    }

    /// The main pane of a 180-column render: the screen's rows cut to the text between the rail and the side pane.
    fn main_pane(screen: &str) -> String {
        screen.lines().map(|r| r.chars().skip(17).take(94).collect::<String>().trim_end().to_string()).collect::<Vec<_>>().join("\n")
    }

    /// The rail's rows of a 180-column render of a card: the popup's left column, below its bar.
    fn rail_of(screen: &str) -> String {
        screen.lines().skip(8).take(14).map(|r| r.chars().skip(9).take(14).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn the_plan_gate_opens_on_review_with_flags_then_brief_criteria_steps_and_rollback_in_that_order() {
        let mut app = plan_gate_app();
        assert_eq!(app.detail_section, Section::Review);
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        let at = |needle: &str| main.find(needle).unwrap_or_else(|| panic!("no {needle:?} in\n{main}"));
        assert!(at("⚑ ") < at("Brief") && at("Brief") < at("Criteria") && at("Criteria") < at("Steps") && at("Steps") < at("Rollback"), "{main}");
        assert!(main.contains("⚑ plan: step 3 names a file outside the code map"), "the flag carries the plan check's reason\n{main}");
        assert!(main.contains("  • the endpoint streams rows"), "the brief goes through the markdown renderer\n{main}");
        for gone in ["Criteria to build", "Slices", "Outcome", "Checks", "Code map"] {
            assert!(!main.contains(gone), "{gone} belongs to the reference, not the first page\n{main}");
        }
    }

    #[test]
    fn at_180x50_the_first_page_holds_the_flags_the_brief_the_criteria_and_the_steps() {
        let mut app = plan_gate_app();
        let main = main_pane(&render(&mut app, 180, 50));
        for want in ["⚑ plan:", "Brief", "Criteria", "C5  a person without access", "Steps", "4  Add the export button"] {
            assert!(main.contains(want), "{want} is on the first screen\n{main}");
        }
    }

    #[test]
    fn each_criterion_is_printed_once_with_its_scenarios_under_it() {
        let mut app = open_review();
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        for text in ["exports every column the report shows", "escapes commas, quotes and newlines", "a person without access gets a 403"] {
            assert_eq!(main.matches(text).count(), 1, "{text} appears once in the main pane\n{main}");
        }
        let c1 = main.lines().position(|l| l.contains("C1  exports every column")).expect("C1 row");
        let rows: Vec<&str> = main.lines().collect();
        assert!(rows[c1 + 1].contains("S1 happy · unit  case 1 proves criterion 1"), "{}", rows[c1 + 1]);
        assert!(rows[c1 + 2].contains("S6 failure · integration  case 6 proves criterion 1"), "{}", rows[c1 + 2]);
        let c2 = rows.iter().position(|l| l.contains("C2  escapes commas")).unwrap();
        assert!(rows[c2 + 1].contains("S2 happy · integration"), "{}", rows[c2 + 1]);
    }

    #[test]
    fn a_criterion_with_no_scenario_says_so_and_one_with_many_folds_them_into_a_reference_group() {
        let mut app = open_review();
        {
            let d = app.detail.as_mut().unwrap();
            let gate = d.approvals.iter_mut().find(|a| a.kind.as_deref() == Some("awaiting_test_check")).unwrap();
            let cases = gate.requested["cases"].as_array_mut().unwrap();
            cases.retain(|c| c["criterion"] != "a person without access gets a 403");
            for n in 0..2 {
                cases.push(serde_json::json!({"id": format!("X{n}"), "title": format!("extra {n}"), "criterion": "escapes commas, quotes and newlines", "type": "edge", "layer": "unit"}));
            }
        }
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        let c5 = main.lines().position(|l| l.contains("C5  a person without access")).unwrap();
        assert!(main.lines().nth(c5 + 1).unwrap().contains("⚑ no scenario"), "{main}");
        let c2 = main.lines().position(|l| l.contains("C2  escapes commas")).unwrap();
        assert!(main.lines().nth(c2 + 1).unwrap().contains("✓ 3 scenarios"), "{main}");
        assert!(screen.contains("Scenarios"), "the full list is a reference group\n{screen}");
        assert!(!main.contains("extra 0"), "the scenario titles stay out of the main pane\n{main}");
    }

    #[test]
    fn steps_come_with_their_size_and_files_and_the_rest_of_the_plan_stays_short() {
        let mut app = open_review();
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        let step = main.lines().position(|l| l.contains("2  Add GET /api/reports/:id/export.csv")).expect("step 2");
        assert!(main.lines().nth(step + 1).unwrap().contains("~120 lines · src/reports/api.ts"), "{main}");
        for want in ["Rollback", "Revert the commit; the export route owns no data.", "Out of scope", "XLSX export", "Migration", "none needed"] {
            assert!(main.contains(want), "{want} missing in\n{main}");
        }
        assert!(!main.contains("Approvals"), "a plan one name may approve has no approvers line: {main}");
    }

    #[test]
    fn outcome_risk_and_checks_are_in_the_reference_and_the_rail_has_review_in_place_of_plan_and_tests() {
        let mut app = open_review();
        let screen = render(&mut app, 180, 60);
        for want in ["Outcome    plan", "Risk       medium", "✓ coverage proceed", "⚑ plan flag", "▸ Code map  5 files"] {
            assert!(screen.contains(want), "{want} missing in\n{screen}");
        }
        let rail = rail_of(&screen);
        assert!(rail.contains("Review"), "{rail}");
        assert!(!rail.contains("Plan") && !rail.contains("Tests"), "Plan and Tests are not sections at this gate\n{rail}");
    }

    #[test]
    fn a_narrow_review_still_leads_with_the_flags_and_folds_the_reference_under_the_text() {
        let mut app = open_review();
        let screen = render(&mut app, 100, 80);
        let at = |needle: &str| screen.find(needle).unwrap_or_else(|| panic!("no {needle:?} in\n{screen}"));
        assert!(at("⚑ plan: step 3") < at("Brief") && at("Steps") < at("── reference") && at("── reference") < at("▸ Code map"), "{screen}");
    }

    #[test]
    fn after_the_gate_is_passed_the_rail_shows_plan_and_tests_again() {
        let mut app = plan_gate_app();
        app.tasks[0].state = "implementing".into();
        app.detail.as_mut().unwrap().task.state = "implementing".into();
        app.detail_section = Section::Plan;
        let screen = render(&mut app, 180, 60);
        let rail = rail_of(&screen);
        assert!(rail.contains("Plan") && rail.contains("Tests") && !rail.contains("Review"), "{rail}");
    }
}

#[cfg(test)]
mod approver_tests {
    use crate::{
        detail::Section,
        testkit::{plan_gate_app, render},
    };

    #[test]
    fn a_plan_that_needs_two_names_says_how_many_have_given_theirs_in_one_line() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Review;
        let gate = app.detail.as_mut().unwrap().approvals.iter_mut().find(|a| a.requested["lane"].is_string()).unwrap();
        gate.requested["approvalRule"] = serde_json::json!({"needed": 2, "outside": "required", "text": "Needs 2 approvers."});
        gate.requested["approvers"] = serde_json::json!(["ana"]);
        let screen = render(&mut app, 180, 60);
        assert!(screen.contains("Approvals  1 of 2 given (ana)"), "{screen}");
    }

    #[test]
    fn a_flagged_check_with_no_reason_is_named_and_a_plan_with_no_flags_has_no_flag_block() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Review;
        {
            let gate = app.detail.as_mut().unwrap().approvals.iter_mut().find(|a| a.requested["lane"].is_string()).unwrap();
            gate.requested["planIssues"] = serde_json::json!([]);
        }
        let screen = render(&mut app, 180, 60);
        assert!(screen.contains("⚑ plan check flagged"), "{screen}");
        {
            let gate = app.detail.as_mut().unwrap().approvals.iter_mut().find(|a| a.requested["lane"].is_string()).unwrap();
            gate.requested["verdicts"] = serde_json::json!({"coverage": "proceed", "plan": "proceed", "risk": "proceed"});
            gate.requested["flagged"] = serde_json::json!([]);
        }
        let screen = render(&mut app, 180, 60);
        let main: String = screen.lines().skip(8).map(|r| r.chars().skip(17).take(94).collect::<String>()).collect::<Vec<_>>().join("\n");
        assert!(!main.contains("⚑ plan") && !main.contains("check flagged"), "{main}");
    }
}

/// The first pages of a running, a stopped, a shipped and a questioning card, drawn through `ui::draw` on the fixture cards.
#[cfg(test)]
mod first_page_tests {
    use crate::{
        detail::Section,
        testkit::{escalated_app, plan_gate_app, questions_app, release_question_app, render, running_build_app, ship_stage_app},
    };

    fn main_pane(screen: &str) -> String {
        screen.lines().map(|r| r.chars().skip(17).take(94).collect::<String>().trim_end().to_string()).collect::<Vec<_>>().join("\n")
    }

    fn rail_of(screen: &str) -> String {
        screen.lines().skip(8).take(14).map(|r| r.chars().skip(9).take(14).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    fn in_order(text: &str, needles: &[&str]) {
        let mut last = 0;
        for needle in needles {
            let at = text[last..].find(needle).unwrap_or_else(|| panic!("{needle:?} missing, or before the one that should precede it, in\n{text}"));
            last += at + needle.len();
        }
    }

    #[test]
    fn a_running_card_opens_on_now_first_in_the_rail_with_the_step_the_slices_the_budget_and_the_checkpoint() {
        let mut app = running_build_app();
        assert_eq!(app.detail_section, Section::Now);
        let screen = render(&mut app, 180, 50);
        let main = main_pane(&screen);
        assert!(rail_of(&screen).lines().next().unwrap().contains("Now"), "{}", rail_of(&screen));
        in_order(&main, &["implementing", "Build", "● S1", "● S2", "○ S3", "iterations", "tokens", "minutes", "checkpoint", "Latest activity"]);
        for want in ["iterations ███░░░░░░░ 4 of 12", "52k of 400k", "7.5 of 45", "9f3c2a1 after a green scenario", "S3 of 3"] {
            assert!(main.contains(want), "{want} missing in\n{main}");
        }
        assert!(screen.contains("Repo       /work/app"), "the repo, branch and tracker are in the Card group\n{screen}");
        assert!(!main.contains("Repo  "), "and not in the main text\n{main}");
    }

    #[test]
    fn a_budget_bar_turns_to_the_flag_style_from_eighty_percent_and_says_the_run_is_not_counting_tokens_when_it_is_not() {
        // The colours are what this asserts; with NO_COLOR there are none.
        if std::env::var_os("NO_COLOR").is_some() {
            return;
        }
        let spans = |used: f64, max: f64| super::budget_row("iterations", used, max, format!("{used} of {max}"));
        let flagged = |line: ratatui::text::Line| line.spans.iter().any(|s| s.style == crate::theme::flag());
        assert!(!flagged(spans(4.0, 12.0)));
        assert!(!flagged(spans(9.0, 12.0)), "75%");
        assert!(flagged(spans(10.0, 12.0)), "83%");
        assert!(flagged(spans(12.0, 12.0)));
        assert_eq!(super::thousands(52_000), "52k");
        assert_eq!(super::thousands(1_500), "1.5k");
        assert_eq!(super::thousands(640), "640");
    }

    #[test]
    fn an_escalated_card_opens_on_why_it_stopped_with_the_reason_the_options_and_the_output() {
        let mut app = escalated_app();
        assert_eq!(app.detail_section, Section::Stopped);
        let screen = render(&mut app, 180, 50);
        let main = main_pane(&screen);
        in_order(&main, &["✗ escalated · the same migration test failed three times", "82%", "The session table migration cannot run twice", "What you can do", "a ", "Output", "FAIL migrate.test.ts", "expected 3 rows, received 2"]);
        assert!(rail_of(&screen).lines().next().unwrap().contains("Stopped"), "{}", rail_of(&screen));
        assert!(!main.contains("stage  ") && !main.contains("took"), "the run table stays in Runs\n{main}");
    }

    #[test]
    fn the_output_is_cut_to_twenty_lines_and_says_how_many_more_there_are_and_control_characters_are_gone() {
        let mut app = escalated_app();
        let tail: String = (1..=30).map(|i| format!("line {i}\u{1b}[31m")).collect::<Vec<_>>().join("\n");
        let gate = app.detail.as_mut().unwrap().approvals.iter_mut().find(|a| a.kind.as_deref() == Some("escalated")).unwrap();
        gate.requested["outputTail"] = serde_json::Value::String(tail);
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        assert!(main.contains("line 30") && main.contains("line 11 ") && !main.contains("line 10 "), "the last twenty lines\n{main}");
        assert!(main.contains("▸ 10 more lines"), "{main}");
        assert!(!screen.contains('\u{1b}'));
    }

    #[test]
    fn a_ship_stage_card_opens_on_result_with_the_summary_findings_by_level_the_pr_and_the_evidence_count() {
        let mut app = ship_stage_app();
        assert_eq!(app.detail_section, Section::Result);
        let screen = render(&mut app, 180, 50);
        let main = main_pane(&screen);
        in_order(&main, &["Rate limits the public API per key", "C2: one client must not starve the rest", "Findings", "1 should fix · 1 nit", "the limiter keys on the proxy address", "src/limit.ts:31", "PR", "#412", "Evidence", "3 files", "Ship checklist", "✓ checks", "✗ review"]);
        assert!(rail_of(&screen).lines().next().unwrap().contains("Result"), "{}", rail_of(&screen));
    }

    #[test]
    fn the_release_question_of_a_high_risk_card_starts_with_its_own_flag_line_and_the_preview_gate_does_not() {
        let mut app = release_question_app();
        let screen = render(&mut app, 180, 50);
        let main = main_pane(&screen);
        let first = main_pane(&screen.lines().skip_while(|l| !l.contains('├')).skip(1).collect::<Vec<_>>().join("\n"));
        let first = first.lines().find(|l| !l.trim().is_empty()).unwrap();
        assert!(first.contains("⚑ release owner: safe to release now?"), "{main}");
        assert!(main.contains("✓ CI green on 3 of 3 checks"), "{main}");
        let mut app = ship_stage_app();
        assert!(!main_pane(&render(&mut app, 180, 50)).contains("release owner"));
    }

    #[test]
    fn a_card_at_the_triage_questions_opens_on_the_questions_numbered_each_with_the_suggested_answer() {
        let mut app = questions_app();
        assert_eq!(app.detail_section, Section::Gate);
        let screen = render(&mut app, 180, 50);
        let main = main_pane(&screen);
        in_order(&main, &["answer 2 questions", "1. Round half up or half to even?", "suggested: half to even", "2. Which currency does the report use?", "suggested: the account currency"]);
        assert!(rail_of(&screen).lines().next().unwrap().contains("Question"), "{}", rail_of(&screen));
    }

    #[test]
    fn every_first_page_also_reads_at_100x30_with_its_reference_folded_under_it() {
        for (name, mut app) in [("running", running_build_app()), ("escalated", escalated_app()), ("ship", ship_stage_app()), ("questions", questions_app()), ("plan gate", plan_gate_app())] {
            let screen = render(&mut app, 100, 30);
            assert!(screen.contains("approve") || screen.contains("answer") || screen.contains("escalated") || screen.contains("implementing") || screen.contains("ship"), "{name}\n{screen}");
            assert!(!screen.contains("│  Risk") || name == "plan gate", "{name}: no side pane at 100 columns\n{screen}");
        }
    }
}

/// The rail's groups and the accent, and the four cards at the two sizes the owner uses.
#[cfg(test)]
mod rail_tests {
    use ratatui::{Terminal, backend::TestBackend};

    use crate::{
        app::App,
        detail::Section,
        testkit::{escalated_app, plan_gate_app, render, running_build_app, ship_stage_app},
        theme, ui,
    };

    fn rail_of(screen: &str) -> Vec<String> {
        screen.lines().skip(8).take(16).map(|r| r.chars().skip(9).take(14).collect::<String>().trim_end().to_string()).collect()
    }

    #[test]
    fn sections_with_nothing_yet_sit_under_a_dim_later_label_below_the_ones_with_content() {
        let mut app = ship_stage_app();
        let screen = render(&mut app, 180, 50);
        let rail = rail_of(&screen);
        let at = |name: &str| rail.iter().position(|r| r.contains(name)).unwrap_or_else(|| panic!("no {name} in {rail:?}"));
        assert!(at("Result") < at("Runs") && at("Runs") < at("Evidence") && at("Evidence") < at("later"), "{rail:?}");
        assert!(at("later") < at("Diff") && at("later") < at("Activity"), "no diff and no events yet: {rail:?}");
        assert!(at("PR") < at("later"), "the ship gate's PR is content: {rail:?}");
    }

    #[test]
    fn digits_number_the_sections_with_content_and_l_still_reaches_the_later_ones() {
        let mut app = ship_stage_app();
        let key = |app: &mut App, c: char| app.handle_key(ratatui::crossterm::event::KeyEvent::from(ratatui::crossterm::event::KeyCode::Char(c)));
        render(&mut app, 180, 50);
        key(&mut app, '2');
        assert_eq!(app.detail_section, Section::Overview);
        key(&mut app, '9');
        assert_eq!(app.detail_section, Section::Overview, "9 is past the last numbered section");
        app.set_section(Section::Engines);
        key(&mut app, 'l');
        assert!(matches!(app.detail_section, Section::Plan | Section::Tests | Section::Diff | Section::Activity), "after the numbered ones come the later ones: {:?}", app.detail_section);
    }

    #[test]
    fn the_narrow_strip_lists_what_has_content_and_counts_the_rest() {
        let mut app = ship_stage_app();
        let screen = render(&mut app, 100, 30);
        let strip = screen.lines().find(|l| l.contains("Result")).unwrap();
        assert!(strip.contains("+4 later") && !strip.contains("Diff") && !strip.contains("Activity"), "{strip}");
    }

    #[test]
    fn only_a_waiting_marker_and_flag_lines_take_the_accent_and_headings_are_neutral() {
        // The colours are what this asserts; with NO_COLOR there are none.
        if std::env::var_os("NO_COLOR").is_some() {
            return;
        }
        let app = plan_gate_app();
        let mut terminal = Terminal::new(TestBackend::new(180, 50)).unwrap();
        terminal.draw(|f| ui::draw(f, &app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let find = |needle: &str| {
            (0..50u16).find_map(|y| {
                let row: String = (0..180u16).map(|x| buffer[(x, y)].symbol().to_string()).collect();
                row.find(needle).map(|i| (row[..i].chars().count() as u16, y))
            })
        };
        let (x, y) = find("Brief").expect("Brief");
        assert_eq!(buffer[(x, y)].fg, ratatui::style::Color::Reset, "a heading has no colour of its own");
        let (x, y) = find("⚑ plan:").expect("the flag line");
        assert_eq!(buffer[(x, y)].fg, theme::flag().fg.unwrap(), "a flag line is in the flag style");
        let (x, y) = find("▌1 Review").expect("the active section's marker");
        assert_eq!(buffer[(x, y)].fg, theme::needs_you().fg.unwrap(), "Review waits for the person");
        let (x, y) = find("Code map").expect("a reference group");
        assert_ne!(buffer[(x, y)].fg, theme::needs_you().fg.unwrap(), "reference never takes the accent");
    }

    #[test]
    fn at_100x30_each_card_opens_on_its_own_first_line() {
        for (name, mut app, first) in [("plan gate", plan_gate_app(), "⚑ plan:"), ("running", running_build_app(), "Stage"), ("escalated", escalated_app(), "✗ escalated · the same migration"), ("ship", ship_stage_app(), "Summary")] {
            let screen = render(&mut app, 100, 30);
            assert!(screen.contains(first), "{name}: {first} on the first screen\n{screen}");
        }
    }

    #[test]
    fn at_180x50_each_card_shows_its_headings_in_order_and_none_of_the_others() {
        let mut app = running_build_app();
        let screen = render(&mut app, 180, 50);
        let at = |needle: &str| screen.find(needle).unwrap_or_else(|| panic!("no {needle:?}\n{screen}"));
        assert!(at("Build") < at("Budget") && at("Budget") < at("Latest activity"), "{screen}");
        assert!(!screen.contains("What you can do") && !screen.contains("Findings"), "{screen}");
        let mut app = escalated_app();
        let screen = render(&mut app, 180, 50);
        assert!(!screen.contains("Budget") && !screen.contains("Latest activity"), "{screen}");
    }
}
