//! Drawing. Reads the app and never changes it.

use std::{
    cell::Cell,
    env,
    time::{SystemTime, UNIX_EPOCH},
};

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Clear, List, ListItem, ListState, Padding, Paragraph, Wrap},
};
use serde_json::Value;
use tui_textarea::TextArea;

use crate::inbox::{self, InboxState, Split};
use crate::{
    app::{ACTIONS, App, FloorState, HELP, Mode},
    model::{
        Approval, COLUMNS, Look, Metrics, REPO_COLOUR_SLOTS, Task, TaskDetail, TaskEvent, age, fmt_ms, fmt_pct, fmt_usd, repo_colour_slot, spend_p90,
        now_secs, questions_of,
    },
};

// Catppuccin Mocha, the theme herdr is configured with.
const BASE: Color = Color::Rgb(0x1e, 0x1e, 0x2e);
const SURFACE0: Color = Color::Rgb(0x31, 0x32, 0x44);
const SURFACE1: Color = Color::Rgb(0x45, 0x47, 0x5a);
const SUBTEXT0: Color = Color::Rgb(0xa6, 0xad, 0xc8);
const BLUE: Color = Color::Rgb(0x89, 0xb4, 0xfa);
const LAVENDER: Color = Color::Rgb(0xb4, 0xbe, 0xfe);
const GREEN: Color = Color::Rgb(0xa6, 0xe3, 0xa1);
const YELLOW: Color = Color::Rgb(0xf9, 0xe2, 0xaf);
const PEACH: Color = Color::Rgb(0xfa, 0xb3, 0x87);
const RED: Color = Color::Rgb(0xf3, 0x8b, 0xa8);

const ACCENT: Color = BLUE;
const MUTED: Color = SURFACE1;
const SELECTED_BG: Color = SURFACE0;

/// Narrowest a column may get before the board scrolls instead of squeezing.
const MIN_COLUMN_WIDTH: u16 = 18;
/// Width of a collapsed column in folded mode: wide enough for its header bar, not its cards.
const FOLD_WIDTH: u16 = 14;
/// Activity lines shown with a ticket.
const ACTIVITY_LINES: usize = 10;

/// Colours are dropped when `NO_COLOR` is set. States still read from their glyph and label.
fn c(color: Color) -> Color {
    if env::var_os("NO_COLOR").is_some() {
        Color::Reset
    } else {
        color
    }
}

fn look_color(look: Look) -> Color {
    match look {
        Look::Escalated => c(RED),
        Look::NeedsYou => c(PEACH),
        Look::Stale => c(PEACH),
        Look::Working => c(YELLOW),
        Look::Queued => c(SUBTEXT0),
        Look::Paused => c(LAVENDER),
        Look::Draft => c(SUBTEXT0),
        Look::Done => c(GREEN),
    }
}

fn look_glyph(look: Look) -> &'static str {
    match look {
        Look::Escalated => "✗",
        Look::NeedsYou => "⏸",
        Look::Stale => "⌛",
        Look::Working => spinner(),
        Look::Queued => "…",
        Look::Paused => "⏳",
        Look::Draft => "○",
        Look::Done => "✓",
    }
}

/// A four-frame spinner for running stages, advancing every quarter second.
fn spinner() -> &'static str {
    const FRAMES: [&str; 4] = ["◐", "◓", "◑", "◒"];
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    FRAMES[(millis / 250 % 4) as usize]
}

fn selection_style() -> Style {
    if env::var_os("NO_COLOR").is_some() {
        Style::new().add_modifier(Modifier::REVERSED)
    } else {
        Style::new().bg(SELECTED_BG)
    }
}

pub fn draw(frame: &mut Frame, app: &App) {
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(frame.area());

    frame.render_widget(header_line(app), header);
    if let Some(floor) = &app.floor {
        render_floor(frame, body, floor);
        frame.render_widget(footer_line(app), footer);
        return;
    }
    if let Some(inbox) = app.inbox.as_ref().filter(|_| matches!(app.mode, Mode::Normal | Mode::ConfirmApproveAll(_))) {
        render_inbox(frame, body, app, inbox);
        frame.render_widget(footer_line(app), footer);
        if let Mode::ConfirmApproveAll(ids) = &app.mode {
            render_note(frame, " Approve them all? ", &format!("{} ticket(s) in Approve get a yes, each with no guidance.  y / n", ids.len()));
        }
        return;
    }
    render_board(frame, body, app);
    frame.render_widget(footer_line(app), footer);

    match &app.mode {
        Mode::Detail(id) => {
            if let Some(task) = app.task(id) {
                let area = centered(frame.area(), frame.area().width * 9 / 10, frame.area().height * 8 / 10);
                frame.render_widget(Clear, area);
                render_detail(frame, area, task, app.detail.as_ref(), &app.detail_scroll);
            }
        }
        Mode::ConfirmDelete(id) => {
            if let Some(task) = app.task(id) {
                render_confirm(
                    frame,
                    task,
                    " Delete ticket? ",
                    "Its runs and history go too. Its worktree and branch stay.",
                );
            }
        }
        Mode::ConfirmAbort(id) => {
            if let Some(task) = app.task(id) {
                render_confirm(
                    frame,
                    task,
                    " Abort the running stage? ",
                    "The container is stopped and the ticket waits for you.",
                );
            }
        }
        Mode::ConfirmWorktree(id) => {
            if let Some(task) = app.task(id) {
                render_confirm(
                    frame,
                    task,
                    " Kill the worktree? ",
                    "Removes its checkout from disk. The branch and its commits stay.",
                );
            }
        }
        Mode::EditTicket { id, area, vim } => {
            let rect = centered(frame.area(), frame.area().width * 9 / 10, frame.area().height * 8 / 10);
            frame.render_widget(Clear, rect);
            let (label, mode_color) = match vim.mode() {
                crate::vim::Mode::Normal => (" NORMAL ", ACCENT),
                crate::vim::Mode::Insert => (" INSERT ", GREEN),
            };
            let mut area = area.clone();
            if let Some(block) = area.block() {
                let mut block = block
                    .clone()
                    .border_type(BorderType::Rounded)
                    .border_style(Style::new().fg(c(mode_color)))
                    .title_bottom(Line::from(label).bold().fg(c(mode_color)).left_aligned());
                if let Some(task) = app.task(id) {
                    block = block.title_bottom(
                        Line::from(format!(" {} ", task.column))
                            .bold()
                            .fg(c(look_color(task.look())))
                            .right_aligned(),
                    );
                }
                area.set_block(block);
            }
            area.set_cursor_line_style(Style::new().bg(c(SURFACE0)));
            area.set_selection_style(Style::new().bg(c(SURFACE1)));
            area.set_cursor_style(Style::new().bg(c(mode_color)).fg(c(BASE)));
            frame.render_widget(&area, rect);
        }
        Mode::EditPlan { id, plan_area, ticket_area, focus, plan_vim, ticket_vim } => {
            let outer = centered(frame.area(), frame.area().width * 95 / 100, frame.area().height * 9 / 10);
            frame.render_widget(Clear, outer);
            let [plan_rect, ticket_rect] =
                Layout::horizontal([Constraint::Percentage(54), Constraint::Percentage(46)]).areas(outer);

            let paint = |area: &mut TextArea<'static>, vim: &crate::vim::Vim, pane: crate::app::PlanPane, title: String| {
                let focused = *focus == pane;
                let (label, mode_color) = match vim.mode() {
                    crate::vim::Mode::Normal => (" NORMAL ", ACCENT),
                    crate::vim::Mode::Insert => (" INSERT ", GREEN),
                };
                let border = if focused { mode_color } else { SURFACE1 };
                if let Some(block) = area.block() {
                    let mut block = block
                        .clone()
                        .border_type(BorderType::Rounded)
                        .border_style(Style::new().fg(c(border)))
                        .title(title);
                    if focused {
                        block = block.title_bottom(Line::from(label).bold().fg(c(mode_color)).left_aligned());
                    }
                    area.set_block(block);
                }
                if focused {
                    area.set_cursor_line_style(Style::new().bg(c(SURFACE0)));
                    area.set_selection_style(Style::new().bg(c(SURFACE1)));
                    area.set_cursor_style(Style::new().bg(c(mode_color)).fg(c(BASE)));
                } else {
                    area.set_cursor_line_style(Style::new());
                    area.set_cursor_style(Style::new());
                }
            };

            let mut plan_area = plan_area.clone();
            paint(&mut plan_area, plan_vim, crate::app::PlanPane::Plan, " plan ".to_string());
            frame.render_widget(&plan_area, plan_rect);

            let mut ticket_area = ticket_area.clone();
            let ticket_title = app.task(id).map(|t| format!(" ticket #{} ", t.short_id())).unwrap_or_else(|| " ticket ".to_string());
            paint(&mut ticket_area, ticket_vim, crate::app::PlanPane::Ticket, ticket_title);
            frame.render_widget(&ticket_area, ticket_rect);
        }
        Mode::Actions { cursor } => render_actions(frame, app, *cursor),
        Mode::RepoPicker { id, query, all, cursor } => {
            if let Some(task) = app.task(id) {
                render_repo_picker(frame, task, query, all, *cursor);
            }
        }
        Mode::Help => render_help(frame),
        _ => {}
    }
}

fn header_line(app: &App) -> Line<'static> {
    let mut spans = vec![Span::from(" Luna TUI ").fg(c(BASE)).bg(c(ACCENT)).bold()];
    if app.online {
        let total = app.tasks.len();
        let running = app.tasks.iter().filter(|t| t.running).count();
        let queued = app.tasks.iter().filter(|t| t.queued).count();
        let waiting = app
            .tasks
            .iter()
            .filter(|t| matches!(t.look(), Look::NeedsYou | Look::Escalated))
            .count();
        let queued_part = if queued > 0 { format!(" · {queued} queued") } else { String::new() };
        spans.push(
            Span::from(format!("  {total} tickets · {running} running{queued_part} · {waiting} need you"))
                .fg(c(SUBTEXT0)),
        );
    } else {
        spans.push(
            Span::from(format!(
                "  machine offline at {} · {} · retrying",
                app.machine_url(),
                app.offline_reason
            ))
            .fg(c(RED))
            .bold(),
        );
    }
    if app.needs_only {
        spans.push(Span::from("  [needs you only]").fg(c(PEACH)).bold());
    }
    if app.this_repo_only {
        spans.push(Span::from("  [this repo only]").fg(c(PEACH)).bold());
    }
    if !app.filter.trim().is_empty() {
        spans.push(Span::from(format!("  [filter: {}]", app.filter)).fg(c(ACCENT)).bold());
    }
    if app.floor.is_some() {
        spans.push(Span::from("  [floor]").fg(c(BLUE)).bold());
    }
    if app.fold {
        spans.push(Span::from("  [folded]").fg(c(BLUE)).bold());
    }
    Line::from(spans)
}

fn footer_line(app: &App) -> Line<'static> {
    if let Some(toast) = &app.toast {
        let color = if toast.error { RED } else { GREEN };
        return Line::from(Span::from(format!(" {}", toast.text)).fg(c(color)).bold());
    }

    if app.floor.is_some() && matches!(app.mode, Mode::Normal) {
        return hint(&[("r", "refresh"), ("esc", "close")]);
    }
    if app.inbox.is_some() && matches!(app.mode, Mode::Normal) {
        return hint(&[("j/k", "move"), ("h/l", "split"), ("a/r/e", "act"), ("A", "approve all"), ("enter", "open"), ("esc", "close")]);
    }

    match &app.mode {
        Mode::Adding(buf) => Line::from(vec![
            Span::from(" new ticket: ").fg(c(ACCENT)).bold(),
            Span::from(format!("{buf}▏")),
            Span::from("   enter create and edit · esc cancel").fg(c(SUBTEXT0)),
        ]),
        Mode::EditTicket { vim, .. } => match vim.mode() {
            crate::vim::Mode::Normal => hint(&[
                ("i/a/o", "insert"),
                ("hjkl", "move"),
                ("dd/x", "delete"),
                ("ctrl+s", "save"),
                ("esc", "cancel"),
            ]),
            crate::vim::Mode::Insert => hint(&[("esc", "normal mode"), ("ctrl+s", "save")]),
        },
        Mode::EditPlan { focus, plan_vim, ticket_vim, .. } => {
            let vim = match focus {
                crate::app::PlanPane::Plan => plan_vim,
                crate::app::PlanPane::Ticket => ticket_vim,
            };
            let pane = match focus {
                crate::app::PlanPane::Plan => "plan",
                crate::app::PlanPane::Ticket => "ticket",
            };
            match vim.mode() {
                crate::vim::Mode::Normal => hint(&[
                    ("tab", "switch pane"),
                    ("i/a/o", "insert"),
                    ("hjkl", "move"),
                    ("ctrl+s", "save both"),
                    ("esc", "cancel"),
                ]),
                crate::vim::Mode::Insert => {
                    Line::from(vec![
                        Span::from(format!(" editing the {pane} ")).fg(c(ACCENT)).bold(),
                        Span::from("   esc normal mode · ctrl+s save both").fg(c(SUBTEXT0)),
                    ])
                }
            }
        }
        Mode::Filter => Line::from(vec![
            Span::from(" filter: ").fg(c(ACCENT)).bold(),
            Span::from(format!("{}▏", app.filter)),
            Span::from("   enter keep · esc clear").fg(c(SUBTEXT0)),
        ]),
        Mode::Reason { approve, text, .. } => {
            let prompt = if *approve {
                " guidance for the retry (optional): "
            } else {
                " send back because: "
            };
            Line::from(vec![
                Span::from(prompt).fg(c(ACCENT)).bold(),
                Span::from(format!("{text}▏")),
                Span::from("   enter send · esc cancel").fg(c(SUBTEXT0)),
            ])
        }
        Mode::ConfirmDelete(_) | Mode::ConfirmAbort(_) | Mode::ConfirmWorktree(_) => {
            hint(&[("y", "yes"), ("n", "no")])
        }
        Mode::Actions { .. } => hint(&[("j/k", "move"), ("enter", "run"), ("esc", "close")]),
        Mode::RepoPicker { .. } => hint(&[("type", "filter"), ("↑/↓", "move"), ("enter", "set"), ("esc", "cancel")]),
        Mode::ConfirmApproveAll(_) => hint(&[("y", "approve them all"), ("n", "cancel")]),
        Mode::Help => hint(&[("any key", "close")]),
        Mode::Detail(id) => {
            let shippable = app.task(id).is_some_and(|t| t.state == "awaiting_ship");
            if shippable {
                hint(&[
                    ("jk", "scroll"),
                    ("S", "ship"),
                    ("r", "send back"),
                    ("e", "edit"),
                    ("f", "focus agent"),
                    ("esc", "back"),
                ])
            } else {
                hint(&[
                    ("jk", "scroll"),
                    ("a", "advance"),
                    ("r", "send back"),
                    ("e", "edit"),
                    ("f", "focus agent"),
                    ("X", "abort"),
                    ("esc", "back"),
                ])
            }
        }
        Mode::Normal => hint(&[
            ("?", "help"),
            ("n", "new"),
            ("a", "advance"),
            ("enter", "open"),
            ("x", "actions"),
            ("/", "filter"),
            ("q", "quit"),
        ]),
    }
}

fn hint(keys: &[(&str, &str)]) -> Line<'static> {
    let mut spans = vec![Span::raw(" ")];
    for (key, desc) in keys {
        spans.push(Span::from(format!(" {key} ")).fg(c(BASE)).bg(c(ACCENT)));
        spans.push(Span::from(format!(" {desc}  ")).fg(c(SUBTEXT0)));
    }
    Line::from(spans)
}

fn render_board(frame: &mut Frame, area: Rect, app: &App) {
    if app.fold {
        render_board_folded(frame, area, app);
        return;
    }
    let visible = ((area.width / MIN_COLUMN_WIDTH) as usize).clamp(1, COLUMNS.len());
    let start = app
        .focus
        .saturating_sub(visible - 1)
        .min(COLUMNS.len() - visible);
    let rects = Layout::horizontal(vec![Constraint::Ratio(1, visible as u32); visible]).split(area);

    app.column_rects.borrow_mut().clear();
    for (slot, rect) in rects.iter().enumerate() {
        let column = start + slot;
        app.column_rects.borrow_mut().push((column, *rect));
        render_column(frame, *rect, app, column, true);
    }
}

/// Every column at once: the focused one expanded, the rest collapsed to their header bar.
/// Lets a narrow terminal keep every column's presence and count in view, instead of scrolling
/// columns off-screen entirely.
fn render_board_folded(frame: &mut Frame, area: Rect, app: &App) {
    let constraints: Vec<Constraint> = (0..COLUMNS.len())
        .map(|column| {
            if column == app.focus {
                Constraint::Fill(1)
            } else {
                Constraint::Length(FOLD_WIDTH)
            }
        })
        .collect();
    let rects = Layout::horizontal(constraints).split(area);

    app.column_rects.borrow_mut().clear();
    for (column, rect) in rects.iter().enumerate() {
        app.column_rects.borrow_mut().push((column, *rect));
        render_column(frame, *rect, app, column, column == app.focus);
    }
}

fn render_column(frame: &mut Frame, area: Rect, app: &App, column: usize, expanded: bool) {
    let focused = column == app.focus;
    let indices = app.indices(column);

    let mut title = vec![
        Span::from(format!(" {} ", COLUMNS[column])).bold(),
        Span::from(format!("{} ", indices.len())).fg(c(SUBTEXT0)),
    ];
    for look in [Look::Escalated, Look::NeedsYou, Look::Working, Look::Queued, Look::Paused] {
        let count = indices.iter().filter(|&&i| app.tasks[i].look() == look).count();
        if count > 0 {
            title.push(Span::from(format!("{}{count} ", look_glyph(look))).fg(look_color(look)));
        }
    }

    let border = if focused { ACCENT } else { MUTED };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(border)))
        .padding(Padding::horizontal(1))
        .title(Line::from(title));

    if !expanded {
        // Folded: just the header bar (title and counts), no room to show cards legibly.
        frame.render_widget(block, area);
        return;
    }

    let p90 = spend_p90(&app.tasks);
    let items: Vec<ListItem> = indices.iter().map(|&i| card(&app.tasks[i], p90)).collect();
    let list = List::new(items)
        .block(block)
        .highlight_style(selection_style())
        .highlight_symbol("▌ ");

    let mut state = ListState::default();
    if focused && !indices.is_empty() {
        state.select(Some(app.selection[column]));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

/// A board card: id and title, then state, age, worktree and how many implementer runs.
/// One colour per repo, so a column scans by repo: the bar and the name share it.
const REPO_COLOURS: [Color; REPO_COLOUR_SLOTS] = [BLUE, GREEN, PEACH, LAVENDER, YELLOW, RED];

/// The card's first line: a repo-coloured bar, the id, the repo's name, the title.
fn card_head(task: &Task) -> Line<'static> {
    let mut spans = Vec::new();
    if let Some(repo) = task.repo_name() {
        let colour = REPO_COLOURS[repo_colour_slot(repo)];
        spans.push(Span::from("▌").fg(c(colour)));
        spans.push(Span::from(format!("#{} ", task.short_id())).fg(c(SUBTEXT0)));
        spans.push(Span::from(format!("{repo} ")).fg(c(colour)));
    } else {
        spans.push(Span::from(format!("#{} ", task.short_id())).fg(c(SUBTEXT0)));
    }
    spans.push(Span::from(task.issue_prefix()).fg(c(SUBTEXT0)));
    spans.push(Span::from(task.title.clone()).bold());
    Line::from(spans)
}

fn card(task: &Task, spend_p90: Option<f64>) -> ListItem<'static> {
    ListItem::new(card_lines(task, spend_p90))
}

/// The card's three lines: head, status, and the triad (or a blank spacer without one).
fn card_lines(task: &Task, spend_p90: Option<f64>) -> Vec<Line<'static>> {
    let look = task.look();
    let head = card_head(task);

    let mut meta = vec![
        Span::raw("  "),
        Span::from(format!("{} {}", look_glyph(look), task.status_label()))
            .fg(look_color(look))
            .bold(),
        Span::from(format!(" {}", age(&task.updated_at, now_secs()))).fg(c(SUBTEXT0)),
    ];
    if task.worktree_path.is_some() {
        meta.push(Span::from("  ⎇").fg(c(ACCENT)));
    }
    if task.retries.total > 1 {
        meta.push(Span::from(format!("  run {}", task.retries.total)).fg(c(PEACH)));
    }
    if task.repo_path.is_none() && task.state == "draft" {
        meta.push(Span::from("  no repo").fg(c(SUBTEXT0)));
    }
    // A dim `$` on the tickets above the p90 of spend: the expensive ones at a glance.
    if task.spent_usd.zip(spend_p90).is_some_and(|(spent, p90)| spent > p90) {
        meta.push(Span::from("  $").fg(c(SUBTEXT0)));
    }

    let third = task.triad().map_or_else(Line::default, |t| Line::from(Span::from(format!("  {t}")).fg(c(SUBTEXT0))));
    vec![head, Line::from(meta), third]
}

fn bullets(items: &[String]) -> Vec<Line<'static>> {
    items.iter().map(|item| Line::from(format!("  • {item}"))).collect()
}

fn json_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// "title (~N LOC)" per proposed slice; entries without a title are skipped.
fn slice_lines(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let title = item["title"].as_str()?;
                    Some(match item["est_loc"].as_u64() {
                        Some(loc) => format!("{title} (~{loc} LOC)"),
                        None => title.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// test_design's cases: what each proves (the plan criterion) and the test that does it.
fn case_lines(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let title = item["title"].as_str()?;
                    let test = item["test"].as_str().unwrap_or("");
                    Some(match item["criterion"].as_str() {
                        Some(criterion) => format!("{title} — proves: {criterion} · {test}"),
                        None => format!("{title} · {test}"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// "verdict", "N artifacts" and up to three artifact paths from `requested.evidence`.
fn evidence_lines(value: &Value) -> Vec<String> {
    let Some(verdict) = value["verdict"].as_str() else { return Vec::new() };
    let count = value["artifactCount"].as_u64().unwrap_or(0);
    let mut lines = vec![
        format!("verdict: {verdict}"),
        format!("{count} artifact{}", if count == 1 { "" } else { "s" }),
    ];
    lines.extend(json_list(&value["thumbnails"]).into_iter().take(3));
    lines
}

/// Counts, calibration and the proposed rules text from `requested.rules`, at most 12 lines of
/// it, each cut to `width` columns. Empty when the review proposed nothing.
fn rules_lines(value: &Value, width: usize) -> Vec<String> {
    let Some(markdown) = value["markdown"].as_str().filter(|m| !m.trim().is_empty()) else {
        return Vec::new();
    };
    const MAX: usize = 12;
    let mut counts = format!(
        "{} incident(s) · {} pattern(s)",
        value["incidents"].as_u64().unwrap_or(0),
        value["patterns"].as_u64().unwrap_or(0)
    );
    if let Some(bias) = value["calibration"]["estLocBias"].as_f64() {
        counts.push_str(&format!(" · estLocBias {bias}"));
    }
    let text: Vec<&str> = markdown.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut lines = vec![counts];
    lines.extend(text.iter().take(MAX).map(|l| l.chars().take(width).collect::<String>()));
    if text.len() > MAX {
        lines.push(format!("… +{} more", text.len() - MAX));
    }
    lines
}

/// Assumptions, the proposed slices and the test cases (or, without them, the test files)
/// an open gate asks you to judge.
fn push_proposal_sections(lines: &mut Vec<Line<'static>>, requested: &Value) {
    let heading = |text: &str| Line::from(Span::from(text.to_string()).fg(c(PEACH)).bold());
    let cases = case_lines(&requested["cases"]);
    let tests = if cases.is_empty() { json_list(&requested["tests"]) } else { Vec::new() };
    for (title, items) in [
        ("Assumptions", json_list(&requested["assumptions"])),
        ("Slices", slice_lines(&requested["slices"])),
        ("Test cases", cases),
        ("Tests", tests),
    ] {
        if !items.is_empty() {
            lines.extend([Line::default(), heading(title)]);
            lines.extend(bullets(&items));
        }
    }
}

/// Where a paused or escalated ticket picks up; an escalated one also says how to retry it.
fn continues_line(state: &str, stage: &str) -> String {
    if state == "escalated" {
        format!("Continues at: {stage} · a retries it (add guidance if you like)")
    } else {
        format!("Continues at: {stage}")
    }
}

/// The full ticket: state, what it waits on you for, text, stage runs and activity.
fn render_detail(frame: &mut Frame, area: Rect, task: &Task, detail: Option<&TaskDetail>, scroll: &Cell<u16>) {
    let detail = detail.filter(|d| d.task.id == task.id);
    if task.state == "awaiting_approval"
        && let Some(approval) = detail.and_then(TaskDetail::open_approval) {
            render_plan_and_ticket(frame, area, task, detail, approval, scroll);
            return;
        }

    let heading = |text: String| Line::from(Span::from(text).fg(c(ACCENT)).bold());
    // What the agent proposed, needing your judgment, gets its own color — distinct from the
    // plain facts (Description, Stages, Activity...) below it.
    let proposal_heading = |text: String| Line::from(Span::from(text).fg(c(PEACH)).bold());
    let muted = |text: String| Line::from(Span::from(text).fg(c(SUBTEXT0)));
    let look = task.look();

    let mut lines = vec![muted(format!(
        "Repo: {}",
        task.repo_path.as_deref().unwrap_or("none (add one with e to run real agents)")
    ))];
    if let Some(source) = &task.source {
        lines.push(muted(format!("GitHub: {}#{}  {}", source.repo, source.number, source.url)));
    }
    if let Some(branch) = &task.branch {
        lines.push(muted(format!("Branch: {branch}")));
    }
    if let Some(stage) = &task.resume_to {
        lines.push(muted(continues_line(&task.state, stage)));
    }
    if let Some(reason) = &task.reason {
        lines.push(Line::from(format!("Why: {reason}")).fg(look_color(look)));
    }
    if task.retries.total > 0 {
        let r = &task.retries;
        lines.push(muted(format!(
            "Implementer runs: {} · failures: verify {} · e2e {} · ci {}",
            r.total, r.verify, r.e2e, r.ci
        )));
    }

    if let Some(approval) = detail.and_then(TaskDetail::open_approval) {
        lines.extend([Line::default(), Line::from(Span::from(format!("Waiting on you: {}", task.status_label())).fg(look_color(look)).bold())]);
        let requested = &approval.requested;
        if let Some(error) = requested["error"].as_str() {
            lines.extend([Line::default(), Line::from(Span::from("Error").fg(c(RED)).bold())]);
            lines.extend(error.lines().map(|l| Line::from(format!("  {l}")).fg(c(RED))));
        }
        if let Some(note) = requested["note"].as_str() {
            lines.push(muted(note.to_string()));
        }
        if let Some(url) = requested["prUrl"].as_str() {
            let reused = requested["reused"].as_bool().unwrap_or(false);
            lines.push(Line::from(vec![
                Span::from(if reused { "PR (already open): " } else { "PR opened: " }).fg(c(SUBTEXT0)),
                Span::from(url.to_string()).fg(c(BLUE)),
            ]));
        }
        if let Some(brief) = requested["brief"].as_str() {
            lines.extend([Line::default(), proposal_heading("Plan".into())]);
            lines.extend(brief.lines().map(|l| Line::from(format!("  {l}"))));
        }
        let criteria = json_list(&requested["criteria"]);
        if !criteria.is_empty() {
            lines.extend([Line::default(), proposal_heading("Criteria to build".into())]);
            lines.extend(bullets(&criteria));
        }
        push_proposal_sections(&mut lines, requested);
        let evidence = evidence_lines(&requested["evidence"]);
        if !evidence.is_empty() {
            lines.extend([Line::default(), proposal_heading("Evidence".into())]);
            lines.extend(bullets(&evidence));
        }
        let rules = rules_lines(&requested["rules"], usize::from(area.width).saturating_sub(8).max(20));
        if !rules.is_empty() {
            lines.extend([Line::default(), proposal_heading("Proposed rules (a applies, A skips)".into())]);
            lines.extend(rules.iter().map(|l| Line::from(format!("  {l}"))));
        }
        let questions = questions_of(approval);
        if !questions.is_empty() {
            lines.extend([Line::default(), proposal_heading("Questions (a to answer)".into())]);
            for (question, recommended) in questions {
                lines.push(Line::from(format!("  ? {question}")));
                lines.push(muted(format!("    recommended: {recommended}")));
            }
        }
    }

    lines.extend([Line::default(), heading("Description".into())]);
    if task.description.trim().is_empty() {
        lines.push(muted("  (none yet, press e to add)".into()));
    } else {
        lines.extend(task.description.lines().map(|l| Line::from(format!("  {l}"))));
    }
    lines.extend([Line::default(), heading("Acceptance criteria".into())]);
    if task.criteria.is_empty() {
        lines.push(muted("  (none yet, press e to add)".into()));
    } else {
        lines.extend(bullets(&task.criteria));
    }

    if let Some(detail) = detail {
        if !detail.stage_runs.is_empty() {
            lines.extend([Line::default(), heading("Stages".into())]);
            for run in &detail.stage_runs {
                let color = match run.status.as_str() {
                    "passed" => GREEN,
                    "failed" => RED,
                    "running" => YELLOW,
                    _ => SUBTEXT0,
                };
                let mut spans = vec![
                    Span::from(format!("  {} #{} ", run.stage, run.attempt)),
                    Span::from(run.status.clone()).fg(c(color)),
                ];
                if let Some(usage) = run.usage_label() {
                    spans.push(Span::from(format!("  {usage}")).fg(c(SUBTEXT0)));
                }
                lines.push(Line::from(spans));
            }
            if let Some(spent) = detail.spent_usd() {
                lines.push(Line::from(Span::from(format!("  Spent: ${spent:.2}")).fg(c(SUBTEXT0))));
            }
        }
        lines.extend([Line::default(), heading("Activity".into())]);
        let start = detail.events.len().saturating_sub(ACTIVITY_LINES);
        lines.extend(detail.events[start..].iter().map(|e| muted(format!("  {}", describe(e)))));
    }

    let block = detail_block(task, look);

    // Clamp to the content's actual height, which depends on the terminal width (wrapping),
    // so j/k can't scroll into empty space past the end.
    let inner = block.inner(area);
    let total_lines = Paragraph::new(Text::from(lines.clone())).wrap(Wrap { trim: false }).line_count(inner.width);
    let offset = scroll.get().min(total_lines.saturating_sub(inner.height as usize) as u16);
    scroll.set(offset);

    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .block(block)
            .wrap(Wrap { trim: false })
            .scroll((offset, 0)),
        area,
    );
}

/// The detail popup's border and titles: look-colored, the ticket's name, status and age.
fn detail_block(task: &Task, look: Look) -> Block<'static> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(look_color(look))))
        .padding(Padding::new(2, 2, 1, 1))
        .title(Line::from(format!(" #{} {} ", task.short_id(), task.title)).bold())
        .title_bottom(
            Line::from(vec![
                Span::from(format!(" {} {} ", look_glyph(look), task.status_label())).bold(),
            ])
            .fg(c(look_color(look)))
            .left_aligned(),
        )
        .title_bottom(
            Line::from(format!(" {} · {} ago ", task.column, age(&task.updated_at, now_secs())))
                .fg(c(SUBTEXT0))
                .right_aligned(),
        )
}

/// Triage's plan (left) and the ticket's own text (right), side by side at 110 columns or
/// wider — stacked, plan first, on a narrower terminal. `e` edits both.
fn render_plan_and_ticket(frame: &mut Frame, area: Rect, task: &Task, detail: Option<&TaskDetail>, approval: &Approval, scroll: &Cell<u16>) {
    let heading = |text: String| Line::from(Span::from(text).fg(c(ACCENT)).bold());
    let proposal_heading = |text: String| Line::from(Span::from(text).fg(c(PEACH)).bold());
    let muted = |text: String| Line::from(Span::from(text).fg(c(SUBTEXT0)));
    let look = task.look();
    let requested = &approval.requested;

    let mut plan_lines = vec![proposal_heading("Plan".into())];
    match requested["brief"].as_str() {
        Some(brief) => plan_lines.extend(brief.lines().map(|l| Line::from(format!("  {l}")))),
        None => plan_lines.push(muted("  (none)".into())),
    }
    plan_lines.extend([Line::default(), proposal_heading("Criteria to build".into())]);
    let criteria = json_list(&requested["criteria"]);
    if criteria.is_empty() {
        plan_lines.push(muted("  (none)".into()));
    } else {
        plan_lines.extend(bullets(&criteria));
    }
    push_proposal_sections(&mut plan_lines, requested);

    let mut ticket_lines = vec![muted(format!(
        "Repo: {}",
        task.repo_path.as_deref().unwrap_or("none (add one with e to run real agents)")
    ))];
    if let Some(source) = &task.source {
        ticket_lines.push(muted(format!("GitHub: {}#{}  {}", source.repo, source.number, source.url)));
    }
    if let Some(branch) = &task.branch {
        ticket_lines.push(muted(format!("Branch: {branch}")));
    }
    ticket_lines.extend([
        Line::default(),
        Line::from(Span::from(format!("Waiting on you: {}", task.status_label())).fg(look_color(look)).bold()),
    ]);
    ticket_lines.extend([Line::default(), heading("Description".into())]);
    if task.description.trim().is_empty() {
        ticket_lines.push(muted("  (none yet, press e to add)".into()));
    } else {
        ticket_lines.extend(task.description.lines().map(|l| Line::from(format!("  {l}"))));
    }
    ticket_lines.extend([Line::default(), heading("Acceptance criteria".into())]);
    if task.criteria.is_empty() {
        ticket_lines.push(muted("  (none yet, press e to add)".into()));
    } else {
        ticket_lines.extend(bullets(&task.criteria));
    }
    if let Some(detail) = detail {
        if !detail.stage_runs.is_empty() {
            ticket_lines.extend([Line::default(), heading("Stages".into())]);
            for run in &detail.stage_runs {
                let color = match run.status.as_str() {
                    "passed" => GREEN,
                    "failed" => RED,
                    "running" => YELLOW,
                    _ => SUBTEXT0,
                };
                let mut spans = vec![
                    Span::from(format!("  {} #{} ", run.stage, run.attempt)),
                    Span::from(run.status.clone()).fg(c(color)),
                ];
                if let Some(usage) = run.usage_label() {
                    spans.push(Span::from(format!("  {usage}")).fg(c(SUBTEXT0)));
                }
                ticket_lines.push(Line::from(spans));
            }
            if let Some(spent) = detail.spent_usd() {
                ticket_lines.push(Line::from(Span::from(format!("  Spent: ${spent:.2}")).fg(c(SUBTEXT0))));
            }
        }
        ticket_lines.extend([Line::default(), heading("Activity".into())]);
        let start = detail.events.len().saturating_sub(ACTIVITY_LINES);
        ticket_lines.extend(detail.events[start..].iter().map(|e| muted(format!("  {}", describe(e)))));
    }

    let block = detail_block(task, look).title_bottom(Line::from(" e edits both ").fg(c(SUBTEXT0)).left_aligned());
    let inner = block.inner(area);
    let wide = inner.width >= 110;
    let (plan_area, ticket_area) = if wide {
        let [plan_area, _gap, ticket_area] =
            Layout::horizontal([Constraint::Percentage(54), Constraint::Length(2), Constraint::Percentage(44)]).areas(inner);
        (plan_area, ticket_area)
    } else {
        let plan_height = Paragraph::new(Text::from(plan_lines.clone())).wrap(Wrap { trim: false }).line_count(inner.width) as u16;
        let [plan_area, ticket_area] =
            Layout::vertical([Constraint::Length(plan_height.min(inner.height / 2)), Constraint::Min(0)]).areas(inner);
        (plan_area, ticket_area)
    };

    // One shared scroll offset, clamped to whichever column is taller — the two stay in step.
    let plan_total = Paragraph::new(Text::from(plan_lines.clone())).wrap(Wrap { trim: false }).line_count(plan_area.width);
    let ticket_total = Paragraph::new(Text::from(ticket_lines.clone())).wrap(Wrap { trim: false }).line_count(ticket_area.width);
    let total_lines = plan_total.max(ticket_total);
    let offset = scroll.get().min(total_lines.saturating_sub(inner.height as usize) as u16);
    scroll.set(offset);

    frame.render_widget(Clear, area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(Text::from(plan_lines)).wrap(Wrap { trim: false }).scroll((offset, 0)),
        plan_area,
    );
    frame.render_widget(
        Paragraph::new(Text::from(ticket_lines)).wrap(Wrap { trim: false }).scroll((offset, 0)),
        ticket_area,
    );
}

/// One activity entry in words.
fn describe(event: &TaskEvent) -> String {
    let p = &event.payload;
    let s = |key: &str| p[key].as_str().unwrap_or("?").to_string();
    let time = event.at.get(11..19).unwrap_or("");
    let what = match event.kind.as_str() {
        "transition" => format!("{} → {}", s("from"), s("to")),
        "stage.started" => format!("▶ {} #{}", s("stage"), p["attempt"]),
        "stage.finished" => {
            let error = p["error"]
                .as_str()
                .or_else(|| p["detail"]["error"].as_str())
                .map(|e| format!(": {e}"))
                .unwrap_or_default();
            format!("■ {} #{} {}{error}", s("stage"), p["attempt"], s("status"))
        }
        "task.created" => "created".to_string(),
        "task.edited" => "edited".to_string(),
        "loop.crashed" => format!("stage loop stopped: {}", s("error")),
        other => other.to_string(),
    };
    format!("{time}  {what}")
}

/// Popup asking to confirm a delete or an abort.
fn render_confirm(frame: &mut Frame, task: &Task, title: &str, note: &str) {
    let area = centered(frame.area(), 68, 7);
    frame.render_widget(Clear, area);

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(RED)))
        .padding(Padding::horizontal(2))
        .title(Line::from(title).fg(c(RED)).bold());
    let lines = vec![
        Line::from(Span::from(format!("#{} {}", task.short_id(), task.title)).bold()),
        Line::from(Span::from(note).fg(c(SUBTEXT0))),
        Line::default(),
        Line::from(vec![
            Span::from(" y ").fg(c(BASE)).bg(c(RED)),
            Span::from(" yes   ").fg(c(SUBTEXT0)),
            Span::from(" n ").fg(c(BASE)).bg(c(ACCENT)),
            Span::from(" no").fg(c(SUBTEXT0)),
        ]),
    ];
    frame.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: false }),
        area,
    );
}

/// The `x` menu: each action with the key it maps to.
/// Cuts `text` to `width` characters, ending in `…` when it had to cut.
fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_string();
    }
    let kept: String = text.chars().take(width.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// One cell per window: `pick` reads a value out of a window's metrics, `–` while it has none.
fn both(floor: &FloorState, pick: impl Fn(&Metrics) -> String) -> [String; 2] {
    let cell = |m: &Option<Metrics>| m.as_ref().map_or(fmt_ms(None), &pick);
    [cell(&floor.d7), cell(&floor.d30)]
}

fn median_p90(median: Option<f64>, p90: Option<f64>, f: fn(Option<f64>) -> String) -> String {
    format!("{} / {}", f(median), f(p90))
}

/// The Floor table as (label, 7d, 30d) rows. A `None` label marks a section gap.
fn floor_rows(floor: &FloorState) -> Vec<(String, String, String)> {
    let mut rows: Vec<(String, String, String)> = Vec::new();
    let mut add = |label: &str, [a, b]: [String; 2]| rows.push((label.to_string(), a, b));
    add("Tasks closed", both(floor, |m| m.tasks.closed.to_string()));
    add("  created", both(floor, |m| m.tasks.created.to_string()));
    add("  open now", both(floor, |m| m.tasks.open.to_string()));
    add(
        "Needs you / running / queued",
        both(floor, |m| format!("{} / {} / {}", m.tasks.waiting_on_you, m.tasks.running, m.tasks.queued)),
    );
    add(
        "Cycle time median / p90",
        both(floor, |m| median_p90(m.cycle_time_ms.task.median, m.cycle_time_ms.task.p90, fmt_ms)),
    );
    add("First-pass verifying", both(floor, |m| fmt_pct(m.first_pass_rate.verifying)));
    add("  ci_watch", both(floor, |m| fmt_pct(m.first_pass_rate.ci_watch)));
    add("  implementing", both(floor, |m| fmt_pct(m.first_pass_rate.implementing)));
    add("Escalation rate", both(floor, |m| fmt_pct(m.escalations.rate)));
    let reasons = [&floor.d7, &floor.d30]
        .iter()
        .filter_map(|m| m.as_ref().map(|m| m.escalations.top_reasons.len().min(3)))
        .max()
        .unwrap_or(0);
    for i in 0..reasons {
        let reason = move |m: &Metrics| {
            m.escalations
                .top_reasons
                .get(i)
                .map_or(String::new(), |r| format!("{}× {}", r.count, r.reason))
        };
        add(if i == 0 { "  top reasons" } else { "" }, both(floor, reason));
    }
    add(
        "Retries/task median / p90",
        both(floor, |m| median_p90(m.retries.per_task.median, m.retries.per_task.p90, |v| {
            v.map_or(fmt_ms(None), |n| format!("{n:.1}").trim_end_matches(".0").to_string())
        })),
    );
    add("Cost total", both(floor, |m| fmt_usd(Some(m.cost.total_usd))));
    add("  per task median", both(floor, |m| fmt_usd(m.cost.per_task_usd.median)));
    add(
        "Queue depth · slots · util",
        both(floor, |m| {
            format!("{} · {}/{} · {}", m.queue.depth, m.queue.slots.active, m.queue.slots.max, fmt_pct(m.queue.utilisation))
        }),
    );
    rows
}

/// (stage, runs, median, p90, cost) for every stage that appears in either map, by name.
fn stage_rows(m: &Metrics) -> Vec<[String; 5]> {
    let mut names: Vec<&String> = m.cycle_time_ms.per_stage.keys().chain(m.cost.by_stage.keys()).collect();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|name| {
            let stats = m.cycle_time_ms.per_stage.get(name);
            [
                name.clone(),
                stats.map_or("–".to_string(), |s| s.runs.to_string()),
                fmt_ms(stats.and_then(|s| s.median)),
                fmt_ms(stats.and_then(|s| s.p90)),
                fmt_usd(m.cost.by_stage.get(name).copied()),
            ]
        })
        .collect()
}

/// The Floor view: 7d and 30d side by side, then a per-stage table (beside it when wide).
/// The Inbox: a header of splits with their counts, then the split's tickets oldest first.
fn render_inbox(frame: &mut Frame, area: Rect, app: &App, inbox: &InboxState) {
    let now = now_secs();
    let mut head = vec![Span::from(" Inbox ").fg(c(ACCENT)).bold()];
    for split in Split::ALL {
        let count = inbox::items(&app.tasks, split, now).len();
        let label = format!(" {} {} ", split.label(), count);
        head.push(if split == inbox.split {
            Span::from(label).fg(c(BASE)).bg(c(ACCENT)).bold()
        } else {
            Span::from(label).fg(c(SUBTEXT0))
        });
        head.push(Span::from(" "));
    }
    let items = inbox::items(&app.tasks, inbox.split, now);
    let mut lines = vec![Line::from(head), Line::default()];
    if items.is_empty() {
        lines.push(Line::from(Span::from("  ✓ caught up").fg(c(GREEN))));
    }
    for (row, &i) in items.iter().enumerate() {
        let task = &app.tasks[i];
        let look = task.look_at(now);
        let selected = row == inbox.cursor.min(items.len().saturating_sub(1));
        let bar = if selected { "▌ " } else { "  " };
        let what = task.reason.clone().unwrap_or_else(|| task.status_label());
        let repo = task.repo_name().map(|r| format!("{r} · ")).unwrap_or_default();
        let mut line = vec![
            Span::from(bar).fg(c(ACCENT)),
            Span::from(format!("{} ", look_glyph(look))).fg(look_color(look)),
            Span::from(format!("#{} ", task.short_id())).fg(c(SUBTEXT0)),
            Span::from(repo).fg(c(SUBTEXT0)),
            Span::from(task.title.clone()).bold(),
            Span::from(format!("   {what}")).fg(look_color(look)),
            Span::from(format!(" · {}", age(&task.updated_at, now))).fg(c(SUBTEXT0)),
        ];
        if selected {
            line = line.into_iter().map(|s| s.bg(c(SELECTED_BG))).collect();
        }
        lines.push(Line::from(line));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// A small centered box with one line of text, for a yes/no that has no single ticket.
fn render_note(frame: &mut Frame, title: &str, note: &str) {
    let width = (note.len() as u16 + 6).min(frame.area().width.saturating_sub(4)).max(20);
    let area = centered(frame.area(), width, 5);
    frame.render_widget(Clear, area);
    let block = Block::bordered().border_type(BorderType::Rounded).title(title).padding(Padding::horizontal(1));
    frame.render_widget(Paragraph::new(note).block(block), area);
}

fn render_floor(frame: &mut Frame, area: Rect, floor: &FloorState) {
    let label_style = Style::new().fg(c(SUBTEXT0));
    let head_style = Style::new().fg(c(ACCENT)).bold();
    let since = |m: &Option<Metrics>| m.as_ref().map_or("…".to_string(), |m| m.since.chars().take(10).collect());
    let mut lines = vec![Line::from(
        Span::from(format!(" Floor · since {} (7d) · {} (30d)", since(&floor.d7), since(&floor.d30))).style(head_style),
    )];
    if floor.d7.is_none() && floor.d30.is_none() {
        lines.push(Line::from(Span::from(" no numbers yet; r to retry").style(label_style)));
    }

    let wide = area.width >= 110;
    let [table_area, stage_area] = if wide {
        Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(area)
    } else {
        Layout::vertical([Constraint::Length(lines.len() as u16 + floor_rows(floor).len() as u16 + 1), Constraint::Min(0)]).areas(area)
    };

    let label_w = 31usize;
    let col_w = (table_area.width as usize).saturating_sub(label_w + 1) / 2;
    let line_of = |label: &str, a: &str, b: &str, style: Style| {
        Line::from(vec![
            Span::from(format!(" {:<w$}", truncate(label, label_w - 1), w = label_w - 1)).style(label_style),
            Span::from(format!("{:<w$}", truncate(a, col_w.saturating_sub(1)), w = col_w)).style(style),
            Span::from(truncate(b, col_w.saturating_sub(1))).style(style),
        ])
    };
    lines.push(line_of("", "7d", "30d", head_style));
    for (label, a, b) in floor_rows(floor) {
        lines.push(line_of(&label, &a, &b, Style::new()));
    }
    frame.render_widget(Paragraph::new(lines), table_area);

    let Some(window) = floor.d7.as_ref().or(floor.d30.as_ref()) else {
        return;
    };
    let which = if floor.d7.is_some() { "7d" } else { "30d" };
    let stages = stage_rows(window);
    let room = (stage_area.height as usize).saturating_sub(1);
    let mut out = vec![Line::from(
        Span::from(format!(" {:<14}{:>5}{:>8}{:>8}{:>9}", format!("stage · {which}"), "runs", "median", "p90", "cost"))
            .style(head_style),
    )];
    for row in stages.iter().take(room.saturating_sub(usize::from(stages.len() > room))) {
        out.push(Line::from(format!(
            " {:<14}{:>5}{:>8}{:>8}{:>9}",
            truncate(&row[0], 13),
            row[1],
            row[2],
            row[3],
            row[4]
        )));
    }
    if stages.len() > room {
        let hidden = stages.len() - room.saturating_sub(1);
        out.push(Line::from(Span::from(format!(" … +{hidden} more")).style(label_style)));
    }
    frame.render_widget(Paragraph::new(out), stage_area);
}

fn render_actions(frame: &mut Frame, app: &App, cursor: usize) {
    let area = centered(frame.area(), 56, ACTIONS.len() as u16 + 4);
    frame.render_widget(Clear, area);

    let title = app
        .selected_task()
        .map_or(" Actions ".to_string(), |t| format!(" #{} {} ", t.short_id(), t.title));
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(title).bold());
    let lines: Vec<Line> = ACTIONS
        .iter()
        .enumerate()
        .map(|(i, (key, label))| {
            let selected = i == cursor;
            let style = if selected {
                Style::new().fg(c(ACCENT)).bold()
            } else {
                Style::new()
            };
            Line::from(vec![
                Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
                Span::from(format!("{key:<4}")).fg(c(SUBTEXT0)),
                Span::from(*label).style(style),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

fn render_repo_picker(frame: &mut Frame, task: &Task, query: &str, all: &[String], cursor: usize) {
    const VISIBLE_ROWS: usize = 10;
    let area = centered(frame.area(), 90, VISIBLE_ROWS as u16 + 6);
    frame.render_widget(Clear, area);

    let matches = App::matching_repos(all, query);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(format!(" repo for #{} {} ", task.short_id(), task.title)).bold());

    let mut lines = vec![
        Line::from(vec![
            Span::from(" search: ").fg(c(ACCENT)).bold(),
            Span::from(format!("{query}▏")),
        ]),
        Line::default(),
    ];
    if matches.is_empty() {
        lines.push(Line::from(Span::from("  no matches").fg(c(SUBTEXT0))));
    } else {
        // A window of rows around the cursor, so a long list still shows the selection.
        let start = cursor.saturating_sub(VISIBLE_ROWS / 2).min(matches.len().saturating_sub(VISIBLE_ROWS));
        for (i, repo) in matches.iter().enumerate().skip(start).take(VISIBLE_ROWS) {
            let selected = i == cursor;
            let style = if selected { Style::new().fg(c(ACCENT)).bold() } else { Style::new() };
            lines.push(Line::from(vec![
                Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
                Span::from(*repo).style(style),
            ]));
        }
        if matches.len() > VISIBLE_ROWS {
            lines.push(Line::from(Span::from(format!("  … {} of {} repos", cursor + 1, matches.len())).fg(c(SUBTEXT0))));
        }
    }
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

fn render_help(frame: &mut Frame) {
    let area = centered(frame.area(), 76, HELP.len() as u16 + 4);
    frame.render_widget(Clear, area);

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(" Keys · any key closes ").bold());
    let lines: Vec<Line> = HELP
        .iter()
        .map(|(keys, what)| {
            Line::from(vec![
                Span::from(format!("{keys:<8}")).fg(c(ACCENT)).bold(),
                Span::from(*what),
            ])
        })
        .collect();
    frame.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: false }),
        area,
    );
}

/// A `width` x `height` rectangle centred in `area`.
fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let [_, middle, _] = Layout::vertical([
        Constraint::Length(area.height.saturating_sub(height) / 2),
        Constraint::Length(height),
        Constraint::Min(0),
    ])
    .areas(area);
    let [_, center, _] = Layout::horizontal([
        Constraint::Length(area.width.saturating_sub(width) / 2),
        Constraint::Length(width),
        Constraint::Min(0),
    ])
    .areas(middle);
    center
}

#[cfg(test)]
mod tests {
    use ratatui::{Terminal, backend::TestBackend};

    use super::*;

    fn awaiting_approval_task() -> Task {
        serde_json::from_str(
            r#"{"id":"abcd1234","title":"Add CSV export","description":"Users want to export their data.",
            "criteria":["handles a/b & c"],"repoPath":"/repo","branch":null,"worktreePath":null,
            "state":"awaiting_approval","column":"Approved","waitingOnYou":true,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#,
        )
        .unwrap()
    }

    fn task_detail_with_open_plan(task: &Task) -> TaskDetail {
        let task_json = r#"{"id":"abcd1234","title":"Add CSV export","description":"Users want to export their data.",
            "criteria":["handles a/b & c"],"repoPath":"/repo","branch":null,"worktreePath":null,
            "state":"awaiting_approval","column":"Approved","waitingOnYou":true,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#;
        let _ = task;
        serde_json::from_str(&format!(
            r#"{{"task":{task_json},"stageRuns":[],
            "approvals":[{{"requested":{{"brief":"Add a CSV export endpoint.","criteria":["handles a/b & c","exports UTF-8"],"assumptions":["CSV only for now"]}},"decision":null}}],
            "events":[]}}"#
        ))
        .unwrap()
    }

    fn find(text: &str, needle: &str) -> Option<(usize, usize)> {
        text.lines().enumerate().find_map(|(row, line)| line.find(needle).map(|col| (row, col)))
    }

    const TASK_JSON_DRAFT: &str = r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":null,"branch":null,"worktreePath":null,"state":"draft","column":"Intake",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#;

    fn render_task_detail(width: u16, height: u16, task: &Task, detail: Option<&TaskDetail>) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let scroll = Cell::new(0);
        terminal.draw(|f| render_detail(f, f.area(), task, detail, &scroll)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("
")
    }

    #[test]
    fn a_plan_awaiting_approval_renders_plan_and_ticket_as_two_columns() {
        let task = awaiting_approval_task();
        let detail = task_detail_with_open_plan(&task);
        let text = render_task_detail(140, 40, &task, Some(&detail));

        let (_, plan_col) = find(&text, "Plan").expect("a Plan heading");
        let (_, criteria_col) = find(&text, "Criteria to build").expect("the plan's criteria");
        let (_, desc_col) = find(&text, "Description").expect("the ticket's Description");
        let (_, accept_col) = find(&text, "Acceptance criteria").expect("the ticket's criteria");
        assert!(plan_col < 70 && criteria_col < 70, "plan content should sit in the left column: {text}");
        assert!(desc_col >= 70 && accept_col >= 70, "ticket content should sit in the right column: {text}");
        assert!(text.contains("exports UTF-8"), "the edited plan's criteria should show: {text}");
        assert!(text.contains("handles a/b & c"), "the ticket's own criteria should show: {text}");
    }

    #[test]
    fn the_detail_shows_each_run_s_cost_and_turns_and_what_the_ticket_has_spent() {
        let task: Task = serde_json::from_str(TASK_JSON_DRAFT).unwrap();
        let detail: TaskDetail = serde_json::from_str(&format!(
            r#"{{"task":{TASK_JSON_DRAFT},"stageRuns":[
              {{"stage":"triage","attempt":1,"status":"passed","costUsd":0.42,"turns":18}},
              {{"stage":"implementing","attempt":1,"status":"running","costUsd":null,"turns":null}}],
              "approvals":[],"events":[]}}"#
        ))
        .unwrap();
        let text = render_task_detail(100, 40, &task, Some(&detail));
        assert!(text.contains("$0.42 · 18 turns"), "a run shows its cost and turns: {text}");
        assert!(text.contains("Spent: $0.42"), "the ticket's spend is summed: {text}");
    }

    #[test]
    fn a_narrow_terminal_stacks_the_plan_above_the_ticket_instead() {
        let task = awaiting_approval_task();
        let detail = task_detail_with_open_plan(&task);
        let text = render_task_detail(90, 50, &task, Some(&detail));

        let (plan_row, _) = find(&text, "Plan").expect("a Plan heading");
        let (desc_row, _) = find(&text, "Description").expect("the ticket's Description");
        assert!(plan_row < desc_row, "the plan should render above the ticket when stacked: {text}");
    }

    #[test]
    fn a_ticket_with_no_open_plan_keeps_the_single_column_view() {
        let mut task = awaiting_approval_task();
        task.state = "implementing".to_string();
        let text = render_task_detail(140, 40, &task, None);
        assert!(find(&text, "Criteria to build").is_none(), "no plan is open, so there is nothing to show: {text}");
        assert!(find(&text, "Description").is_some());
    }

    fn floor() -> FloorState {
        let json = r#"{"since":"2026-10-16T00:00:00.000Z","until":"2026-10-23T00:00:00.000Z",
          "tasks":{"created":9,"closed":6,"open":3,"waitingOnYou":1,"running":1,"queued":0},
          "cycleTimeMs":{"task":{"median":5400000,"p90":null},"perStage":{
            "verifying":{"median":90000,"p90":120000,"runs":7},
            "implementing":{"median":null,"p90":null,"runs":0}}},
          "firstPassRate":{"verifying":0.83,"ci_watch":null,"implementing":0.5},
          "escalations":{"rate":0.25,"topReasons":[{"reason":"a very long escalation reason that cannot fit","count":2}]},
          "retries":{"perTask":{"median":1,"p90":3},"byLoop":{"verify":2,"e2e":0,"ci":1}},
          "cost":{"totalUsd":12.5,"perTaskUsd":{"median":1.234,"p90":null},"byStage":{"verifying":2.5,"shipping":0.4}},
          "queue":{"depth":2,"slots":{"max":4,"active":1},"utilisation":null}}"#;
        let m: Metrics = serde_json::from_str(json).unwrap();
        FloorState { d7: Some(m.clone()), d30: Some(m) }
    }

    fn render(width: u16, height: u16, floor: &FloorState) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| render_floor(f, f.area(), floor)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn an_escalated_ticket_says_a_retries_it() {
        assert_eq!(
            continues_line("escalated", "implementing"),
            "Continues at: implementing · a retries it (add guidance if you like)"
        );
        assert_eq!(continues_line("paused_rate_limit", "verifying"), "Continues at: verifying");
    }

    #[test]
    fn a_card_above_the_spend_p90_carries_a_dim_dollar_the_others_do_not() {
        const CARD_TASK: &str = r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/app","branch":null,"worktreePath":null,"state":"draft","column":"Intake",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#;
        let mut app = App::new(crate::Machine::from_env());
        for (i, spent) in [0.1, 0.2, 0.3, 5.0].into_iter().enumerate() {
            let mut task: Task = serde_json::from_str(&CARD_TASK.replace("Login page", &format!("Ticket {i}"))).unwrap();
            task.spent_usd = Some(spent);
            app.tasks.push(task);
        }
        let mut terminal = Terminal::new(TestBackend::new(240, 30)).unwrap();
        terminal.draw(|f| render_board(f, f.area(), &app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text: String = (0..30)
            .map(|y| (0..240).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        let (row3, _) = find(&text, "Ticket 3").expect("the expensive ticket");
        let (row0, _) = find(&text, "Ticket 0").expect("a cheap ticket");
        let line_after = |row: usize| text.lines().nth(row + 1).unwrap_or("").to_string();
        assert!(line_after(row3).contains('$'), "the expensive card is marked: {text}");
        assert!(!line_after(row0).contains('$'), "a cheap card is not: {text}");
    }

    #[test]
    fn a_card_shows_its_repo_name_after_the_id() {
        const TASK: &str = r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/Developer/projects/luna-tui","branch":null,"worktreePath":null,"state":"draft","column":"Intake",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#;
        let task: Task = serde_json::from_str(TASK).unwrap();
        let head = card_head(&task).to_string();
        assert!(head.contains("luna-tui"), "{head}");
        assert!(head.starts_with('▌'), "a repo bar leads the card: {head}");
        let mut bare = task.clone();
        bare.repo_path = None;
        let head = card_head(&bare).to_string();
        assert!(!head.contains("luna-tui") && !head.starts_with('▌'), "{head}");
    }

    #[test]
    fn glyphs_tell_waiting_on_you_from_waiting_on_the_window_from_stale() {
        assert_eq!(look_glyph(Look::NeedsYou), "⏸");
        assert_eq!(look_glyph(Look::Paused), "⏳");
        assert_eq!(look_glyph(Look::Stale), "⌛");
    }

    #[test]
    fn a_card_s_second_line_is_the_triad_when_the_task_has_one() {
        const TASK: &str = r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/app","branch":null,"worktreePath":null,"state":"implementing","column":"Build",
            "waitingOnYou":false,"running":true,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":1},"resumeTo":null,"reason":null,
            "workedMs":240000,"diff":{"added":142,"removed":18},"tests":{"passed":7,"total":9},
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#;
        let task: Task = serde_json::from_str(TASK).unwrap();
        let lines: Vec<String> = card_lines(&task, None).iter().map(|l| l.to_string()).collect();
        assert!(lines[2].contains("worked 4m · +142 −18 · tests 7/9"), "{lines:?}");
        let mut bare = task.clone();
        bare.worked_ms = None;
        bare.diff = None;
        bare.tests = None;
        let lines: Vec<String> = card_lines(&bare, None).iter().map(|l| l.to_string()).collect();
        assert_eq!(lines[2].trim(), "", "no numbers, no line: {lines:?}");
    }

    #[test]
    fn the_inbox_says_caught_up_when_empty_and_lists_the_split_s_tickets_otherwise() {
        let mut app = App::new(crate::Machine::from_env());
        let render = |app: &App| {
            let mut terminal = Terminal::new(TestBackend::new(120, 12)).unwrap();
            terminal.draw(|f| render_inbox(f, f.area(), app, app.inbox.as_ref().unwrap())).unwrap();
            let buffer = terminal.backend().buffer().clone();
            (0..12).map(|y| (0..120).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
        };
        app.inbox = Some(InboxState::default());
        assert!(render(&app).contains("caught up"));
        let task: Task = serde_json::from_str(
            r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/luna-tui","branch":null,"worktreePath":null,"state":"awaiting_approval","column":"Triage",
            "waitingOnYou":true,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#,
        )
        .unwrap();
        app.tasks.push(task);
        let text = render(&app);
        assert!(text.contains("Approve 1"), "{text}");
        assert!(text.contains("luna-tui · Login page"), "{text}");
        assert!(text.contains("approve plan"), "{text}");
        assert!(!text.contains("caught up"), "{text}");
    }

    #[test]
    fn header_names_the_product_luna_tui() {
        let mut app = App::new(crate::Machine::from_env());
        let text: String = header_line(&app).spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("Luna TUI"), "{text}");
        assert!(!text.contains("Hardness"), "{text}");
        app.online = true;
        let text: String = header_line(&app).spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("Luna TUI"), "{text}");
    }

    #[test]
    fn floor_fits_80x24_and_shows_the_numbers() {
        let text = render(80, 22, &floor());
        assert!(text.contains("Floor · since 2026-10-16"));
        assert!(text.contains("1.5h / –"), "{text}");
        assert!(text.contains("83%"));
        assert!(text.contains("$12.50"));
        assert!(text.contains("2 · 1/4 · –"));
        assert!(text.contains("verifying"));
        assert!(!text.contains("a very long escalation reason that cannot fit"));
    }

    #[test]
    fn floor_with_no_numbers_and_tiny_terminals_do_not_panic() {
        render(80, 22, &FloorState::default());
        render(20, 5, &floor());
        render(140, 30, &floor());
    }

    #[test]
    fn stage_rows_merge_runs_and_cost_sorted_by_name() {
        let rows = stage_rows(floor().d7.as_ref().unwrap());
        let names: Vec<&str> = rows.iter().map(|r| r[0].as_str()).collect();
        assert_eq!(names, ["implementing", "shipping", "verifying"]);
        assert_eq!(rows[1][1], "–");
        assert_eq!(rows[1][4], "$0.40");
        assert_eq!(rows[2][2], "1.5m");
    }

    #[test]
    fn test_cases_show_what_each_proves_and_its_test() {
        let v: Value = serde_json::json!([
            {"title":"rejects a bad password","criterion":"Bad password shows an error","test":"src/a.test.ts > rejects"},
            {"title":"an edge case","criterion":null,"test":"src/b.test.ts > edge"},
            {"criterion":"no title"}, "junk"
        ]);
        assert_eq!(
            case_lines(&v),
            [
                "rejects a bad password — proves: Bad password shows an error · src/a.test.ts > rejects",
                "an edge case · src/b.test.ts > edge",
            ]
        );
        assert!(case_lines(&Value::Null).is_empty());
    }

    #[test]
    fn slice_lines_show_title_and_size() {
        let v: Value = serde_json::json!([{"title":"Add route","est_loc":80},{"title":"No size"},{"est_loc":5},"junk"]);
        assert_eq!(slice_lines(&v), ["Add route (~80 LOC)", "No size"]);
        assert!(slice_lines(&Value::Null).is_empty());
    }

    #[test]
    fn evidence_lines_show_verdict_count_and_three_paths() {
        let v: Value = serde_json::json!({"verdict":"pass","artifactCount":5,
            "thumbnails":["/a.png","/b.png","/c.png","/d.png"]});
        assert_eq!(
            evidence_lines(&v),
            ["verdict: pass", "5 artifacts", "/a.png", "/b.png", "/c.png"]
        );
        let one: Value = serde_json::json!({"verdict":"skipped","artifactCount":1});
        assert_eq!(evidence_lines(&one), ["verdict: skipped", "1 artifact"]);
        assert!(evidence_lines(&Value::Null).is_empty());
    }

    #[test]
    fn rules_lines_show_counts_bias_and_truncate_to_twelve() {
        let md: String = (1..=15).map(|i| format!("- rule {i} {}\n", "x".repeat(40))).collect();
        let v: Value = serde_json::json!({"markdown": md, "incidents": 2, "patterns": 1,
            "calibration": {"estLocBias": 1.4}});
        let lines = rules_lines(&v, 20);
        assert_eq!(lines[0], "2 incident(s) · 1 pattern(s) · estLocBias 1.4");
        assert_eq!(lines.len(), 1 + 12 + 1);
        assert_eq!(lines[1].chars().count(), 20);
        assert_eq!(lines[13], "… +3 more");
        assert!(rules_lines(&Value::Null, 20).is_empty());
        assert!(rules_lines(&serde_json::json!({"markdown": "  \n"}), 20).is_empty());
    }

    #[test]
    fn test_gate_lists_tests_and_approval_lists_slices() {
        let t: Value = serde_json::json!({"tests":["src/a.test.ts","src/b.test.ts"]});
        assert_eq!(json_list(&t["tests"]), ["src/a.test.ts", "src/b.test.ts"]);
        let mut lines = Vec::new();
        push_proposal_sections(&mut lines, &t);
        let text: String = lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("Tests"), "{text}");
        assert!(text.contains("  • src/a.test.ts"), "{text}");
        let p: Value = serde_json::json!({"assumptions":["x"],"slices":[{"title":"S1","est_loc":10}]});
        let mut lines = Vec::new();
        push_proposal_sections(&mut lines, &p);
        let text: String = lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(text.find("Assumptions").unwrap() < text.find("Slices").unwrap(), "{text}");
        assert!(text.contains("  • S1 (~10 LOC)"), "{text}");
    }
}
