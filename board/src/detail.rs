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
    Approval, CriterionRow, EngineCatalog, PullRequest, StageRun, Task, TaskDetail, TaskDiff, TaskSource, TestCase, Tone, age, criteria_summary, now_secs,
    plan_history, questions_of,
};
use crate::reference::{self, Page, RefGroup, RefState, SIDE_FROM, SIDE_WIDTH};
use crate::text::{cells, ellipsis, truncate_middle};
use crate::theme;
use crate::ui::{
    ACCENT, GREEN, MUTED, PEACH, RED, SUBTEXT0, YELLOW, bullets, c, centered, continues_line, describe, evidence_lines,
    json_list, look_color, look_glyph, proof_lines, rules_lines, slice_lines, truncate,
};

/// The sections of the workspace, in rail order. `1`…`9` jump to them.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub enum Section {
    /// The plan gate's one page: flags, brief, criteria with their scenarios, steps. In the rail in place of Plan and Tests.
    Review,
    /// A stage is running: the step, the slices, the budget, the latest activity.
    Now,
    /// The card stopped (escalated, failed, paused): why, what can be done, the failing output.
    Stopped,
    /// The card is at or past shipping: what changed, what review found, the PR, the evidence.
    Result,
    /// A gate that asks a question (triage questions, setup, intake): the question and its choices first.
    Gate,
    #[default]
    Overview,
    Plan,
    Tests,
    Runs,
    Diff,
    Evidence,
    Pr,
    Activity,
    Engines,
}

impl Section {
    pub const ALL: [Section; 14] = [
        Section::Review,
        Section::Now,
        Section::Stopped,
        Section::Result,
        Section::Gate,
        Section::Overview,
        Section::Plan,
        Section::Tests,
        Section::Runs,
        Section::Diff,
        Section::Evidence,
        Section::Pr,
        Section::Activity,
        Section::Engines,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Section::Review => "Review",
            Section::Now => "Now",
            Section::Stopped => "Stopped",
            Section::Result => "Result",
            Section::Gate => "Question",
            Section::Overview => "Overview",
            Section::Plan => "Plan",
            Section::Tests => "Tests",
            Section::Runs => "Runs",
            Section::Diff => "Diff",
            Section::Evidence => "Evidence",
            Section::Pr => "PR",
            Section::Activity => "Activity",
            Section::Engines => "Engines",
        }
    }

    /// The next section in `order` (the rail), wrapping; the first when this one is not in it.
    pub fn next(self, order: &[Section]) -> Section {
        match order.iter().position(|s| *s == self) {
            Some(i) => order[(i + 1) % order.len()],
            None => order.first().copied().unwrap_or(self),
        }
    }

    pub fn prev(self, order: &[Section]) -> Section {
        match order.iter().position(|s| *s == self) {
            Some(i) => order[(i + order.len() - 1) % order.len()],
            None => order.first().copied().unwrap_or(self),
        }
    }

    /// `1`…`9`, as the keys jump: the nth section of `order`.
    pub fn from_digit(digit: char, order: &[Section]) -> Option<Section> {
        let i = digit.to_digit(10)? as usize;
        (1..=order.len()).contains(&i).then(|| order[i - 1])
    }

    /// Where the popup opens for a ticket: on the page of what the person came for. A gate opens on its question (the plan
    /// gate on Review), a stopped card on why, a running one on what it is doing, a shipped one on its result.
    pub fn for_task(task: &Task) -> Section {
        match task.state.as_str() {
            "awaiting_approval" => Section::Review,
            "awaiting_test_check" => Section::Tests,
            _ if is_stopped(task) => Section::Stopped,
            _ if is_question(task) => Section::Gate,
            _ if is_result(task) => Section::Result,
            _ if is_running(task) => Section::Now,
            _ => Section::Overview,
        }
    }

    /// Sections where `j`/`k` pick a row instead of scrolling the text.
    pub fn has_cursor(self) -> bool {
        matches!(self, Section::Runs | Section::Diff | Section::Evidence | Section::Engines)
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
    /// The pane's height, written back each frame for the page keys.
    pub viewport: &'a Cell<u16>,
    /// Bring the selected row into view this frame (the cursor moved); cleared once done.
    pub follow: &'a Cell<bool>,
    /// `GET /packs` and `GET /engines`, for the Engines section; None until first asked.
    pub engines: Option<&'a Result<EngineCatalog, String>>,
    /// The board's current cards, to name a split's origin and children by title.
    pub tasks: &'a [Task],
    /// The keys the decision bar offers now, `(keys, label)` heaviest first (`keys::card_actions`).
    pub actions: &'a [(String, String)],
    /// The same keys with what each does, `(keys, label)`, for the pages that list what you can do (`keys::card_action_help`).
    pub can: &'a [(String, String)],
    /// Which reference groups are open and where their focus is.
    pub refs: &'a RefState,
}

/// A card that ended without shipping: the machine escalated it, a run failed or was aborted, or the usage window paused it.
fn is_stopped(task: &Task) -> bool {
    matches!(task.state.as_str(), "escalated" | "failed" | "aborted" | "paused_rate_limit")
}

/// A card at or past shipping, or finished.
fn is_result(task: &Task) -> bool {
    matches!(task.state.as_str(), "awaiting_ship" | "shipping" | "ci_watch" | "reviewing_memory" | "closed" | "archived" | "done")
}

/// A card whose open gate asks a question the plan gate and the test check do not: answers, setup, intake.
fn is_question(task: &Task) -> bool {
    matches!(task.state.as_str(), "awaiting_setup" | "awaiting_answers") || (task.state == "draft" && task.waiting_on_you)
}

/// A card a stage is working on or waits to work on, and no other page claims.
fn is_running(task: &Task) -> bool {
    (task.running || task.queued) && task.state != "awaiting_approval" && !is_stopped(task) && !is_result(task) && !is_question(task)
}

/// The sections the rail lists for `task`, in order. At the plan gate Review stands in for Plan and Tests; Now, Stopped,
/// Result and Question are listed only for a card they describe.
pub fn order(task: &Task) -> Vec<Section> {
    let at_plan_gate = task.state == "awaiting_approval";
    Section::ALL
        .iter()
        .copied()
        .filter(|s| match s {
            Section::Review => at_plan_gate,
            Section::Plan | Section::Tests => !at_plan_gate,
            Section::Now => is_running(task),
            Section::Stopped => is_stopped(task),
            Section::Result => is_result(task),
            Section::Gate => is_question(task),
            _ => true,
        })
        .collect()
}

/// Whether `section` has anything to show yet: a plan, cases, runs, a diff, a PR, evidence, events.
fn has_content(section: Section, task: &Task, detail: &TaskDetail, has_diff: bool, prs: &[PullRequest]) -> bool {
    match section {
        Section::Plan => detail.latest_approval("awaiting_approval").is_some(),
        Section::Tests => detail.cases_approval().is_some(),
        Section::Runs => !detail.stage_runs.is_empty(),
        Section::Diff => has_diff,
        Section::Evidence => !detail.artifacts.is_empty() || task.evidence.is_some(),
        Section::Pr => pr_for(task, prs).is_some() || pr_url(detail).is_some() || detail.ship.is_some(),
        Section::Activity => !detail.events.is_empty(),
        _ => true,
    }
}

/// The rail's two groups: the sections with content, numbered for the `1`-`9` keys, and the ones with nothing yet, listed under
/// `later` and reached with `h`/`l`. Without the card's detail nothing is held back.
pub fn rail(task: &Task, detail: Option<&TaskDetail>, has_diff: bool, prs: &[PullRequest]) -> (Vec<Section>, Vec<Section>) {
    let all = order(task);
    let Some(detail) = detail.filter(|d| d.task.id == task.id) else { return (all, Vec::new()) };
    all.into_iter().partition(|s| has_content(*s, task, detail, has_diff, prs))
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
        .title(Line::from(vec![
            Span::from(format!(" #{} ", task.short_id())).bold(),
            Span::from(task.source.as_ref().and_then(TaskSource::notch_tag).map(|t| format!("{t} ")).unwrap_or_default()).style(theme::label()),
            Span::from(format!("{} ", crate::model::plain(&task.title, 400))).bold(),
        ]))
        .title_bottom(Line::from(format!(" {} · {} ago ", task.column, age(&task.updated_at, now))).style(theme::label()).right_aligned());

    frame.render_widget(Clear, area);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    // The frame is three rows of layers: the decision bar (never scrolls), a rule that joins the
    // border, and the body. The body is a rail beside the pane (a tab strip above it when narrow);
    // a reference side pane attaches by splitting `pane_area` below, before `viewport` is set.
    let [bar_area, rule_area, body] = Layout::vertical([Constraint::Length(1), Constraint::Length(1), Constraint::Min(0)]).areas(inner);
    let wide = inner.width >= RAIL_FROM;
    let status = bar_status(task, detail, now);
    frame.render_widget(Paragraph::new(bar_line(bar_area.width as usize, &status.text, status.style, view.actions, &status.note)), bar_area);
    let tee = wide.then_some((inner.x - area.x + RAIL_WIDTH) as usize);
    let rule = Rect { x: area.x, width: area.width, ..rule_area };
    frame.render_widget(Paragraph::new(rule_line(area.width as usize, tee).style(Style::new().fg(c(look_color(look))))), rule);

    let (shown, later) = rail(task, detail, view.diff.is_some() || task.diff.is_some(), view.prs);
    let cell = |s: &Section| (*s, s.label().to_string(), rail_status(*s, view, detail));
    let cells: Vec<(Section, String, Span<'static>)> = shown.iter().map(cell).collect();
    let later_cells: Vec<(Section, String, Span<'static>)> = later.iter().map(cell).collect();
    let pane_area = if wide {
        let [rail_area, sep, pane_area] =
            Layout::horizontal([Constraint::Length(RAIL_WIDTH), Constraint::Length(2), Constraint::Min(0)]).areas(body);
        render_rail(frame, rail_area, &cells, &later_cells, view.section);
        let rule: Vec<Line> = (0..sep.height).map(|_| Line::from(Span::from("│ ").fg(c(MUTED)))).collect();
        frame.render_widget(Paragraph::new(rule), sep);
        pane_area
    } else {
        let [strip, rule, pane_area] = Layout::vertical([Constraint::Length(1), Constraint::Length(1), Constraint::Min(0)]).areas(body);
        render_strip(frame, strip, &cells, later_cells.len(), view.section);
        frame.render_widget(Paragraph::new(Line::from(Span::from("─".repeat(rule.width as usize)).fg(c(MUTED)))), rule);
        pane_area
    };

    // A section with reference groups gives them a side pane when the popup is wide enough.
    let side = wide && inner.width >= SIDE_FROM && has_groups(view.section);
    let (pane_area, side_area) = if side {
        let [main, sep, side_area] = Layout::horizontal([Constraint::Min(0), Constraint::Length(1), Constraint::Length(SIDE_WIDTH)]).areas(pane_area);
        let rule: Vec<Line> = (0..sep.height).map(|_| Line::from(Span::styled("│", theme::dim()))).collect();
        frame.render_widget(Paragraph::new(rule), sep);
        (main, Some(side_area))
    } else {
        (pane_area, None)
    };

    let height = pane_area.height as usize;
    let width = pane_area.width as usize;
    // Reference lines wrap to the side pane, or to the text's width when they are folded under it.
    let ref_width = if side { SIDE_WIDTH as usize - 2 } else { width.saturating_sub(2) };
    view.viewport.set(pane_area.height);
    let mut lines: Vec<Line> = Vec::new();
    let follow = view.follow.replace(false);

    if view.section == Section::Diff {
        view.refs.ids.borrow_mut().clear();
        // Patches run to 512 KB: only the lines in view become widgets, and nothing wraps, so
        // a row of scroll is a line of the patch.
        let head = diff_head(task, view.diff, view.cursor, width);
        let body_len = head.patch.map_or(1, |p| p.lines().count());
        let total = head.lines.len() + body_len + head.tail.len();
        let mut offset = view.scroll.get() as usize;
        if follow && let Some(row) = head.cursor_row {
            offset = keep_visible(offset, row, height);
        }
        let offset = offset.min(total.saturating_sub(height));
        view.scroll.set(offset as u16);
        let body_from = offset.saturating_sub(head.lines.len()).min(body_len);
        lines.extend(head.lines);
        match head.patch {
            Some(patch) => lines.extend(patch.lines().skip(body_from).take(height).map(patch_line)),
            None => lines.push(muted("  loading the patch…".into())),
        }
        lines.extend(head.tail);
        frame.render_widget(Paragraph::new(Text::from(lines)).scroll(((offset - body_from) as u16, 0)), pane_area);
        scroll_markers(frame, pane_area, offset, total);
        return;
    }

    let (page, cursor_row) = match view.section {
        Section::Overview => (Page::of(overview_lines(task, detail, width, now, view.tasks)), None),
        Section::Review => (crate::pages::review_page(task, detail, width, ref_width), None),
        Section::Now => (crate::pages::now_page(task, detail, width, ref_width, now), None),
        Section::Stopped => (crate::pages::stopped_page(task, detail, view.can, width, ref_width), None),
        Section::Result => (crate::pages::result_page(task, detail, view.prs, view.can, width, ref_width, now), None),
        Section::Gate => (crate::pages::gate_page(task, detail, view.can, width, ref_width, now), None),
        Section::Plan => (plan_page(task, detail, ref_width, now), None),
        Section::Tests => (Page::of(tests_lines(task, detail, width, now)), None),
        Section::Runs => {
            let (lines, row) = runs_lines(task, detail, view.cursor, width, now);
            (Page::of(lines), row)
        }
        Section::Diff => unreachable!("drawn above"),
        Section::Evidence => {
            let (lines, row) = evidence_section_lines(detail, view.cursor);
            (Page::of(lines), row)
        }
        Section::Pr => (Page::of(pr_lines(task, detail, view.prs, now)), None),
        Section::Activity => (Page::of(activity_lines(detail)), None),
        Section::Engines => {
            let (lines, row) = engines_lines(task, detail, view.engines, view.cursor);
            (Page::of(lines), row)
        }
    };
    *view.refs.ids.borrow_mut() = page.groups.iter().map(|g| g.id).collect();
    let mut cursor_row = cursor_row;
    lines.extend(page.main);
    if !page.groups.is_empty() {
        match side_area {
            Some(area) => {
                let (rows, _) = reference::layout(&page.groups, view.section, view.refs, true, area.width as usize);
                frame.render_widget(Paragraph::new(Text::from(rows)).wrap(Wrap { trim: false }), area);
            }
            None => {
                lines.push(Line::default());
                lines.push(Line::from(Span::styled(format!("── reference {}", "─".repeat(width.saturating_sub(13))), theme::dim())));
                let (rows, headers) = reference::layout(&page.groups, view.section, view.refs, false, width);
                if view.refs.focus && let Some(row) = headers.get(view.refs.cursor.min(headers.len().saturating_sub(1))) {
                    cursor_row = Some(lines.len() + row);
                }
                lines.extend(rows);
            }
        }
    }

    // One paragraph: counted at this width, then clamped so j/k never scroll past the end.
    let paragraph = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
    let total = paragraph.line_count(pane_area.width);
    let mut offset = view.scroll.get() as usize;
    if follow && let Some(row) = cursor_row {
        offset = keep_visible(offset, row, height);
    }
    let offset = offset.min(total.saturating_sub(height));
    view.scroll.set(offset as u16);
    frame.render_widget(paragraph.scroll((offset as u16, 0)), pane_area);
    scroll_markers(frame, pane_area, offset, total);
}

/// Whether a section hands its reference over as groups (a side pane when wide, folds under the text when narrow).
fn has_groups(section: Section) -> bool {
    matches!(section, Section::Review | Section::Now | Section::Stopped | Section::Result | Section::Gate | Section::Plan)
}

/// `▲ N above` over the pane's first row once it is scrolled, `▼ N more` over its last while
/// content continues. A marker replaces its row, so N counts what is not on screen, that row's
/// line included.
fn scroll_markers(frame: &mut Frame, pane: Rect, offset: usize, total: usize) {
    let height = pane.height as usize;
    if height < 3 {
        return;
    }
    let mut mark = |y: u16, text: String| {
        let row = Rect { y, height: 1, ..pane };
        frame.render_widget(Clear, row);
        frame.render_widget(Paragraph::new(Line::from(Span::from(text).style(theme::dim())).right_aligned()), row);
    };
    if offset > 0 {
        mark(pane.y, format!("▲ {} above", offset + 1));
    }
    let below = total.saturating_sub(offset + height);
    if below > 0 {
        mark(pane.y + pane.height - 1, format!("▼ {} more", below + 1));
    }
}

/// The scroll offset that keeps `row` inside a window of `height` rows, moving as little as
/// possible from `offset`.
fn keep_visible(offset: usize, row: usize, height: usize) -> usize {
    if row < offset {
        row
    } else if row >= offset + height.max(1) {
        row + 1 - height.max(1)
    } else {
        offset
    }
}

/// One line of a patch, coloured by what it does.
fn patch_line(line: &str) -> Line<'static> {
    let color = match line.chars().next() {
        Some('+') if !line.starts_with("+++") => GREEN,
        Some('-') if !line.starts_with("---") => RED,
        Some('@') => ACCENT,
        _ => SUBTEXT0,
    };
    Line::from(Span::from(line.to_string()).fg(c(color)))
}

/// The rail: one row per section with content, the active one marked, its status glyph right-aligned; then the sections with nothing yet
/// under a dim `later`. The marker is bold text, and the accent only where the section waits for the person.
fn render_rail(frame: &mut Frame, area: Rect, cells: &[(Section, String, Span<'static>)], later: &[(Section, String, Span<'static>)], active: Section) {
    let row = |(section, label, status): &(Section, String, Span<'static>), dimmed: bool| {
        let on = *section == active;
        let waits = status.style.fg == theme::needs_you().fg || status.style.fg == theme::flag().fg;
        let width = RAIL_WIDTH as usize - 1 - status.width();
        let name = Span::styled(format!("{label:<width$}"), if on { theme::heading() } else if dimmed { theme::dim() } else { theme::text() });
        let marker = Span::styled(if on { "▌" } else { " " }, if waits { theme::needs_you() } else { theme::heading() });
        Line::from(vec![marker, name, status.clone()])
    };
    let mut lines: Vec<Line> = cells.iter().map(|c| row(c, false)).collect();
    if !later.is_empty() {
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(" later", theme::dim())));
        lines.extend(later.iter().map(|c| row(c, true)));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// The narrow form of the rail: `Overview │ Plan ✓ │▌Tests 5 ✓│ … +2 later`, the sections with content only, cut to the width.
fn render_strip(frame: &mut Frame, area: Rect, cells: &[(Section, String, Span<'static>)], later: usize, active: Section) {
    let build = |pad: &str, label_w: usize| -> Vec<Span<'static>> {
        let mut spans = Vec::new();
        for (i, (section, label, status)) in cells.iter().enumerate() {
            if i > 0 {
                spans.push(Span::styled("│", theme::dim()));
            }
            let on = *section == active;
            let status_text = status.content.trim().to_string();
            let label = truncate(label, label_w);
            let text = if status_text.is_empty() { format!("{pad}{label}{pad}") } else { format!("{pad}{label} {status_text}{pad}") };
            spans.push(if on { Span::styled(text, theme::heading().underlined()) } else { Span::from(text) });
        }
        if later > 0 {
            spans.push(Span::styled(format!(" +{later} later"), theme::dim()));
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
    let dim = |text: String| Span::from(text).style(theme::label());
    let gate = |approval: Option<&Approval>, count: Option<usize>| -> Span<'static> {
        let count = count.map(|n| format!("{n} ")).unwrap_or_default();
        match approval {
            None => dim("–".to_string()),
            Some(a) if a.decision.is_none() => Span::from(format!("{count}⏸")).style(theme::flag()),
            Some(a) if a.decision.as_deref() == Some("sent_back") => Span::from(format!("{count}↩")).style(theme::flag()),
            Some(_) => Span::from(format!("{count}✓")).style(theme::done()),
        }
    };
    let Some(d) = detail else {
        return if matches!(section, Section::Overview) { Span::raw("") } else { dim("…".to_string()) };
    };
    match section {
        Section::Overview => Span::raw(""),
        Section::Review | Section::Plan => gate(d.latest_approval("awaiting_approval"), None),
        Section::Now => Span::raw(""),
        Section::Stopped => Span::styled("✗", theme::lost()),
        Section::Result => match view.task.state.as_str() {
            "closed" | "done" => Span::styled("✓", theme::done()),
            _ if view.task.waiting_on_you => Span::styled("⏸", theme::flag()),
            _ => Span::raw(""),
        },
        Section::Gate => Span::styled("⏸", theme::flag()),
        Section::Tests => {
            let cases = d.cases();
            gate(d.cases_approval(), (!cases.is_empty()).then_some(cases.len()))
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
            None if pr_url(d).is_some() => Span::from("✓").style(theme::done()),
            None => dim("–".to_string()),
        },
        Section::Activity => dim(d.events.len().to_string()),
        Section::Engines => match view.task.stages.len() {
            0 => Span::raw(""),
            n => Span::from(n.to_string()).style(theme::flag()),
        },
    }
}

/// One row per pack the task runs: the engine it is set to (yours, else the default) and, once
/// it ran, the engine it ran on. `E` on the selected row opens the picker.
fn engines_lines(task: &Task, detail: Option<&TaskDetail>, catalog: Option<&Result<EngineCatalog, String>>, cursor: usize) -> (Vec<Line<'static>>, Option<usize>) {
    let mut lines = vec![heading("Engines · what each stage runs on, for this ticket"), Line::default()];
    let catalog = match catalog {
        Some(Ok(catalog)) => catalog,
        Some(Err(why)) => {
            lines.extend([muted("  this machine does not offer engines".into()), muted(format!("  ({why})"))]);
            return (lines, None);
        }
        None => {
            lines.push(muted("  loading…".into()));
            return (lines, None);
        }
    };
    let packs = catalog.task_packs();
    let selected = cursor.min(packs.len().saturating_sub(1));
    let cursor_row = lines.len() + 1 + selected;
    lines.push(muted(format!("    {:<16} {:<24} {}", "stage", "engine", "ran on")));
    for (i, pack) in packs.iter().enumerate() {
        let (engine, color) = match task.stages.get(&pack.id) {
            Some(engine) => (engine.clone(), PEACH),
            None => (format!("default: {}", pack.engines.default), SUBTEXT0),
        };
        let ran = detail.and_then(|d| d.last_run_of(pack)).map(|r| r.engine.clone().unwrap_or_else(|| "–".into())).unwrap_or_default();
        let missing = task.stages.get(&pack.id).and_then(|id| catalog.engines.iter().find(|e| e.id == *id && !e.available)).map_or("", |_| "  no credential here");
        lines.push(Line::from(vec![
            Span::from(if i == selected { "  ▌ " } else { "    " }).style(theme::border_focus()),
            Span::from(format!("{:<16} ", truncate(&pack.id, 16))).bold(),
            Span::from(format!("{engine:<24} ")).fg(c(color)),
            Span::from(ran).style(theme::label()),
            Span::from(missing).style(theme::lost()),
        ]));
    }
    lines.push(Line::default());
    lines.push(muted("E picks the selected stage's engine · a stage that ran keeps its engine".into()));
    (lines, (!packs.is_empty()).then_some(cursor_row))
}

fn run_glyph(run: &StageRun) -> (&'static str, ratatui::style::Color) {
    match run.status.as_str() {
        "passed" => ("✓", GREEN),
        "failed" => ("✗", RED),
        "running" => ("◐", YELLOW),
        _ => ("·", SUBTEXT0),
    }
}

/// The question the ticket waits on you for, in plain words (`approve the plan?`, `answer 2
/// questions`, `ship this PR?`), with what the machine says about who may answer. None when nothing
/// waits at a gate: the watch and the retro are not gates unless the machine waits on you.
pub fn gate_question(task: &Task, detail: Option<&TaskDetail>) -> Option<String> {
    if matches!(task.state.as_str(), "awaiting_ship" | "reviewing_memory") && !task.waiting_on_you {
        return None;
    }
    let open = detail.and_then(|d| d.open_approval());
    let gate = open.filter(|a| a.kind_or_guess() == "awaiting_approval");
    let plan = match gate {
        Some(a) if a.outcome() == Some("archive") => "archive this ticket?".to_string(),
        Some(a) if a.outcome() == Some("conversation") => "post the reply and close the ticket?".to_string(),
        Some(a) if a.outcome() == Some("split_failed") => "the split failed: keep it whole, send back or reject?".to_string(),
        Some(a) if a.outcome() == Some("split") => {
            let n = a.split_children().len();
            let what = if a.requested["split"]["via"].as_str() == Some("tickets") { format!("{n} ticket{}", if n == 1 { "" } else { "s" }) } else { format!("{n} card{}", if n == 1 { "" } else { "s" }) };
            let who = match a.names_needed() {
                1 => String::new(),
                needed => format!(" · {} different people", if needed == 2 { "two".to_string() } else { needed.to_string() }),
            };
            format!("approve the split ({what})?{who}")
        }
        Some(a) if a.names_needed() > 1 => {
            let needed = a.names_needed();
            let word = if needed == 2 { "two".to_string() } else { needed.to_string() };
            let who = match a.approvers().len() as u64 {
                0 => format!("first of {word} approvers; set LUNA_APPROVER"),
                have if have + 1 == needed => format!("last of {word} approvers"),
                _ => format!("next of {word} approvers"),
            };
            format!("approve the plan? · {who}")
        }
        _ => "approve the plan?".to_string(),
    };
    let release = open.filter(|a| a.is_ship_approval());
    let high = release.is_some_and(|a| a.requested["risk"].as_str() == Some("high")) || (release.is_some() && ship_risk_is_high(detail));
    Some(match task.state.as_str() {
        "awaiting_approval" => plan,
        "awaiting_test_check" => "approve the tests?".to_string(),
        "awaiting_setup" => "approve the setup?".to_string(),
        "awaiting_answers" => match open.map(|a| questions_of(a).len()) {
            Some(n) if n > 0 => format!("answer {n} question{}", if n == 1 { "" } else { "s" }),
            _ => "answer the questions".to_string(),
        },
        "awaiting_ship" if task.route == "review" => "post the verdict?".to_string(),
        "awaiting_ship" if release.is_some() && high => "approve the release? · high risk: a release owner, not one of the plan's approvers".to_string(),
        "awaiting_ship" if release.is_some() => "approve the release?".to_string(),
        "awaiting_ship" if ship_risk_is_high(detail) => "ship this PR? · high risk: a release owner is asked after the checks".to_string(),
        "awaiting_ship" => "ship this PR?".to_string(),
        "reviewing_memory" => "apply the memory rules?".to_string(),
        _ => return None,
    })
}

/// What the decision bar says: the state's glyph and words in the state's role style, and the
/// short note that goes right-aligned.
pub struct BarStatus {
    pub text: String,
    pub style: Style,
    pub note: String,
}

/// The role style of a card's `Look`: the one colour for "needs you", one for running, for stopped, for done.
fn look_style(look: crate::model::Look) -> Style {
    use crate::model::Look;
    match look {
        Look::Escalated => theme::lost(),
        Look::NeedsYou | Look::Stale => theme::needs_you(),
        Look::Working => theme::working(),
        Look::Done => theme::done(),
        Look::Archived => theme::dim(),
        Look::Queued | Look::Paused | Look::Draft => theme::label(),
    }
}

/// `S3 of 4`: the scenario Build is on, from the progress the machine reports; None without any.
pub(crate) fn slice_progress(detail: Option<&TaskDetail>) -> Option<String> {
    let scenarios = &detail?.build_progress.as_ref()?.scenarios;
    let green = scenarios.iter().filter(|s| s.state == "green").count();
    (!scenarios.is_empty()).then(|| format!("S{} of {}", (green + 1).min(scenarios.len()), scenarios.len()))
}

/// The bar's content for a card: the gate's question, `escalated · why`, or what runs
/// (`implementing · S3 of 4 · $0.63 · 2m`); the note holds `1 check flagged` at a plan gate.
pub fn bar_status(task: &Task, detail: Option<&TaskDetail>, now: u64) -> BarStatus {
    let look = task.look();
    let words = if task.state == "escalated" {
        let why = detail
            .and_then(|d| d.approvals.iter().rev().find(|a| a.kind_or_guess() == "escalated" && a.decision.is_none()))
            .and_then(|a| a.requested["escalationDecision"]["reason"].as_str())
            .or(task.reason.as_deref());
        match why {
            Some(why) => format!("escalated · {}", ellipsis(&plain(why), 80)),
            None => "escalated".to_string(),
        }
    } else if let Some(question) = gate_question(task, detail) {
        question
    } else if task.running || task.queued {
        let started = detail.and_then(|d| d.stage_runs.iter().rev().find(|r| r.status == "running")).and_then(|r| r.started_at.as_deref()).map(|at| age(at, now));
        let cost = detail.and_then(TaskDetail::spent_usd).or(task.spent_usd).map(|usd| format!("${usd:.2}"));
        let stage = task.status_label() + &detail.and_then(TaskDetail::running_engine).map(|e| format!(" on {}", plain(e))).unwrap_or_default();
        let parts = [Some(stage), slice_progress(detail), cost, started.filter(|a| !a.is_empty())];
        parts.into_iter().flatten().collect::<Vec<_>>().join(" · ")
    } else {
        task.status_label()
    };
    let mut notes = Vec::new();
    if task.state == "awaiting_approval" {
        let flagged = detail.and_then(|d| d.latest_approval("awaiting_approval")).map_or(0, |a| a.checks().iter().filter(|(_, verdict)| verdict == "flag").count());
        if flagged > 0 {
            notes.push(format!("{flagged} check{} flagged", if flagged == 1 { "" } else { "s" }));
        }
        if detail.and_then(|d| d.open_approval()).and_then(|a| a.outcome()).is_some_and(|o| matches!(o, "split" | "split_failed")) {
            notes.push(":whole keeps it one card".to_string());
        }
    }
    BarStatus { text: format!("{} {}", look_glyph(look), plain(&words)), style: look_style(look).add_modifier(ratatui::style::Modifier::BOLD), note: notes.join(" · ") }
}

/// The bar row: the status first, then the keys that apply (the key in bold), the note right-aligned.
/// Too wide, it drops keys from the lowest priority, then the note, and never the status (which is
/// cut with an ellipsis only when it alone is wider than the row).
pub fn bar_line(width: usize, status: &str, style: Style, keys: &[(String, String)], note: &str) -> Line<'static> {
    const MAX_KEYS: usize = 5;
    let key_w = |(key, label): &(String, String)| cells(key) + 1 + cells(label);
    let needed = |keys: &[(String, String)], note: &str| {
        let keys_w = if keys.is_empty() { 0 } else { 4 + keys.iter().map(key_w).sum::<usize>() + 3 * (keys.len() - 1) };
        cells(status) + keys_w + if note.is_empty() { 0 } else { 2 + cells(note) }
    };
    let mut shown: Vec<(String, String)> = keys.iter().take(MAX_KEYS).cloned().collect();
    let mut note = note.to_string();
    while needed(&shown, &note) > width {
        if shown.pop().is_none() {
            if note.is_empty() {
                break;
            }
            note.clear();
        }
    }
    let status = if cells(status) > width { ellipsis(status, width) } else { status.to_string() };
    let mut spans = vec![Span::from(status.clone()).style(style)];
    let mut used = cells(&status);
    if !shown.is_empty() {
        spans.push(Span::raw("    "));
        used += 4;
    }
    for (i, (key, label)) in shown.iter().enumerate() {
        if i > 0 {
            spans.push(Span::raw("   "));
            used += 3;
        }
        spans.push(Span::from(key.clone()).bold());
        spans.push(Span::from(format!(" {label}")).style(theme::label()));
        used += key_w(&(key.clone(), label.clone()));
    }
    if !note.is_empty() {
        spans.push(Span::raw(" ".repeat(width.saturating_sub(used + cells(&note)))));
        spans.push(Span::from(note).style(theme::flag()));
    }
    Line::from(spans)
}

/// The rule under the bar, drawn across the border cells so it joins the frame: `├────┬────┤`,
/// the `┬` where the rail's separator starts when `tee` says so.
fn rule_line(width: usize, tee: Option<usize>) -> Line<'static> {
    let mut text: String = (0..width)
        .map(|x| match (x, tee) {
            (0, _) => '├',
            (x, _) if x + 1 == width => '┤',
            (x, Some(t)) if x == t => '┬',
            _ => '─',
        })
        .collect();
    if width == 0 {
        text.clear();
    }
    Line::from(text)
}

/// Whether the ship gate's Evidence Pack is High risk: shipping then needs an approver who did not approve the plan.
pub(crate) fn ship_risk_is_high(detail: Option<&TaskDetail>) -> bool {
    // The open or last gate's pack, else the task's own: the same source the Evidence section shows.
    detail.is_some_and(|d| match d.latest_approval("awaiting_ship") {
        Some(a) => a.requested["evidence"]["risk"].as_str() == Some("high"),
        None => d.task.evidence.as_ref().is_some_and(|p| p["risk"].as_str() == Some("high")),
    })
}

pub(crate) fn heading(text: &str) -> Line<'static> {
    Line::from(Span::styled(text.to_string(), theme::heading()))
}

/// A facts row for a reference group: a label column and the value wrapped under itself.
pub(crate) fn fact_row(label: &str, value: &str, width: usize) -> Vec<Line<'static>> {
    let value = plain(value);
    let room = width.saturating_sub(11).max(8);
    crate::text::wrap(&value, room, 0)
        .into_iter()
        .enumerate()
        .map(|(i, part)| Line::from(vec![Span::styled(format!("{:<11}", if i == 0 { label } else { "" }), theme::label()), Span::raw(part.trim_start().to_string())]))
        .collect()
}

/// The Triage Record, as reference: the summary, the kind, the type of work, the size, the priority with its five sub-scores, the
/// preliminary risk, the signals the plan gate flags and who decided. None until triage has written one.
pub(crate) fn record_group(task: &Task, requested: &serde_json::Value, width: usize) -> Option<RefGroup> {
    let record = task.record.as_ref()?;
    let who = match record.decision_by.as_deref() {
        Some("person") => format!("corrected by a person ({})", if record.edited_fields.is_empty() { "record".to_string() } else { record.edited_fields.join(", ") }),
        _ => "decided by the machine".to_string(),
    };
    let mut lines = vec![Line::from(Span::styled(format!("Triage record v{} · {who}", record.version.unwrap_or(1)), theme::label()))];
    if let Some(summary) = record.summary.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.extend(plain(summary).lines().map(|l| Line::from(l.to_string())));
    }
    lines.extend(fact_row("Kind", &record.kind, width));
    if let Some(t) = &record.type_of_work {
        lines.extend(fact_row("Type", t, width));
    }
    lines.extend(fact_row("Size", &record.size, width));
    if let Some(u) = &record.urgency_detail {
        let s = &u.sub_scores;
        lines.extend(fact_row("Priority", &format!("{} (who {}, what {}, impact {}, time {}, demand {})", u.priority, s.who, s.what, s.impact, s.time, s.demand), width));
    }
    if let Some(r) = &record.risk_prelim {
        lines.extend(fact_row("Risk", r, width));
    }
    let flagged = triage_flags(requested);
    if !flagged.is_empty() {
        lines.extend(fact_row("Flagged", &format!("{} (T corrects the record)", flagged.join(", ")), width));
    }
    let size = format!("{} · {}", plain(&record.kind), plain(&record.size));
    Some(RefGroup::new("record", "Record", size, lines))
}

/// The triage fields the plan gate flags (`triage.size` is `size`).
pub(crate) fn triage_flags(requested: &serde_json::Value) -> Vec<String> {
    requested["flagged"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).filter_map(|v| v.strip_prefix("triage.")).map(plain).collect()).unwrap_or_default()
}

/// The code map a plan stage opened with, as reference: components, files by role (a plain string is a file to change), entry points,
/// owners and whether the graph it came from is stale. Only a plan stage's gate has one (it carries a lane); without a map the gate says why.
pub(crate) fn map_group(requested: &serde_json::Value, width: usize) -> Option<RefGroup> {
    if !requested["lane"].is_string() {
        return None;
    }
    let map = &requested["map"];
    if !map.is_object() {
        let why = plain(requested["mapNote"].as_str().unwrap_or("the plan was written without one"));
        return Some(RefGroup::new("map", "Code map", "none", fact_row("", &format!("no code map: {why}"), width)));
    }
    let row = |label: &str, value: String| fact_row(label, &value, width);
    let list = |v: &serde_json::Value| -> String { json_list(v).join(", ") };
    let mut lines = row("Components", list(&map["components"]));
    let mut files = 0;
    for role in ["change", "read", "test"] {
        for file in map["files"].as_array().into_iter().flatten() {
            let (path, file_role) = match file.as_str() {
                Some(path) => (Some(path), "change"),
                None => (file["path"].as_str(), file["role"].as_str().unwrap_or("change")),
            };
            if let Some(path) = path.filter(|_| file_role == role) {
                files += 1;
                lines.push(Line::from(vec![Span::styled(format!("{role:<7}"), theme::label()), Span::raw(truncate_middle(&plain(path), width.saturating_sub(7)))]));
            }
        }
    }
    if map["entry_points"].as_array().is_some_and(|a| !a.is_empty()) {
        lines.extend(row("Entry", list(&map["entry_points"])));
    }
    lines.extend(row("Owners", if map["owners"].as_array().is_some_and(|a| !a.is_empty()) { list(&map["owners"]) } else { "none found".to_string() }));
    if map["stale"].as_bool() == Some(true) {
        let behind = map["behind"].as_u64().map(|n| n.to_string()).unwrap_or_else(|| "many".into());
        lines.extend(fact_row("", &format!("stale: the graph is {behind} commits behind the default branch; treat the map as a lead"), width));
    }
    Some(RefGroup::new("map", "Code map", format!("{files} file{}", if files == 1 { "" } else { "s" }), lines))
}

/// The plan's assumptions, as reference.
pub(crate) fn assumptions_group(requested: &serde_json::Value, width: usize) -> Option<RefGroup> {
    let items = json_list(&requested["assumptions"]);
    if items.is_empty() {
        return None;
    }
    let lines = items.iter().flat_map(|item| crate::text::wrap(item, width.saturating_sub(4).max(8), 0).into_iter().enumerate().map(|(i, l)| Line::from(format!("{}{}", if i == 0 { "• " } else { "  " }, l.trim_start())))).collect();
    Some(RefGroup::new("assumptions", "Assumptions", items.len().to_string(), lines))
}

/// Where the card lives: its repo, branch, tracker link, SLA and the engines it was told to use.
pub(crate) fn card_group(task: &Task, detail: Option<&TaskDetail>, width: usize, now: u64) -> RefGroup {
    let mut lines = fact_row("Repo", task.repo_path.as_deref().unwrap_or("none (R sets one)"), width);
    if let Some(branch) = &task.branch {
        lines.extend(fact_row("Branch", branch, width));
    }
    if let Some(source) = &task.source {
        lines.extend(fact_row("Source", &source.detail_line(), width));
    }
    match &task.jira {
        Some(jira) => lines.extend(fact_row("Jira", &jira.summary(now), width)),
        None => lines.extend(fact_row("Jira", "none (J links an issue)", width)),
    }
    let engines: Vec<String> = task.stages.iter().map(|(pack, engine)| format!("{pack} {engine}")).collect();
    let running = detail.and_then(TaskDetail::running_engine).map(|e| format!("running on {e}"));
    match (engines.is_empty(), running) {
        (true, None) => {}
        (true, Some(running)) => lines.extend(fact_row("Engines", &running, width)),
        (false, running) => lines.extend(fact_row("Engines", &[Some(engines.join(", ")), running].into_iter().flatten().collect::<Vec<_>>().join(" · "), width)),
    }
    RefGroup::new("card", "Card", task.repo_path.as_deref().map(|r| r.rsplit('/').next().unwrap_or(r).to_string()).unwrap_or_default(), lines)
}

pub(crate) fn proposal_heading(text: &str) -> Line<'static> {
    Line::from(Span::styled(text.to_string(), theme::heading()))
}

/// `Ticket     the ticket changed since this was written: scope edited, priority changed (2026-11-05 12:00)`: the field names and the time the machine kept, through `plain`.
pub fn ticket_changed_line(requested: &serde_json::Value) -> Option<String> {
    let changed = requested.get("ticketChanged")?;
    let words: Vec<String> = changed
        .get("fields")?
        .as_array()?
        .iter()
        .filter_map(|f| f.as_str())
        .map(|f| match f {
            "scope" => "scope edited".to_string(),
            "priority" => "priority changed".to_string(),
            other => plain(other),
        })
        .collect();
    if words.is_empty() {
        return None;
    }
    let at = changed.get("at").and_then(|a| a.as_str()).map(|a| format!(" ({})", plain(a))).unwrap_or_default();
    Some(format!("Ticket     the ticket changed since this was written: {}{at}", words.join(", ")))
}

pub(crate) fn muted(text: String) -> Line<'static> {
    Line::from(Span::from(text).style(theme::label()))
}

/// `Plan · triage #2 · approved 2h ago`: which run produced a gate's content and what you did.
pub(crate) fn gate_header(title: &str, stage: &str, approval: Option<&Approval>, detail: Option<&TaskDetail>, now: u64) -> Line<'static> {
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
        (Some("rejected"), Some(at)) => (format!("rejected {} ago", age(at, now)), RED),
        (Some("rejected"), None) => ("rejected".to_string(), RED),
        (Some(decision), Some(at)) => (format!("{} {} ago", decision.replace('_', " "), age(at, now)), GREEN),
        (Some(decision), None) => (decision.replace('_', " "), GREEN),
    };
    Line::from(vec![
        Span::from(title.to_string()).style(theme::heading()),
        Span::from(attempt).style(theme::label()),
        Span::from(" · ").style(theme::label()),
        Span::from(what).fg(c(color)),
    ])
}

/// The criteria summary: one row per criterion with its plan, cases and verify columns.
pub(crate) fn criteria_table(rows: &[CriterionRow], width: usize) -> Vec<Line<'static>> {
    if rows.is_empty() {
        return Vec::new();
    }
    let name_w = rows.iter().map(|r| r.criterion.chars().count()).max().unwrap_or(8).clamp(8, width.saturating_sub(28).max(8));
    let mut lines = vec![Line::from(vec![
        Span::from(format!("{:<w$}", "Criteria", w = name_w + 2)).style(theme::heading()),
        Span::from("  plan   cases   verify").style(theme::label()),
    ])];
    for row in rows {
        let plan = match row.planned {
            Some(true) => Span::from("  ✓   ").style(theme::done()),
            Some(false) => Span::from("  ✗   ").style(theme::lost()),
            None => Span::from("  –   ").style(theme::label()),
        };
        let cases = if row.cases == 0 {
            Span::from("   –     ").style(theme::label())
        } else {
            Span::from(format!("  {:<3}    ", row.cases))
        };
        let verify = match row.verify {
            Some((ok, total)) if ok == total => Span::from("✓").style(theme::done()),
            Some((ok, total)) => Span::from(format!("✗ {ok} of {total}")).style(theme::lost()),
            None if row.planned == Some(false) => Span::from("–    not in the plan").style(theme::label()),
            None if row.cases == 0 && row.planned.is_some() => Span::from("–    no case proves it").style(theme::label()),
            None => Span::from("–").style(theme::label()),
        };
        lines.push(Line::from(vec![
            Span::from(format!("  {:<w$}", truncate(&plain(&row.criterion), name_w), w = name_w)),
            plan,
            cases,
            verify,
        ]));
    }
    lines
}

/// Overview: the status line, the criteria summary, the facts, then the ticket's own text and
/// whatever an open gate asks that has no section of its own (setup, questions, rules).
/// Where the card came from and what Intake still needs: its sources, reporter, followers, project, owners, attachments, merged duplicates, and the
/// open Intake gate's missing list with the command that answers it. Every text is a stranger's, so each goes through `plain` and a cap.
pub(crate) fn origin_lines(task: &Task, detail: Option<&TaskDetail>) -> Vec<Line<'static>> {
    const LISTED: usize = 5;
    let text = |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_str()).map(|s| truncate(&plain(s), 60));
    let mut lines = Vec::new();
    for s in task.sources.iter().take(LISTED) {
        let line = match text(s, "kind").or_else(|| text(s, "type")).as_deref() {
            Some("github") | Some("github_pr") => format!("GitHub {}#{}", text(s, "repo").unwrap_or_default(), s.get("number").and_then(|n| n.as_u64()).unwrap_or(0)),
            Some("jira") => format!("Jira {}", text(s, "key").unwrap_or_default()),
            Some(other) => other.to_string(),
            None => "unknown source".to_string(),
        };
        lines.push(muted(format!("Source     {line}")));
    }
    if task.sources.len() > LISTED {
        lines.push(muted(format!("Source     … and {} more", task.sources.len() - LISTED)));
    }
    if let Some(r) = &task.reporter {
        let channel = text(r, "channel").map(|c| format!(" ({c})")).unwrap_or_default();
        lines.push(muted(format!("Reporter   {}{channel}", text(r, "name").or_else(|| text(r, "id")).unwrap_or_default())));
    }
    let list = |items: &[String]| items.iter().take(LISTED).map(|s| truncate(&plain(s), 40)).collect::<Vec<_>>().join(", ");
    if !task.followers.is_empty() {
        lines.push(muted(format!("Followers  {}", list(&task.followers))));
    }
    if let Some(project) = &task.project {
        lines.push(muted(format!("Project    {}", truncate(&plain(project), 40))));
    }
    if !task.owners.is_empty() {
        lines.push(muted(format!("Owners     {}", list(&task.owners))));
    }
    for a in task.attachments.iter().take(LISTED) {
        lines.push(muted(format!("Attached   {}", text(a, "name").unwrap_or_default())));
    }
    if !task.merged.is_empty() {
        let ids = task.merged.iter().take(LISTED).filter_map(|m| text(m, "id")).map(|id| id.chars().take(8).collect::<String>()).collect::<Vec<_>>().join(", ");
        lines.push(muted(format!("Merged     {ids}")));
    }
    let short = |id: &str| plain(id).chars().take(8).collect::<String>();
    if let Some(into) = &task.merged_into {
        lines.push(muted(format!("Merged into  {}", short(into))));
    }
    if !task.related.is_empty() {
        lines.push(muted(format!("Related    {}", task.related.iter().take(LISTED).map(|id| short(id)).collect::<Vec<_>>().join(", "))));
    }
    if let Some(line) = detail.and_then(|d| d.open_approval()).and_then(|a| ticket_changed_line(&a.requested)) {
        lines.push(muted(line));
    }
    lines
}

/// What an Intake gate asks, in the gate's words: the duplicate candidates with how to pick one, or what the card still lacks with the
/// command that gives it. Empty at any other gate.
pub(crate) fn intake_gate_lines(detail: Option<&TaskDetail>) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if let Some(gate) = detail.and_then(|d| d.open_approval()).filter(|a| a.requested.get("kind").and_then(|k| k.as_str()) == Some("dedup")) {
        lines.push(muted("Intake     could this be a duplicate? pick with :dedup duplicate <slot> | related <slots> | neither".to_string()));
        lines.extend(crate::intake::candidates(&gate.requested).iter().map(|c| muted(format!("           {}", plain(&c.line())))));
    }
    if let Some(gate) = detail.and_then(|d| d.open_approval()).filter(|a| a.requested.get("kind").and_then(|k| k.as_str()) == Some("context")) {
        let words = gate
            .requested
            .get("missing")
            .and_then(|m| m.as_array())
            .map(|names| {
                names
                    .iter()
                    .filter_map(|n| n.as_str())
                    .map(|n| match n {
                        "repository" => "which repository it is for",
                        "reporter" => "a way to reach the reporter",
                        "text" => "more detail on what is wrong",
                        _ => "more context",
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        lines.push(muted(format!("Intake     waiting for: {words}")));
        lines.push(muted("           give it with :context repo <path> · project <KEY> · text <more>".to_string()));
    }
    lines
}

/// The blocks a gate carries that no section of its own shows: its error and note, the proposed rules (memory), the proposed
/// `luna.yaml` with its base image, proof and notes (setup), and the triage questions with the machine's suggested answers.
pub(crate) fn gate_blocks(approval: &Approval, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let requested = &approval.requested;
    if let Some(error) = requested["error"].as_str() {
        lines.extend([Line::default(), Line::from(Span::from("Error").style(theme::lost()).bold())]);
        lines.extend(plain(error).lines().map(|l| Line::from(format!("  {l}")).style(theme::lost())));
    }
    if let Some(note) = requested["note"].as_str() {
        lines.push(muted(plain(note)));
    }
    let rules = rules_lines(&requested["rules"], width.saturating_sub(4).max(20));
    if !rules.is_empty() {
        lines.extend([Line::default(), proposal_heading("Proposed rules (a applies, A skips)")]);
        lines.extend(rules.iter().map(|l| Line::from(format!("  {l}"))));
    }
    if let Some(config) = requested["config"].as_str() {
        lines.extend([Line::default(), proposal_heading("Proposed luna.yaml (a writes it to the repo, r sends it back)")]);
        lines.extend(plain(config).lines().map(|l| Line::from(format!("  {l}"))));
        // The base image, singled out of the long proposal: it runs the stage's process, and approving the setup does not approve it.
        if let Some(base) = requested["sandboxBase"].as_str() {
            lines.extend([Line::default(), proposal_heading("Base image (not approved by this gate)")]);
            lines.push(Line::from(format!("  {}", crate::model::plain(base, 400))).style(theme::lost()));
        }
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
    lines
}

fn overview_lines(task: &Task, detail: Option<&TaskDetail>, width: usize, now: u64, tasks: &[Task]) -> Vec<Line<'static>> {
    let look = task.look();
    let mut status = vec![Span::from(format!("{} {}", look_glyph(look), task.status_label())).fg(c(look_color(look))).bold()];
    if let Some(run) = detail.and_then(|d| d.stage_runs.last()) {
        status.push(Span::from(format!(" #{}", run.attempt)).style(theme::label()));
    }
    if task.retries.total > 1 {
        status.push(Span::from(format!(" · run {} of 3", task.retries.total)).style(theme::flag()));
    }
    if task.retries.stronger > 0 {
        let note = if task.retries.stronger_next { " · stronger engine next" } else { " · stronger engine used" };
        status.push(Span::from(note).style(theme::flag()));
    }
    if let Some(spent) = detail.and_then(TaskDetail::spent_usd).or(task.spent_usd) {
        status.push(Span::from(format!(" · ${spent:.2}")).style(theme::label()));
    }
    status.push(Span::from(format!(" · {}", age(&task.updated_at, now))).style(theme::label()));
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
    lines.extend(origin_lines(task, detail));
    if let Some(stage) = &task.resume_to {
        lines.push(muted(format!("Continues  {}", continues_line(&task.state, stage).trim_start_matches("Continues at: "))));
    }
    lines.extend(stack_lines(task, detail, tasks));
    if let Some(reason) = &task.archive_reason {
        lines.push(muted(if reason == "split" { "Archived   split into smaller changes".to_string() } else { format!("Archived   {reason}") }));
    } else if let Some(reason) = &task.reason {
        lines.push(Line::from(format!("Why        {reason}")).fg(look_color(look)));
    }
    if task.retries.total > 0 {
        let r = &task.retries;
        lines.push(muted(format!("Failures   verify {} · e2e {} · ci {}", r.verify, r.e2e, r.ci)));
    }

    lines.extend([Line::default(), heading("Description")]);
    if task.description.trim().is_empty() {
        lines.push(muted("  (none yet, e adds one)".into()));
    } else {
        lines.extend(plain(&task.description).lines().map(|l| Line::from(format!("  {l}"))));
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
            lines.push(Line::from(vec![Span::from("Jira       ").style(theme::label()), Span::from(jira.summary(now))]));
            if let Some(blocked) = &jira.blocked {
                lines.push(Line::from(Span::from(format!("           ⚠ blocked: {}", blocked.line())).style(theme::lost()).bold()));
            }
        }
        None => lines.push(muted("Jira       —  J links an issue".to_string())),
    }
    if let Some(sla) = &task.sla {
        let parts = sla.parts(now);
        if !parts.is_empty() {
            let mut spans = vec![Span::from("SLA        ").style(theme::label())];
            for (i, (text, tone)) in parts.into_iter().enumerate() {
                if i > 0 {
                    spans.push(Span::from(" · ").style(theme::label()));
                }
                spans.push(match tone {
                    Tone::Over => Span::from(text).style(theme::lost()).bold(),
                    Tone::Warn => Span::from(text).style(theme::working()),
                    Tone::Plain => Span::from(text),
                });
            }
            lines.push(Line::from(spans));
        }
    }
    lines
}

/// Text from a run or a model, made safe for a terminal: every control character (an escape sequence included) becomes a space.
pub(crate) fn plain(text: &str) -> String {
    text.chars().map(|ch| if crate::text::is_unsafe(ch) && ch != '\n' { ' ' } else { ch }).collect()
}

/// Plan: the latest triage plan, decided or not, then what happened to it. The brief, the criteria and the slices are the
/// page; the outcome and risk, the triage record, the checks, the code map, the assumptions and the card's facts are reference.
pub(crate) fn plan_page(task: &Task, detail: Option<&TaskDetail>, ref_width: usize, now: u64) -> Page {
    let approval = detail.and_then(|d| d.latest_approval("awaiting_approval"));
    // A gate that carries triage's outcome came from triage; the plan stage's has a lane or a risk.
    let stage = if approval.is_some_and(|a| a.outcome().is_none() && (a.requested["lane"].is_string() || a.requested["risk"].is_object())) { "test_design" } else { "triage" };
    let mut lines = vec![gate_header("Plan", stage, approval, detail, now)];
    let Some(approval) = approval else {
        lines.push(Line::default());
        lines.push(muted("  no plan yet: triage and the planner write one once the ticket starts".into()));
        return Page::of(lines);
    };
    let requested = &approval.requested;
    let facts = gate_main_facts(approval);
    if !facts.is_empty() {
        lines.push(Line::default());
        lines.extend(facts);
    }
    if let Some(reply) = approval.reply() {
        lines.extend([Line::default(), proposal_heading("Reply (a posts it where the ticket came from and closes it)")]);
        lines.extend(plain(&reply).lines().map(|l| Line::from(format!("  {l}"))));
    }
    if approval.outcome() == Some("archive") {
        lines.extend([Line::default(), proposal_heading("Archive (a archives the ticket)")]);
        lines.push(Line::from(format!("  {}", plain(&approval.archive_reason().unwrap_or_else(|| "no reason given".into())))));
    }
    lines.extend([Line::default(), proposal_heading("Brief")]);
    match requested["brief"].as_str().filter(|b| !b.trim().is_empty()) {
        Some(brief) => lines.extend(plain(brief).lines().map(|l| Line::from(format!("  {l}")))),
        None => lines.push(muted("  (none)".into())),
    }
    for (title, items) in [("Criteria to build", json_list(&requested["criteria"])), ("Slices", slice_lines(&requested["slices"]))] {
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
            "e edits the brief, criteria and assumptions · slices stay as the planner wrote them".to_string()
        } else {
            "read-only now that Build has started · r at the next gate sends the ticket back to triage".to_string()
        },
    ));
    let width = ref_width;
    let groups = [gate_ref_group(approval, width), record_group(task, requested, width), checks_group(approval), map_group(requested, width), assumptions_group(requested, width), Some(card_group(task, detail, width, now))];
    Page { main: lines, groups: groups.into_iter().flatten().collect() }
}

/// The gate's outcome, its risk with the three scores, what raised or overrode it, as reference. None for a gate that says none of it.
pub(crate) fn gate_ref_group(approval: &Approval, width: usize) -> Option<RefGroup> {
    let mut lines = Vec::new();
    if let Some(outcome) = approval.outcome_line() {
        lines.extend(fact_row("Outcome", &outcome, width));
    }
    let level = approval.requested["risk"]["level"].as_str().map(plain);
    if let Some(risk) = approval.risk_line() {
        lines.extend(fact_row("Risk", &risk, width));
    }
    if let Some(line) = approval.risk_raised_line() {
        lines.extend(fact_row("Raised", &line, width));
    }
    if let Some(line) = approval.risk_override_line() {
        lines.extend(fact_row("Override", &line, width));
    }
    if let Some(rule) = approval.rule_line() {
        lines.extend(fact_row("Rule", &rule, width));
    }
    (!lines.is_empty()).then(|| RefGroup::new("risk", "Risk", level.unwrap_or_else(|| "see gate".into()), lines))
}

/// The plan stage's checks, one line each with its verdict: `✓` proceeds, `⚑` is flagged, `?` is unsure.
pub(crate) fn checks_group(approval: &Approval) -> Option<RefGroup> {
    let checks = approval.checks();
    if checks.is_empty() {
        return None;
    }
    let flagged = checks.iter().filter(|(_, verdict)| matches!(verdict.as_str(), "flag" | "ask")).count();
    let lines = checks
        .iter()
        .map(|(name, verdict)| {
            let glyph = match verdict.as_str() {
                "proceed" => "✓",
                "flag" => "⚑",
                "ask" => "?",
                _ => "–",
            };
            Line::from(format!("{glyph} {name} {}", plain(verdict)))
        })
        .collect();
    let summary = if flagged == 0 { "all clear".to_string() } else { format!("{flagged} flagged") };
    Some(RefGroup::new("checks", "Checks", summary, lines))
}

/// The gate's own words that the person reads with the plan: the rule on who may approve, who has, and a split's children.
pub(crate) fn gate_main_facts(approval: &Approval) -> Vec<Line<'static>> {
    let label = |name: &str| Span::from(format!("{name:<11}")).style(theme::label());
    let mut lines = Vec::new();
    if let Some(approvals) = approval.approvals_line() {
        lines.push(Line::from(vec![label("Approvals"), Span::from(approvals)]));
    }
    lines.extend(split_facts(approval));
    lines
}

/// A split gate: the size against the limit, the reason there is no split, each child (number, title, estimate, what it follows, criteria),
/// how the approval is made (cards or tickets) and whether the split was judged. Every text is the machine's or a model's and goes through `plain`.
fn split_facts(approval: &Approval) -> Vec<Line<'static>> {
    if !matches!(approval.outcome(), Some("split" | "split_failed")) {
        return Vec::new();
    }
    let label = |name: &str| Span::from(format!("{name:<11}")).style(theme::label());
    let r = &approval.requested;
    let mut lines = Vec::new();
    let size = &r["size"];
    let loc = size["planned"].as_f64().or_else(|| size["estLoc"].as_f64());
    if let (Some(loc), Some(hard)) = (loc, size["limit"]["hard"].as_f64()) {
        lines.push(Line::from(vec![label("Size"), Span::from(format!("about {loc:.0} lines, over the limit of {hard:.0} by {:.0}", (loc - hard).max(0.0))).style(theme::flag())]));
    }
    if let Some(reason) = r["reason"].as_str() {
        lines.push(Line::from(vec![label("Reason"), Span::from(plain(reason)).style(theme::lost())]));
    }
    for issue in r["split"]["issues"].as_array().into_iter().flatten().filter_map(|i| i.as_str()) {
        lines.push(Line::from(vec![label("Issue"), Span::from(plain(issue)).style(theme::flag())]));
    }
    for (i, child) in approval.split_children().iter().enumerate() {
        let after: Vec<String> = child["depends_on"].as_array().into_iter().flatten().filter_map(|d| d.as_u64()).map(|d| d.to_string()).collect();
        let criteria = child["acceptance_criteria"].as_array().map_or(0, |a| a.len());
        let mut text = format!("{}. {} · about {} lines", i + 1, plain(child["title"].as_str().unwrap_or("")), child["est_loc"].as_u64().unwrap_or(0));
        if !after.is_empty() {
            text.push_str(&format!(" · after {}", after.join(", ")));
        }
        text.push_str(&format!(" · {criteria} criteri{}", if criteria == 1 { "on" } else { "a" }));
        lines.push(Line::from(vec![label(if i == 0 { "Children" } else { "" }), Span::from(text)]));
    }
    if r["outcome"].as_str() == Some("split") {
        let via = if r["split"]["via"].as_str() == Some("tickets") { "creates tickets in the tracker" } else { "creates cards" };
        let judged = if r["split"]["judged"].as_bool() == Some(true) { "judged by split_check" } else { "checked by script only" };
        lines.push(Line::from(vec![label("Approving"), Span::from(format!("{via} · {judged}"))]));
    }
    lines
}

/// What the machine says the card waits for: the `text` of its latest `card.held` event, unless a `card.released` came after it.
fn held_text(detail: Option<&TaskDetail>) -> Option<String> {
    let last = detail?.events.iter().rev().find(|e| e.kind == "card.held" || e.kind == "card.released")?;
    if last.kind != "card.held" {
        return None;
    }
    last.payload["text"].as_str().filter(|t| !t.trim().is_empty()).map(String::from)
}

/// A card's place in a split or a stack: where it came from, what it waits for, what it is built on, what it was split into. Nothing for a card with none of them.
fn stack_lines(task: &Task, detail: Option<&TaskDetail>, tasks: &[Task]) -> Vec<Line<'static>> {
    let short = |id: &str| plain(&id.chars().take(8).collect::<String>());
    let find = |id: &str| tasks.iter().find(|t| t.id == id);
    let mut lines = Vec::new();
    if let (Some(from), Some(part)) = (&task.split_from, &task.split_part) {
        let title = find(from).map(|o| format!(" {}", plain(&o.title))).unwrap_or_default();
        lines.push(muted(format!("Stack      Part {} of {} of {}{}", part.n, part.of, short(from), title)));
    }
    for dep in &task.depends_on {
        lines.push(muted(format!("Stack      Depends on {}", short(dep))));
    }
    if let Some(base) = &task.base {
        lines.push(muted(format!("Stack      Stacked on {} ({})", short(&base.card), plain(&base.branch))));
    }
    if let Some(floor) = task.risk_floor.as_deref().filter(|_| task.split_from.is_some()) {
        lines.push(muted(format!("Stack      Risk floor {} (its origin's: a part is never lower)", plain(floor))));
    }
    if task.start_when_ready && task.state == "draft" {
        match held_text(detail) {
            Some(text) => lines.push(muted(format!("Stack      {}", plain(&text).replace('\n', " ")))),
            None => lines.push(muted("Stack      Waiting: held until its dependencies have an open PR or have merged".to_string())),
        }
    }
    let (known, missing): (Vec<&String>, Vec<&String>) = task.split_into.iter().partition(|i| find(i).is_some());
    for id in known {
        let kid = find(id).expect("partitioned as present");
        let part = kid.split_part.as_ref().map(|p| format!("part {}/{} ", p.n, p.of)).unwrap_or_default();
        lines.push(muted(format!("Stack      Split into {} {}{} ({})", short(id), part, plain(&kid.title), kid.status_label())));
    }
    if !missing.is_empty() {
        lines.push(muted(format!("Stack      Split into {}", missing.iter().map(|i| short(i)).collect::<Vec<_>>().join(", "))));
    }
    lines
}

/// Tests: the cases under the criterion each proves, with verifying's verdict on each.
fn tests_lines(task: &Task, detail: Option<&TaskDetail>, width: usize, now: u64) -> Vec<Line<'static>> {
    let approval = detail.and_then(|d| d.cases_approval());
    let mut lines = vec![gate_header("Tests", "test_design", approval, detail, now)];
    let Some(d) = detail.filter(|_| approval.is_some()) else {
        lines.push(Line::default());
        lines.push(muted("  no cases yet: test_design writes them with the plan".into()));
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
            Span::from(plain(criterion)).style(theme::heading()),
            Span::from(format!("   {} case{}", cases.len(), if cases.len() == 1 { "" } else { "s" })).style(theme::label()),
        ]));
        for case in cases {
            lines.push(case_line(case, title_w));
        }
    }
    lines.push(Line::default());
    lines.push(muted(
        if matches!(task.state.as_str(), "awaiting_test_check" | "awaiting_approval") {
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
        Span::from(format!("{:<w$}", truncate(&plain(&case.title), title_w), w = title_w)),
        Span::from(format!("   {}", plain(&case.approach))).style(theme::label()),
    ])
}

/// Runs: a table of stage runs, then the selected run's error and files. With the index of
/// the selected row, so the pane can keep it in view.
fn runs_lines(task: &Task, detail: Option<&TaskDetail>, cursor: usize, width: usize, now: u64) -> (Vec<Line<'static>>, Option<usize>) {
    let Some(d) = detail else {
        return (vec![heading("Runs"), Line::default(), muted("  loading…".into())], None);
    };
    let mut head = vec![Span::from("Runs").style(theme::heading()), Span::from(format!(" · {}", d.stage_runs.len())).style(theme::label())];
    if let Some(spent) = d.spent_usd() {
        head.push(Span::from(format!(" · ${spent:.2} spent")).style(theme::label()));
    }
    if let Some(worked) = task.worked_ms {
        head.push(Span::from(format!(" · {} worked", crate::model::fmt_ms(Some(worked)))).style(theme::label()));
    }
    let mut lines = vec![Line::from(head), Line::default()];
    if d.stage_runs.is_empty() {
        lines.push(muted("  nothing has run yet".into()));
        return (lines, None);
    }
    lines.push(muted(format!("    {:<14} {:>2}  {:<8} {:>6}  {:>7}  {:>5}", "stage", "#", "status", "took", "cost", "turns")));
    let selected = cursor.min(d.stage_runs.len() - 1);
    let cursor_row = lines.len() + selected;
    for (i, run) in d.stage_runs.iter().enumerate() {
        let (_, color) = run_glyph(run);
        let on = i == selected;
        lines.push(Line::from(vec![
            Span::from(if on { "  ▌ " } else { "    " }).style(theme::border_focus()),
            Span::from(format!("{:<14} {:>2}  ", truncate(&run.stage, 14), run.attempt)).bold(),
            Span::from(format!("{:<8}", run.status)).fg(c(color)),
            Span::from(format!(
                " {:>6}  {:>7}  {:>5}",
                run.took(now).unwrap_or_else(|| "–".into()),
                run.cost_usd.map_or("–".to_string(), |v| format!("${v:.2}")),
                run.turns.map_or("–".to_string(), |t| t.to_string())
            ))
            .style(theme::label()),
        ]));
    }
    let run = &d.stage_runs[selected];
    lines.push(Line::default());
    lines.push(Line::from(vec![
        Span::from(format!("─ {} #{} ", run.stage, run.attempt)).style(theme::heading()),
        Span::from("─".repeat(width.saturating_sub(run.stage.chars().count() + 8))).fg(c(MUTED)),
    ]));
    match run_error(d, run) {
        Some(error) => lines.extend(plain(&error).lines().take(8).map(|l| Line::from(format!("  {l}")).style(theme::lost()))),
        None if run.status == "running" => lines.push(muted("  running · f follows its container in herdr".into())),
        None => lines.push(muted("  no error recorded".into())),
    }
    if !run.cases.is_empty() {
        lines.push(Line::default());
        for case in &run.cases {
            let (glyph, color) = if case.ok { ("✓", GREEN) } else { ("✗", RED) };
            lines.push(Line::from(vec![Span::from(format!("  {glyph} ")).fg(c(color)), Span::from(plain(&case.title))]));
        }
    }
    let files: Vec<&crate::model::Artifact> = d.artifacts.iter().filter(|a| a.stage_run_id.is_some() && a.stage_run_id == run.id).collect();
    if !files.is_empty() {
        lines.push(Line::default());
        lines.push(muted(format!("  {} file{}", files.len(), if files.len() == 1 { "" } else { "s" })));
        lines.extend(files.iter().map(|a| muted(format!("    {} {}", plain(&a.kind), plain(&a.path)))));
    }
    lines.push(Line::default());
    lines.push(muted("j/k pick a run · J/K scroll · f follows the running one in herdr".into()));
    (lines, Some(cursor_row))
}

/// The error a run finished with, as the activity log recorded it.
pub(crate) fn run_error(detail: &TaskDetail, run: &StageRun) -> Option<String> {
    detail.events.iter().rev().find_map(|e| {
        let p = &e.payload;
        (e.kind == "stage.finished" && p["stage"].as_str() == Some(run.stage.as_str()) && p["attempt"].as_u64() == Some(u64::from(run.attempt)))
            .then(|| p["error"].as_str().or_else(|| p["detail"]["error"].as_str()).map(str::to_string))
            .flatten()
    })
}

/// The Diff section before and after its patch: the heading and file list (`lines`), the
/// selected file's patch as text (materialised by the caller, only where it shows), and the
/// lines under it. `cursor_row` indexes the selected file inside `lines`.
struct DiffHead<'a> {
    lines: Vec<Line<'static>>,
    cursor_row: Option<usize>,
    patch: Option<&'a str>,
    tail: Vec<Line<'static>>,
}

/// Diff: the branch's files with their counts, then the selected file's patch.
fn diff_head<'a>(task: &Task, diff: Option<&'a TaskDiff>, cursor: usize, width: usize) -> DiffHead<'a> {
    let none = |lines| DiffHead { lines, cursor_row: None, patch: Some(""), tail: Vec::new() };
    let Some(branch) = &task.branch else {
        return none(vec![heading("Diff"), Line::default(), muted("  no branch yet: Build creates one".into())]);
    };
    let Some(diff) = diff else {
        return none(vec![heading("Diff"), Line::default(), muted(format!("  loading {branch}…"))]);
    };
    let added: u64 = diff.files.iter().map(|f| f.added).sum();
    let removed: u64 = diff.files.iter().map(|f| f.removed).sum();
    let mut lines = vec![Line::from(vec![
        Span::from("Diff").style(theme::heading()),
        Span::from(format!(" · {} against {} · {} file{} · ", diff.head, diff.base, diff.files.len(), if diff.files.len() == 1 { "" } else { "s" }))
            .style(theme::label()),
        Span::from(format!("+{added}")).style(theme::done()),
        Span::from(format!(" −{removed}")).style(theme::lost()),
    ])];
    lines.push(Line::default());
    if diff.files.is_empty() {
        lines.push(muted("  no changes yet".into()));
        return none(lines);
    }
    let selected = cursor.min(diff.files.len() - 1);
    let cursor_row = lines.len() + selected;
    let path_w = diff.files.iter().map(|f| f.path.chars().count()).max().unwrap_or(10).clamp(10, width.saturating_sub(22).max(10));
    for (i, file) in diff.files.iter().enumerate() {
        let on = i == selected;
        lines.push(Line::from(vec![
            Span::from(if on { "  ▌ " } else { "    " }).style(theme::border_focus()),
            Span::from(format!("{} ", file.status)).fg(c(match file.status.as_str() {
                "A" => GREEN,
                "D" => RED,
                _ => YELLOW,
            })),
            Span::from(format!("{:<w$}", truncate(&file.path, path_w), w = path_w)),
            Span::from(format!("  +{:<4}", file.added)).style(theme::done()),
            Span::from(format!(" −{}", file.removed)).style(theme::lost()),
        ]));
    }
    let file = &diff.files[selected];
    lines.push(Line::default());
    lines.push(Line::from(vec![
        Span::from(format!("─ {} ", file.path)).style(theme::heading()),
        Span::from("─".repeat(width.saturating_sub(file.path.chars().count() + 4))).fg(c(MUTED)),
    ]));
    let patch = diff.patch.as_deref().filter(|_| diff.file.as_deref() == Some(file.path.as_str()));
    let mut tail = Vec::new();
    if patch.is_some() && diff.truncated {
        tail.push(muted("  … truncated: the machine sends at most 512 KB of a patch".into()));
    }
    tail.push(Line::default());
    tail.push(muted("j/k pick a file · J/K scroll · o opens it".into()));
    DiffHead { lines, cursor_row: Some(cursor_row), patch, tail }
}

/// Verify's report: the open findings by level, each with where it is and the plan criterion it is about, then the browser run by scenario.
/// Every text is the reviewer's or a container's, so it goes through `plain`.
fn verify_report_lines(detail: &TaskDetail) -> Vec<Line<'static>> {
    let Some(report) = detail.reports.as_ref().and_then(|r| r.verify.as_ref()) else { return Vec::new() };
    let mut lines = Vec::new();
    let open: Vec<_> = report.findings.iter().filter(|f| f.resolution.is_none()).collect();
    if !open.is_empty() {
        lines.push(Line::default());
        lines.push(Line::from(Span::from("Verify findings").style(theme::heading())));
        for level in ["blocker", "should_fix", "nit"] {
            let at: Vec<_> = open.iter().filter(|f| f.level() == level).collect();
            if at.is_empty() {
                continue;
            }
            let color = match level {
                "blocker" => RED,
                "should_fix" => YELLOW,
                _ => SUBTEXT0,
            };
            lines.push(Line::from(vec![Span::from(format!("  {level}")).fg(c(color)).bold(), Span::from(format!("  {}", at.len())).style(theme::label())]));
            for f in at.iter().take(30) {
                let place = if f.path.is_empty() { String::new() } else { format!("  {}:{}", truncate(&plain(&f.path), 60), f.line) };
                let criterion = f.criterion_ref.as_deref().map(|r| format!("  {}", truncate(&plain(r), 20))).unwrap_or_default();
                lines.push(Line::from(format!("    {}{place}{criterion}", truncate(&plain(&f.title), 100))));
            }
        }
    }
    if let Some(e2e) = report.e2e.as_ref().filter(|e| !e.rows.is_empty()) {
        lines.push(Line::default());
        lines.push(Line::from(vec![
            Span::from("Browser run").style(theme::heading()),
            Span::from(format!("  {}", plain(e2e.verdict.as_deref().unwrap_or("no verdict")))).style(theme::label()),
        ]));
        for row in e2e.rows.iter().take(40) {
            let (glyph, color) = match row.result.as_str() {
                "pass" => ("✓", GREEN),
                "fail" => ("✗", RED),
                "partial" => ("◐", YELLOW),
                _ => ("○", SUBTEXT0),
            };
            let seen = if row.seen.is_empty() { String::new() } else { format!("  {}", truncate(&plain(&row.seen), 80)) };
            let artifacts = if row.artifacts.is_empty() { String::new() } else { format!("  {}", truncate(&plain(&row.artifacts.join(", ")), 80)) };
            lines.push(Line::from(vec![
                Span::from(format!("  {glyph} ")).fg(c(color)),
                Span::from(format!("{}  {}{seen}{artifacts}", truncate(&plain(&row.scenario), 12), truncate(&plain(&row.title), 80))),
            ]));
        }
    }
    lines
}

/// Evidence: the QA verdict from the ship gate and every artifact the stages produced. With
/// the index of the selected row, so the pane can keep it in view.
fn evidence_section_lines(detail: Option<&TaskDetail>, cursor: usize) -> (Vec<Line<'static>>, Option<usize>) {
    let Some(d) = detail else {
        return (vec![heading("Evidence"), Line::default(), muted("  loading…".into())], None);
    };
    let mut lines = vec![heading("Evidence")];
    // The release question first: the checklist as it was when it was asked, then the pack it is about.
    if let Some(a) = d.open_approval().filter(|a| a.is_ship_approval()) {
        lines.push(Line::default());
        lines.push(Line::from(Span::from(format!("  {}", plain(a.requested["question"].as_str().unwrap_or("safe to release now?")))).bold()));
        for item in a.requested["checklist"].as_array().into_iter().flatten() {
            let ok = item["ok"].as_bool().unwrap_or(false);
            lines.push(Line::from(vec![
                Span::from(format!("    {} ", if ok { "✓" } else { "✗" })).fg(c(if ok { GREEN } else { RED })),
                Span::from(plain(item["detail"].as_str().unwrap_or(item["id"].as_str().unwrap_or("")))),
            ]));
        }
    }
    // The pack from the open or last awaiting_ship gate when there is one, else the task's own (Evidence publishes with no gate).
    let verdict = match d.latest_approval("awaiting_ship") {
        Some(a) => evidence_lines(&a.requested["evidence"]),
        None => d.task.evidence.as_ref().map(crate::ui::pack_lines).unwrap_or_default(),
    };
    if !verdict.is_empty() {
        lines.push(Line::default());
        lines.extend(verdict.iter().map(|l| Line::from(format!("  {}", plain(l)))));
        if d.task.evidence.is_some() {
            lines.push(muted("  y useful · n not useful (with a note)".into()));
        }
    }
    lines.extend(verify_report_lines(d));
    lines.push(Line::default());
    if d.artifacts.is_empty() {
        lines.push(muted("  nothing yet: E2E and Evidence write screenshots, a recording and the manifest here".into()));
        return (lines, None);
    }
    let selected = cursor.min(d.artifacts.len() - 1);
    let mut cursor_row = None;
    let mut last_kind = "";
    for (i, artifact) in d.artifacts.iter().enumerate() {
        if artifact.kind != last_kind {
            last_kind = &artifact.kind;
            let count = d.artifacts.iter().filter(|a| a.kind == artifact.kind).count();
            lines.push(Line::from(vec![Span::from(artifact.kind.clone()).style(theme::heading()), Span::from(format!("   {count}")).style(theme::label())]));
        }
        let on = i == selected;
        if on {
            cursor_row = Some(lines.len());
        }
        let label = if artifact.label.is_empty() { String::new() } else { format!("{}  ", artifact.label) };
        lines.push(Line::from(vec![
            Span::from(if on { "  ▌ " } else { "    " }).style(theme::border_focus()),
            Span::from(label).bold(),
            Span::from(artifact.path.clone()).style(theme::label()),
        ]));
    }
    lines.push(Line::default());
    lines.push(muted("j/k pick a file · J/K scroll · o opens it · r send back with a note".into()));
    (lines, cursor_row)
}

/// The PR for this ticket's branch, if the inbox has it.
pub fn pr_for<'a>(task: &Task, prs: &'a [PullRequest]) -> Option<&'a PullRequest> {
    let branch = task.branch.as_deref()?;
    prs.iter().find(|pr| pr.head_ref == branch)
}

/// The URL the ship gate reported, when the inbox has no row for the PR (not yours, closed).
pub(crate) fn pr_url(detail: &TaskDetail) -> Option<String> {
    detail.latest_approval("awaiting_ship").and_then(|a| a.requested["prUrl"].as_str().map(str::to_string))
}

/// PR: the branch's pull request as the inbox sees it, or what the ship gate said.
/// The watched PR: the checklist item by item, whether the machine may merge and why not, the review rule, the fix rounds, how long it has been quiet, and a freeze or a blocking PR as its own line.
/// Every text is the machine's and goes through `plain`.
pub(crate) fn ship_lines(ship: &crate::model::ShipView, now: u64) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(vec![
        Span::from("Watching  ").style(theme::label()),
        Span::from(if ship.ready { "✓ every item passes" } else { "◐ waiting on the items below" }).fg(c(if ship.ready { GREEN } else { YELLOW })),
    ])];
    for item in &ship.checklist {
        let (glyph, color) = if item.ok { ("✓", GREEN) } else { ("✗", RED) };
        lines.push(Line::from(vec![Span::from(format!("  {glyph} ")).fg(c(color)), Span::from(format!("{:<16}", plain(&item.id).replace('_', " "))), Span::from(plain(&item.detail)).style(theme::label())]));
        if !item.ok && matches!(item.id.as_str(), "freeze" | "blocked" | "stack") {
            lines.push(muted(format!("    the machine keeps waiting and goes on when it ends: {}", plain(&item.detail))));
        }
    }
    lines.push(Line::from(vec![
        Span::from("Merge      ").style(theme::label()),
        Span::from(if ship.auto_merge.allowed { format!("✓ the machine will merge: {}", plain(&ship.auto_merge.reason)) } else { format!("a person merges, or the machine waits: {}", plain(&ship.auto_merge.reason)) }).fg(c(if ship.auto_merge.allowed { GREEN } else { YELLOW })),
    ]));
    let review = match (ship.review.required, ship.review.by.as_deref()) {
        (Some(true), Some(by)) => format!("required by {}", plain(by)),
        (Some(true), None) => "required".to_string(),
        (Some(false), _) => "not required here: the machine never merges without one".to_string(),
        (None, _) => "unreadable: a person merges".to_string(),
    };
    lines.push(Line::from(vec![Span::from("Review     ").style(theme::label()), Span::from(review)]));
    let mut clocks = vec![format!("{} fix round{}", ship.fix_rounds, if ship.fix_rounds == 1 { "" } else { "s" })];
    if ship.queued {
        clocks.push("in the merge queue".to_string());
    }
    if let Some(since) = ship.quiet_since.as_deref().and_then(crate::model::unix_secs) {
        let days = now.saturating_sub(since) / 86_400;
        clocks.push(format!("quiet {}", if days == 0 { "today".to_string() } else { format!("{days} day{}", if days == 1 { "" } else { "s" }) }));
    }
    if let Some(event) = &ship.last_event {
        clocks.push(format!("last event: {}", plain(&event.class).replace('_', " ")));
    }
    lines.push(Line::from(vec![Span::from("Clocks     ").style(theme::label()), Span::from(clocks.join(" · "))]));
    lines.push(muted("  a reminder after two quiet days, the release owners named after five; neither merges or archives".to_string()));
    lines.push(muted("  :dismiss <finding id> [reason] · :finding <blocker|should_fix|nit> <title>".to_string()));
    lines
}

fn pr_lines(task: &Task, detail: Option<&TaskDetail>, prs: &[PullRequest], now: u64) -> Vec<Line<'static>> {
    let mut lines = vec![heading("PR"), Line::default()];
    if let Some(ship) = detail.and_then(|d| d.ship.as_ref()) {
        lines.extend(ship_lines(ship, now));
        lines.push(Line::default());
    }
    match pr_for(task, prs) {
        Some(pr) => {
            lines.extend(pr_widget(pr, now));
            lines.push(Line::default());
            lines.push(muted("o opens it in the browser".into()));
        }
        None => match detail.and_then(pr_url) {
            Some(url) => {
                let reused = detail
                    .and_then(|d| d.latest_approval("awaiting_ship"))
                    .is_some_and(|a| a.requested["reused"].as_bool().unwrap_or(false));
                lines.push(Line::from(vec![
                    Span::from(if reused { "PR (already open)  " } else { "PR opened  " }).style(theme::label()),
                    Span::from(url).style(theme::border_focus()),
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
        Line::from(vec![Span::from(format!("{}  ", pr.key())).style(theme::label()), Span::from(crate::model::plain(&pr.title, 400)).bold()]),
        muted(format!("@{} · {} → {}{} · {} ago", pr.author, pr.head_ref, pr.base_ref, if pr.from_fork { " (fork)" } else { "" }, age(&pr.updated_at, now))),
        muted(pr.url.clone()),
        Line::default(),
        Line::from(vec![
            Span::from("Checks     ").style(theme::label()),
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
    lines.push(Line::from(vec![Span::from("Review     ").style(theme::label()), Span::from(review).fg(c(crate::ui::LAVENDER))]));
    match (&pr.task, pr.local_path.is_some()) {
        (Some(task), _) => lines.push(Line::from(vec![
            Span::from("Task       ").style(theme::label()),
            Span::from(format!("⚙ {} · {} · #{}", task.route.replace('_', " "), task.state.replace('_', " "), crate::model::short_id(&task.id))).style(theme::working()),
        ])),
        (None, false) => lines.push(Line::from(vec![Span::from("Checkout   ").style(theme::label()), Span::from("none on this machine · a dispatch asks where to clone").style(theme::label())])),
        _ => {}
    }
    lines
}

/// Activity: every event, oldest first.
fn activity_lines(detail: Option<&TaskDetail>) -> Vec<Line<'static>> {
    let Some(d) = detail else {
        return vec![heading("Activity"), Line::default(), muted("  loading…".into())];
    };
    let mut lines = vec![Line::from(vec![Span::from("Activity").style(theme::heading()), Span::from(format!(" · {}", d.events.len())).style(theme::label())]), Line::default()];
    if d.events.is_empty() {
        lines.push(muted("  nothing yet".into()));
    }
    lines.extend(d.events.iter().map(|e| {
        let text = plain(&describe(e));
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
        draw(width, height, task, detail, section, cursor, (prs, diff), &RefState::default())
    }

    #[allow(clippy::too_many_arguments)]
    fn draw(width: u16, height: u16, task: &Task, detail: Option<&TaskDetail>, section: Section, cursor: usize, (prs, diff): (&[PullRequest], Option<&TaskDiff>), refs: &RefState) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let scroll = Cell::new(0);
        let view = DetailView { task, detail, section, cursor, scroll: &scroll, prs, diff, viewport: &Cell::new(0), follow: &Cell::new(false), engines: None, tasks: &[], actions: &[], can: &[], refs };
        terminal.draw(|f| super::render(f, f.area(), &view)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect()
    }

    /// The screen with every reference group of `section` unfolded: drawn once to learn the groups, then again with them open.
    fn render_open(width: u16, height: u16, task: &Task, detail: Option<&TaskDetail>, section: Section, cursor: usize) -> Vec<String> {
        let probe = RefState::default();
        draw(width, height, task, detail, section, cursor, (&[], None), &probe);
        let refs = RefState { toggled: probe.ids.borrow().iter().map(|id| (section, *id)).collect(), ..Default::default() };
        draw(width, height, task, detail, section, cursor, (&[], None), &refs)
    }

    /// The plan page as one run of lines: the main text, then each reference group open under its title.
    fn plan_lines(task: &Task, detail: Option<&TaskDetail>, now: u64) -> Vec<Line<'static>> {
        let page = plan_page(task, detail, 100, now);
        let mut lines = page.main;
        for group in page.groups {
            lines.push(Line::from(group.title));
            lines.extend(group.lines);
        }
        lines
    }

    fn build_progress_lines(detail: &TaskDetail) -> Vec<Line<'static>> {
        crate::pages::now_page(&detail.task, Some(detail), 100, 30, 0).main
    }

    /// The stopped page's text, its reference groups open under it.
    fn escalation_lines(detail: &TaskDetail) -> Vec<Line<'static>> {
        let page = crate::pages::stopped_page(&detail.task, Some(detail), &[], 100, 30);
        let mut lines = page.main;
        for group in page.groups {
            lines.extend(group.lines);
        }
        lines
    }

    fn fixture() -> (Task, TaskDetail) {
        let task: Task = serde_json::from_str(TASK).unwrap();
        let detail: TaskDetail = serde_json::from_str(&detail_json(TASK)).unwrap();
        (task, detail)
    }

    /// An ANSI escape, a bare carriage return, a bell, a bidi override and a zero-width space around letters.
    const HOSTILE: &str = "A\u{1b}[31mB\rC\u{7}D\u{202e}E\u{200b}F";
    /// What `HOSTILE` becomes once every unsafe character is a space.
    const TAMED: &str = "A [31mB C D E F";

    fn text_of(lines: &[Line]) -> String {
        lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    fn assert_safe(site: &str, text: &str) {
        assert!(text.contains(TAMED), "{site}: the text did not reach the screen\n{text}");
        for bad in ['\u{1b}', '\r', '\u{7}', '\u{202e}', '\u{200b}'] {
            assert!(!text.contains(bad), "{site}: {bad:?} reached the screen\n{text}");
        }
    }

    /// A card whose every model and ticket string is hostile.
    fn hostile() -> (Task, TaskDetail) {
        let mut task: serde_json::Value = serde_json::from_str(TASK).unwrap();
        task["title"] = HOSTILE.into();
        task["description"] = HOSTILE.into();
        task["criteria"] = serde_json::json!([HOSTILE]);
        task["record"] = serde_json::json!({"kind": HOSTILE, "summary": HOSTILE, "size": HOSTILE, "riskPrelim": HOSTILE, "typeOfWork": HOSTILE});
        let mut detail: serde_json::Value = serde_json::from_str(&detail_json(TASK)).unwrap();
        detail["task"] = task.clone();
        detail["approvals"].as_array_mut().unwrap().push(serde_json::json!({
            "id": "p9", "kind": "awaiting_approval", "decision": null, "createdAt": "2026-10-22T11:00:00Z",
            "requested": {
                "lane": "plan", "outcome": "archive", "archiveReason": HOSTILE, "reply": HOSTILE, "brief": HOSTILE,
                "criteria": [HOSTILE], "assumptions": [HOSTILE], "slices": [{"title": HOSTILE, "est_loc": 10}],
                "error": HOSTILE, "note": HOSTILE, "config": HOSTILE, "notes": [HOSTILE],
                "proof": [{"name": HOSTILE, "cmd": HOSTILE, "ok": false, "tail": HOSTILE}],
                "questions": [{"question": HOSTILE, "recommended": HOSTILE}],
                "map": {"components": [HOSTILE], "files": [HOSTILE]}, "mapNote": HOSTILE
            }
        }));
        let approvals = detail["approvals"].as_array_mut().unwrap();
        let cases = approvals.iter_mut().find(|a| a["kind"] == "awaiting_test_check").unwrap();
        cases["requested"]["cases"][0] = serde_json::json!({"title": HOSTILE, "criterion": HOSTILE, "approach": HOSTILE});
        detail["events"][0]["payload"]["error"] = HOSTILE.into();
        detail["events"][1]["payload"]["to"] = HOSTILE.into();
        detail["stageRuns"][2]["cases"][0]["title"] = HOSTILE.into();
        detail["artifacts"][0]["path"] = HOSTILE.into();
        (serde_json::from_value(task).unwrap(), serde_json::from_value(detail).unwrap())
    }

    #[test]
    fn the_title_description_and_criteria_are_drawn_without_unsafe_characters() {
        let (task, detail) = hostile();
        assert_safe("overview", &text_of(&overview_lines(&task, Some(&detail), 100, 0, &[])));
        assert_safe("popup title", &render(120, 40, &task, Some(&detail), Section::Overview, 0)[0]);
    }

    #[test]
    fn a_gate_s_error_note_config_proof_notes_and_questions_are_drawn_without_unsafe_characters() {
        let (task, detail) = hostile();
        let page = crate::pages::gate_page(&task, Some(&detail), &[], 100, 30, 0);
        let text = text_of(&page.main);
        assert_safe("question page", &text);
        for needle in [format!("1. {TAMED}"), format!("suggested: {TAMED}"), format!("✗ {TAMED}: {TAMED}")] {
            assert!(text.contains(&needle), "{needle} missing in\n{text}");
        }
    }

    #[test]
    fn the_plan_s_record_reply_brief_lists_and_map_are_drawn_without_unsafe_characters() {
        let (task, detail) = hostile();
        let text = text_of(&plan_lines(&task, Some(&detail), 0));
        assert_safe("plan", &text);
        for needle in [format!("  • {TAMED}"), format!("Kind       {TAMED}"), format!("{TAMED} (~10 LOC)"), format!("change {TAMED}")] {
            assert!(text.contains(&needle), "{needle} missing in\n{text}");
        }
    }

    #[test]
    fn the_test_cases_runs_and_activity_are_drawn_without_unsafe_characters() {
        let (task, detail) = hostile();
        assert_safe("tests", &text_of(&tests_lines(&task, Some(&detail), 100, 0)));
        // The failed verifying run is the second row; the cursor picks it so its error and cases show.
        let (runs, _) = runs_lines(&task, Some(&detail), 2, 100, 0);
        assert_safe("runs", &text_of(&runs));
        assert_safe("activity", &text_of(&activity_lines(Some(&detail))));
    }

    #[test]
    fn the_overview_shows_where_a_card_came_from_and_what_merged_into_it() {
        let (_, detail) = fixture();
        let extra = r#""reason":null,"sources":[{"kind":"github","repo":"o/a","number":3,"url":"u"},{"type":"slack"}],"reporter":{"id":"U1\u001b[2J","channel":"slack"},"followers":["U2"],"project":"PAY","owners":["@team-a"],"attachments":[{"name":"trace.txt","url":"https://f/t"}],"merged":[{"id":"11111111-2222-3333-4444-555555555555"}]"#;
        let task: Task = serde_json::from_str(&TASK.replace(r#""reason":null"#, extra)).unwrap();
        let rows = render(120, 40, &task, Some(&detail), Section::Overview, 0).join("\n");
        for needle in ["GitHub o/a#3", "slack", "Reporter   U1", "Followers  U2", "Project    PAY", "Owners     @team-a", "trace.txt", "Merged     11111111"] {
            assert!(rows.contains(needle), "{needle} missing in\n{rows}");
        }
        assert!(!rows.contains('\u{1b}'));
    }

    #[test]
    fn the_question_page_names_what_the_intake_gate_is_missing() {
        let (task, mut detail) = fixture();
        detail.approvals.push(serde_json::from_str(r#"{"kind":"awaiting_setup","requested":{"kind":"context","missing":["repository","text"]},"decision":null}"#).unwrap());
        let rows = render(120, 40, &task, Some(&detail), Section::Gate, 0).join("\n");
        assert!(rows.contains("Intake     waiting for: which repository it is for, more detail on what is wrong"), "{rows}");
        assert!(rows.contains(":context repo"), "{rows}");
    }

    #[test]
    fn the_overview_lists_the_dedup_candidates_and_where_a_merged_card_went() {
        let (_, mut detail) = fixture();
        detail.approvals.push(serde_json::from_str(r#"{"kind":"awaiting_setup","requested":{"kind":"dedup","candidates":[{"slot":1,"id":"11111111-0000-0000-0000-000000000000","kind":"open","title":"Checkout fails\u001b[2J","state":"triage","score":0.82}]},"decision":null}"#).unwrap());
        let extra = r#""reason":null,"mergedInto":"22222222-0000-0000-0000-000000000000","related":["33333333-0000-0000-0000-000000000000"]"#;
        let task: Task = serde_json::from_str(&TASK.replace(r#""reason":null"#, extra)).unwrap();
        let overview = render(120, 40, &task, Some(&detail), Section::Overview, 0).join("\n");
        let gate = render(120, 40, &task, Some(&detail), Section::Gate, 0).join("\n");
        for needle in ["Intake     could this be a duplicate? pick with :dedup duplicate <slot> | related <slots> | neither", "1  11111111  triage", "0.82  Checkout fails"] {
            assert!(gate.contains(needle), "{needle} missing in\n{gate}");
        }
        for needle in ["Merged into  22222222", "Related    33333333"] {
            assert!(overview.contains(needle), "{needle} missing in\n{overview}");
        }
        assert!(!overview.contains("could this be a duplicate"), "the question is not printed on the Overview too");
        assert!(!gate.contains('\u{1b}'));
    }

    fn col_of(rows: &[String], needle: &str) -> Option<usize> {
        rows.iter().find_map(|r| r.find(needle).map(|i| r[..i].chars().count()))
    }

    #[test]
    fn a_ticket_from_luna_notch_says_so_in_the_header_and_the_overview() {
        let (_, detail) = fixture();
        let task: Task = serde_json::from_str(&TASK.replace(r#""reason":null"#, r#""reason":null,"source":{"kind":"notch","ref":"LUNA-14","id":"wo_1"}"#)).unwrap();
        let rows = render(120, 36, &task, Some(&detail), Section::Overview, 0);
        assert!(rows[0].contains("#abcdef12 notch LUNA-14 Add CSV export"), "{}", rows[0]);
        assert!(rows.iter().any(|r| r.contains("Luna Notch LUNA-14")), "{}", rows.join("\n"));
        let (plain, _) = fixture();
        let rows = render(120, 36, &plain, Some(&detail), Section::Overview, 0);
        assert!(rows[0].contains("#abcdef12 Add CSV export"), "{}", rows[0]);
    }

    #[test]
    fn the_rail_lists_every_section_with_its_status_and_marks_the_active_one() {
        let (task, detail) = fixture();
        let rows = render_open(120, 30, &task, Some(&detail), Section::Plan, 0);
        let text = rows.join("\n");
        for s in order(&task) {
            assert!(text.contains(s.label()), "{}: {text}", s.label());
        }
        let rail = |label: &str| rows.iter().find(|r| r.chars().take(14).collect::<String>().contains(label) || r.contains(&format!(" {label}"))).cloned().unwrap_or_default();
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
        let text = render_open(120, 36, &task, Some(&detail), Section::Plan, 0).join("\n");
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
    fn an_open_gate_puts_its_bar_on_top_of_every_section() {
        let (mut task, mut detail) = fixture();
        task.state = "awaiting_approval".into();
        task.waiting_on_you = true;
        detail.approvals[1].decision = None;
        for section in [Section::Overview, Section::Plan, Section::Activity] {
            let rows = render(120, 30, &task, Some(&detail), section, 0);
            assert!(rows[1].contains("⏸ approve the plan?"), "{section:?}: {}", rows[1]);
            assert!(rows[2].starts_with('├') && rows[2].trim_end().ends_with('┤'), "the rule under the bar: {}", rows[2]);
        }
        let text = render_open(120, 30, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("waiting for you"), "{text}");
        assert!(text.contains("e edits the brief"), "{text}");
    }

    #[test]
    fn under_a_hundred_columns_the_rail_becomes_a_tab_strip() {
        let (task, detail) = fixture();
        let rows = render(99, 30, &task, Some(&detail), Section::Tests, 0);
        assert!(rows[3].contains("Overview") && rows[3].contains("Tests 3 ✓") && rows[3].contains("Activity 3"), "{}", rows[3]);
        assert!(rows[4].chars().filter(|ch| *ch == '─').count() > 60, "a rule under the strip: {}", rows[4]);
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
        assert!(text.contains("j/k pick a run · J/K scroll · f follows"), "{text}");
    }

    #[test]
    fn the_evidence_section_lists_artifacts_by_kind_and_says_so_when_there_are_none() {
        let (task, detail) = fixture();
        let text = render(120, 30, &task, Some(&detail), Section::Evidence, 0).join("\n");
        assert!(text.contains("log   1"), "{text}");
        assert!(text.contains("verify  /out/files/verify.log"), "{text}");
        assert!(text.contains("j/k pick a file · J/K scroll · o opens it"), "{text}");
        let mut bare = detail.clone();
        bare.artifacts.clear();
        let text = render(120, 30, &task, Some(&bare), Section::Evidence, 0).join("\n");
        assert!(text.contains("nothing yet"), "{text}");
    }

    #[test]
    fn the_evidence_section_shows_verify_s_findings_by_level_with_their_criterion_and_the_browser_run_by_scenario() {
        let (task, mut detail) = fixture();
        detail.reports = Some(
            serde_json::from_str(
                r#"{"verify":{"findings":[
                  {"severity":"bug","title":"off by one\u001b[31m","path":"a.ts","line":3,"criterion_ref":"C1"},
                  {"severity":"nit","title":"naming","path":"b.ts","line":9},
                  {"severity":"blocker","title":"already fixed","path":"c.ts","line":1,"resolution":{"status":"fixed","by":"build"}}],
                 "e2e":{"verdict":"fail","rows":[
                  {"scenario":"S1","title":"export downloads a file","result":"fail","seen":"got a 500","artifacts":["shot.png"]},
                  {"scenario":"S2","title":"empty report","result":"not_run","seen":"","artifacts":[]}]}}}"#,
            )
            .unwrap(),
        );
        let text = render(120, 40, &task, Some(&detail), Section::Evidence, 0).join("\n");
        assert!(text.contains("Verify findings"), "{text}");
        assert!(text.contains("blocker  1"), "{text}");
        assert!(text.contains("off by one [31m  a.ts:3  C1"), "the escape is a space: {text}");
        assert!(!text.contains('\u{1b}'), "{text}");
        assert!(text.contains("nit  1"), "{text}");
        assert!(!text.contains("already fixed"), "{text}");
        assert!(text.contains("Browser run  fail"), "{text}");
        assert!(text.contains("✗ S1  export downloads a file  got a 500  shot.png"), "{text}");
        assert!(text.contains("○ S2  empty report"), "{text}");
    }

    #[test]
    fn the_evidence_section_shows_the_task_s_pack_when_no_gate_is_open() {
        let (mut task, detail) = fixture();
        task.evidence = Some(serde_json::json!({
            "summary":"Show the cart total.","format":"video","note":"the film is short","risk":"low","commitSha":"abc1234def",
            "scenarios":[{"text":"Total shows","test":null,"result":"pass"},{"text":"Zero on empty","test":null,"result":"not_run"}],
            "media":[{"kind":"video","label":"walk.mp4","url":"https://x/w.mp4"},{"kind":"report","label":"terminal.txt","url":"/Users/me/state/evidence/t/abc/terminal.txt"}],
            "video":{"verdict":"ship","scores":{"hook":9},"defects":[]},
            "results":{"unit":{"passed":3,"total":4},"integration":null,"e2e":{"verdict":"pass","passed":2,"total":2},"coverageDelta":null}}));
        let mut detail = detail;
        let mut task_detail_task = detail.task.clone();
        task_detail_task.evidence = task.evidence.clone();
        detail.task = task_detail_task;
        let text = render(120, 50, &task, Some(&detail), Section::Evidence, 0).join("\n");
        for part in ["format: video (degraded: the film is short)", "Show the cart total.", "✓ Total shows", "? Zero on empty", "media: walk.mp4  https://x/w.mp4", "critic: ship", "published: yes", "y useful · n not useful"] {
            assert!(text.contains(part), "{part}: {text}");
        }
        assert!(!text.contains("/Users/me"), "a local path is never printed: {text}");
        assert!(text.contains("media: terminal.txt"), "{text}");
    }

    #[test]
    fn a_pack_with_no_web_media_says_it_is_not_published_and_text_is_made_plain() {
        let lines = crate::ui::pack_lines(&serde_json::json!({"summary":"hi\u{1b}[31m red","format":"text","scenarios":[],"media":[{"label":"a\u{1b}[2Jb","url":"/x/a.txt"}]}));
        let text = lines.join("\n");
        assert!(text.contains("published: no"), "{text}");
        assert!(!text.contains('\u{1b}'), "{text:?}");
    }

    #[test]
    fn a_text_only_pack_the_machine_published_says_published_and_an_old_pack_is_read_from_its_links() {
        let text = crate::ui::pack_lines(&serde_json::json!({"summary":"s","format":"text","scenarios":[],"media":[],"published":true})).join("\n");
        assert!(text.contains("published: yes"), "{text}");
        let text = crate::ui::pack_lines(&serde_json::json!({"summary":"s","format":"video","scenarios":[],"media":[{"label":"w","url":"https://x/w.mp4"}],"published":false})).join("\n");
        assert!(text.contains("published: no"), "{text}");
        // A pack stored before the field existed still reads from its links.
        let text = crate::ui::pack_lines(&serde_json::json!({"summary":"s","format":"video","scenarios":[],"media":[{"label":"w","url":"https://x/w.mp4"}]})).join("\n");
        assert!(text.contains("published: yes"), "{text}");
    }

    #[test]
    fn a_high_risk_pack_is_read_from_the_task_when_no_gate_is_open() {
        let (_, mut detail) = fixture();
        assert!(!ship_risk_is_high(Some(&detail)));
        detail.task.evidence = Some(serde_json::json!({"risk":"high"}));
        assert!(ship_risk_is_high(Some(&detail)));
    }

    #[test]
    fn the_evidence_section_shows_the_whole_pack_and_the_send_back_footer() {
        let (task, mut detail) = fixture();
        detail.approvals.push(
            serde_json::from_value(serde_json::json!({"kind":"awaiting_ship","requested":{"evidence":{
                "verdict":"pass","artifactCount":3,"thumbnails":["/a.png","/b.png"],"format":"captures","summary":"Show the cart total.",
                "scenarios":[{"text":"Total shows","result":"pass"}],"media":[{"label":"a.png","url":"https://x/a.png"}]}}}))
            .unwrap(),
        );
        let text = render(120, 40, &task, Some(&detail), Section::Evidence, 0).join("\n");
        for part in ["format: captures", "Show the cart total.", "verdict: pass", "3 artifacts", "/a.png", "/b.png", "✓ Total shows", "media: a.png  https://x/a.png"] {
            assert!(text.contains(part), "{part}: {text}");
        }
        assert!(text.contains("j/k pick a file · J/K scroll · o opens it · r send back with a note"), "{text}");
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
        assert!(text.contains("o opens it in the browser"), "{text}");
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
        assert!(text.contains("j/k pick a file · J/K scroll · o opens it"), "{text}");
        assert!(!text.contains("truncated"), "{text}");
        let text = render_with(120, 30, &task, Some(&detail), Section::Diff, 0, (&[], None)).join("\n");
        assert!(text.contains("loading task/abcdef12"), "{text}");
    }

    #[test]
    fn a_long_patch_scrolls_in_a_window_and_says_when_the_machine_cut_it() {
        let (task, detail) = fixture();
        let body: String = (1..=400).map(|i| format!("+line {i}\n")).collect();
        let diff: TaskDiff = serde_json::from_str(&format!(
            r#"{{"base":"main","head":"task/abcdef12","files":[{{"path":"big.ts","status":"A","added":400,"removed":0}}],"file":"big.ts","patch":{},"truncated":true}}"#,
            serde_json::to_string(&body).unwrap()
        ))
        .unwrap();
        let (width, height) = (120, 20);
        let scroll = Cell::new(300);
        let view = DetailView { task: &task, detail: Some(&detail), section: Section::Diff, cursor: 0, scroll: &scroll, prs: &[], diff: Some(&diff), viewport: &Cell::new(0), follow: &Cell::new(false), engines: None, tasks: &[], actions: &[], can: &[], refs: &RefState::default() };
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| super::render(f, f.area(), &view)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text: String = (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>() + "\n").collect();
        assert!(text.contains("+line 300"), "scrolled into the patch: {text}");
        assert!(!text.contains("+line 100"), "{text}");
        assert_eq!(scroll.get(), 300, "well inside the content, nothing to clamp");
        scroll.set(10_000);
        terminal.draw(|f| super::render(f, f.area(), &view)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text: String = (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>() + "\n").collect();
        assert!(text.contains("+line 400") && text.contains("… truncated"), "clamped to the end, which says the machine cut the patch: {text}");
        assert!(scroll.get() < 10_000, "the offset is clamped to the content");
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
              "sandboxBase":"sandbox.image.base: attacker/x:1 (approving the setup does not approve the base)",
              "notes":["no e2e surface"]}},"decision":null}}],"events":[]}}"#
        ))
        .unwrap();
        let text = render(120, 40, &task, Some(&detail), Section::Gate, 0).join("\n");
        assert!(text.contains("approve the setup?"), "{text}");
        assert!(text.contains("Proposed luna.yaml"), "{text}");
        assert!(text.contains("run: cargo test"), "the file is shown as is: {text}");
        assert!(text.contains("Base image (not approved by this gate)") && text.contains("sandbox.image.base: attacker/x:1"), "{text}");
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

    /// A ticket at one open gate, with `requested` as the machine sent it.
    fn at_gate(requested: &str, state: &str) -> (Task, TaskDetail) {
        let task_json = TASK.replace("\"state\":\"implementing\"", &format!("\"state\":\"{state}\"")).replace("\"waitingOnYou\":false,\"running\":true", "\"waitingOnYou\":true,\"running\":false");
        let task: Task = serde_json::from_str(&task_json).unwrap();
        let detail: TaskDetail = serde_json::from_str(&format!(
            r#"{{"task":{task_json},"stageRuns":[{{"id":"r1","stage":"test_design","attempt":1,"status":"passed","startedAt":"2026-10-22T09:30:00Z","endedAt":"2026-10-22T09:33:00Z"}}],"events":[],"artifacts":[],
              "approvals":[{{"id":"p1","kind":"awaiting_approval","requested":{requested},"decision":null,"createdAt":"2026-10-22T09:50:00Z"}}]}}"#
        ))
        .unwrap();
        (task, detail)
    }

    const PLAN_GATE: &str = r#"{"brief":"Guard the empty list","criteria":["no panic"],"slices":[{"title":"guard j","est_loc":12}],"lane":"fast",
        "risk":{"level":"high","scores":{"blast_radius":2,"reversibility":1,"data_sensitivity":0}},
        "verdicts":{"coverage":"proceed","plan":"flag","risk":"proceed"},"approvers":["ana"],
        "cases":[{"title":"j on empty","criterion":"no panic","approach":"cargo test keys::empty"}]}"#;

    #[test]
    fn the_gate_shows_its_approval_rule_and_a_risk_a_person_set() {
        let (task, detail) = at_gate(r#"{"brief":"b","lane":"full","risk":{"level":"high","machine":"high"},"overrides":{"risk":{"level":"low","reason":"behind a flag","applied":false}},"approvalRule":{"needed":2,"outside":"required","text":"Needs 2 approvers: at least one must be someone not among the code map's owners (@ana). This is an attestation."}}"#, "awaiting_approval");
        let text = render_open(120, 50, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("Rule       Needs 2 approvers") && text.contains("attestation"), "{text}");
        assert!(text.contains("Override   you set low, below the machine's high"), "{text}");
        let (task, detail) = at_gate(r#"{"brief":"b","lane":"full","risk":{"level":"low"}}"#, "awaiting_approval");
        let text = render_open(120, 50, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(!text.contains("Rule ") && !text.contains("Override"), "{text}");
    }

    #[test]
    fn a_flagged_check_is_highlighted_and_a_plan_with_no_checks_shows_none() {
        let (task, detail) = at_gate(PLAN_GATE, "awaiting_approval");
        let lines = plan_lines(&task, Some(&detail), 0);
        let flagged = lines.iter().find(|l| l.to_string().contains("⚑ plan flag")).expect("the flagged check");
        let ok = lines.iter().find(|l| l.to_string().contains("✓ coverage proceed")).expect("a clear check");
        assert!(flagged.to_string().starts_with("⚑") && ok.to_string().starts_with("✓"), "a glyph tells them apart");
        let (task, detail) = at_gate(r#"{"brief":"b"}"#, "awaiting_approval");
        let text = render_open(100, 30, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(!text.contains("Checks") && !text.contains("Risk ") && !text.contains("Outcome"), "{text}");
    }

    #[test]
    fn the_plan_gate_shows_the_code_map_by_role_with_owners_entry_points_and_the_stale_flag() {
        let gate = r#"{"brief":"b","lane":"full","map":{"components":["board keys","board app"],"files":[{"path":"board/src/keys.rs","role":"change"},{"path":"board/src/app.rs","role":"read"},{"path":"board/src/keys_tests.rs","role":"test"},"board/src/old.rs"],"entry_points":["keys::handle"],"owners":["@marta","@lee"],"confidence":0.7,"stale":true,"behind":120}}"#;
        let (task, detail) = at_gate(gate, "awaiting_approval");
        let text = render_open(110, 50, &task, Some(&detail), Section::Plan, 0).join("\n");
        for want in ["Code map", "Components board keys, board app", "change board/src/keys.rs", "change board/src/old.rs", "read   board/src/app.rs", "test   board/src/keys_tests.rs", "Entry      keys::handle", "Owners     @marta, @lee", "stale: the graph is 120 commits behind"] {
            assert!(text.contains(want), "{want}: {text}");
        }
        assert!(text.find("Code map").unwrap() > text.find("Brief").unwrap(), "the map is reference, below the brief: {text}");
        let (task, detail) = at_gate(&gate.replace(r#","stale":true,"behind":120"#, r#","stale":false,"behind":3"#), "awaiting_approval");
        let text = render_open(110, 50, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("Code map") && !text.contains("stale"), "a current graph shows no flag: {text}");
    }

    #[test]
    fn a_plan_gate_without_a_map_says_so_and_why_and_a_triage_gate_shows_none() {
        let (task, detail) = at_gate(r#"{"brief":"b","lane":"full","map":null,"mapNote":"the repo has no code graph, so there is no code map"}"#, "awaiting_approval");
        let text = render_open(110, 50, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("Code map") && text.contains("no code graph"), "{text}");
        let (task, detail) = at_gate(r#"{"brief":"b","lane":"full","map":null}"#, "awaiting_approval");
        assert!(render_open(110, 50, &task, Some(&detail), Section::Plan, 0).join("\n").contains("no code map"));
        let (task, detail) = at_gate(r#"{"brief":"b","outcome":"conversation","reply":"hi"}"#, "awaiting_approval");
        assert!(!render_open(110, 50, &task, Some(&detail), Section::Plan, 0).join("\n").contains("Code map"));
    }

    #[test]
    fn a_reply_gate_shows_the_reply_and_an_archive_gate_its_reason() {
        let (task, detail) = at_gate(r#"{"outcome":"conversation","brief":"asks how","reply":"Use `pnpm dev`."}"#, "awaiting_approval");
        let text = render_open(100, 30, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("Outcome    conversation") && text.contains("Use `pnpm dev`.") && text.contains("posts it"), "{text}");
        let (task, detail) = at_gate(r#"{"outcome":"archive","archiveReason":"duplicate","brief":"same as #7"}"#, "awaiting_approval");
        let text = render_open(100, 30, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("Outcome    archive (duplicate)") && text.contains("archives the ticket"), "{text}");
    }

    const RECORD: &str = r#"{"kind":"bug","goal":"Stop the panic","summary":"The board panics on j.","typeOfWork":"frontend","size":"S","urgencyDetail":{"priority":"P1","subScores":{"who":3,"what":2,"impact":2,"time":1,"demand":1}},"riskPrelim":"low","decisionBy":"machine","version":1}"#;

    #[test]
    fn the_plan_shows_the_triage_record_its_priority_flags_and_who_decided() {
        let (mut task, detail) = at_gate(r#"{"brief":"b","flagged":["triage.size","plan"]}"#, "awaiting_approval");
        task.record = Some(serde_json::from_str(RECORD).unwrap());
        let text = render_open(110, 40, &task, Some(&detail), Section::Plan, 0).join("\n");
        for want in ["Triage record v1 · decided by the machine", "The board panics on j.", "Kind       bug", "Type       frontend", "Size       S", "Priority   P1 (who 3, what 2, impact 2, time 1, demand 1)", "Risk       low", "Flagged    size (T corrects the record)"] {
            assert!(text.contains(want), "{want}: {text}");
        }
        assert!(text.find("Triage record").unwrap() > text.find("Brief").unwrap(), "the record is reference, below the brief: {text}");
        task.record = serde_json::from_str(&RECORD.replace(r#""decisionBy":"machine","version":1"#, r#""decisionBy":"person","version":2,"editedFields":["kind","size"]"#)).unwrap();
        let text = render_open(110, 40, &task, Some(&detail), Section::Plan, 0).join("\n");
        assert!(text.contains("Triage record v2 · corrected by a person (kind, size)"), "{text}");
        task.record = None;
        assert!(!render_open(110, 40, &task, Some(&detail), Section::Plan, 0).join("\n").contains("Triage record"));
    }

    #[test]
    fn the_tests_section_reads_the_cases_off_the_plan_gate() {
        let (task, detail) = at_gate(PLAN_GATE, "awaiting_approval");
        let text = render(120, 30, &task, Some(&detail), Section::Tests, 0).join("\n");
        assert!(text.contains("1 case over 1 criterion") && text.contains("no panic") && text.contains("j on empty") && text.contains("cargo test keys::empty"), "{text}");
        assert!(text.contains("e edits the cases"), "the cases are editable while the plan gate waits: {text}");
    }

    #[test]
    fn the_bar_asks_the_question_of_each_kind_of_gate() {
        let question = |requested: &str| {
            let (task, detail) = at_gate(requested, "awaiting_approval");
            gate_question(&task, Some(&detail)).unwrap()
        };
        assert_eq!(question(r#"{"brief":"b","risk":{"level":"low"}}"#), "approve the plan?");
        assert!(question(r#"{"brief":"b","risk":{"level":"high"}}"#).contains("approve the plan? · first of two approvers; set LUNA_APPROVER"));
        assert!(question(PLAN_GATE).contains("approve the plan? · last of two approvers"), "{}", question(PLAN_GATE));
        assert!(question(r#"{"brief":"b","risk":{"level":"high"},"approvalRule":{"needed":3,"text":"t"},"approvers":["ana"]}"#).contains("next of 3 approvers"));
        assert_eq!(question(r#"{"outcome":"archive","archiveReason":"duplicate"}"#), "archive this ticket?");
        assert_eq!(question(r#"{"outcome":"conversation","reply":"x"}"#), "post the reply and close the ticket?");
    }

    const SPLIT_GATE: &str = r#"{"outcome":"split","summary":"over the size limit","size":{"estLoc":4000,"planned":null,"limit":{"hard":2500,"target":[1000,2000]},"verdict":"over","by":"decision"},
        "split":{"children":[{"title":"Part A","goal":"g","acceptance_criteria":["a works","b works"],"est_loc":900,"depends_on":[],"order":1},{"title":"Part B","goal":"g","acceptance_criteria":["c"],"est_loc":1200,"depends_on":[1],"order":2}],"rounds":1,"judged":true,"via":"tickets"},
        "risk":{"level":"low"}}"#;

    #[test]
    fn a_split_gate_asks_about_the_split_and_a_failed_one_has_no_approve() {
        let ask = |requested: &str| {
            let (task, detail) = at_gate(requested, "awaiting_approval");
            (gate_question(&task, Some(&detail)).unwrap(), bar_status(&task, Some(&detail), 0).note)
        };
        let (split, note) = ask(SPLIT_GATE);
        assert_eq!(split, "approve the split (2 tickets)?");
        assert!(note.contains(":whole keeps it one card"), "{note}");
        assert!(ask(&SPLIT_GATE.replace("tickets", "cards")).0.contains("approve the split (2 cards)?"));
        let (failed, note) = ask(r#"{"outcome":"split_failed","reason":"no valid split after 3 rounds","split":{"children":[],"issues":["a"],"rounds":3}}"#);
        assert!(failed.contains("the split failed") && !failed.contains("approve"), "{failed}");
        assert!(note.contains(":whole keeps it one card"), "{note}");
        let (two, _) = ask(&SPLIT_GATE.replace(r#""risk":{"level":"low"}"#, r#""risk":{"level":"high"},"approvalRule":{"needed":2,"text":"t"}"#));
        assert!(two.contains("two different people"), "{two}");
    }

    #[test]
    fn the_plan_section_of_a_split_gate_shows_the_size_the_children_and_what_each_waits_for() {
        let (task, detail) = at_gate(SPLIT_GATE, "awaiting_approval");
        let text = plan_lines(&task, Some(&detail), 0).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("about 4000 lines") && text.contains("2500"), "{text}");
        assert!(text.contains("1. Part A") && text.contains("900") && text.contains("2 criteria"), "{text}");
        assert!(text.contains("2. Part B") && text.contains("after 1"), "{text}");
        assert!(text.contains("tickets") && text.contains("judged"), "{text}");
        let (task, detail) = at_gate(r#"{"outcome":"split_failed","reason":"no valid split after 3 rounds","split":{"children":[],"issues":["child 1 has fewer than 20 words to work from"],"rounds":3}}"#, "awaiting_approval");
        let failed = plan_lines(&task, Some(&detail), 0).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(failed.contains("no valid split after 3 rounds") && failed.contains("fewer than 20 words"), "{failed}");
    }

    #[test]
    fn a_machine_text_in_a_split_is_plain() {
        let (task, detail) = at_gate(&SPLIT_GATE.replace("Part A", "Part \\u001b[31mA"), "awaiting_approval");
        let text = plan_lines(&task, Some(&detail), 0).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(!text.contains('\u{1b}'), "{text:?}");
    }

    #[test]
    fn the_overview_says_what_a_stacked_card_is_and_what_it_waits_for() {
        let json = TASK.replace("\"state\":\"implementing\"", "\"state\":\"draft\"").replace("\"createdAt\"", "\"splitFrom\":\"aaaaaaaa-0000-4000-8000-000000000000\",\"splitPart\":{\"n\":2,\"of\":3},\"dependsOn\":[\"bbbbbbbb-0000-4000-8000-000000000000\"],\"base\":{\"card\":\"cccccccc-0000-4000-8000-000000000000\",\"branch\":\"task/x\"},\"startWhenReady\":true,\"riskFloor\":\"high\",\"createdAt\"");
        let task: Task = serde_json::from_str(&json).unwrap();
        let text = overview_lines(&task, None, 100, 0, &[]).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("Part 2 of 3 of aaaaaaaa"), "{text}");
        assert!(text.contains("Depends on bbbbbbbb"), "{text}");
        assert!(text.contains("Stacked on cccccccc (task/x)"), "{text}");
        assert!(text.contains("Waiting"), "{text}");
        assert!(text.contains("Risk floor high"), "{text}");
        let plain: Task = serde_json::from_str(TASK).unwrap();
        assert!(!overview_lines(&plain, None, 100, 0, &[]).iter().any(|l| l.to_string().contains("Stacked") || l.to_string().contains("Part ")), "a card with no stack shows nothing of one");
    }

    #[test]
    fn a_split_gate_shows_who_may_approve_in_the_machine_s_words_and_the_bar_counts_the_names() {
        let high = SPLIT_GATE.replace(r#""risk":{"level":"low"}"#, r#""risk":{"level":"high"},"approvalRule":{"needed":2,"outside":"at_approval","text":"Needs 2 different approvers. When CODEOWNERS names owners at the tap, one must be outside them (@ana\u001b[2J)."}"#);
        let (task, detail) = at_gate(&high, "awaiting_approval");
        let text = plan_lines(&task, Some(&detail), 0).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("Rule       Needs 2 different approvers"), "{text}");
        assert!(!text.contains('\u{1b}'), "{text:?}");
        assert!(text.split_whitespace().collect::<Vec<_>>().join(" ").contains("one must be outside them"), "the outside condition is the rule's own words: {text}");
        let question = gate_question(&task, Some(&detail)).unwrap();
        assert!(question.contains("two different people"), "{question}");
        let (task, detail) = at_gate(SPLIT_GATE, "awaiting_approval");
        assert!(!gate_question(&task, Some(&detail)).unwrap().contains("different people"));
    }

    #[test]
    fn a_held_card_says_what_it_waits_for_from_the_machine_s_hold_event_and_stops_when_released() {
        let held = |events: &str| {
            let json = TASK.replace("\"state\":\"implementing\"", "\"state\":\"draft\"").replace("\"createdAt\"", "\"startWhenReady\":true,\"createdAt\"");
            let task: Task = serde_json::from_str(&json).unwrap();
            let detail: TaskDetail = serde_json::from_str(&format!(r#"{{"task":{json},"stageRuns":[],"approvals":[],"events":{events}}}"#)).unwrap();
            overview_lines(&task, Some(&detail), 100, 0, &[]).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")
        };
        let hold = r#"{"taskId":"t","kind":"card.held","at":"2026-11-06T10:00:00Z","payload":{"reason":"dependency","waitingOn":["b"],"text":"Waiting for bbbbbbbb: its PR is not open yet\u001b[31m"}}"#;
        let text = held(&format!("[{hold}]"));
        assert!(text.contains("Waiting for bbbbbbbb: its PR is not open yet"), "{text}");
        assert!(!text.contains('\u{1b}'), "{text:?}");
        let released = r#"{"taskId":"t","kind":"card.released","at":"2026-11-06T11:00:00Z","payload":{}}"#;
        assert!(!held(&format!("[{hold},{released}]")).contains("its PR is not open yet"));
        assert!(held("[]").contains("held until its dependencies"), "no event: the fixed words stay");
    }

    // @scenario:S12
    #[test]
    fn a_snapshot_without_split_fields_parses_with_them_empty() {
        let task: Task = serde_json::from_str(TASK).unwrap();
        assert!(task.split_part.is_none() && task.split_from.is_none());
        assert!(overview_lines(&task, None, 100, 0, &[]).iter().all(|l| !l.to_string().contains("Part ")));
    }

    #[test]
    fn an_old_snapshot_without_the_stack_fields_still_parses_and_a_split_origin_reads_split() {
        let task: Task = serde_json::from_str(TASK).unwrap();
        assert!(task.split_from.is_none() && task.depends_on.is_empty() && task.base.is_none());
        let json = TASK.replace("\"createdAt\"", "\"archiveReason\":\"split\",\"splitInto\":[\"dddddddd-0000-4000-8000-000000000000\"],\"createdAt\"");
        let origin: Task = serde_json::from_str(&json).unwrap();
        let text = overview_lines(&origin, None, 100, 0, &[]).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("split into smaller changes") && text.contains("Split into dddddddd"), "{text}");
    }

    fn split_card(id8: &str, title: &str, extra: &str) -> Task {
        let json = TASK
            .replace("abcdef123456", &format!("{id8}-0000-4000-8000-000000000000"))
            .replace("Add CSV export", title)
            .replace("\"createdAt\"", &format!("{extra}\"createdAt\""));
        serde_json::from_str(&json).unwrap()
    }

    fn overview_text(task: &Task, tasks: &[Task]) -> String {
        overview_lines(task, None, 100, 0, tasks).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")
    }

    const CHILD_FROM: &str = "\"splitFrom\":\"aaaaaaaa-0000-4000-8000-000000000000\",";

    fn origin_into(ids: &[&str]) -> Task {
        let list = ids.iter().map(|i| format!("\"{i}-0000-4000-8000-000000000000\"")).collect::<Vec<_>>().join(",");
        split_card("aaaaaaaa", "Export everything", &format!("\"archiveReason\":\"split\",\"splitInto\":[{list}],"))
    }

    fn child(id8: &str, title: &str, n: u32, of: u32) -> Task {
        split_card(id8, title, &format!("{CHILD_FROM}\"splitPart\":{{\"n\":{n},\"of\":{of}}},"))
    }

    // @scenario:S4
    #[test]
    fn a_split_origin_lists_every_child_on_its_own_stack_line_with_part_title_and_state() {
        let origin = origin_into(&["bbbbbbbb", "cccccccc", "dddddddd"]);
        let tasks = vec![origin.clone(), child("bbbbbbbb", "Export CSV rows", 1, 3), child("cccccccc", "Export JSON rows", 2, 3), child("dddddddd", "Export XML rows", 3, 3)];
        let text = overview_text(&origin, &tasks);
        for (n, title) in [(1, "Export CSV rows"), (2, "Export JSON rows"), (3, "Export XML rows")] {
            let line = text.lines().find(|l| l.contains(title)).unwrap_or_else(|| panic!("no line for {title}: {text}"));
            assert!(line.starts_with("Stack") && line.to_lowercase().contains(&format!("part {n}")) && line.contains("implementing"), "{line}");
        }
    }

    // @scenario:S5
    #[test]
    fn a_split_origin_with_one_child_has_exactly_one_child_stack_line() {
        let origin = origin_into(&["bbbbbbbb"]);
        let tasks = vec![origin.clone(), child("bbbbbbbb", "Export CSV rows", 1, 1)];
        let text = overview_text(&origin, &tasks);
        let lines: Vec<&str> = text.lines().filter(|l| l.contains("Export CSV rows")).collect();
        assert_eq!(lines.len(), 1, "{text}");
        assert!(lines[0].starts_with("Stack") && lines[0].to_lowercase().contains("part 1") && lines[0].contains("implementing"), "{text}");
    }

    // @scenario:S6
    #[test]
    fn a_child_s_origin_line_has_the_origin_title_and_its_short_id() {
        let origin = origin_into(&["bbbbbbbb"]);
        let kid = child("bbbbbbbb", "Export CSV rows", 1, 1);
        let text = overview_text(&kid, &[origin, kid.clone()]);
        let line = text.lines().find(|l| l.contains("Part 1 of 1 of")).unwrap_or_else(|| panic!("{text}"));
        assert!(line.contains("Export everything") && line.contains("aaaaaaaa"), "{line}");
    }

    // @scenario:S7
    #[test]
    fn a_child_whose_origin_is_gone_shows_the_origin_s_short_id() {
        let kid = child("bbbbbbbb", "Export CSV rows", 1, 2);
        let text = overview_text(&kid, std::slice::from_ref(&kid));
        let line = text.lines().find(|l| l.contains("Part 1 of 2 of")).unwrap_or_else(|| panic!("{text}"));
        assert!(line.contains("aaaaaaaa") && !line.contains("aaaaaaaa-"), "{line}");
    }

    // @scenario:S8
    #[test]
    fn a_split_origin_shows_a_missing_child_by_short_id_and_a_present_one_by_title() {
        let origin = origin_into(&["bbbbbbbb", "eeeeeeee"]);
        let tasks = vec![origin.clone(), child("bbbbbbbb", "Export CSV rows", 1, 2)];
        let text = overview_text(&origin, &tasks);
        let stack: Vec<&str> = text.lines().filter(|l| l.starts_with("Stack")).collect();
        assert!(stack.iter().any(|l| l.contains("Export CSV rows")), "{text}");
        let missing = stack.iter().find(|l| l.contains("eeeeeeee")).unwrap_or_else(|| panic!("{text}"));
        assert!(!missing.contains("Export CSV rows"), "{missing}");
        assert!(!stack.iter().any(|l| l.trim() == "Stack"), "no empty line: {text}");
    }

    // @scenario:S9
    #[test]
    fn a_title_with_an_escape_sequence_in_a_split_line_is_printed_plain() {
        let origin = split_card("aaaaaaaa", "Origin \\u001b[31mred", "\"archiveReason\":\"split\",\"splitInto\":[\"bbbbbbbb-0000-4000-8000-000000000000\"],");
        let kid = child("bbbbbbbb", "Child \\u001b[2Jwipe", 1, 1);
        let tasks = vec![origin.clone(), kid.clone()];
        let from_origin = overview_text(&origin, &tasks);
        let from_child = overview_text(&kid, &tasks);
        assert!(!from_origin.contains('\u{1b}') && !from_child.contains('\u{1b}'), "{from_origin:?} {from_child:?}");
        assert!(from_origin.contains("Child") && from_child.contains("Origin"), "{from_origin} {from_child}");
    }

    // @scenario:S10
    #[test]
    fn the_split_lines_keep_the_part_and_split_into_wording_with_an_empty_list() {
        let kid = child("bbbbbbbb", "Export CSV rows", 2, 3);
        assert!(overview_text(&kid, &[]).contains("Part 2 of 3 of aaaaaaaa"));
        let origin = origin_into(&["dddddddd"]);
        assert!(overview_text(&origin, &[]).contains("Split into dddddddd"));
        let tasks = vec![origin.clone(), kid.clone()];
        let named = overview_text(&kid, &tasks);
        assert!(named.contains("Part 2 of 3 of") && named.contains("aaaaaaaa") && named.contains("Export everything"), "{named}");
    }

    // @scenario:S11
    #[test]
    fn a_card_with_no_split_fields_has_no_split_stack_lines() {
        let plain: Task = serde_json::from_str(TASK).unwrap();
        let other = child("bbbbbbbb", "Export CSV rows", 1, 2);
        let text = overview_text(&plain, &[other, plain.clone()]);
        assert!(!text.contains("Part ") && !text.contains("Split into") && !text.contains("Export CSV rows"), "{text}");
    }

    #[test]
    fn the_ship_question_names_the_other_approver_only_for_a_high_risk_pack() {
        let question = |risk: &str| {
            let (task, mut detail) = at_gate("{}", "awaiting_ship");
            detail.approvals = vec![serde_json::from_value(serde_json::json!({"kind":"awaiting_ship","requested":{"evidence":{"risk":risk}}})).unwrap()];
            gate_question(&task, Some(&detail)).unwrap()
        };
        assert_eq!(question("high"), "ship this PR? · high risk: a release owner is asked after the checks");
        assert_eq!(question("low"), "ship this PR?");
    }

    #[test]
    fn a_ticket_opens_on_the_section_its_gate_concerns_and_digits_jump() {
        let (mut task, _) = fixture();
        assert_eq!(Section::for_task(&task), Section::Now, "a running card opens on what it is doing");
        task.running = false;
        task.state = "draft".into();
        task.waiting_on_you = false;
        assert_eq!(Section::for_task(&task), Section::Overview);
        for (state, section) in [("awaiting_answers", Section::Gate), ("awaiting_setup", Section::Gate), ("awaiting_ship", Section::Result), ("closed", Section::Result), ("paused_rate_limit", Section::Stopped), ("failed", Section::Stopped)] {
            task.state = state.into();
            assert_eq!(Section::for_task(&task), section, "{state}");
        }
        task.state = "awaiting_approval".into();
        assert_eq!(Section::for_task(&task), Section::Review);
        task.state = "awaiting_test_check".into();
        assert_eq!(Section::for_task(&task), Section::Tests);
        task.state = "escalated".into();
        assert_eq!(Section::for_task(&task), Section::Stopped);
        task.state = "implementing".into();
        task.running = false;
        let order = order(&task);
        assert_eq!(Section::from_digit('1', &order), Some(Section::Overview));
        assert_eq!(Section::from_digit('8', &order), Some(Section::Activity));
        assert_eq!(Section::from_digit('9', &order), Some(Section::Engines));
        assert_eq!(Section::from_digit('0', &order), None);
        assert_eq!(Section::Engines.next(&order), Section::Overview);
        assert_eq!(Section::Overview.prev(&order), Section::Engines);
    }

    #[test]
    fn at_the_plan_gate_the_rail_has_review_in_place_of_plan_and_tests() {
        let (mut task, _) = fixture();
        task.state = "awaiting_approval".into();
        let at_gate = order(&task);
        assert_eq!(at_gate.first(), Some(&Section::Review));
        assert!(!at_gate.contains(&Section::Plan) && !at_gate.contains(&Section::Tests));
        assert_eq!(Section::from_digit('2', &at_gate), Some(Section::Overview));
        task.state = "implementing".into();
        let later = order(&task);
        assert!(later.contains(&Section::Plan) && later.contains(&Section::Tests) && !later.contains(&Section::Review));
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

    fn render_engines(task: &Task, detail: &TaskDetail, catalog: &Result<EngineCatalog, String>) -> String {
        let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
        let scroll = Cell::new(0);
        let view = DetailView {
            task,
            detail: Some(detail),
            section: Section::Engines,
            cursor: 1,
            scroll: &scroll,
            prs: &[],
            diff: None,
            viewport: &Cell::new(0),
            follow: &Cell::new(false),
            engines: Some(catalog),
            tasks: &[],
            actions: &[],
            can: &[],
            refs: &RefState::default(),
        };
        terminal.draw(|f| super::render(f, f.area(), &view)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..30).map(|y| (0..120).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn the_engines_section_shows_each_stage_s_engine_and_the_header_the_running_one() {
        let (mut task, mut detail) = fixture();
        task.stages.insert("triage".into(), "codex:sol".into());
        detail.stage_runs[0].engine = Some("claude:opus".into());
        detail.stage_runs[3].engine = Some("codex:sol".into());
        let catalog = Ok(crate::model::engine_tests::catalog());
        let text = render_engines(&task, &detail, &catalog);
        let row = |pack: &str| text.lines().find(|l| l.contains(&format!(" {pack} "))).unwrap_or_default().to_string();
        assert!(row("triage").contains("codex:sol") && row("triage").contains("claude:opus"), "yours, then what it ran on: {text}");
        assert!(row("triage").contains("no credential here"), "{text}");
        assert!(row("test_design").contains("▌") && row("test_design").contains("default: claude:sonnet"), "{text}");
        assert!(!text.contains("slack_triage") && !text.contains("evidence  "), "only the packs a task runs: {text}");
        assert!(text.contains("implementing on codex:sol"), "the header names the running stage's engine: {text}");
        let text = render_engines(&task, &detail, &Err("not found".into()));
        assert!(text.contains("this machine does not offer engines"), "{text}");
    }

    fn lines_text(lines: &[Line<'static>]) -> String {
        lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn build_progress_shows_each_scenario_red_or_green_the_budget_against_its_limits_and_the_last_checkpoint() {
        let mut detail: TaskDetail = serde_json::from_str(&detail_json(TASK)).unwrap();
        detail.build_progress = Some(serde_json::from_str(r#"{"scenarios":[{"id":"S1","state":"green"},{"id":"S2","state":"red"}],
            "budget":{"iterations":4,"tokens":175000,"minutes":12.5,"limits":{"max_iterations":15,"max_tokens":2000000,"max_minutes":90}},
            "lastCheckpoint":{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","follows":"green","at":"2026-10-22T10:12:00Z"}}"#).unwrap());
        let text = lines_text(&build_progress_lines(&detail));
        assert!(text.contains("S1") && text.contains("green"), "{text}");
        assert!(text.contains("S2") && text.contains("red"), "{text}");
        assert!(text.contains("4 of 15"), "{text}");
        assert!(text.contains("175k of 2000k"), "{text}");
        assert!(text.contains("12.5 of 90"), "{text}");
        assert!(text.contains("bbbbbbb") && text.contains("after a green"), "{text}");
    }

    #[test]
    fn build_progress_says_tokens_are_not_counted_and_is_silent_without_progress() {
        let mut detail: TaskDetail = serde_json::from_str(&detail_json(TASK)).unwrap();
        assert!(!lines_text(&build_progress_lines(&detail)).contains("Budget"), "no budget without progress");
        detail.build_progress = Some(serde_json::from_str(r#"{"scenarios":[],"budget":{"iterations":1,"tokens":null,"minutes":1.0,"limits":{"max_iterations":15,"max_tokens":2000000,"max_minutes":90}},"lastCheckpoint":null}"#).unwrap());
        assert!(lines_text(&build_progress_lines(&detail)).contains("not counted"));
    }

    #[test]
    fn an_escalated_gate_shows_the_reason_its_confidence_the_summary_and_the_outputs_tail_with_control_characters_taken_out() {
        let task = TASK.replace("\"state\":\"implementing\"", "\"state\":\"escalated\"");
        let mut detail: TaskDetail = serde_json::from_str(&detail_json(&task)).unwrap();
        detail.approvals.push(serde_json::from_str(r#"{"kind":"escalated","requested":{"escalation":"flaky_tests","escalationDecision":{"reason":"flaky_tests","confidence":0.82,"source":"decision","agentReason":"other"},"summary":"stopped at slice 2","outputTail":"FAIL a.test.ts\u001b[31m red \u001b]0;title\u0007\nexpected 3"},"decision":null}"#).unwrap());
        let text = lines_text(&escalation_lines(&detail));
        assert!(text.contains("flaky_tests") && text.contains("82% sure") && text.contains("by decision"), "{text}");
        assert!(text.contains("the agent said: other"), "{text}");
        assert!(text.contains("stopped at slice 2") && text.contains("expected 3"), "{text}");
        assert!(!text.contains('\u{1b}') && !text.contains('\u{7}'), "no control character reaches the terminal");
    }

    #[test]
    fn a_corrected_reason_is_shown_beside_the_decided_one() {
        let task = TASK.replace("\"state\":\"implementing\"", "\"state\":\"escalated\"");
        let mut detail: TaskDetail = serde_json::from_str(&detail_json(&task)).unwrap();
        detail.approvals.push(serde_json::from_str(r#"{"kind":"escalated","requested":{"escalationDecision":{"reason":"flaky_tests","confidence":0.8,"source":"decision","agentReason":null},"summary":"s","outputTail":"x"},"decision":null}"#).unwrap());
        detail.events.push(serde_json::from_str(r#"{"taskId":"abcdef123456","kind":"escalation.corrected","payload":{"from":"flaky_tests","to":"env_broken"},"at":"2026-10-22T10:20:00Z"}"#).unwrap());
        assert!(lines_text(&escalation_lines(&detail)).contains("corrected to env_broken"));
    }

    #[test]
    fn a_gate_that_carries_a_ticket_change_says_which_fields_and_when_through_plain() {
        let line = ticket_changed_line(&serde_json::json!({"ticketChanged":{"fields":["scope","priority"],"at":"2026-11-05T12:00:00Z"}})).expect("a line");
        assert_eq!(line, "Ticket     the ticket changed since this was written: scope edited, priority changed (2026-11-05T12:00:00Z)");
        let dirty = ticket_changed_line(&serde_json::json!({"ticketChanged":{"fields":["x\u{1b}[2J"],"at":"t\u{1b}"}})).expect("a line");
        assert!(!dirty.contains('\u{1b}'));
        assert!(ticket_changed_line(&serde_json::json!({})).is_none());
        assert!(ticket_changed_line(&serde_json::json!({"ticketChanged":{"fields":[]}})).is_none());
    }

    #[test]
    fn an_escalated_gate_names_the_kept_sandbox_and_how_long_it_lasts_with_control_characters_taken_out() {
        let task = TASK.replace("\"state\":\"implementing\"", "\"state\":\"escalated\"");
        let mut detail: TaskDetail = serde_json::from_str(&detail_json(&task)).unwrap();
        detail.approvals.push(serde_json::from_str(r#"{"kind":"escalated","requested":{"escalationDecision":{"reason":"flaky_tests","confidence":0.8,"source":"decision","agentReason":null},"summary":"s","outputTail":"x","keptSandbox":{"path":"/w/app/task-1\u001b[31m","ref":"refs/luna/kept/r1","until":"2026-11-06T12:00:00Z","keepHours":24}},"decision":null}"#).unwrap());
        let text = lines_text(&escalation_lines(&detail));
        assert!(text.contains("sandbox kept at /w/app/task-1"), "{text}");
        assert!(text.contains("until 2026-11-06T12:00:00Z"), "{text}");
        assert!(!text.contains('\u{1b}'));
    }

    #[test]
    fn the_ship_approval_asks_for_the_release_and_the_watch_is_no_gate() {
        let strip = |requested: serde_json::Value, waiting: bool| {
            let (mut task, mut detail) = at_gate("{}", "awaiting_ship");
            task.waiting_on_you = waiting;
            detail.approvals = vec![serde_json::from_value(serde_json::json!({"kind":"awaiting_ship","requested":requested})).unwrap()];
            gate_question(&task, Some(&detail))
        };
        assert_eq!(strip(serde_json::json!({"gate":"ship_approval","risk":"low"}), true).unwrap(), "approve the release?");
        assert!(strip(serde_json::json!({"gate":"ship_approval","risk":"high"}), true).unwrap().contains("high risk: a release owner, not one of the plan's approvers"));
        assert_eq!(strip(serde_json::json!({"evidence":{"risk":"low"}}), true).unwrap(), "ship this PR?");
        assert_eq!(strip(serde_json::json!({}), false), None, "a watched PR is not a gate");
    }

    #[test]
    fn the_ship_section_lists_the_checklist_and_cleans_every_machine_string() {
        let ship: crate::model::ShipView = serde_json::from_value(serde_json::json!({
            "pr":{"number":3,"url":"u"},"ready":false,
            "checklist":[{"id":"ci","ok":false,"detail":"CI \u{1b}[31mred"},{"id":"freeze","ok":false,"detail":"freeze until Monday"},{"id":"pack","ok":true,"detail":"complete"}],
            "autoMerge":{"allowed":false,"reason":"not ready\u{7}"},"review":{"required":true,"by":"a ruleset"},"fixRounds":1,"quietSince":"2026-11-01T00:00:00Z"
        })).unwrap();
        let text = ship_lines(&ship, crate::model::unix_secs("2026-11-04T00:00:00Z").unwrap()).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(!text.chars().any(|c| c.is_control() && c != '\n'), "{text:?}");
        for want in ["✗ ", "ci", "✓ ", "required by a ruleset", "1 fix round", "quiet 3 days", "keeps waiting and goes on when it ends"] {
            assert!(text.contains(want), "{want}: {text}");
        }
    }
}

/// The task view's frame: the fixed decision bar, the scroll markers and the border, drawn through `ui::draw` on the fixture cards.
#[cfg(test)]
mod frame_tests {
    use super::*;
    use crate::testkit::{escalated_app, plan_gate_app, render, running_build_app, ship_stage_app};

    fn rows(screen: &str) -> Vec<&str> {
        screen.lines().collect()
    }

    fn bar_row(screen: &str, needle: &str) -> usize {
        rows(screen).iter().position(|r| r.contains(needle)).unwrap_or_else(|| panic!("{needle} not on screen:\n{screen}"))
    }

    fn press(app: &mut crate::app::App, code: ratatui::crossterm::event::KeyCode) {
        app.handle_key(ratatui::crossterm::event::KeyEvent::from(code));
    }

    #[test]
    fn a_wide_plan_has_a_side_pane_of_reference_groups_and_the_main_text_keeps_the_plan() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Plan;
        let screen = render(&mut app, 180, 50);
        let col = |needle: &str| rows(&screen).iter().find_map(|r| r.find(needle).map(|i| r[..i].chars().count())).unwrap_or_else(|| panic!("no {needle:?} in\n{screen}"));
        assert!(col("Risk") > col("Brief") + 80, "the groups sit in a pane right of the main text: Brief at {}, Risk at {}\n{screen}", col("Brief"), col("Risk"));
        for want in ["Risk", "▸ Code map  5 files", "Checks", "⚑ plan flag", "Card", "Repo       /work/app"] {
            assert!(screen.contains(want), "{want} missing in\n{screen}");
        }
        assert!(!screen.contains("reference ──"), "no folded block under the text when the pane is there");
    }

    #[test]
    fn a_narrow_plan_folds_its_groups_under_the_main_text_behind_a_dim_rule() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Plan;
        let screen = render(&mut app, 100, 60);
        let at = |needle: &str| screen.find(needle).unwrap_or_else(|| panic!("no {needle:?} in\n{screen}"));
        assert!(at("Slices") < at("── reference") && at("── reference") < at("▸ Code map  5 files"), "{screen}");
        for folded in ["▸ Risk", "▸ Checks", "▸ Card"] {
            assert!(screen.contains(folded), "{folded} is a folded header: {screen}");
        }
        assert!(!screen.contains("src/reports/csv.ts"), "folded: the files stay out of sight\n{screen}");
    }

    #[test]
    fn tab_focuses_the_groups_enter_unfolds_one_and_esc_gives_the_keys_back_before_it_closes_the_view() {
        use ratatui::crossterm::event::KeyCode;
        let mut app = plan_gate_app();
        app.detail_section = Section::Plan;
        render(&mut app, 180, 50);
        press(&mut app, KeyCode::Tab);
        assert!(app.detail_refs.focus);
        // Risk, Checks (short, always open in the pane), then Code map: two steps down.
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        let screen = render(&mut app, 180, 50);
        assert!(screen.contains("▸ Code map  5 files"), "{screen}");
        press(&mut app, KeyCode::Enter);
        let open = render(&mut app, 180, 50);
        assert!(open.contains("▾ Code map") && open.contains("src/reports/csv.ts") && !open.contains("5 files"), "{open}");
        press(&mut app, KeyCode::Char(' '));
        assert!(render(&mut app, 180, 50).contains("▸ Code map  5 files"), "space folds it again");
        press(&mut app, KeyCode::Esc);
        assert!(!app.detail_refs.focus && matches!(app.mode, crate::app::Mode::Detail(_)), "the first esc leaves the groups");
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, crate::app::Mode::Normal), "the second closes the view");
    }

    #[test]
    fn the_fold_state_is_forgotten_when_another_card_opens_and_tab_does_nothing_without_groups() {
        use ratatui::crossterm::event::KeyCode;
        let mut app = plan_gate_app();
        app.detail_section = Section::Plan;
        render(&mut app, 180, 50);
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Enter);
        assert!(!app.detail_refs.toggled.is_empty());
        let id = app.tasks[0].id.clone();
        app.open_detail(id);
        assert!(app.detail_refs.toggled.is_empty() && !app.detail_refs.focus);
        app.detail_section = Section::Activity;
        render(&mut app, 180, 50);
        press(&mut app, KeyCode::Tab);
        assert!(!app.detail_refs.focus, "the Activity section has no groups to take the keys");
    }

    #[test]
    fn tab_and_space_are_in_the_registry_off_with_a_reason_where_there_are_no_groups() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Activity;
        render(&mut app, 180, 50);
        let avail = |app: &crate::app::App, key: &str| crate::keys::bindings_for(app, crate::keys::Scope::Detail).into_iter().find(|(b, _)| b.first() == key).map(|(_, a)| a).unwrap();
        assert!(matches!(avail(&app, "tab"), crate::keys::Avail::Off(_)));
        app.detail_section = Section::Plan;
        render(&mut app, 180, 50);
        assert_eq!(avail(&app, "tab"), crate::keys::Avail::On);
        assert!(matches!(avail(&app, "space"), crate::keys::Avail::Off(_)), "space waits for the focus");
        press(&mut app, ratatui::crossterm::event::KeyCode::Tab);
        assert_eq!(avail(&app, "space"), crate::keys::Avail::On);
    }

    #[test]
    fn the_plan_gate_bar_holds_the_question_the_keys_and_the_flag_note() {
        let mut app = plan_gate_app();
        let screen = render(&mut app, 120, 40);
        let bar = rows(&screen)[bar_row(&screen, "approve the plan?")];
        for want in ["⏸ approve the plan?", "a approve", "r send back", "e edit", "1 check flagged"] {
            assert!(bar.contains(want), "{want} missing in the bar: {bar}");
        }
        let rule = rows(&screen)[bar_row(&screen, "approve the plan?") + 1];
        assert!(rule.contains('├') && rule.contains('┬') && rule.contains('┤'), "a rule under the bar joins the frame: {rule}");
    }

    #[test]
    fn scrolling_leaves_the_bar_where_it_was() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Plan;
        let before = render(&mut app, 120, 24);
        let at = bar_row(&before, "approve the plan?");
        let bar = rows(&before)[at].to_string();
        app.detail_scroll.set(10);
        let after = render(&mut app, 120, 24);
        assert!(app.detail_scroll.get() > 0, "the plan is long enough to scroll");
        assert_eq!(rows(&after)[at], bar, "the bar is the same row after a page down:\n{after}");
        assert!(after.contains("▲") && after.contains("above"), "{after}");
    }

    #[test]
    fn the_bar_is_on_every_section_of_an_open_gate() {
        let mut app = plan_gate_app();
        for section in Section::ALL {
            app.detail_section = section;
            let screen = render(&mut app, 120, 40);
            assert!(rows(&screen)[bar_row(&screen, "approve the plan?")].contains("a approve"), "{section:?}:\n{screen}");
        }
    }

    #[test]
    fn a_running_card_says_what_runs_and_offers_no_gate_keys() {
        let mut app = running_build_app();
        let screen = render(&mut app, 120, 40);
        let at = bar_row(&screen, "implementing");
        let bar = rows(&screen)[at];
        for want in ["implementing", "S3 of 3", "$0.83"] {
            assert!(bar.contains(want), "{want} missing in the bar: {bar}");
        }
        let footer = rows(&screen).last().unwrap().to_string();
        for text in [bar.to_string(), footer] {
            for banned in ["advance", "send back", "edit", "approve"] {
                assert!(!text.contains(banned), "{banned} offered on a running card: {text}");
            }
        }
    }

    #[test]
    fn an_escalated_card_is_in_the_lost_wording_with_the_keys_that_apply() {
        let mut app = escalated_app();
        let screen = render(&mut app, 120, 40);
        let bar = rows(&screen)[bar_row(&screen, "✗ escalated")];
        assert!(bar.contains("the same migration test failed three times"), "{bar}");
        assert!(bar.contains("a retry"), "{bar}");
        assert!(!bar.contains("a approve"), "{bar}");
    }

    #[test]
    fn the_ship_gate_asks_whether_to_ship() {
        let mut app = ship_stage_app();
        let screen = render(&mut app, 120, 40);
        let bar = rows(&screen)[bar_row(&screen, "ship this PR?")];
        assert!(bar.contains("ship") && bar.contains("a ship"), "{bar}");
    }

    #[test]
    fn the_bottom_border_carries_the_stage_and_age_and_no_key_hints() {
        let mut app = plan_gate_app();
        let screen = render(&mut app, 120, 40);
        let border = rows(&screen).iter().find(|r| r.contains(" ago ") && r.contains('╯')).copied().expect("a bottom border");
        assert!(border.contains("Plan · "), "{border}");
        for hint in ["sections", "scroll", "help", "size"] {
            assert!(!border.contains(hint), "{hint} on the border: {border}");
        }
    }

    /// The count in a marker row: `▼ 12 more` is 12.
    fn count(screen: &str, glyph: char, word: &str) -> Option<usize> {
        let row = screen.lines().find(|r| r.contains(glyph))?;
        row.split(glyph).nth(1)?.trim_end_matches(|c: char| c == '│' || c.is_whitespace()).trim().trim_end_matches(word).trim().parse().ok()
    }

    #[test]
    fn scroll_markers_count_the_lines_off_screen_and_none_show_when_everything_fits() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Activity;
        let short = render(&mut app, 120, 40);
        assert!(!short.contains('▼') && !short.contains('▲'), "everything fits:\n{short}");
        app.detail_section = Section::Plan;
        let top = render(&mut app, 120, 14);
        let more = count(&top, '▼', "more").unwrap_or_else(|| panic!("a count of lines below:\n{top}"));
        assert!(more > 1 && !top.contains('▲'), "{top}");
        // Three lines of scroll: three fewer below, and what is above is those three plus the row the marker covers.
        app.detail_scroll.set(3);
        let moved = render(&mut app, 120, 14);
        assert_eq!(count(&moved, '▼', "more"), Some(more - 3), "{moved}");
        assert_eq!(count(&moved, '▲', "above"), Some(4), "{moved}");
        // At the end the marker goes, the last line shows, and one cannot scroll past it.
        app.detail_scroll.set(500);
        let end = render(&mut app, 120, 14);
        assert!(!end.contains('▼') && end.contains('▲'), "{end}");
        let clamped = app.detail_scroll.get();
        // The pane is 7 rows (11 of the popup, less the border, the bar and its rule): `more` counted from the top was total - 7 + 1.
        assert_eq!(clamped as usize, more - 1, "the offset stops at the last line");
        app.detail_scroll.set(clamped + 50);
        assert_eq!(render(&mut app, 120, 14), end, "scrolling past the end changes nothing");
        assert_eq!(app.detail_scroll.get(), clamped);
    }

    #[test]
    fn a_narrow_bar_drops_keys_from_the_lowest_priority_then_the_note_and_never_the_question() {
        let keys: Vec<(String, String)> = [("a", "approve"), ("r", "send back"), ("N", "reject"), ("e", "edit")].iter().map(|(k, l)| (k.to_string(), l.to_string())).collect();
        let text = |width: usize| bar_line(width, "⏸ approve the plan?", theme::needs_you(), &keys, "1 check flagged").to_string();
        let full = text(120);
        assert!(full.starts_with("⏸ approve the plan?") && full.contains("a approve") && full.contains("e edit") && full.trim_end().ends_with("1 check flagged"), "{full}");
        assert_eq!(cells(&full), 120, "the note sits at the right edge");
        let tight = text(80);
        assert!(tight.contains("1 check flagged") && tight.contains("a approve") && !tight.contains("e edit"), "{tight}");
        let tighter = text(30);
        assert!(!tighter.contains("check flagged") && !tighter.contains("approve ") || tighter.starts_with("⏸ approve the plan?"), "{tighter}");
        assert!(tighter.contains("⏸ approve the plan?") && !tighter.contains("a approve") && !tighter.contains("flagged"), "{tighter}");
        let squeezed = text(12);
        assert!(squeezed.starts_with("⏸ approve t") && cells(&squeezed) <= 12, "{squeezed}");
        let none: Vec<(String, String)> = Vec::new();
        assert_eq!(bar_line(60, "◐ implementing", theme::working(), &none, "").to_string(), "◐ implementing", "a running card with nothing to do shows no keys");
    }

    #[test]
    fn the_bar_shows_at_most_five_keys() {
        let keys: Vec<(String, String)> = (0..8).map(|i| (format!("{i}"), format!("do{i}"))).collect();
        let text = bar_line(200, "⏸ q?", theme::needs_you(), &keys, "").to_string();
        assert!(text.contains("4 do4") && !text.contains("5 do5"), "{text}");
    }

    #[test]
    fn a_bar_is_cleaned_of_control_characters_in_the_reason() {
        let app = escalated_app();
        let mut task = app.tasks[0].clone();
        task.reason = Some("boom\u{1b}[31m red".into());
        let status = bar_status(&task, None, 0);
        assert!(!status.text.contains('\u{1b}') && status.text.contains("escalated · boom"), "{}", status.text);
    }
}
