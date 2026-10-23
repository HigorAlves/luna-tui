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

use crate::{
    app::{ACTIONS, App, HELP, Mode},
    model::{COLUMNS, Look, Task, TaskDetail, TaskEvent, age, now_secs, questions_of},
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
        Look::NeedsYou => "!",
        Look::Working => spinner(),
        Look::Queued => "…",
        Look::Paused => "⏸",
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
    let mut spans = vec![Span::from(" Hardness Board ").fg(c(BASE)).bg(c(ACCENT)).bold()];
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

    let items: Vec<ListItem> = indices.iter().map(|&i| card(&app.tasks[i])).collect();
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
fn card(task: &Task) -> ListItem<'static> {
    let look = task.look();
    let head = Line::from(vec![
        Span::from(format!("#{} ", task.short_id())).fg(c(SUBTEXT0)),
        Span::from(task.title.clone()).bold(),
    ]);

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

    ListItem::new(vec![head, Line::from(meta), Line::default()])
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

/// The full ticket: state, what it waits on you for, text, stage runs and activity.
fn render_detail(frame: &mut Frame, area: Rect, task: &Task, detail: Option<&TaskDetail>, scroll: &Cell<u16>) {
    let heading = |text: String| Line::from(Span::from(text).fg(c(ACCENT)).bold());
    // What the agent proposed, needing your judgment, gets its own color — distinct from the
    // plain facts (Description, Stages, Activity...) below it.
    let proposal_heading = |text: String| Line::from(Span::from(text).fg(c(PEACH)).bold());
    let muted = |text: String| Line::from(Span::from(text).fg(c(SUBTEXT0)));
    let detail = detail.filter(|d| d.task.id == task.id);
    let look = task.look();

    let mut lines = vec![muted(format!(
        "Repo: {}",
        task.repo_path.as_deref().unwrap_or("none (add one with e to run real agents)")
    ))];
    if let Some(branch) = &task.branch {
        lines.push(muted(format!("Branch: {branch}")));
    }
    if let Some(stage) = &task.resume_to {
        lines.push(muted(format!("Continues at: {stage}")));
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
        let assumptions = json_list(&requested["assumptions"]);
        if !assumptions.is_empty() {
            lines.extend([Line::default(), proposal_heading("Assumptions".into())]);
            lines.extend(bullets(&assumptions));
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
                lines.push(Line::from(vec![
                    Span::from(format!("  {} #{} ", run.stage, run.attempt)),
                    Span::from(run.status.clone()).fg(c(color)),
                ]));
            }
        }
        lines.extend([Line::default(), heading("Activity".into())]);
        let start = detail.events.len().saturating_sub(ACTIVITY_LINES);
        lines.extend(detail.events[start..].iter().map(|e| muted(format!("  {}", describe(e)))));
    }

    let block = Block::bordered()
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
        );

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
