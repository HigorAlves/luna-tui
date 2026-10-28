//! The ticket workspace: the popup `enter` opens over the board. A rail of sections on the
//! left (a tab strip on a narrow terminal), one pane on the right, drawn from everything the
//! machine knows about the ticket, whether or not a gate was decided. Reads, never changes.

use std::cell::Cell;

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Style, Stylize},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Clear, Padding, Paragraph, Wrap},
};
use crate::model::{
    Approval, CriterionRow, PullRequest, StageRun, Task, TaskDetail, TaskDiff, TestCase, Tone, age, criteria_summary, now_secs,
    plan_history, questions_of,
};
use crate::ui::{
    ACCENT, BASE, GREEN, MUTED, PEACH, RED, SUBTEXT0, YELLOW, bullets, c, centered, continues_line, describe, evidence_lines,
    json_list, look_color, look_glyph, proof_lines, rules_lines, slice_lines, truncate,
};

/// The sections of the workspace, in rail order. `1`…`8` jump to them.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Section {
    #[default]
    Overview,
    Plan,
    Tests,
    Runs,
    Diff,
    Evidence,
    Pr,
    Activity,
}

impl Section {
    pub const ALL: [Section; 8] = [
        Section::Overview,
        Section::Plan,
        Section::Tests,
        Section::Runs,
        Section::Diff,
        Section::Evidence,
        Section::Pr,
        Section::Activity,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Section::Overview => "Overview",
            Section::Plan => "Plan",
            Section::Tests => "Tests",
            Section::Runs => "Runs",
            Section::Diff => "Diff",
            Section::Evidence => "Evidence",
            Section::Pr => "PR",
            Section::Activity => "Activity",
        }
    }

    fn index(self) -> usize {
        Section::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }

    pub fn next(self) -> Section {
        Section::ALL[(self.index() + 1) % Section::ALL.len()]
    }

    pub fn prev(self) -> Section {
        Section::ALL[(self.index() + Section::ALL.len() - 1) % Section::ALL.len()]
    }

    /// `1`…`8`, as the keys jump.
    pub fn from_digit(digit: char) -> Option<Section> {
        let i = digit.to_digit(10)? as usize;
        (1..=Section::ALL.len()).contains(&i).then(|| Section::ALL[i - 1])
    }

    /// Where the popup opens for a ticket: on the section its open gate concerns.
    pub fn for_task(task: &Task) -> Section {
        match task.state.as_str() {
            "awaiting_approval" => Section::Plan,
            "awaiting_test_check" => Section::Tests,
            "awaiting_ship" | "shipping" | "ci_watch" => Section::Pr,
            "escalated" => Section::Runs,
            _ => Section::Overview,
        }
    }

    /// Sections where `j`/`k` pick a row instead of scrolling the text.
    pub fn has_cursor(self) -> bool {
        matches!(self, Section::Runs | Section::Diff | Section::Evidence)
    }
}

/// Everything the popup needs to draw, borrowed from the app for one frame.
pub struct DetailView<'a> {
    pub task: &'a Task,
    pub detail: Option<&'a TaskDetail>,
    pub section: Section,
    /// The selected row in a section that has one (`Section::has_cursor`).
    pub cursor: usize,
    pub scroll: &'a Cell<u16>,
    /// The PR inbox, to find this branch's PR.
    pub prs: &'a [PullRequest],
    /// The branch's diff once fetched, for the Diff section.
    pub diff: Option<&'a TaskDiff>,
}

/// A terminal this wide or wider lays the rail beside the pane; narrower, the rail becomes a
/// tab strip above it.
const RAIL_FROM: u16 = 100;
const RAIL_WIDTH: u16 = 12;

/// The popup over `area`.
pub fn render(frame: &mut Frame, area: Rect, view: &DetailView) {
    let task = view.task;
    let detail = view.detail.filter(|d| d.task.id == task.id);
    let look = task.look();
    let now = now_secs();

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(look_color(look))))
        .padding(Padding::new(1, 1, 0, 0))
        .title(Line::from(format!(" #{} {} ", task.short_id(), task.title)).bold())
        .title_bottom(
            Line::from(format!(" {} {} · h/l sections · + size · ? help ", look_glyph(look), task.status_label()))
                .fg(c(look_color(look)))
                .left_aligned(),
        )
        .title_bottom(Line::from(format!(" {} · {} ago ", task.column, age(&task.updated_at, now))).fg(c(SUBTEXT0)).right_aligned());

    frame.render_widget(Clear, area);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let cells: Vec<(Section, String, Span<'static>)> = Section::ALL.iter().map(|s| (*s, s.label().to_string(), rail_status(*s, view, detail))).collect();
    let pane_area = if inner.width >= RAIL_FROM {
        let [rail_area, sep, pane_area] =
            Layout::horizontal([Constraint::Length(RAIL_WIDTH), Constraint::Length(2), Constraint::Min(0)]).areas(inner);
        render_rail(frame, rail_area, &cells, view.section);
        let rule: Vec<Line> = (0..sep.height).map(|_| Line::from(Span::from("│ ").fg(c(MUTED)))).collect();
        frame.render_widget(Paragraph::new(rule), sep);
        pane_area
    } else {
        let [strip, rule, pane_area] = Layout::vertical([Constraint::Length(1), Constraint::Length(1), Constraint::Min(0)]).areas(inner);
        render_strip(frame, strip, &cells, view.section);
        frame.render_widget(Paragraph::new(Line::from(Span::from("─".repeat(rule.width as usize)).fg(c(MUTED)))), rule);
        pane_area
    };

    let mut lines = match view.section {
        Section::Overview => overview_lines(task, detail, pane_area.width as usize, now),
        Section::Plan => plan_lines(task, detail, now),
        Section::Tests => tests_lines(task, detail, pane_area.width as usize, now),
        Section::Runs => runs_lines(task, detail, view.cursor, pane_area.width as usize, now),
        Section::Diff => diff_lines(task, view.diff, view.cursor, pane_area.width as usize),
        Section::Evidence => evidence_section_lines(detail, view.cursor),
        Section::Pr => pr_lines(task, detail, view.prs, now),
        Section::Activity => activity_lines(detail),
    };
    if let Some(strip) = gate_strip(task, detail) {
        lines.insert(0, strip);
        lines.insert(1, Line::default());
    }

    // Clamp to the content's height at this width, so j/k never scroll past the end.
    let total = Paragraph::new(Text::from(lines.clone())).wrap(Wrap { trim: false }).line_count(pane_area.width);
    let offset = view.scroll.get().min(total.saturating_sub(pane_area.height as usize) as u16);
    view.scroll.set(offset);
    frame.render_widget(Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false }).scroll((offset, 0)), pane_area);
}

/// The rail: one row per section, the active one marked, its status glyph right-aligned.
fn render_rail(frame: &mut Frame, area: Rect, cells: &[(Section, String, Span<'static>)], active: Section) {
    let lines: Vec<Line> = cells
        .iter()
        .map(|(section, label, status)| {
            let on = *section == active;
            let width = RAIL_WIDTH as usize - 1 - status.width();
            let name = Span::from(format!("{label:<width$}"));
            let name = if on { name.bold().fg(c(ACCENT)) } else { name };
            Line::from(vec![Span::from(if on { "▌" } else { " " }).fg(c(ACCENT)), name, status.clone()])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), area);
}

/// The narrow form of the rail: `Overview │ Plan ✓ │▌Tests 5 ✓│ …`, cut to the width.
fn render_strip(frame: &mut Frame, area: Rect, cells: &[(Section, String, Span<'static>)], active: Section) {
    let build = |pad: &str, label_w: usize| -> Vec<Span<'static>> {
        let mut spans = Vec::new();
        for (i, (section, label, status)) in cells.iter().enumerate() {
            if i > 0 {
                spans.push(Span::from("│").fg(c(MUTED)));
            }
            let on = *section == active;
            let status_text = status.content.trim().to_string();
            let label = truncate(label, label_w);
            let text = if status_text.is_empty() { format!("{pad}{label}{pad}") } else { format!("{pad}{label} {status_text}{pad}") };
            spans.push(if on { Span::from(text).bold().fg(c(ACCENT)).underlined() } else { Span::from(text) });
        }
        spans
    };
    let width = |spans: &[Span]| spans.iter().map(Span::width).sum::<usize>();
    let room = area.width as usize;
    let mut spans = build(" ", 12);
    if width(&spans) > room {
        spans = build("", 12);
    }
    if width(&spans) > room {
        spans = build("", 4);
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// What the rail says beside a section: approved, waiting, a count, a verdict, or nothing.
fn rail_status(section: Section, view: &DetailView, detail: Option<&TaskDetail>) -> Span<'static> {
    let dim = |text: String| Span::from(text).fg(c(SUBTEXT0));
    let gate = |approval: Option<&Approval>, count: Option<usize>| -> Span<'static> {
        let count = count.map(|n| format!("{n} ")).unwrap_or_default();
        match approval {
            None => dim("–".to_string()),
            Some(a) if a.decision.is_none() => Span::from(format!("{count}⏸")).fg(c(PEACH)),
            Some(a) if a.decision.as_deref() == Some("sent_back") => Span::from(format!("{count}↩")).fg(c(PEACH)),
            Some(_) => Span::from(format!("{count}✓")).fg(c(GREEN)),
        }
    };
    let Some(d) = detail else {
        return if section == Section::Overview { Span::raw("") } else { dim("…".to_string()) };
    };
    match section {
        Section::Overview => Span::raw(""),
        Section::Plan => gate(d.latest_approval("awaiting_approval"), None),
        Section::Tests => {
            let cases = d.cases();
            gate(d.latest_approval("awaiting_test_check"), (!cases.is_empty()).then_some(cases.len()))
        }
        Section::Runs => match d.stage_runs.last() {
            None => dim("–".to_string()),
            Some(run) => {
                let (glyph, color) = run_glyph(run);
                Span::from(format!("{} {glyph}", d.stage_runs.len())).fg(c(color))
            }
        },
        Section::Diff => match (view.diff, view.task.diff) {
            (Some(diff), _) => dim(format!("+{}", diff.files.iter().map(|f| f.added).sum::<u64>())),
            (None, Some(diff)) => dim(format!("+{}", diff.added)),
            (None, None) if view.task.branch.is_some() => dim("…".to_string()),
            _ => dim("–".to_string()),
        },
        Section::Evidence => {
            if d.artifacts.is_empty() {
                dim("–".to_string())
            } else {
                dim(d.artifacts.len().to_string())
            }
        }
        Section::Pr => match pr_for(view.task, view.prs) {
            Some(pr) => {
                let color = match pr.checks.state.as_str() {
                    "failure" => RED,
                    "pending" => YELLOW,
                    "success" => GREEN,
                    _ => SUBTEXT0,
                };
                Span::from(pr.checks_label().chars().next().unwrap_or('·').to_string()).fg(c(color))
            }
            None if pr_url(d).is_some() => Span::from("✓").fg(c(GREEN)),
            None => dim("–".to_string()),
        },
        Section::Activity => dim(d.events.len().to_string()),
    }
}

fn run_glyph(run: &StageRun) -> (&'static str, ratatui::style::Color) {
    match run.status.as_str() {
        "passed" => ("✓", GREEN),
        "failed" => ("✗", RED),
        "running" => ("◐", YELLOW),
        _ => ("·", SUBTEXT0),
    }
}

/// The one line that says what the ticket waits on you for and which keys answer, on top
/// of every section while a gate is open (or the ticket is escalated or paused).
pub fn gate_strip(task: &Task, detail: Option<&TaskDetail>) -> Option<Line<'static>> {
    let look = task.look();
    let keys = match task.state.as_str() {
        "awaiting_approval" => "a approve · r send back · e edit the plan",
        "awaiting_test_check" => "a approve · r send back · e edit the cases",
        "awaiting_setup" => "a write luna.yaml · r send back",
        "awaiting_answers" => "a answer the questions",
        "awaiting_ship" if task.route == "review" => "a post the verdict · r drop it",
        "awaiting_ship" => "S ship · r send back",
        "reviewing_memory" => "a apply the rules · A skip them",
        "escalated" => "a retry (guidance optional) · X abort",
        "paused_rate_limit" => "a resume now",
        _ => return None,
    };
    let _ = detail;
    Some(Line::from(vec![
        Span::from(format!(" {} {} ", look_glyph(look), task.status_label())).fg(c(BASE)).bg(c(look_color(look))).bold(),
        Span::from(format!(" {keys}")).fg(c(look_color(look))),
    ]))
}

fn heading(text: &str) -> Line<'static> {
    Line::from(Span::from(text.to_string()).fg(c(ACCENT)).bold())
}

fn proposal_heading(text: &str) -> Line<'static> {
    Line::from(Span::from(text.to_string()).fg(c(PEACH)).bold())
}

fn muted(text: String) -> Line<'static> {
    Line::from(Span::from(text).fg(c(SUBTEXT0)))
}

/// `Plan · triage #2 · approved 2h ago`: which run produced a gate's content and what you did.
fn gate_header(title: &str, stage: &str, approval: Option<&Approval>, detail: Option<&TaskDetail>, now: u64) -> Line<'static> {
    let Some(approval) = approval else {
        return heading(title);
    };
    let attempt = detail
        .and_then(|d| d.stage_runs.iter().rev().find(|r| r.stage == stage))
        .map(|r| format!(" · {stage} #{}", r.attempt))
        .unwrap_or_default();
    let (what, color) = match (approval.decision.as_deref(), approval.decided_at.as_deref()) {
        (None, _) => ("waiting for you".to_string(), PEACH),
        (Some("sent_back"), Some(at)) => (format!("sent back {} ago", age(at, now)), PEACH),
        (Some("sent_back"), None) => ("sent back".to_string(), PEACH),
        (Some(decision), Some(at)) => (format!("{} {} ago", decision.replace('_', " "), age(at, now)), GREEN),
        (Some(decision), None) => (decision.replace('_', " "), GREEN),
    };
    Line::from(vec![
        Span::from(title.to_string()).fg(c(ACCENT)).bold(),
        Span::from(attempt).fg(c(SUBTEXT0)),
        Span::from(" · ").fg(c(SUBTEXT0)),
        Span::from(what).fg(c(color)),
    ])
}

/// The criteria summary: one row per criterion with its plan, cases and verify columns.
fn criteria_table(rows: &[CriterionRow], width: usize) -> Vec<Line<'static>> {
    if rows.is_empty() {
        return Vec::new();
    }
    let name_w = rows.iter().map(|r| r.criterion.chars().count()).max().unwrap_or(8).clamp(8, width.saturating_sub(28).max(8));
    let mut lines = vec![Line::from(vec![
        Span::from(format!("{:<w$}", "Criteria", w = name_w + 2)).fg(c(ACCENT)).bold(),
        Span::from("  plan   cases   verify").fg(c(SUBTEXT0)),
    ])];
    for row in rows {
        let plan = match row.planned {
            Some(true) => Span::from("  ✓   ").fg(c(GREEN)),
            Some(false) => Span::from("  ✗   ").fg(c(RED)),
            None => Span::from("  –   ").fg(c(SUBTEXT0)),
        };
        let cases = if row.cases == 0 {
            Span::from("   –     ").fg(c(SUBTEXT0))
        } else {
            Span::from(format!("  {:<3}    ", row.cases))
        };
        let verify = match row.verify {
            Some((ok, total)) if ok == total => Span::from("✓").fg(c(GREEN)),
            Some((ok, total)) => Span::from(format!("✗ {ok} of {total}")).fg(c(RED)),
            None if row.planned == Some(false) => Span::from("–    not in the plan").fg(c(SUBTEXT0)),
            None if row.cases == 0 && row.planned.is_some() => Span::from("–    no case proves it").fg(c(SUBTEXT0)),
            None => Span::from("–").fg(c(SUBTEXT0)),
        };
        lines.push(Line::from(vec![
            Span::from(format!("  {:<w$}", truncate(&row.criterion, name_w), w = name_w)),
            plan,
            cases,
            verify,
        ]));
    }
    lines
}

/// Overview: the status line, the criteria summary, the facts, then the ticket's own text and
/// whatever an open gate asks that has no section of its own (setup, questions, rules).
fn overview_lines(task: &Task, detail: Option<&TaskDetail>, width: usize, now: u64) -> Vec<Line<'static>> {
    let look = task.look();
    let mut status = vec![Span::from(format!("{} {}", look_glyph(look), task.status_label())).fg(c(look_color(look))).bold()];
    if let Some(run) = detail.and_then(|d| d.stage_runs.last()) {
        status.push(Span::from(format!(" #{}", run.attempt)).fg(c(SUBTEXT0)));
    }
    if task.retries.total > 1 {
        status.push(Span::from(format!(" · run {} of 3", task.retries.total)).fg(c(PEACH)));
    }
    if let Some(spent) = detail.and_then(TaskDetail::spent_usd).or(task.spent_usd) {
        status.push(Span::from(format!(" · ${spent:.2}")).fg(c(SUBTEXT0)));
    }
    status.push(Span::from(format!(" · {}", age(&task.updated_at, now))).fg(c(SUBTEXT0)));
    let mut lines = vec![Line::from(status)];

    if let Some(d) = detail {
        let table = criteria_table(&criteria_summary(d), width);
        if !table.is_empty() {
            lines.push(Line::default());
            lines.extend(table);
        }
    }

    lines.push(Line::default());
    lines.push(muted(format!("Repo       {}", task.repo_path.as_deref().unwrap_or("none (R sets one)"))));
    if let Some(branch) = &task.branch {
        lines.push(muted(format!("Branch     {branch}")));
    }
    if let Some(source) = &task.source {
        lines.push(muted(source.detail_line()));
    }
    lines.extend(jira_lines(task, now));
    if let Some(stage) = &task.resume_to {
        lines.push(muted(format!("Continues  {}", continues_line(&task.state, stage).trim_start_matches("Continues at: "))));
    }
    if let Some(reason) = &task.reason {
        lines.push(Line::from(format!("Why        {reason}")).fg(look_color(look)));
    }
    if task.retries.total > 0 {
        let r = &task.retries;
        lines.push(muted(format!("Failures   verify {} · e2e {} · ci {}", r.verify, r.e2e, r.ci)));
    }

    if let Some(approval) = detail.and_then(TaskDetail::open_approval) {
        let requested = &approval.requested;
        if let Some(error) = requested["error"].as_str() {
            lines.extend([Line::default(), Line::from(Span::from("Error").fg(c(RED)).bold())]);
            lines.extend(error.lines().map(|l| Line::from(format!("  {l}")).fg(c(RED))));
        }
        if let Some(note) = requested["note"].as_str() {
            lines.push(muted(note.to_string()));
        }
        let rules = rules_lines(&requested["rules"], width.saturating_sub(4).max(20));
        if !rules.is_empty() {
            lines.extend([Line::default(), proposal_heading("Proposed rules (a applies, A skips)")]);
            lines.extend(rules.iter().map(|l| Line::from(format!("  {l}"))));
        }
        if let Some(config) = requested["config"].as_str() {
            lines.extend([Line::default(), proposal_heading("Proposed luna.yaml (a writes it to the repo, r sends it back)")]);
            lines.extend(config.lines().map(|l| Line::from(format!("  {l}"))));
            let proof = proof_lines(&requested["proof"]);
            if !proof.is_empty() {
                lines.extend([Line::default(), proposal_heading("Proof (each check run once)")]);
                for (ok, text) in proof {
                    lines.push(Line::from(format!("  {text}")).fg(c(if ok { GREEN } else { RED })));
                }
            }
            let notes = json_list(&requested["notes"]);
            if !notes.is_empty() {
                lines.extend([Line::default(), proposal_heading("Notes from setup")]);
                lines.extend(bullets(&notes));
            }
        }
        let questions = questions_of(approval);
        if !questions.is_empty() {
            lines.extend([Line::default(), proposal_heading("Questions (a to answer)")]);
            for (question, recommended) in questions {
                lines.push(Line::from(format!("  ? {question}")));
                lines.push(muted(format!("    recommended: {recommended}")));
            }
        }
    }

    lines.extend([Line::default(), heading("Description")]);
    if task.description.trim().is_empty() {
        lines.push(muted("  (none yet, e adds one)".into()));
    } else {
        lines.extend(task.description.lines().map(|l| Line::from(format!("  {l}"))));
    }
    lines.extend([Line::default(), heading("Acceptance criteria")]);
    if task.criteria.is_empty() {
        lines.push(muted("  (none yet, e adds them)".into()));
    } else {
        lines.extend(bullets(&task.criteria));
    }
    lines
}

/// The Overview's Jira and SLA facts: `Jira       PLAT-123 · In Progress · due Fri · High`
/// (muted `—  J links an issue` while unlinked), a red `⚠ blocked: …` line under it when the
/// last transition was refused, and `SLA        gate 12m of 1h · stage implementing 42m of 4h`
/// with each clock in its tone; no SLA row at all on a machine without the clocks.
fn jira_lines(task: &Task, now: u64) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    match &task.jira {
        Some(jira) => {
            lines.push(Line::from(vec![Span::from("Jira       ").fg(c(SUBTEXT0)), Span::from(jira.summary(now))]));
            if let Some(blocked) = &jira.blocked {
                lines.push(Line::from(Span::from(format!("           ⚠ blocked: {}", blocked.line())).fg(c(RED)).bold()));
            }
        }
        None => lines.push(muted("Jira       —  J links an issue".to_string())),
    }
    if let Some(sla) = &task.sla {
        let parts = sla.parts(now);
        if !parts.is_empty() {
            let mut spans = vec![Span::from("SLA        ").fg(c(SUBTEXT0))];
            for (i, (text, tone)) in parts.into_iter().enumerate() {
                if i > 0 {
                    spans.push(Span::from(" · ").fg(c(SUBTEXT0)));
                }
                spans.push(match tone {
                    Tone::Over => Span::from(text).fg(c(RED)).bold(),
                    Tone::Warn => Span::from(text).fg(c(YELLOW)),
                    Tone::Plain => Span::from(text),
                });
            }
            lines.push(Line::from(spans));
        }
    }
    lines
}

/// Plan: the latest triage plan, decided or not, then what happened to it.
fn plan_lines(task: &Task, detail: Option<&TaskDetail>, now: u64) -> Vec<Line<'static>> {
    let approval = detail.and_then(|d| d.latest_approval("awaiting_approval"));
    let mut lines = vec![gate_header("Plan", "triage", approval, detail, now)];
    let Some(approval) = approval else {
        lines.push(Line::default());
        lines.push(muted("  no plan yet: triage writes one once the ticket starts".into()));
        return lines;
    };
    let requested = &approval.requested;
    lines.extend([Line::default(), proposal_heading("Brief")]);
    match requested["brief"].as_str().filter(|b| !b.trim().is_empty()) {
        Some(brief) => lines.extend(brief.lines().map(|l| Line::from(format!("  {l}")))),
        None => lines.push(muted("  (none)".into())),
    }
    for (title, items) in [
        ("Criteria to build", json_list(&requested["criteria"])),
        ("Assumptions", json_list(&requested["assumptions"])),
        ("Slices", slice_lines(&requested["slices"])),
    ] {
        if !items.is_empty() {
            lines.extend([Line::default(), proposal_heading(title)]);
            lines.extend(bullets(&items));
        }
    }
    let history = detail.map(plan_history).unwrap_or_default();
    if !history.is_empty() {
        lines.extend([Line::default(), heading("History")]);
        lines.extend(history.into_iter().map(|l| muted(format!("  {l}"))));
    }
    lines.push(Line::default());
    lines.push(muted(
        if matches!(task.state.as_str(), "awaiting_approval" | "awaiting_test_check") {
            "e edits the brief, criteria and assumptions · slices stay as triage wrote them".to_string()
        } else {
            "read-only now that Build has started · r at the next gate sends the ticket back to triage".to_string()
        },
    ));
    lines
}

/// Tests: the cases under the criterion each proves, with verifying's verdict on each.
fn tests_lines(task: &Task, detail: Option<&TaskDetail>, width: usize, now: u64) -> Vec<Line<'static>> {
    let approval = detail.and_then(|d| d.latest_approval("awaiting_test_check"));
    let mut lines = vec![gate_header("Tests", "test_design", approval, detail, now)];
    let Some(d) = detail.filter(|_| approval.is_some()) else {
        lines.push(Line::default());
        lines.push(muted("  no cases yet: test_design writes them once the plan is approved".into()));
        return lines;
    };
    let groups = d.cases_by_criterion();
    let total: usize = groups.iter().map(|(_, cases)| cases.len()).sum();
    let judged: Vec<bool> = groups.iter().flat_map(|(_, cases)| cases.iter().filter_map(|c| c.result)).collect();
    let mut summary = format!("{total} case{} over {} criteri{}", if total == 1 { "" } else { "s" }, groups.len(), if groups.len() == 1 { "on" } else { "a" });
    if !judged.is_empty() {
        summary.push_str(&format!(" · verifying {}/{}", judged.iter().filter(|ok| **ok).count(), judged.len()));
    }
    if let Some(run) = d.stage_runs.iter().rev().find(|r| r.stage == "verifying" && !r.cases.is_empty()) {
        let (glyph, _) = run_glyph(run);
        summary.push_str(&format!(" {glyph}"));
    }
    lines.push(muted(summary));
    let title_w = groups
        .iter()
        .flat_map(|(_, cases)| cases.iter().map(|c| c.title.chars().count()))
        .max()
        .unwrap_or(10)
        .clamp(10, width.saturating_sub(30).max(10));
    for (criterion, cases) in &groups {
        lines.push(Line::default());
        lines.push(Line::from(vec![
            Span::from(criterion.clone()).fg(c(ACCENT)).bold(),
            Span::from(format!("   {} case{}", cases.len(), if cases.len() == 1 { "" } else { "s" })).fg(c(SUBTEXT0)),
        ]));
        for case in cases {
            lines.push(case_line(case, title_w));
        }
    }
    lines.push(Line::default());
    lines.push(muted(
        if task.state == "awaiting_test_check" {
            "e edits the cases while they wait for your check · the implementer never sees them".to_string()
        } else {
            "read-only · each case carries what verifying found".to_string()
        },
    ));
    lines
}

fn case_line(case: &TestCase, title_w: usize) -> Line<'static> {
    let (glyph, color) = match case.result {
        Some(true) => ("✓", GREEN),
        Some(false) => ("✗", RED),
        None => ("–", SUBTEXT0),
    };
    Line::from(vec![
        Span::from(format!("  {glyph} ")).fg(c(color)),
        Span::from(format!("{:<w$}", truncate(&case.title, title_w), w = title_w)),
        Span::from(format!("   {}", case.approach)).fg(c(SUBTEXT0)),
    ])
}

/// Runs: a table of stage runs, then the selected run's error and files.
fn runs_lines(task: &Task, detail: Option<&TaskDetail>, cursor: usize, width: usize, now: u64) -> Vec<Line<'static>> {
    let Some(d) = detail else {
        return vec![heading("Runs"), Line::default(), muted("  loading…".into())];
    };
    let mut head = vec![Span::from("Runs").fg(c(ACCENT)).bold(), Span::from(format!(" · {}", d.stage_runs.len())).fg(c(SUBTEXT0))];
    if let Some(spent) = d.spent_usd() {
        head.push(Span::from(format!(" · ${spent:.2} spent")).fg(c(SUBTEXT0)));
    }
    if let Some(worked) = task.worked_ms {
        head.push(Span::from(format!(" · {} worked", crate::model::fmt_ms(Some(worked)))).fg(c(SUBTEXT0)));
    }
    let mut lines = vec![Line::from(head), Line::default()];
    if d.stage_runs.is_empty() {
        lines.push(muted("  nothing has run yet".into()));
        return lines;
    }
    lines.push(muted(format!("    {:<14} {:>2}  {:<8} {:>6}  {:>7}  {:>5}", "stage", "#", "status", "took", "cost", "turns")));
    let selected = cursor.min(d.stage_runs.len() - 1);
    for (i, run) in d.stage_runs.iter().enumerate() {
        let (_, color) = run_glyph(run);
        let on = i == selected;
        lines.push(Line::from(vec![
            Span::from(if on { "  ▌ " } else { "    " }).fg(c(ACCENT)),
            Span::from(format!("{:<14} {:>2}  ", truncate(&run.stage, 14), run.attempt)).bold(),
            Span::from(format!("{:<8}", run.status)).fg(c(color)),
            Span::from(format!(
                " {:>6}  {:>7}  {:>5}",
                run.took(now).unwrap_or_else(|| "–".into()),
                run.cost_usd.map_or("–".to_string(), |v| format!("${v:.2}")),
                run.turns.map_or("–".to_string(), |t| t.to_string())
            ))
            .fg(c(SUBTEXT0)),
        ]));
    }
    let run = &d.stage_runs[selected];
    lines.push(Line::default());
    lines.push(Line::from(vec![
        Span::from(format!("─ {} #{} ", run.stage, run.attempt)).fg(c(ACCENT)).bold(),
        Span::from("─".repeat(width.saturating_sub(run.stage.chars().count() + 8))).fg(c(MUTED)),
    ]));
    match run_error(d, run) {
        Some(error) => lines.extend(error.lines().take(8).map(|l| Line::from(format!("  {l}")).fg(c(RED)))),
        None if run.status == "running" => lines.push(muted("  running · f follows its container in herdr".into())),
        None => lines.push(muted("  no error recorded".into())),
    }
    if !run.cases.is_empty() {
        lines.push(Line::default());
        for case in &run.cases {
            let (glyph, color) = if case.ok { ("✓", GREEN) } else { ("✗", RED) };
            lines.push(Line::from(vec![Span::from(format!("  {glyph} ")).fg(c(color)), Span::from(case.title.clone())]));
        }
    }
    let files: Vec<&crate::model::Artifact> = d.artifacts.iter().filter(|a| a.stage_run_id.is_some() && a.stage_run_id == run.id).collect();
    if !files.is_empty() {
        lines.push(Line::default());
        lines.push(muted(format!("  {} file{}", files.len(), if files.len() == 1 { "" } else { "s" })));
        lines.extend(files.iter().map(|a| muted(format!("    {} {}", a.kind, a.path))));
    }
    lines.push(Line::default());
    lines.push(muted("j/k pick a run · f follows the running one in herdr".into()));
    lines
}

/// The error a run finished with, as the activity log recorded it.
fn run_error(detail: &TaskDetail, run: &StageRun) -> Option<String> {
    detail.events.iter().rev().find_map(|e| {
        let p = &e.payload;
        (e.kind == "stage.finished" && p["stage"].as_str() == Some(run.stage.as_str()) && p["attempt"].as_u64() == Some(u64::from(run.attempt)))
            .then(|| p["error"].as_str().or_else(|| p["detail"]["error"].as_str()).map(str::to_string))
            .flatten()
    })
}

/// Diff: the branch's files with their counts, then the selected file's patch.
fn diff_lines(task: &Task, diff: Option<&TaskDiff>, cursor: usize, width: usize) -> Vec<Line<'static>> {
    let Some(branch) = &task.branch else {
        return vec![heading("Diff"), Line::default(), muted("  no branch yet: Build creates one".into())];
    };
    let Some(diff) = diff else {
        return vec![heading("Diff"), Line::default(), muted(format!("  loading {branch}…"))];
    };
    let added: u64 = diff.files.iter().map(|f| f.added).sum();
    let removed: u64 = diff.files.iter().map(|f| f.removed).sum();
    let mut lines = vec![Line::from(vec![
        Span::from("Diff").fg(c(ACCENT)).bold(),
        Span::from(format!(" · {} against {} · {} file{} · ", diff.head, diff.base, diff.files.len(), if diff.files.len() == 1 { "" } else { "s" }))
            .fg(c(SUBTEXT0)),
        Span::from(format!("+{added}")).fg(c(GREEN)),
        Span::from(format!(" −{removed}")).fg(c(RED)),
    ])];
    lines.push(Line::default());
    if diff.files.is_empty() {
        lines.push(muted("  no changes yet".into()));
        return lines;
    }
    let selected = cursor.min(diff.files.len() - 1);
    let path_w = diff.files.iter().map(|f| f.path.chars().count()).max().unwrap_or(10).clamp(10, width.saturating_sub(22).max(10));
    for (i, file) in diff.files.iter().enumerate() {
        let on = i == selected;
        lines.push(Line::from(vec![
            Span::from(if on { "  ▌ " } else { "    " }).fg(c(ACCENT)),
            Span::from(format!("{} ", file.status)).fg(c(match file.status.as_str() {
                "A" => GREEN,
                "D" => RED,
                _ => YELLOW,
            })),
            Span::from(format!("{:<w$}", truncate(&file.path, path_w), w = path_w)),
            Span::from(format!("  +{:<4}", file.added)).fg(c(GREEN)),
            Span::from(format!(" −{}", file.removed)).fg(c(RED)),
        ]));
    }
    let file = &diff.files[selected];
    lines.push(Line::default());
    lines.push(Line::from(vec![
        Span::from(format!("─ {} ", file.path)).fg(c(ACCENT)).bold(),
        Span::from("─".repeat(width.saturating_sub(file.path.chars().count() + 4))).fg(c(MUTED)),
    ]));
    match diff.patch.as_deref().filter(|_| diff.file.as_deref() == Some(file.path.as_str())) {
        Some(patch) => {
            for line in patch.lines() {
                let color = match line.chars().next() {
                    Some('+') if !line.starts_with("+++") => GREEN,
                    Some('-') if !line.starts_with("---") => RED,
                    Some('@') => ACCENT,
                    _ => SUBTEXT0,
                };
                lines.push(Line::from(Span::from(line.to_string()).fg(c(color))));
            }
        }
        None => lines.push(muted("  loading the patch…".into())),
    }
    lines.push(Line::default());
    lines.push(muted("j/k pick a file · o opens it in $EDITOR".into()));
    lines
}

/// Evidence: the QA verdict from the ship gate and every artifact the stages produced.
fn evidence_section_lines(detail: Option<&TaskDetail>, cursor: usize) -> Vec<Line<'static>> {
    let Some(d) = detail else {
        return vec![heading("Evidence"), Line::default(), muted("  loading…".into())];
    };
    let mut lines = vec![heading("Evidence")];
    let verdict = d.latest_approval("awaiting_ship").map(|a| evidence_lines(&a.requested["evidence"])).unwrap_or_default();
    if !verdict.is_empty() {
        lines.push(Line::default());
        lines.extend(verdict.iter().take(2).map(|l| Line::from(format!("  {l}"))));
    }
    lines.push(Line::default());
    if d.artifacts.is_empty() {
        lines.push(muted("  nothing yet: E2E and Evidence write screenshots, a recording and the manifest here".into()));
        return lines;
    }
    let selected = cursor.min(d.artifacts.len() - 1);
    let mut kinds: Vec<&str> = d.artifacts.iter().map(|a| a.kind.as_str()).collect();
    kinds.dedup();
    let mut last_kind = "";
    for (i, artifact) in d.artifacts.iter().enumerate() {
        if artifact.kind != last_kind {
            last_kind = &artifact.kind;
            let count = d.artifacts.iter().filter(|a| a.kind == artifact.kind).count();
            lines.push(Line::from(vec![Span::from(artifact.kind.clone()).fg(c(ACCENT)).bold(), Span::from(format!("   {count}")).fg(c(SUBTEXT0))]));
        }
        let on = i == selected;
        let label = if artifact.label.is_empty() { String::new() } else { format!("{}  ", artifact.label) };
        lines.push(Line::from(vec![
            Span::from(if on { "  ▌ " } else { "    " }).fg(c(ACCENT)),
            Span::from(label).bold(),
            Span::from(artifact.path.clone()).fg(c(SUBTEXT0)),
        ]));
    }
    lines.push(Line::default());
    lines.push(muted("j/k pick a file · o opens it".into()));
    lines
}

/// The PR for this ticket's branch, if the inbox has it.
pub fn pr_for<'a>(task: &Task, prs: &'a [PullRequest]) -> Option<&'a PullRequest> {
    let branch = task.branch.as_deref()?;
    prs.iter().find(|pr| pr.head_ref == branch)
}

/// The URL the ship gate reported, when the inbox has no row for the PR (not yours, closed).
fn pr_url(detail: &TaskDetail) -> Option<String> {
    detail.latest_approval("awaiting_ship").and_then(|a| a.requested["prUrl"].as_str().map(str::to_string))
}

/// PR: the branch's pull request as the inbox sees it, or what the ship gate said.
fn pr_lines(task: &Task, detail: Option<&TaskDetail>, prs: &[PullRequest], now: u64) -> Vec<Line<'static>> {
    let mut lines = vec![heading("PR"), Line::default()];
    match pr_for(task, prs) {
        Some(pr) => lines.extend(pr_widget(pr, now)),
        None => match detail.and_then(pr_url) {
            Some(url) => {
                let reused = detail
                    .and_then(|d| d.latest_approval("awaiting_ship"))
                    .is_some_and(|a| a.requested["reused"].as_bool().unwrap_or(false));
                lines.push(Line::from(vec![
                    Span::from(if reused { "PR (already open)  " } else { "PR opened  " }).fg(c(SUBTEXT0)),
                    Span::from(url).fg(c(ACCENT)),
                ]));
                lines.push(muted("  not in your inbox: o opens it in the browser".into()));
            }
            None if task.branch.is_some() => lines.push(muted("  no PR yet: Deliver opens a draft once Verify passes".into())),
            None => lines.push(muted("  no branch yet".into())),
        },
    }
    lines
}

/// One PR, the way both the ticket's PR section and the Pulls detail pane draw it: title,
/// author and branches, checks, review state, the task in flight.
pub fn pr_widget(pr: &PullRequest, now: u64) -> Vec<Line<'static>> {
    let checks_color = match pr.checks.state.as_str() {
        "failure" => RED,
        "pending" => YELLOW,
        "success" => GREEN,
        _ => SUBTEXT0,
    };
    let mut lines = vec![
        Line::from(vec![Span::from(format!("{}  ", pr.key())).fg(c(SUBTEXT0)), Span::from(pr.title.clone()).bold()]),
        muted(format!("@{} · {} → {}{} · {} ago", pr.author, pr.head_ref, pr.base_ref, if pr.from_fork { " (fork)" } else { "" }, age(&pr.updated_at, now))),
        muted(pr.url.clone()),
        Line::default(),
        Line::from(vec![
            Span::from("Checks     ").fg(c(SUBTEXT0)),
            Span::from(match pr.checks.state.as_str() {
                "none" => "no checks".to_string(),
                "failure" => format!("✗ {} of {} failed", pr.checks.failed.len().max(1), pr.checks.total),
                "pending" => format!("◐ {} of {} done", pr.checks.passed, pr.checks.total),
                _ => format!("✓ {} of {} passed", pr.checks.passed, pr.checks.total),
            })
            .fg(c(checks_color)),
        ]),
    ];
    let all: Vec<(&str, &str)> = if pr.checks.all.is_empty() {
        pr.checks.failed.iter().map(|ch| (ch.name.as_str(), "FAILURE")).collect()
    } else {
        pr.checks.all.iter().map(|ch| (ch.name.as_str(), ch.state.as_str())).collect()
    };
    for (name, state) in all {
        let (glyph, color) = match state {
            "SUCCESS" => ("✓", GREEN),
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" => ("✗", RED),
            _ => ("◐", YELLOW),
        };
        lines.push(Line::from(vec![Span::from(format!("  {glyph} ")).fg(c(color)), Span::from(name.to_string())]));
    }
    let mut review = pr.review_label().to_string();
    if pr.unresolved_threads > 0 {
        review.push_str(&format!(" · {} unresolved thread{}", pr.unresolved_threads, if pr.unresolved_threads == 1 { "" } else { "s" }));
    }
    lines.push(Line::from(vec![Span::from("Review     ").fg(c(SUBTEXT0)), Span::from(review).fg(c(crate::ui::LAVENDER))]));
    match (&pr.task, pr.local_path.is_some()) {
        (Some(task), _) => lines.push(Line::from(vec![
            Span::from("Task       ").fg(c(SUBTEXT0)),
            Span::from(format!("⚙ {} · {} · #{}", task.route.replace('_', " "), task.state.replace('_', " "), crate::model::short_id(&task.id))).fg(c(YELLOW)),
        ])),
        (None, false) => lines.push(Line::from(vec![Span::from("Checkout   ").fg(c(SUBTEXT0)), Span::from("none on this machine · a dispatch asks where to clone").fg(c(SUBTEXT0))])),
        _ => {}
    }
    lines
}

/// Activity: every event, oldest first.
fn activity_lines(detail: Option<&TaskDetail>) -> Vec<Line<'static>> {
    let Some(d) = detail else {
        return vec![heading("Activity"), Line::default(), muted("  loading…".into())];
    };
    let mut lines = vec![Line::from(vec![Span::from("Activity").fg(c(ACCENT)).bold(), Span::from(format!(" · {}", d.events.len())).fg(c(SUBTEXT0))]), Line::default()];
    if d.events.is_empty() {
        lines.push(muted("  nothing yet".into()));
    }
    lines.extend(d.events.iter().map(|e| {
        let text = describe(e);
        let color = if text.contains(" failed") || e.kind == "loop.crashed" { RED } else { SUBTEXT0 };
        Line::from(Span::from(format!("  {text}")).fg(c(color)))
    }));
    lines
}

/// The popup's rectangle: most of the terminal, or all of it after `+`.
pub fn popup_area(frame: Rect, full: bool) -> Rect {
    if full { frame } else { centered(frame, frame.width * 9 / 10, frame.height * 8 / 10) }
}

#[cfg(test)]
mod tests {
    use ratatui::{Terminal, backend::TestBackend};

    use super::*;
    use crate::model::PullRequest;

    const TASK: &str = r#"{"id":"abcdef123456","title":"Add CSV export","description":"Users want CSV.","criteria":["handles a/b & c","declares charset in header"],
        "repoPath":"/r/app","branch":"task/abcdef12","worktreePath":"/w","state":"implementing","column":"Build",
        "waitingOnYou":false,"running":true,"queued":false,
        "retries":{"verify":1,"e2e":0,"ci":0,"total":2},"resumeTo":null,"reason":null,
        "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#;

    fn detail_json(task: &str) -> String {
        format!(
            r#"{{"task":{task},
            "stageRuns":[
              {{"id":"r1","stage":"triage","attempt":1,"status":"passed","costUsd":0.42,"turns":18,"startedAt":"2026-10-22T09:30:00Z","endedAt":"2026-10-22T09:33:00Z"}},
              {{"id":"r4","stage":"test_design","attempt":1,"status":"passed","costUsd":0.21,"turns":9,"startedAt":"2026-10-22T10:00:00Z","endedAt":"2026-10-22T10:02:00Z"}},
              {{"id":"r2","stage":"verifying","attempt":1,"status":"failed","costUsd":null,"turns":null,"startedAt":"2026-10-22T10:07:00Z","endedAt":"2026-10-22T10:11:00Z",
                "cases":[{{"title":"rejects a bad password","ok":true}},{{"title":"escapes a quoted comma","ok":false}}]}},
              {{"id":"r3","stage":"implementing","attempt":2,"status":"running","costUsd":null,"turns":null,"startedAt":"2026-10-22T10:11:00Z","endedAt":null}}],
            "approvals":[
              {{"id":"p1","kind":"awaiting_approval","requested":{{"brief":"first try","criteria":["handles a/b & c"]}},"decision":"sent_back","reason":"criteria too vague","createdAt":"2026-10-22T09:33:00Z","decidedAt":"2026-10-22T09:40:00Z"}},
              {{"id":"p2","kind":"awaiting_approval","requested":{{"brief":"Add a CSV export endpoint.","criteria":["handles a/b & c","exports UTF-8 with a BOM"],"assumptions":["CSV only"],"slices":[{{"title":"Add route","est_loc":80}}]}},
                 "decision":"approved","reason":null,"createdAt":"2026-10-22T09:50:00Z","decidedAt":"2026-10-22T09:58:00Z"}},
              {{"id":"t1","kind":"awaiting_test_check","requested":{{"cases":[
                 {{"title":"rejects a bad password","criterion":"handles a/b & c","approach":"run the suite"}},
                 {{"title":"escapes a quoted comma","criterion":"handles a/b & c","approach":"read the output"}},
                 {{"title":"writes EF BB BF first","criterion":"exports UTF-8 with a BOM","approach":"hexdump"}}]}},
                 "decision":"approved","reason":null,"createdAt":"2026-10-22T10:00:00Z","decidedAt":"2026-10-22T10:02:00Z"}}],
            "events":[
              {{"taskId":"abcdef123456","kind":"stage.finished","payload":{{"stage":"verifying","attempt":1,"status":"failed","error":"2 tests failed: csv.test.ts"}},"at":"2026-10-22T10:11:58.000Z"}},
              {{"taskId":"abcdef123456","kind":"transition","payload":{{"from":"verifying","to":"implementing"}},"at":"2026-10-22T10:11:58.000Z"}},
              {{"taskId":"abcdef123456","kind":"stage.started","payload":{{"stage":"implementing","attempt":2}},"at":"2026-10-22T10:12:03.000Z"}}],
            "artifacts":[{{"id":"a1","stageRunId":"r2","kind":"log","path":"/out/files/verify.log","label":"verify","sha256":"x","createdAt":"2026-10-22T10:11:00Z"}}]}}"#
        )
    }

    fn render(width: u16, height: u16, task: &Task, detail: Option<&TaskDetail>, section: Section, cursor: usize) -> Vec<String> {
        render_with(width, height, task, detail, section, cursor, (&[], None))
    }

    fn render_with(
        width: u16,
        height: u16,
        task: &Task,
        detail: Option<&TaskDetail>,
        section: Section,
        cursor: usize,
        (prs, diff): (&[PullRequest], Option<&TaskDiff>),
    ) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let scroll = Cell::new(0);
        let view = DetailView { task, detail, section, cursor, scroll: &scroll, prs, diff };
        terminal.draw(|f| super::render(f, f.area(), &view)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect()
    }

    fn fixture() -> (Task, TaskDetail) {
        let task: Task = serde_json::from_str(TASK).unwrap();
        let detail: TaskDetail = serde_json::from_str(&detail_json(TASK)).unwrap();
        (task, detail)
    }

    fn col_of(rows: &[String], needle: &str) -> Option<usize> {
        rows.iter().find_map(|r| r.find(needle).map(|i| r[..i].chars().count()))
    }

    #[test]
    fn the_rail_lists_every_section_with_its_status_and_marks_the_active_one() {
        let (task, detail) = fixture();
        let rows = render(120, 30, &task, Some(&detail), Section::Plan, 0);
        let text = rows.join("\n");
        for s in Section::ALL {
            assert!(text.contains(s.label()), "{}: {text}", s.label());
        }
        let rail = |label: &str| rows.iter().find(|r| r[..14.min(r.len())].contains(label) || r.contains(&format!(" {label}"))).cloned().unwrap_or_default();
        let plan_row = rows.iter().find(|r| r.contains("▌Plan")).expect("the active section is marked");
        assert!(plan_row.contains("✓"), "the plan is approved: {plan_row}");
        assert!(rail("Tests").contains("3 ✓"), "three cases, checked: {}", rail("Tests"));
        assert!(rail("Runs").contains("4 ◐"), "four runs, the last one running: {}", rail("Runs"));
        assert!(rail("Activity").contains("3"), "{}", rail("Activity"));
        assert!(col_of(&rows, "Brief").unwrap() > 13, "the pane sits right of the rail");
    }

    #[test]
    fn the_plan_section_shows_the_approved_plan_and_its_history_after_the_gate_was_decided() {
        let (task, detail) = fixture();
        let text = render(120, 36, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("Plan · triage #1 · approved"), "{text}");
        assert!(text.contains("Add a CSV export endpoint."), "{text}");
        assert!(text.contains("• exports UTF-8 with a BOM"), "{text}");
        assert!(text.contains("• CSV only"), "{text}");
        assert!(text.contains("Add route (~80 LOC)"), "{text}");
        assert!(text.contains("09:40  sent back · criteria too vague"), "{text}");
        assert!(text.contains("09:58  approved"), "{text}");
        assert!(text.contains("read-only now that Build has started"), "{text}");
    }

    #[test]
    fn the_overview_opens_with_the_criteria_summary_and_the_facts() {
        let (task, detail) = fixture();
        let rows = render(120, 36, &task, Some(&detail), Section::Overview, 0);
        let text = rows.join("\n");
        assert!(text.contains("Criteria"), "{text}");
        let row = rows.iter().find(|r| r.contains("handles a/b & c")).unwrap();
        assert!(row.contains("✓") && row.contains("2") && row.contains("✗ 1 of 2"), "{row}");
        let dropped = rows.iter().find(|r| r.contains("declares charset in header")).unwrap();
        assert!(dropped.contains("not in the plan"), "{dropped}");
        let bom = rows.iter().find(|r| r.contains("exports UTF-8 with a BOM")).unwrap();
        assert!(bom.contains("no case proves it") || bom.contains("1"), "{bom}");
        assert!(text.contains("Branch     task/abcdef12"), "{text}");
        assert!(text.contains("Users want CSV."), "{text}");
        assert!(text.contains("run 2 of 3"), "{text}");
    }

    #[test]
    fn an_open_gate_puts_its_strip_on_top_of_every_section() {
        let (mut task, mut detail) = fixture();
        task.state = "awaiting_approval".into();
        task.waiting_on_you = true;
        detail.approvals[1].decision = None;
        for section in [Section::Overview, Section::Plan, Section::Activity] {
            let rows = render(120, 30, &task, Some(&detail), section, 0);
            assert!(rows[1].contains("approve plan") && rows[1].contains("a approve · r send back · e edit the plan"), "{section:?}: {}", rows[1]);
        }
        let text = render(120, 30, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("waiting for you"), "{text}");
        assert!(text.contains("e edits the brief"), "{text}");
    }

    #[test]
    fn under_a_hundred_columns_the_rail_becomes_a_tab_strip() {
        let (task, detail) = fixture();
        let rows = render(80, 30, &task, Some(&detail), Section::Tests, 0);
        assert!(rows[1].contains("Overview") && rows[1].contains("Tests 3 ✓") && rows[1].contains("Activity 3"), "{}", rows[1]);
        assert!(rows[2].chars().filter(|ch| *ch == '─').count() > 60, "a rule under the strip: {}", rows[2]);
        assert!(rows.iter().any(|r| r.contains("rejects a bad password")));
    }

    #[test]
    fn the_tests_section_groups_cases_by_criterion_with_verifying_s_verdict() {
        let (task, detail) = fixture();
        let rows = render(120, 30, &task, Some(&detail), Section::Tests, 0);
        let text = rows.join("\n");
        assert!(text.contains("Tests · test_design"), "{text}");
        assert!(text.contains("3 cases over 2 criteria · verifying 1/2"), "{text}");
        let crit = rows.iter().position(|r| r.contains("handles a/b & c") && r.contains("2 cases")).expect("criterion heading");
        assert!(rows[crit + 1].contains("✓ rejects a bad password") && rows[crit + 1].contains("run the suite"), "{}", rows[crit + 1]);
        assert!(rows[crit + 2].contains("✗ escapes a quoted comma"), "{}", rows[crit + 2]);
        assert!(text.contains("– writes EF BB BF first"), "{text}");
    }

    #[test]
    fn the_runs_section_tables_the_runs_and_shows_the_selected_one_s_error_and_files() {
        let (task, detail) = fixture();
        let rows = render(120, 30, &task, Some(&detail), Section::Runs, 2);
        let text = rows.join("\n");
        assert!(text.contains("Runs · 4 · $0.63 spent"), "{text}");
        let triage = rows.iter().find(|r| r.contains("triage")).unwrap();
        assert!(triage.contains("passed") && triage.contains("3m") && triage.contains("$0.42") && triage.contains("18"), "{triage}");
        let verifying = rows.iter().find(|r| r.contains("verifying") && r.contains("failed")).unwrap();
        assert!(verifying.contains("▌"), "the cursor sits on the third run: {verifying}");
        assert!(text.contains("─ verifying #1"), "{text}");
        assert!(text.contains("2 tests failed: csv.test.ts"), "{text}");
        assert!(text.contains("✗ escapes a quoted comma"), "{text}");
        assert!(text.contains("log /out/files/verify.log"), "{text}");
    }

    #[test]
    fn the_evidence_section_lists_artifacts_by_kind_and_says_so_when_there_are_none() {
        let (task, detail) = fixture();
        let text = render(120, 30, &task, Some(&detail), Section::Evidence, 0).join("\n");
        assert!(text.contains("log   1"), "{text}");
        assert!(text.contains("verify  /out/files/verify.log"), "{text}");
        let mut bare = detail.clone();
        bare.artifacts.clear();
        let text = render(120, 30, &task, Some(&bare), Section::Evidence, 0).join("\n");
        assert!(text.contains("nothing yet"), "{text}");
    }

    fn pr(head: &str) -> PullRequest {
        serde_json::from_str(&format!(
            r#"{{"repo":"acme/app","number":412,"title":"Add CSV export","url":"https://github.com/acme/app/pull/412","author":"mia","mine":true,"reviewRequested":false,
            "isDraft":false,"headRef":"{head}","baseRef":"main","fromFork":false,"reviewDecision":"APPROVED","mergeable":"MERGEABLE",
            "checks":{{"state":"failure","passed":2,"total":3,"failed":[{{"name":"lint","state":"FAILURE","url":null}}],
            "all":[{{"name":"build","state":"SUCCESS","url":null}},{{"name":"lint","state":"FAILURE","url":null}},{{"name":"test","state":"SUCCESS","url":null}}]}},
            "unresolvedThreads":2,"split":"ci_failed","localPath":"/r/app","task":{{"id":"e1f2a3b4c5","state":"ci_watch","route":"ci_fix"}},"updatedAt":"2026-10-27T09:00:00Z"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn the_pr_section_finds_the_branch_s_pr_in_the_inbox_and_lists_its_checks() {
        let (task, detail) = fixture();
        let prs = [pr("task/abcdef12")];
        let rows = render_with(120, 30, &task, Some(&detail), Section::Pr, 0, (&prs, None));
        let text = rows.join("\n");
        assert!(text.contains("acme/app#412  Add CSV export"), "{text}");
        assert!(text.contains("@mia · task/abcdef12 → main"), "{text}");
        assert!(text.contains("✗ 1 of 3 failed"), "{text}");
        assert!(text.contains("✗ lint") && text.contains("✓ build"), "{text}");
        assert!(text.contains("approved · 2 unresolved threads"), "{text}");
        assert!(text.contains("⚙ ci fix · ci watch · #e1f2a3b4"), "{text}");
        let other = [pr("feat/other")];
        let text = render_with(120, 30, &task, Some(&detail), Section::Pr, 0, (&other, None)).join("\n");
        assert!(text.contains("no PR yet"), "{text}");
    }

    #[test]
    fn the_diff_section_lists_files_and_the_selected_patch() {
        let (task, detail) = fixture();
        let diff: TaskDiff = serde_json::from_str(
            r#"{"base":"main","head":"task/abcdef12","files":[{"path":"machine/src/csv.ts","status":"M","added":88,"removed":4},{"path":"machine/src/csv.test.ts","status":"A","added":41,"removed":0}],
            "file":"machine/src/csv.test.ts","patch":"@@ -0,0 +1,41 @@\n+import { toCsv } from \"./csv\";\n+"}"#,
        )
        .unwrap();
        let rows = render_with(120, 30, &task, Some(&detail), Section::Diff, 1, (&[], Some(&diff)));
        let text = rows.join("\n");
        assert!(text.contains("Diff · task/abcdef12 against main · 2 files · +129 −4"), "{text}");
        let selected = rows.iter().find(|r| r.contains("csv.test.ts") && r.contains("▌")).expect("the cursor on the second file");
        assert!(selected.contains("A ") && selected.contains("+41"), "{selected}");
        assert!(text.contains("─ machine/src/csv.test.ts"), "{text}");
        assert!(text.contains("+import { toCsv }"), "{text}");
        let text = render_with(120, 30, &task, Some(&detail), Section::Diff, 0, (&[], None)).join("\n");
        assert!(text.contains("loading task/abcdef12"), "{text}");
    }

    #[test]
    fn the_setup_gate_shows_the_proposed_file_the_proof_per_check_and_the_notes_on_the_overview() {
        let (mut task, _) = fixture();
        task.state = "awaiting_setup".to_string();
        task.waiting_on_you = true;
        let detail: TaskDetail = serde_json::from_str(&format!(
            r#"{{"task":{TASK},"stageRuns":[],"approvals":[{{"kind":"awaiting_setup","requested":{{
              "config":"checks:\n  - name: board tests\n    run: cargo test\n",
              "proof":[{{"name":"board tests","cmd":"cargo test (in board)","ok":true,"tail":""}},
                       {{"name":"lint","cmd":"pnpm lint","ok":false,"tail":"a\nb\n3 problems"}}],
              "notes":["no e2e surface"]}},"decision":null}}],"events":[]}}"#
        ))
        .unwrap();
        let text = render(120, 40, &task, Some(&detail), Section::Overview, 0).join("\n");
        assert!(text.contains("approve setup") && text.contains("a write luna.yaml"), "{text}");
        assert!(text.contains("Proposed luna.yaml"), "{text}");
        assert!(text.contains("run: cargo test"), "the file is shown as is: {text}");
        assert!(text.contains("✓ board tests: cargo test (in board)"), "{text}");
        assert!(text.contains("✗ lint: pnpm lint"), "{text}");
        assert!(text.contains("3 problems"), "a failed check shows its tail: {text}");
        assert!(text.contains("no e2e surface"), "{text}");
    }

    #[test]
    fn the_overview_shows_the_jira_link_its_block_and_the_sla_clocks_in_their_tones() {
        let now = crate::model::unix_secs("2026-10-28T10:00:00Z").unwrap();
        let (_, detail) = fixture();
        let task: Task = serde_json::from_str(&crate::model::tests::jira_task_json()).unwrap();
        let lines = jira_lines(&task, now);
        let text: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        assert_eq!(text[0], "Jira       PLAT-123 · In Progress · due Fri · High");
        assert!(text[1].contains("⚠ blocked: no transition to \"In Review\" from \"Blocked\""), "{}", text[1]);
        assert!(lines[1].spans.iter().all(|s| s.style.fg == Some(c(RED))), "the block is red");
        assert_eq!(text[2], "SLA        gate overdue 40m · stage implementing 1h of 4h · cycle 10h of 3d · jira due Fri");
        let gate = lines[2].spans.iter().find(|s| s.content.contains("gate")).unwrap();
        assert_eq!(gate.style.fg, Some(c(RED)), "an overdue gate is red");
        let stage = lines[2].spans.iter().find(|s| s.content.contains("stage")).unwrap();
        assert_eq!(stage.style.fg, Some(c(YELLOW)), "a warning stage is yellow");
        let cycle = lines[2].spans.iter().find(|s| s.content.contains("cycle")).unwrap();
        assert_eq!(cycle.style.fg, None, "a clock inside its target is plain");

        let rows = render(120, 40, &task, Some(&detail), Section::Overview, 0).join("\n");
        assert!(rows.contains("Jira       PLAT-123 · In Progress") && rows.contains("SLA        gate overdue"), "{rows}");

        let (unlinked, _) = fixture();
        let text: Vec<String> = jira_lines(&unlinked, now).iter().map(|l| l.to_string()).collect();
        assert_eq!(text, vec!["Jira       —  J links an issue"], "no clocks, no SLA row");
        let mut fine = task.clone();
        fine.jira.as_mut().unwrap().blocked = None;
        fine.sla.as_mut().unwrap().gate = None;
        fine.sla.as_mut().unwrap().jira_due = None;
        let text: Vec<String> = jira_lines(&fine, now).iter().map(|l| l.to_string()).collect();
        assert_eq!(text.len(), 2);
        assert_eq!(text[1], "SLA        stage implementing 1h of 4h · cycle 10h of 3d", "null clocks are left out");
    }

    #[test]
    fn the_activity_section_names_the_jira_events() {
        let (task, mut detail) = fixture();
        let events: Vec<crate::model::TaskEvent> = serde_json::from_str(
            r#"[{"taskId":"abcdef123456","kind":"jira.transitioned","payload":{"from":"To Do","to":"In Progress"},"at":"2026-10-22T09:41:00.000Z"},
                {"taskId":"abcdef123456","kind":"jira.blocked","payload":{"wanted":"In Review","current":"Blocked","why":"not allowed"},"at":"2026-10-22T10:02:00.000Z"},
                {"taskId":"abcdef123456","kind":"jira.moved","payload":{"status":"Done"},"at":"2026-10-22T10:30:00.000Z"}]"#,
        )
        .unwrap();
        detail.events.extend(events);
        let text = render(120, 30, &task, Some(&detail), Section::Activity, 0).join("\n");
        assert!(text.contains("09:41:00  jira → In Progress"), "{text}");
        assert!(text.contains("10:02:00  jira blocked: no transition to \"In Review\" from \"Blocked\" — not allowed"), "{text}");
        assert!(text.contains("10:30:00  jira moved to Done"), "{text}");
    }

    #[test]
    fn the_activity_section_lists_every_event() {
        let (task, detail) = fixture();
        let text = render(120, 30, &task, Some(&detail), Section::Activity, 0).join("\n");
        assert!(text.contains("Activity · 3"), "{text}");
        assert!(text.contains("10:11:58  ■ verifying #1 failed: 2 tests failed"), "{text}");
        assert!(text.contains("10:12:03  ▶ implementing #2"), "{text}");
    }

    #[test]
    fn a_ticket_opens_on_the_section_its_gate_concerns_and_digits_jump() {
        let (mut task, _) = fixture();
        assert_eq!(Section::for_task(&task), Section::Overview);
        task.state = "awaiting_approval".into();
        assert_eq!(Section::for_task(&task), Section::Plan);
        task.state = "awaiting_test_check".into();
        assert_eq!(Section::for_task(&task), Section::Tests);
        task.state = "escalated".into();
        assert_eq!(Section::for_task(&task), Section::Runs);
        assert_eq!(Section::from_digit('1'), Some(Section::Overview));
        assert_eq!(Section::from_digit('8'), Some(Section::Activity));
        assert_eq!(Section::from_digit('9'), None);
        assert_eq!(Section::Activity.next(), Section::Overview);
        assert_eq!(Section::Overview.prev(), Section::Activity);
    }

    #[test]
    fn every_section_draws_at_any_size_with_or_without_a_detail() {
        let (task, detail) = fixture();
        for section in Section::ALL {
            for (w, h) in [(1, 1), (6, 3), (20, 6), (80, 24), (99, 30), (100, 30), (200, 50)] {
                let rows = render(w, h, &task, Some(&detail), section, 7);
                assert_eq!(rows.len(), usize::from(h));
                let rows = render(w, h, &task, None, section, 0);
                assert_eq!(rows.len(), usize::from(h));
            }
        }
    }
}
