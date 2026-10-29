//! Drawing. Reads the app and never changes it.

use std::{
    env,
    time::{SystemTime, UNIX_EPOCH},
};

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, BorderType, Clear, List, ListItem, ListState, Padding, Paragraph, Wrap},
};
use serde_json::Value;
use tui_textarea::TextArea;

use crate::detail::{self, DetailView};
use crate::digest::{self, DigestState};
use crate::inbox::{self, InboxState, Split};
use crate::keys::{self, Avail, HelpRow, Scope};
use crate::pulls::{self, PrKey, PrSplit, PullsState};
use crate::slack::{self, SlackKey, SlackSplit, SlackState};
use crate::{
    app::{App, Density, FloorState, GroupBy, Mode},
    model::{
        COLUMNS, JiraIssueHit, Look, Metrics, PullRequest, REPO_COLOUR_SLOTS, SLACK_PRIORITIES, SlackItem, SlackMetrics, Task, TaskEvent, age, age_secs, fmt_ms, fmt_pct,
        fmt_usd, repo_colour_slot, sla_targets, spend_p90, now_secs, unix_secs,
    },
};

// Catppuccin Mocha, the theme herdr is configured with.
pub(crate) const BASE: Color = Color::Rgb(0x1e, 0x1e, 0x2e);
pub(crate) const SURFACE0: Color = Color::Rgb(0x31, 0x32, 0x44);
pub(crate) const SURFACE1: Color = Color::Rgb(0x45, 0x47, 0x5a);
pub(crate) const SUBTEXT0: Color = Color::Rgb(0xa6, 0xad, 0xc8);
pub(crate) const BLUE: Color = Color::Rgb(0x89, 0xb4, 0xfa);
pub(crate) const LAVENDER: Color = Color::Rgb(0xb4, 0xbe, 0xfe);
pub(crate) const GREEN: Color = Color::Rgb(0xa6, 0xe3, 0xa1);
pub(crate) const YELLOW: Color = Color::Rgb(0xf9, 0xe2, 0xaf);
pub(crate) const PEACH: Color = Color::Rgb(0xfa, 0xb3, 0x87);
pub(crate) const RED: Color = Color::Rgb(0xf3, 0x8b, 0xa8);

pub(crate) const ACCENT: Color = BLUE;
pub(crate) const MUTED: Color = SURFACE1;
const SELECTED_BG: Color = SURFACE0;

/// Narrowest a column may get before the board scrolls instead of squeezing.
const MIN_COLUMN_WIDTH: u16 = 18;
/// Width of a collapsed column in folded mode: wide enough for its header bar, not its cards.
const FOLD_WIDTH: u16 = 14;

/// Colours are dropped when `NO_COLOR` is set. States still read from their glyph and label.
pub(crate) fn c(color: Color) -> Color {
    if env::var_os("NO_COLOR").is_some() {
        Color::Reset
    } else {
        color
    }
}

pub(crate) fn look_color(look: Look) -> Color {
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

pub(crate) fn look_glyph(look: Look) -> &'static str {
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
        if matches!(app.mode, Mode::Help { .. }) {
            render_help(frame, app);
        }
        return;
    }
    if let Some(digest) = app.digest.as_ref().filter(|_| matches!(app.mode, Mode::Normal | Mode::Help { .. })) {
        render_digest(frame, body, app, digest);
        frame.render_widget(footer_line(app), footer);
        if matches!(app.mode, Mode::Help { .. }) {
            render_help(frame, app);
        }
        return;
    }
    if let Some(inbox) = app.inbox.as_ref().filter(|_| matches!(app.mode, Mode::Normal | Mode::ConfirmApproveAll(_) | Mode::Help { .. })) {
        render_inbox(frame, body, app, inbox);
        frame.render_widget(footer_line(app), footer);
        if let Mode::ConfirmApproveAll(ids) = &app.mode {
            render_note(frame, " Approve them all? ", &format!("{} ticket(s) in Approve get a yes, each with no guidance.  y / n", ids.len()));
        }
        if matches!(app.mode, Mode::Help { .. }) {
            render_help(frame, app);
        }
        return;
    }
    if let Some(state) = app.pulls.as_ref().filter(|_| {
        matches!(app.mode, Mode::Normal | Mode::ConfirmMerge { .. } | Mode::ClonePrompt { .. } | Mode::PrActions { .. } | Mode::Help { .. })
    }) {
        render_pulls(frame, body, app, state);
        frame.render_widget(footer_line(app), footer);
        match &app.mode {
            Mode::ConfirmMerge { repo, number } => {
                render_note(frame, " Merge? ", &format!("{repo}#{number} is squash-merged and its branch deleted.  y / n"));
            }
            Mode::ClonePrompt { repo, query, all, cursor, .. } => render_clone_prompt(frame, repo, query, all, *cursor),
            Mode::PrActions { cursor } => render_pr_actions(frame, app, *cursor),
            Mode::Help { .. } => render_help(frame, app),
            _ => {}
        }
        return;
    }
    if let Some(state) = app.slack.as_ref().filter(|_| {
        matches!(
            app.mode,
            Mode::Normal
                | Mode::SlackSnooze { .. }
                | Mode::SlackReply { .. }
                | Mode::SlackTask { .. }
                | Mode::SlackWatchAdd { .. }
                | Mode::SlackActions { .. }
                | Mode::Help { .. }
        )
    }) {
        render_slack(frame, body, app, state);
        frame.render_widget(footer_line(app), footer);
        if state.watches.is_some() {
            render_slack_watches(frame, app, state);
        }
        match &app.mode {
            Mode::SlackSnooze { cursor, .. } => render_slack_snooze(frame, *cursor),
            Mode::SlackReply { id, area, vim, nudge } => render_slack_reply(frame, app, id, area, vim, *nudge),
            Mode::SlackTask { id, title, repo } => render_slack_task(frame, app, id, title, repo.as_deref()),
            Mode::SlackWatchAdd { query, cursor } => render_slack_watch_add(frame, app, query, *cursor),
            Mode::SlackActions { cursor } => render_slack_actions(frame, app, *cursor),
            Mode::Help { .. } => render_help(frame, app),
            _ => {}
        }
        return;
    }
    render_board(frame, body, app);
    frame.render_widget(footer_line(app), footer);

    match &app.mode {
        Mode::Detail(id) => {
            if let Some(task) = app.task(id) {
                let view = DetailView {
                    task,
                    detail: app.detail.as_ref(),
                    section: app.detail_section,
                    cursor: app.detail_cursor,
                    scroll: &app.detail_scroll,
                    prs: &app.prs.prs,
                    diff: app.diff.as_ref().filter(|d| d.0 == task.id).map(|d| &d.1),
                    viewport: &app.detail_viewport,
                    follow: &app.detail_follow,
                };
                detail::render(frame, detail::popup_area(frame.area(), app.detail_full), &view);
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
        Mode::EditTicket { id, area, vim } | Mode::Answer { id, area, vim } | Mode::EditCases { id, area, vim } => {
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
                    .title(Line::from(format!("· {} ", keys::editor_line(app))).fg(c(SUBTEXT0)))
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
                        block = block
                            .title(Line::from(format!("· {} ", keys::editor_line(app))).fg(c(SUBTEXT0)))
                            .title_bottom(Line::from(label).bold().fg(c(mode_color)).left_aligned());
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
        Mode::ConfirmMany { action, ids } => render_note(frame, " Marked tickets ", &format!("{}  y / n", action.question(ids.len()))),
        Mode::JiraLink { id, query, hits, cursor } => {
            if let Some(task) = app.task(id) {
                render_jira_link(frame, task, query, hits, *cursor);
            }
        }
        Mode::ConfirmJiraUnlink(id) => {
            if let Some(task) = app.task(id) {
                let key = task.jira_key().unwrap_or("the issue");
                render_confirm(frame, task, &format!(" unlink {key}? "), "The ticket forgets the issue; nothing changes in Jira.");
            }
        }
        Mode::Help { .. } => render_help(frame, app),
        Mode::Command { text, pick } => render_completions(frame, text, *pick),
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
            Span::from(format!(
                "  {total} tickets · {running}{} running{queued_part} · {waiting} need you{}",
                app.slots.as_ref().map_or(String::new(), |s| format!("/{}", s.max)),
                if app.marked.is_empty() { String::new() } else { format!(" · {} marked", app.marked.len()) }
            ))
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
    let overdue = app.overdue_count();
    if app.online && overdue > 0 {
        spans.push(Span::from(format!("  ‼ {overdue} overdue")).fg(c(RED)).bold());
    }
    if app.slots.as_ref().is_some_and(|s| s.draining) {
        spans.push(Span::from("  [DRAINING]").fg(c(PEACH)).bold());
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
    if app.pulls.is_some() {
        spans.push(Span::from("  [pulls]").fg(c(BLUE)).bold());
    }
    if app.slack.is_some() {
        spans.push(Span::from("  [slack]").fg(c(BLUE)).bold());
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
    if let Some((prefix, seconds)) = app.which_key() {
        return which_key_line(prefix, &seconds);
    }

    match &app.mode {
        Mode::Adding(buf) => Line::from(vec![
            Span::from(" new ticket: ").fg(c(ACCENT)).bold(),
            Span::from(format!("{buf}▏")),
            Span::from("   enter create and edit · esc cancel").fg(c(SUBTEXT0)),
        ]),
        Mode::EditTicket { vim, .. } | Mode::Answer { vim, .. } | Mode::EditCases { vim, .. } | Mode::SlackReply { vim, .. } => {
            let save = match app.mode {
                Mode::Answer { .. } => "send answers",
                Mode::SlackReply { .. } => "send",
                _ => "save",
            };
            match vim.mode() {
                crate::vim::Mode::Normal => hint(&[("i/a/o", "insert"), ("hjkl", "move"), ("dd/x", "delete"), ("ctrl+s", save), ("esc", "cancel")]),
                crate::vim::Mode::Insert => hint(&[("esc", "normal mode"), ("ctrl+s", save)]),
            }
        }
        Mode::EditPlan { focus, plan_vim, ticket_vim, .. } => {
            let (vim, pane) = match focus {
                crate::app::PlanPane::Plan => (plan_vim, "plan"),
                crate::app::PlanPane::Ticket => (ticket_vim, "ticket"),
            };
            match vim.mode() {
                crate::vim::Mode::Normal => hint(&[("tab", "switch pane"), ("i/a/o", "insert"), ("hjkl", "move"), ("ctrl+s", "save both"), ("esc", "cancel")]),
                crate::vim::Mode::Insert => Line::from(vec![
                    Span::from(format!(" editing the {pane} ")).fg(c(ACCENT)).bold(),
                    Span::from("   esc normal mode · ctrl+s save both").fg(c(SUBTEXT0)),
                ]),
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
        Mode::Actions { .. } | Mode::PrActions { .. } | Mode::SlackActions { .. } => hint(&[("j/k", "move"), ("enter", "run"), ("esc", "close")]),
        Mode::RepoPicker { .. } => hint(&[("type", "filter"), ("↑/↓", "move"), ("enter", "set"), ("esc", "cancel")]),
        Mode::ConfirmMerge { .. } => hint(&[("y", "merge"), ("n", "cancel")]),
        Mode::JiraLink { .. } => hint(&[("type", "search from 3 chars"), ("↑/↓", "move"), ("enter", "link (row 0 creates)"), ("ctrl+n", "create"), ("esc", "cancel")]),
        Mode::ConfirmJiraUnlink(_) => hint(&[("y", "unlink"), ("n", "cancel")]),
        Mode::ClonePrompt { .. } => hint(&[("type", "filter folders"), ("↑/↓", "move"), ("enter", "clone here"), ("esc", "stay read-only")]),
        Mode::SlackSnooze { .. } => hint(&[("j/k 1-4", "pick"), ("enter", "snooze"), ("esc", "cancel")]),
        Mode::SlackTask { .. } => hint(&[("y", "create the ticket"), ("n", "cancel")]),
        Mode::SlackWatchAdd { .. } => hint(&[("type", "@handle, #channel or a word"), ("↑/↓", "pick"), ("enter", "watch"), ("esc", "cancel")]),
        Mode::ConfirmApproveAll(_) => hint(&[("y", "approve them all"), ("n", "cancel")]),
        Mode::ConfirmMany { .. } => hint(&[("y", "do it to all of them"), ("n", "cancel")]),
        Mode::Command { text, .. } => Line::from(vec![
            Span::from(" :").fg(c(ACCENT)).bold(),
            Span::from(format!("{text}▏")),
            Span::from("   tab completes · enter runs · esc closes").fg(c(SUBTEXT0)),
        ]),
        Mode::Help { .. } => scope_footer(app, Scope::Help),
        // The views, the ticket popup and the Watches popup: a few short words, as before the
        // key registry. The sheet behind `?` lists the rest.
        _ => view_footer(app),
    }
}

fn view_footer(app: &App) -> Line<'static> {
    match keys::active_scope(app) {
        Scope::Floor => hint(&[("tab", "next repo"), ("r", "refresh"), ("esc", "close")]),
        Scope::Digest => hint(&[("j/k", "move"), ("enter", "jump to the ticket"), ("o", "open the PR"), ("esc", "close")]),
        Scope::Inbox => hint(&[("j/k", "move"), ("h/l", "split"), ("a/r/e", "act"), ("A", "approve all"), ("enter", "open"), ("esc", "close")]),
        Scope::Pulls => hint(&[("j/k", "move"), ("h/l", "split"), ("m", "merge"), ("c/v/t", "CI fix / review / threads"), ("o", "open"), ("R", "poll"), ("x", "menu"), ("esc", "close")]),
        Scope::Watches => hint(&[("j/k", "move"), ("n", "add"), ("e", "floor"), ("d", "delete"), ("space", "on/off"), ("esc", "close")]),
        Scope::Slack => hint(&[
            ("j/k", "move"),
            ("h/l 1-6", "split"),
            ("r", "reply"),
            ("t", "ticket"),
            ("d", "done"),
            ("s", "snooze"),
            ("! -", "priority"),
            ("W", "watches"),
            ("o", "open"),
            ("R", "poll"),
            ("esc", "close"),
        ]),
        Scope::Detail => {
            let shippable = matches!(&app.mode, Mode::Detail(id) if app.task(id).is_some_and(|t| t.state == "awaiting_ship"));
            let (rows, scroll) = if app.detail_section.has_cursor() { (("jk", "pick"), ("JK", "scroll")) } else { (("jk", "scroll"), ("^d/^u", "page")) };
            let act = if shippable { ("S", "ship") } else { ("a", "advance") };
            hint(&[("h/l 1-8", "section"), rows, scroll, act, ("r", "send back"), ("e", "edit"), ("+", "size"), ("esc", "back")])
        }
        _ => hint(&[("?", "help"), ("n", "new"), ("a", "advance"), ("enter", "open"), ("x", "actions"), ("=", "density"), ("/", "filter"), ("q", "quit")]),
    }
}

/// How many keys the footer shows: `?` and seven more fit in 120 columns with these labels.
const FOOTER_KEYS: usize = 8;

/// The footer of a scope: its `On` bindings by weight, `?` first.
fn scope_footer(app: &App, scope: Scope) -> Line<'static> {
    let keys: Vec<(String, String)> = keys::footer_keys(app, scope, FOOTER_KEYS).into_iter().map(|b| (b.short_keys(), b.label.to_string())).collect();
    hint_owned(&keys)
}

/// The which-key strip: ` g ▸  g first ticket   s order by stage …   esc `.
fn which_key_line(prefix: char, seconds: &[(char, &str)]) -> Line<'static> {
    let mut spans = vec![Span::from(format!(" {prefix} ▸ ")).fg(c(BASE)).bg(c(ACCENT)).bold()];
    for (key, label) in seconds {
        spans.push(Span::from(format!("  {key} ")).fg(c(ACCENT)).bold());
        spans.push(Span::from((*label).to_string()).fg(c(SUBTEXT0)));
    }
    spans.push(Span::from("   esc").fg(c(SUBTEXT0)));
    Line::from(spans)
}

fn hint_owned(keys: &[(String, String)]) -> Line<'static> {
    let mut spans = vec![Span::raw(" ")];
    for (key, desc) in keys {
        spans.push(Span::from(format!(" {key} ")).fg(c(BASE)).bg(c(ACCENT)));
        spans.push(Span::from(format!(" {desc}  ")).fg(c(SUBTEXT0)));
    }
    Line::from(spans)
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
    // A folded column (`zc`; Done by default) keeps only its header bar; the others share the rest.
    let constraints: Vec<Constraint> = (0..visible)
        .map(|slot| if app.folded.contains(&(start + slot)) { Constraint::Length(FOLD_WIDTH) } else { Constraint::Fill(1) })
        .collect();
    let rects = Layout::horizontal(constraints).split(area);

    app.column_rects.borrow_mut().clear();
    for (slot, rect) in rects.iter().enumerate() {
        let column = start + slot;
        app.column_rects.borrow_mut().push((column, *rect));
        render_column(frame, *rect, app, column, !app.folded.contains(&column));
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
    // Two cells go to the highlight symbol, one to the padding each side.
    let width = usize::from(area.width.saturating_sub(6));
    let by_repo = app.group == GroupBy::Repo;
    let mut items: Vec<ListItem> = Vec::new();
    let mut positions = Vec::with_capacity(indices.len());
    let mut last_repo: Option<Option<&str>> = None;
    for &i in &indices {
        let task = &app.tasks[i];
        if by_repo && last_repo != Some(task.repo_name()) {
            let count = indices.iter().filter(|&&j| app.tasks[j].repo_name() == task.repo_name()).count();
            items.push(repo_separator(task.repo_name(), count, width));
            last_repo = Some(task.repo_name());
        }
        positions.push(items.len());
        items.push(card(task, p90, app.marked.contains(&task.id), app.is_new(task), app.density, width));
    }
    let list = List::new(items)
        .block(block)
        .highlight_style(selection_style())
        .highlight_symbol("▌ ");

    let mut state = ListState::default();
    if focused && !indices.is_empty() {
        state.select(positions.get(app.selection[column]).copied().or(positions.last().copied()));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

/// Under `gr` ordering: `── luna-tui 3 ─────`, a line that names the group the cards below
/// belong to, in the repo's colour.
fn repo_separator(repo: Option<&str>, count: usize, width: usize) -> ListItem<'static> {
    let name = repo.unwrap_or("no repo");
    let colour = repo.map_or(SUBTEXT0, |r| REPO_COLOURS[repo_colour_slot(r)]);
    let head = format!("── {name} {count} ");
    let rule = "─".repeat(width.saturating_sub(head.chars().count()));
    ListItem::new(Line::from(Span::from(format!("{head}{rule}")).fg(c(colour))))
}

/// A board card. One colour per repo, so a column scans by repo: the bar and the name share it.
const REPO_COLOURS: [Color; REPO_COLOUR_SLOTS] = [BLUE, GREEN, PEACH, LAVENDER, YELLOW, RED];

/// The card's first line: the marks, a repo-coloured bar, the issue number, the title. The
/// title leads so a narrow column cuts the identifiers, never the words. A ticket past one of
/// its SLA clocks leads with `‼` and goes red, like an overdue Slack row.
fn card_head(task: &Task, marked: bool, is_new: bool) -> Line<'static> {
    let mut spans = Vec::new();
    if marked {
        spans.push(Span::from("◆ ").fg(c(ACCENT)).bold());
    }
    if is_new {
        spans.push(Span::from("• ").fg(c(YELLOW)).bold());
    }
    if let Some(repo) = task.repo_name() {
        spans.push(Span::from("▌").fg(c(REPO_COLOURS[repo_colour_slot(repo)])));
    }
    if task.overdue() {
        spans.push(Span::from("‼ ").fg(c(RED)).bold());
    }
    if task.route == "setup" {
        spans.push(Span::from("⚙ ").fg(c(SUBTEXT0)));
    }
    spans.push(Span::from(task.issue_prefix()).fg(c(SUBTEXT0)));
    let title = Span::from(task.title.clone()).bold();
    spans.push(if task.overdue() { title.fg(c(RED)) } else { title });
    Line::from(spans)
}

fn card(task: &Task, spend_p90: Option<f64>, marked: bool, is_new: bool, density: Density, width: usize) -> ListItem<'static> {
    ListItem::new(card_lines(task, spend_p90, marked, is_new, density, width))
}

/// The card's lines by density: the head; `#id · repo`; the status with its age and badges;
/// and, when comfortable, the worked / diff / tests line. Compact is the head alone with the
/// status glyph and the age.
fn card_lines(task: &Task, spend_p90: Option<f64>, marked: bool, is_new: bool, density: Density, width: usize) -> Vec<Line<'static>> {
    let look = task.look();
    let age = age(&task.updated_at, now_secs());
    // Red once a clock is past; yellow while the running stage is past 80% of its target.
    let age_colour = if task.overdue() {
        RED
    } else if task.stage_warn() {
        YELLOW
    } else {
        SUBTEXT0
    };
    if density == Density::Compact {
        let mut spans = Vec::new();
        if marked {
            spans.push(Span::from("◆ ").fg(c(ACCENT)).bold());
        }
        if is_new {
            spans.push(Span::from("• ").fg(c(YELLOW)).bold());
        }
        if task.overdue() {
            spans.push(Span::from("‼ ").fg(c(RED)).bold());
        }
        spans.push(Span::from(format!("{} ", look_glyph(look))).fg(look_color(look)));
        let used: usize = spans.iter().map(Span::width).sum::<usize>() + age.chars().count() + 1;
        let title = Span::from(truncate(&task.title, width.saturating_sub(used).max(4))).bold();
        spans.push(if task.overdue() { title.fg(c(RED)) } else { title });
        spans.push(Span::from(format!(" {age}")).fg(c(age_colour)));
        return vec![Line::from(spans)];
    }
    let head = card_head(task, marked, is_new);

    let mut ids = format!("  #{}", task.short_id());
    if let Some(repo) = task.repo_name() {
        ids.push_str(&format!(" · {repo}"));
    }
    if let Some(number) = task.source.as_ref().and_then(|s| s.number) {
        ids.push_str(&format!(" · gh#{number}"));
    }
    if let Some(key) = task.jira_key() {
        ids.push_str(&format!(" · {key}"));
    }
    let ids = Line::from(Span::from(ids).fg(c(SUBTEXT0)));

    let mut meta = vec![
        Span::raw("  "),
        Span::from(format!("{} {}", look_glyph(look), task.status_label())).fg(look_color(look)).bold(),
        Span::from(format!(" · {age}")).fg(c(age_colour)),
    ];
    if task.worktree_path.is_some() {
        meta.push(Span::from(" ⎇").fg(c(ACCENT)));
    }
    if task.retries.total > 1 {
        meta.push(Span::from(format!(" ×{}", task.retries.total)).fg(c(PEACH)));
    }
    if task.repo_path.is_none() && task.state == "draft" {
        meta.push(Span::from(" no repo").fg(c(SUBTEXT0)));
    }
    // A dim `$` on the tickets above the p90 of spend: the expensive ones at a glance.
    if task.spent_usd.zip(spend_p90).is_some_and(|(spent, p90)| spent > p90) {
        meta.push(Span::from(" $").fg(c(SUBTEXT0)));
    }
    let mut lines = vec![head, ids, Line::from(meta)];
    if density == Density::Comfortable {
        lines.push(task.triad().map_or_else(Line::default, |t| Line::from(Span::from(format!("  {t}")).fg(c(SUBTEXT0)))));
    }
    lines
}

pub(crate) fn bullets(items: &[String]) -> Vec<Line<'static>> {
    items.iter().map(|item| Line::from(format!("  • {item}"))).collect()
}

pub(crate) fn json_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// "title (~N LOC)" per proposed slice; entries without a title are skipped.
pub(crate) fn slice_lines(value: &Value) -> Vec<String> {
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

/// "verdict", "N artifacts" and up to three artifact paths from `requested.evidence`.
pub(crate) fn evidence_lines(value: &Value) -> Vec<String> {
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
pub(crate) fn rules_lines(value: &Value, width: usize) -> Vec<String> {
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

/// One line per proved check: `✓ name: cmd` or `✗ name: cmd`, a failed one followed by the
/// last lines of its output.
pub(crate) fn proof_lines(value: &Value) -> Vec<(bool, String)> {
    const TAIL: usize = 3;
    let Some(items) = value.as_array() else { return Vec::new() };
    let mut lines = Vec::new();
    for item in items {
        let ok = item["ok"].as_bool().unwrap_or(false);
        let name = item["name"].as_str().unwrap_or("check");
        let cmd = item["cmd"].as_str().unwrap_or("");
        lines.push((ok, format!("{} {name}: {cmd}", if ok { "✓" } else { "✗" })));
        if !ok && let Some(tail) = item["tail"].as_str() {
            let shown: Vec<&str> = tail.lines().filter(|l| !l.trim().is_empty()).collect();
            for line in shown.iter().rev().take(TAIL).rev() {
                lines.push((ok, format!("    {line}")));
            }
        }
    }
    lines
}

/// Where a paused or escalated ticket picks up; an escalated one also says how to retry it.
pub(crate) fn continues_line(state: &str, stage: &str) -> String {
    if state == "escalated" {
        format!("Continues at: {stage} · a retries it (add guidance if you like)")
    } else {
        format!("Continues at: {stage}")
    }
}

/// One activity entry in words.
pub(crate) fn describe(event: &TaskEvent) -> String {
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
        "jira.transitioned" => format!("jira → {}", s("to")),
        "jira.blocked" => {
            let why = p["why"].as_str().map(|w| format!(" — {w}")).unwrap_or_default();
            format!("jira blocked: no transition to \"{}\" from \"{}\"{why}", s("wanted"), s("current"))
        }
        "jira.moved" => format!("jira moved to {}", s("status")),
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
pub(crate) fn truncate(text: &str, width: usize) -> String {
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
    add("Gates answered · within SLA", both(floor, |m| format!("{} · {}", m.gates.answered, fmt_pct(m.gates.within_sla))));
    let mut gate_states: Vec<String> = [&floor.d7, &floor.d30].iter().filter_map(|m| m.as_ref()).flat_map(|m| m.gates.wait_ms.keys().cloned()).collect();
    gate_states.sort();
    gate_states.dedup();
    for state in gate_states {
        let label = format!("  wait {} median", state.trim_start_matches("awaiting_").replace('_', " "));
        let wait = |m: &Metrics| fmt_ms(m.gates.wait_ms.get(&state).and_then(|s| s.median));
        add(&label, both(floor, wait));
    }
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

/// The PR view: a header of splits with their counts and when GitHub was last polled; the
/// split's PRs oldest first as an aligned list on the left; the selected PR drawn by the same
/// widget the ticket popup uses on the right (from 100 columns; `x` shows it narrower).
fn render_pulls(frame: &mut Frame, area: Rect, app: &App, state: &PullsState) {
    let now = now_secs();
    let counts = pulls::counts(&app.prs.prs);
    let mut head = vec![Span::from(" Pulls ").fg(c(ACCENT)).bold()];
    if app.prs_polling {
        // Up front, where a narrow terminal still shows it.
        head.push(Span::from(format!("{} polling GitHub… ", spinner())).fg(c(YELLOW)).bold());
    }
    for (i, split) in PrSplit::ALL.iter().enumerate() {
        if i > 0 {
            head.push(Span::from("│").fg(c(MUTED)));
        }
        let label = format!(" {} {} ", split.label(), counts[i]);
        head.push(if *split == state.split {
            Span::from(label).fg(c(BASE)).bg(c(ACCENT)).bold()
        } else {
            Span::from(label).fg(c(SUBTEXT0))
        });
    }
    if !app.prs_polling {
        let polled = match app.prs.polled_at.as_deref().and_then(unix_secs) {
            Some(at) => format!("polled {} ago", age_secs(now.saturating_sub(at))),
            None => "not polled yet".to_string(),
        };
        head.push(Span::from(format!("  {polled}")).fg(c(SUBTEXT0)));
    }
    let mut top = vec![Line::from(head)];
    if let Some(error) = &app.prs.error {
        top.push(Line::from(Span::from(format!(" ⚠ {error}")).fg(c(RED))));
    }
    let [head_area, body] = Layout::vertical([Constraint::Length(top.len() as u16), Constraint::Min(0)]).areas(area);
    frame.render_widget(Paragraph::new(top), head_area);

    let items = pulls::items(&app.prs.prs, state.split);
    let selected = state.cursor.min(items.len().saturating_sub(1));
    let wide = body.width >= PULLS_DETAIL_FROM;
    let [list_area, detail_area] = if wide {
        Layout::horizontal([Constraint::Min(0), Constraint::Length(PULLS_DETAIL_WIDTH)]).areas(body)
    } else {
        Layout::horizontal([Constraint::Min(0), Constraint::Length(0)]).areas(body)
    };

    let list_block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .title(Line::from(format!(" {} {} ", state.split.label(), items.len())).bold());
    let inner = list_block.inner(list_area);
    let mut lines = Vec::new();
    if items.is_empty() {
        lines.push(Line::from(Span::from("  ✓ nothing here").fg(c(GREEN))));
    }
    // A window of rows around the cursor, so a long split never hides the selected PR.
    let visible = (inner.height as usize).max(1);
    let start = selected.saturating_sub(visible / 2).min(items.len().saturating_sub(visible));
    for (row, &i) in items.iter().enumerate().skip(start).take(visible) {
        lines.push(pr_row(&app.prs.prs[i], row == selected, inner.width as usize, now));
    }
    frame.render_widget(Paragraph::new(lines).block(list_block), list_area);

    if wide {
        let pr = items.get(selected).map(|&i| &app.prs.prs[i]);
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(c(MUTED)))
            .padding(Padding::horizontal(1))
            .title(Line::from(pr.map_or(" PR ".to_string(), |pr| format!(" {} ", pr.key()))).bold());
        let lines = match pr {
            Some(pr) => pr_detail_lines(pr, now),
            None => vec![Line::from(Span::from("nothing selected").fg(c(SUBTEXT0)))],
        };
        frame.render_widget(Paragraph::new(lines).block(block).wrap(Wrap { trim: false }), detail_area);
    }
}

/// From this width the PR view keeps a detail pane beside the list.
const PULLS_DETAIL_FROM: u16 = 100;
const PULLS_DETAIL_WIDTH: u16 = 46;

/// One PR as a row of fixed columns: the checks glyph, the repo's colour bar and name (after
/// the owner's `/`; the whole slug when there is none), the
/// number, the title (the only field ever cut), the age, and a tag (⚙ a task runs, ⌂ no
/// checkout). Everything else lives in the detail pane.
fn pr_row(pr: &PullRequest, selected: bool, width: usize, now: u64) -> Line<'static> {
    let (glyph, checks_color) = match pr.checks.state.as_str() {
        "failure" => ("✗", RED),
        "pending" => ("◐", YELLOW),
        "success" => ("✓", GREEN),
        _ => ("·", SUBTEXT0),
    };
    let repo_name = pr.repo.rsplit('/').next().unwrap_or(&pr.repo);
    let repo_colour = REPO_COLOURS[repo_colour_slot(repo_name)];
    let (tag, tag_color) = match (&pr.task, pr.local_path.is_some()) {
        (Some(_), _) => ("⚙", YELLOW),
        (None, false) => ("⌂", SUBTEXT0),
        _ => (" ", SUBTEXT0),
    };
    let number = format!("#{}", pr.number);
    let age = age(&pr.updated_at, now);
    // sel(2) glyph(2) bar(1) repo(10) gap(1) number(5) gap(1) title gap(2) age(3) gap(2) tag(1)
    let fixed = 2 + 2 + 1 + 10 + 1 + 5 + 1 + 2 + 3 + 2 + 1;
    let room = width.saturating_sub(fixed).max(4);
    let mut spans = vec![
        Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
        Span::from(format!("{glyph} ")).fg(c(checks_color)),
        Span::from("▌").fg(c(repo_colour)),
        Span::from(format!("{:<10} ", truncate(repo_name, 10))).fg(c(repo_colour)),
        Span::from(format!("{number:>5} ")).fg(c(SUBTEXT0)),
        Span::from(format!("{:<room$}", truncate(&pr.title, room))).bold(),
        Span::from(format!("  {age:>3}  ")).fg(c(SUBTEXT0)),
        Span::from(tag.to_string()).fg(c(tag_color)),
    ];
    if selected {
        spans = spans.into_iter().map(|s| s.bg(c(SELECTED_BG))).collect();
    }
    Line::from(spans)
}

/// The PR widget, then the four keys with whether each is on and why not.
fn pr_detail_lines(pr: &PullRequest, now: u64) -> Vec<Line<'static>> {
    let mut lines = detail::pr_widget(pr, now);
    lines.push(Line::default());
    for key in PrKey::ALL {
        let label = key.label().split(':').next().unwrap_or(key.label()).split(" (").next().unwrap_or("");
        match pulls::blocker(pr, key) {
            None => lines.push(Line::from(vec![
                Span::from(format!("{} ", key.key())).fg(c(BASE)).bg(c(ACCENT)),
                Span::from(format!(" {label:<8}")).bold(),
                Span::from("  ready").fg(c(GREEN)),
            ])),
            Some(why) => lines.push(Line::from(vec![
                Span::from(format!("{} ", key.key())).fg(c(BASE)).bg(c(MUTED)),
                Span::from(format!(" {label:<8}")).fg(c(SUBTEXT0)),
                Span::from(format!("  off: {why}")).fg(c(SUBTEXT0)),
            ])),
        }
    }
    lines
}

/// Where to clone a repo the machine has no checkout of: the folders under the repos root.
fn render_clone_prompt(frame: &mut Frame, repo: &str, query: &str, all: &[String], cursor: usize) {
    const VISIBLE_ROWS: usize = 10;
    let area = centered(frame.area(), 90, VISIBLE_ROWS as u16 + 7);
    frame.render_widget(Clear, area);
    let name = repo.rsplit('/').next().unwrap_or(repo);
    let matches = App::matching_repos(all, query);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(format!(" clone {repo} into … ")).bold());
    let mut lines = vec![
        Line::from(Span::from(format!("No checkout of {repo}. Pick a folder; it lands at <folder>/{name}. esc keeps it read-only.")).fg(c(SUBTEXT0))),
        Line::from(vec![Span::from(" search: ").fg(c(ACCENT)).bold(), Span::from(format!("{query}▏"))]),
        Line::default(),
    ];
    if matches.is_empty() {
        lines.push(Line::from(Span::from("  no matches").fg(c(SUBTEXT0))));
    } else {
        let start = cursor.saturating_sub(VISIBLE_ROWS / 2).min(matches.len().saturating_sub(VISIBLE_ROWS));
        for (i, folder) in matches.iter().enumerate().skip(start).take(VISIBLE_ROWS) {
            let selected = i == cursor;
            let style = if selected { Style::new().fg(c(ACCENT)).bold() } else { Style::new() };
            lines.push(Line::from(vec![
                Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
                Span::from(format!("{folder}/{name}")).style(style),
            ]));
        }
    }
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

/// `x` in the PR view: the PR drawn by the shared widget, then the four keys for it; an off
/// key says why under it. On a terminal too narrow for the detail pane this is where the
/// detail shows.
fn render_pr_actions(frame: &mut Frame, app: &App, cursor: usize) {
    let Some(pr) = app.pr_under_cursor() else { return };
    let widget = detail::pr_widget(&pr, now_secs());
    render_menu(frame, format!(" {} ", pr.key()), widget, &keys::menu(app, Scope::Pulls), cursor, 0);
}

/// An `x` menu: the item's widget (when the view gives one), then the registry's rows for it,
/// the dim ones with why they are off. The cursor's row is bright; a dim row keeps its grey.
fn render_menu(frame: &mut Frame, title: String, widget: Vec<Line<'static>>, rows: &[(&keys::Binding, Avail)], cursor: usize, min_width: u16) {
    let reasons = rows.iter().filter(|(_, a)| matches!(a, Avail::Off(_))).count();
    let longest = rows
        .iter()
        .map(|(b, a)| match a {
            Avail::Off(why) => b.label.chars().count().max(why.chars().count() + 4),
            _ => b.label.chars().count(),
        })
        .chain(widget.iter().map(|l| l.width().min(70)))
        .max()
        .unwrap_or(40);
    let gap = usize::from(!widget.is_empty());
    let height = widget.len() + gap + rows.len() + reasons;
    let width = (longest as u16 + 12).max(min_width).min(frame.area().width.saturating_sub(2));
    let area = centered(frame.area(), width, (height as u16 + 4).min(frame.area().height));
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(title).bold());
    let mut lines: Vec<Line> = widget;
    if gap == 1 {
        lines.push(Line::default());
    }
    for (i, (binding, avail)) in rows.iter().enumerate() {
        let selected = i == cursor;
        let style = match (selected, avail) {
            (_, Avail::Off(_)) => Style::new().fg(c(MUTED)),
            (true, _) => Style::new().fg(c(ACCENT)).bold(),
            (false, _) => Style::new(),
        };
        lines.push(Line::from(vec![
            Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
            Span::from(format!("{:<4}", binding.menu_keys())).fg(c(SUBTEXT0)),
            Span::from(binding.label).style(style),
        ]));
        if let Avail::Off(why) = avail {
            lines.push(Line::from(Span::from(format!("      ↳ {why}")).fg(c(MUTED))));
        }
    }
    frame.render_widget(Paragraph::new(lines).block(block).wrap(Wrap { trim: false }), area);
}

/// The Slack view: a header strip of splits with their counts, when Slack was last polled and
/// how the socket is; the split's items as an aligned list on the left; the selected item's
/// pane on the right (from 100 columns; `x` shows it narrower).
fn render_slack(frame: &mut Frame, area: Rect, app: &App, state: &SlackState) {
    let now = now_secs();
    let snapshot = &app.slack_snapshot;
    let counts = slack::counts(&snapshot.items);
    let narrow = area.width < SLACK_DETAIL_FROM;
    let mut head = vec![Span::from(" Slack ").fg(c(ACCENT)).bold()];
    if app.slack_polling {
        head.push(Span::from(format!("{} polling Slack… ", spinner())).fg(c(YELLOW)).bold());
    }
    for (i, split) in SlackSplit::ALL.iter().enumerate() {
        if i > 0 {
            head.push(Span::from("│").fg(c(MUTED)));
        }
        let name = if narrow { split.label_narrow() } else { split.label() };
        let label = format!(" {name} {} ", counts[i]);
        head.push(if *split == state.split {
            Span::from(label).fg(c(BASE)).bg(c(ACCENT)).bold()
        } else {
            Span::from(label).fg(c(SUBTEXT0))
        });
    }
    if !app.slack_polling {
        let polled = match snapshot.polled_at.as_deref().and_then(unix_secs) {
            Some(at) => format!("polled {} ago", age_secs(now.saturating_sub(at))),
            None => "not polled yet".to_string(),
        };
        head.push(Span::from(format!("  {polled}")).fg(c(SUBTEXT0)));
    }
    match snapshot.socket.as_str() {
        "connected" => head.push(Span::from("  ⚡ live").fg(c(GREEN))),
        "disconnected" => head.push(Span::from("  ⚡ socket down").fg(c(YELLOW))),
        _ => {}
    }
    let overdue = slack::overdue_count(&snapshot.items);
    if overdue > 0 {
        head.push(Span::from(format!("  ‼ {overdue} overdue")).fg(c(RED)).bold());
    }
    let mut top = vec![Line::from(head)];
    if let Some(error) = &snapshot.error {
        top.push(Line::from(Span::from(format!(" ⚠ {error}")).fg(c(RED))));
    }
    let [head_area, body] = Layout::vertical([Constraint::Length(top.len() as u16), Constraint::Min(0)]).areas(area);
    frame.render_widget(Paragraph::new(top), head_area);

    let items = slack::items(&snapshot.items, state.split);
    let selected = state.cursor.min(items.len().saturating_sub(1));
    let wide = body.width >= SLACK_DETAIL_FROM;
    let [list_area, detail_area] = if wide {
        Layout::horizontal([Constraint::Min(0), Constraint::Length(SLACK_DETAIL_WIDTH)]).areas(body)
    } else {
        Layout::horizontal([Constraint::Min(0), Constraint::Length(0)]).areas(body)
    };

    let list_block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .title(Line::from(format!(" {} {} ", state.split.label(), items.len())).bold());
    let inner = list_block.inner(list_area);
    let mut lines = Vec::new();
    if items.is_empty() {
        lines.push(Line::from(Span::from("  ✓ nothing here").fg(c(GREEN))));
    }
    for (row, &i) in items.iter().enumerate() {
        lines.push(slack_row(&snapshot.items[i], row == selected, inner.width as usize, now));
    }
    frame.render_widget(Paragraph::new(lines).block(list_block), list_area);

    if wide {
        let item = items.get(selected).map(|&i| &snapshot.items[i]);
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(c(MUTED)))
            .padding(Padding::horizontal(1))
            .title(Line::from(item.map_or(" message ".to_string(), |i| format!(" {} ", i.channel_label()))).bold());
        let lines = match item {
            Some(item) => slack_detail_lines(item, snapshot.sla_for(item.priority()), now),
            None => vec![Line::from(Span::from("nothing selected").fg(c(SUBTEXT0)))],
        };
        frame.render_widget(Paragraph::new(lines).block(block).wrap(Wrap { trim: false }), detail_area);
    }
}

/// From this width the Slack view keeps a detail pane beside the list.
const SLACK_DETAIL_FROM: u16 = 100;
const SLACK_DETAIL_WIDTH: u16 = 48;

/// `P0` red, `P1` yellow, `P2` plain, `P3` and untriaged muted.
fn priority_style(priority: Option<&str>) -> Style {
    match priority {
        Some("P0") => Style::new().fg(c(RED)).bold(),
        Some("P1") => Style::new().fg(c(YELLOW)),
        Some("P2") => Style::new(),
        _ => Style::new().fg(c(SUBTEXT0)),
    }
}

/// The tag after the age, two glyphs from `↺` came back after you cleared it, `⚙` already a
/// ticket, `⎇` inside a thread; an overdue item puts `‼` in front of them and takes a third.
fn slack_tag(item: &SlackItem) -> String {
    let mut tag = String::new();
    let room = if item.overdue { 3 } else { 2 };
    for (on, glyph) in [(item.overdue, '‼'), (item.reopened_at.is_some(), '↺'), (item.task_id().is_some(), '⚙'), (item.thread_ts.is_some(), '⎇')] {
        if on && tag.chars().count() < room {
            tag.push(glyph);
        }
    }
    while tag.chars().count() < room {
        tag.push(' ');
    }
    tag
}

/// One item as a row of fixed columns: the priority, the channel's colour bar and name, the
/// author, triage's summary (the only field ever cut, `×N` when a thread collapsed into it),
/// the age, and the tag. Everything else lives in the detail pane. Past its reply SLA the
/// summary and the age go red and the tag leads with `‼`; inside five minutes of it the age
/// goes yellow.
fn slack_row(item: &SlackItem, selected: bool, width: usize, now: u64) -> Line<'static> {
    let channel = item.channel_label();
    let channel_colour = REPO_COLOURS[repo_colour_slot(&item.channel.name)];
    let author = format!("@{}", item.author.name);
    let mut summary = item.summary().to_string();
    if item.count > 1 {
        summary.push_str(&format!(" ×{}", item.count));
    }
    let tag = slack_tag(item);
    let tag_colour = if item.overdue {
        RED
    } else if item.reopened_at.is_some() {
        YELLOW
    } else {
        SUBTEXT0
    };
    let (summary_style, age_style) = if item.overdue {
        (Style::new().fg(c(RED)).bold(), Style::new().fg(c(RED)).bold())
    } else if item.due_soon(now) {
        (Style::new().bold(), Style::new().fg(c(YELLOW)))
    } else {
        (Style::new().bold(), Style::new().fg(c(SUBTEXT0)))
    };
    // sel(2) prio(3) bar(1) channel(16) gap(1) author(9) gap(1) summary gap(2) age(3) gap(1) tag(2, 3 overdue)
    let fixed = 2 + 3 + 1 + 16 + 1 + 9 + 1 + 2 + 3 + 1 + tag.chars().count();
    let room = width.saturating_sub(fixed).max(4);
    let mut spans = vec![
        Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
        Span::from(format!("{:<3}", item.priority().unwrap_or("·"))).style(priority_style(item.priority())),
        Span::from("▌").fg(c(channel_colour)),
        Span::from(format!("{:<16} ", truncate(&channel, 16))).fg(c(channel_colour)),
        Span::from(format!("{:<9} ", truncate(&author, 9))).fg(c(SUBTEXT0)),
        Span::from(format!("{:<room$}", truncate(&summary, room))).style(summary_style),
        Span::from(format!("  {:>3} ", item.age(now))).style(age_style),
        Span::from(tag).fg(c(tag_colour)),
    ];
    if selected {
        spans = spans.into_iter().map(|s| s.bg(c(SELECTED_BG))).collect();
    }
    Line::from(spans)
}

/// The item as the pane and the actions menu draw it: where and who, when the reply is due
/// under `sla` (its priority's, in seconds; 0 for none), the context, the message, and
/// triage's verdict with why, links and draft.
fn slack_widget(item: &SlackItem, sla: u64, now: u64) -> Vec<Line<'static>> {
    let muted = |text: String| Line::from(Span::from(text).fg(c(SUBTEXT0)));
    let field = |name: &str, text: String| {
        Line::from(vec![Span::from(format!("{name:<9}")).fg(c(SUBTEXT0)), Span::from(text)])
    };
    let mut head = format!("{} · @{} · {} ago", item.channel_label(), item.author.name, item.age(now));
    if item.thread_ts.is_some() {
        head.push_str(&format!(" · thread ({} replies)", item.replies));
    }
    if item.count > 1 {
        head.push_str(&format!(" · {} messages", item.count));
    }
    let mut lines = vec![muted(head)];
    if let Some(due) = item.due_label(now) {
        let target = match (item.priority(), sla) {
            (Some(p), 0) => format!(" ({p})"),
            (Some(p), secs) => format!(" ({p} · {} SLA)", age_secs(secs)),
            (None, _) => String::new(),
        };
        let style = if item.overdue { Style::new().fg(c(RED)).bold() } else { Style::new() };
        lines.push(Line::from(vec![Span::from(format!("{:<9}", "due")).fg(c(SUBTEXT0)), Span::from(format!("{due}{target}")).style(style)]));
    }
    if item.reopened_at.is_some() {
        lines.push(Line::from(Span::from("new since you cleared it").fg(c(YELLOW)).bold()));
    }
    lines.push(Line::default());
    for message in &item.context {
        lines.push(muted(format!("@{}  {}", message.user.name, message.text)));
    }
    lines.push(Line::from(Span::from(item.text.clone()).bold()));
    lines.push(Line::default());
    match &item.triage {
        Some(triage) => {
            let expects = if triage.expects_reply { " · reply expected" } else { "" };
            let by = if triage.by == "rules" { " · by rule" } else { "" };
            let hand = if triage.overridden { " · yours" } else { "" };
            lines.push(Line::from(vec![
                Span::from(format!("{:<9}", "triage")).fg(c(SUBTEXT0)),
                Span::from(triage.priority.clone()).style(priority_style(Some(&triage.priority))),
                Span::from(format!(" · {}{expects}{by}{hand}", triage.category)),
            ]));
            if !triage.why.is_empty() {
                lines.push(field("why", triage.why.clone()));
            }
            let mut links: Vec<String> = Vec::new();
            if let Some(pr) = &item.linked.pr {
                links.push(format!("{}#{} ({})", pr.repo, pr.number, pr.split.replace('_', " ")));
            }
            for r in &triage.refs {
                if !links.iter().any(|l| l.starts_with(&r.reference)) {
                    links.push(r.reference.clone());
                }
            }
            if !links.is_empty() {
                lines.push(field("links", links.join(" · ")));
            }
            if let Some(deadline) = &triage.deadline {
                lines.push(field("deadline", deadline.clone()));
            }
            if let Some(draft) = triage.draft.as_deref().filter(|d| !d.is_empty()) {
                lines.push(Line::default());
                lines.push(field("draft", draft.to_string()));
            }
        }
        None => lines.push(field("triage", "not yet".to_string())),
    }
    if let Some(task) = item.task_id() {
        lines.push(field("ticket", format!("#{}", crate::model::short_id(task))));
    }
    lines
}

/// The widget, then every key with whether it is on and why not.
fn slack_detail_lines(item: &SlackItem, sla: u64, now: u64) -> Vec<Line<'static>> {
    let mut lines = slack_widget(item, sla, now);
    lines.push(Line::default());
    for key in SlackKey::ALL {
        let label = key.short();
        match slack::blocker(item, key) {
            None => lines.push(Line::from(vec![
                Span::from(format!("{} ", key.key())).fg(c(BASE)).bg(c(ACCENT)),
                Span::from(format!(" {label:<8}")).bold(),
                Span::from("  ready").fg(c(GREEN)),
            ])),
            Some(why) => lines.push(Line::from(vec![
                Span::from(format!("{} ", key.key())).fg(c(BASE)).bg(c(MUTED)),
                Span::from(format!(" {label:<8}")).fg(c(SUBTEXT0)),
                Span::from(format!("  off: {why}")).fg(c(SUBTEXT0)),
            ])),
        }
    }
    lines
}

/// `x` in the Slack view: the item drawn by the widget, then its keys; an off key says why
/// under it. On a terminal too narrow for the pane this is where the detail shows.
fn render_slack_actions(frame: &mut Frame, app: &App, cursor: usize) {
    let Some(item) = app.slack_under_cursor() else { return };
    let widget = slack_widget(item, app.slack_snapshot.sla_for(item.priority()), now_secs());
    render_menu(frame, format!(" {} · @{} ", item.channel_label(), item.author.name), widget, &keys::menu(app, Scope::Slack), cursor, 0);
}

/// The reply editor: the text on top, the thread's last messages under a `context` rule, so
/// what you answer stays in view. ctrl+s posts it as you.
fn render_slack_reply(frame: &mut Frame, app: &App, id: &str, area: &TextArea<'static>, vim: &crate::vim::Vim, nudge: bool) {
    let rect = centered(frame.area(), frame.area().width * 9 / 10, frame.area().height * 8 / 10);
    frame.render_widget(Clear, rect);
    let item = app.slack_item(id);
    let (label, mode_color) = match vim.mode() {
        crate::vim::Mode::Normal => (" NORMAL ", ACCENT),
        crate::vim::Mode::Insert => (" INSERT ", GREEN),
    };
    let verb = if nudge { "nudge" } else { "reply" };
    let title = match item {
        Some(item) if nudge => format!(" nudge · {} · opens with @{} ", item.channel_label(), item.author.name),
        Some(item) if item.thread_ts.is_some() => format!(" reply · {} · thread with @{} ", item.channel_label(), item.author.name),
        Some(item) => format!(" reply · {} · to @{} ", item.channel_label(), item.author.name),
        None => format!(" {verb} "),
    };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(mode_color)))
        .padding(Padding::horizontal(1))
        .title(Line::from(title).bold())
        .title(Line::from(format!("· {} ", keys::editor_line(app))).fg(c(SUBTEXT0)))
        .title_top(Line::from(" ctrl+s send  esc back ").fg(c(SUBTEXT0)).right_aligned())
        .title_bottom(Line::from(label).bold().fg(c(mode_color)).left_aligned());
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    let context: Vec<&crate::model::SlackMessage> = item.map(|i| i.context.iter().rev().take(3).rev().collect()).unwrap_or_default();
    let context_rows = if context.is_empty() { 0 } else { (context.len() as u16 + 1).min(inner.height / 2) };
    let [text_area, context_area] = Layout::vertical([Constraint::Min(1), Constraint::Length(context_rows)]).areas(inner);

    let mut area = area.clone();
    area.set_block(Block::default());
    area.set_cursor_line_style(Style::new().bg(c(SURFACE0)));
    area.set_selection_style(Style::new().bg(c(SURFACE1)));
    area.set_cursor_style(Style::new().bg(c(mode_color)).fg(c(BASE)));
    frame.render_widget(&area, text_area);

    if context_rows > 0 {
        let rule = format!("─ context {}", "─".repeat((context_area.width as usize).saturating_sub(10)));
        let mut lines = vec![Line::from(Span::from(rule).fg(c(MUTED)))];
        for message in context {
            lines.push(Line::from(Span::from(format!("@{:<7} {}", message.user.name, message.text)).fg(c(SUBTEXT0))));
        }
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), context_area);
    }
}

/// `W`: the handles, broadcasts, keywords and channels the inbox treats as addressed to you.
fn render_slack_watches(frame: &mut Frame, app: &App, state: &SlackState) {
    let watches = &app.slack_snapshot.watches;
    let cursor = state.watches.as_ref().map_or(0, |w| w.cursor).min(watches.len().saturating_sub(1));
    let width = 96.min(frame.area().width.saturating_sub(2));
    let height = (watches.len().max(1) as u16 + 6).min(frame.area().height.saturating_sub(2));
    let area = centered(frame.area(), width, height);
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(1))
        .title(Line::from(" Watches ").bold())
        .title_bottom(Line::from(" n add  e floor  d delete  space on/off  esc ").fg(c(SUBTEXT0)).right_aligned());
    let mut lines = Vec::new();
    if watches.is_empty() {
        lines.push(Line::from(Span::from("  nothing watched yet").fg(c(SUBTEXT0))));
    }
    for (i, watch) in watches.iter().enumerate() {
        let selected = i == cursor;
        let (state_label, state_colour) = if watch.enabled { ("on ", GREEN) } else { ("off", SUBTEXT0) };
        let label_style = match (selected, watch.enabled) {
            (true, _) => Style::new().fg(c(ACCENT)).bold(),
            (false, true) => Style::new(),
            (false, false) => Style::new().fg(c(SUBTEXT0)),
        };
        let builtin = if watch.builtin { " · built-in" } else { "" };
        lines.push(Line::from(vec![
            Span::from(if selected { "› " } else { "  " }).fg(c(ACCENT)),
            Span::from(format!("{state_label}  ")).fg(c(state_colour)),
            Span::from(format!("{:<22}", truncate(&watch.label, 22))).style(label_style),
            Span::from(format!("{:<11}", watch.kind)).fg(c(SUBTEXT0)),
            Span::from(format!("{:<10}", truncate(&watch.value, 10))).fg(c(SUBTEXT0)),
            Span::from(format!("{}{builtin}", slack::watch_scope(watch))).fg(c(SUBTEXT0)),
        ]));
    }
    lines.push(Line::default());
    lines.push(Line::from(
        Span::from("n: type @handle, #channel or a word · usergroups and channels autocomplete from Slack").fg(c(SUBTEXT0)),
    ));
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

/// `n` in Watches: the query, what kind of watch it makes, and the completions it matches.
fn render_slack_watch_add(frame: &mut Frame, app: &App, query: &str, cursor: usize) {
    const VISIBLE_ROWS: usize = 8;
    let area = centered(frame.area(), 70.min(frame.area().width.saturating_sub(2)), VISIBLE_ROWS as u16 + 6);
    frame.render_widget(Clear, area);
    let (kind, text) = slack::watch_kind_of(query);
    let matches = app.slack_watch_matches(query);
    let cursor = cursor.min(matches.len().saturating_sub(1));
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(" add a watch ").bold());
    let what = match kind {
        "usergroup" => "a user group: mentions of it count as mentions of you",
        "channel" => "a channel: every message in it, as FYI",
        _ if text.is_empty() => "@handle, #channel, or a word to watch for",
        _ => "a keyword, matched case-insensitively everywhere",
    };
    let mut lines = vec![
        Line::from(vec![Span::from(" watch: ").fg(c(ACCENT)).bold(), Span::from(format!("{query}▏"))]),
        Line::from(Span::from(format!(" {what}")).fg(c(SUBTEXT0))),
        Line::default(),
    ];
    if kind == "keyword" {
        if !text.is_empty() {
            lines.push(Line::from(vec![Span::from("▌ ").fg(c(ACCENT)), Span::from(text.to_string()).fg(c(ACCENT)).bold()]));
        }
    } else if matches.is_empty() {
        lines.push(Line::from(Span::from(if app.slack_catalog_loading() { "  loading…" } else { "  no matches" }).fg(c(SUBTEXT0))));
    } else {
        let start = cursor.saturating_sub(VISIBLE_ROWS / 2).min(matches.len().saturating_sub(VISIBLE_ROWS));
        for (i, option) in matches.iter().enumerate().skip(start).take(VISIBLE_ROWS) {
            let selected = i == cursor;
            let style = if selected { Style::new().fg(c(ACCENT)).bold() } else { Style::new() };
            lines.push(Line::from(vec![
                Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
                Span::from(format!("{:<28}", option.label)).style(style),
                Span::from(option.id.clone()).fg(c(SUBTEXT0)),
            ]));
        }
    }
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

/// `s`: how long the item sleeps.
fn render_slack_snooze(frame: &mut Frame, cursor: usize) {
    let area = centered(frame.area(), 36, slack::SNOOZE_OPTIONS.len() as u16 + 4);
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(" snooze until ").bold());
    let lines: Vec<Line> = slack::SNOOZE_OPTIONS
        .iter()
        .enumerate()
        .map(|(i, option)| {
            let selected = i == cursor;
            let style = if selected { Style::new().fg(c(ACCENT)).bold() } else { Style::new() };
            Line::from(vec![
                Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
                Span::from(format!("{}  ", i + 1)).fg(c(SUBTEXT0)),
                Span::from(*option).style(style),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

/// `t`: the ticket about to be made, with the title and repo it gets.
fn render_slack_task(frame: &mut Frame, app: &App, id: &str, title: &str, repo: Option<&str>) {
    let width = 80.min(frame.area().width.saturating_sub(2));
    let area = centered(frame.area(), width, 8);
    frame.render_widget(Clear, area);
    let channel = app.slack_item(id).map(SlackItem::channel_label).unwrap_or_default();
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(format!(" ticket from {channel}? ")).bold());
    let field = |name: &str, text: String| Line::from(vec![Span::from(format!("{name:<7}")).fg(c(SUBTEXT0)), Span::from(text)]);
    let lines = vec![
        field("title", title.to_string()),
        field("repo", repo.map_or("none guessed; you pick one right after".to_string(), str::to_string)),
        Line::from(Span::from("the message and its thread become the description; the ticket links back").fg(c(SUBTEXT0))),
        Line::default(),
        Line::from(vec![
            Span::from(" y ").fg(c(BASE)).bg(c(ACCENT)),
            Span::from(" create  ").fg(c(SUBTEXT0)),
            Span::from(" n ").fg(c(BASE)).bg(c(ACCENT)),
            Span::from(" cancel").fg(c(SUBTEXT0)),
        ]),
    ];
    frame.render_widget(Paragraph::new(lines).block(block).wrap(Wrap { trim: false }), area);
}

/// The Floor's Slack block: items and replies by priority over 7d / 30d, how many of the 7d
/// replies came inside their SLA (count and share), how long a reply took (7d), the share
/// answered within an hour, and the SLA targets in force.
fn slack_metric_lines(d7: &SlackMetrics, d30: &SlackMetrics, head_style: Style, label_style: Style) -> Vec<Line<'static>> {
    let pair = |a: u64, b: u64| format!("{a} / {b}");
    let seconds = |v: Option<f64>| fmt_ms(v.map(|s| s * 1000.0));
    let mut out = vec![Line::from(
        Span::from(format!(" {:<14}{:>8}{:>8}{:>12}{:>16}", "Slack · 7d / 30d", "items", "replied", "within SLA", "median / p90")).style(head_style),
    )];
    for p in SLACK_PRIORITIES {
        let stats = d7.time_to_reply.get(p);
        let (within, share) = d7.within_sla_of(p);
        out.push(Line::from(vec![
            Span::from(format!(" {p:<14}")).style(priority_style(Some(p))),
            Span::from(format!(
                "{:>8}{:>8}{:>12}{:>16}",
                pair(d7.items.get(p).copied().unwrap_or(0), d30.items.get(p).copied().unwrap_or(0)),
                pair(d7.replied.get(p).copied().unwrap_or(0), d30.replied.get(p).copied().unwrap_or(0)),
                format!("{within} · {}", fmt_pct(share)),
                format!("{} / {}", seconds(stats.and_then(|s| s.median)), seconds(stats.and_then(|s| s.p90))),
            )),
        ]));
    }
    out.push(Line::from(vec![
        Span::from(format!(" {:<14}", "within 1h")).style(label_style),
        Span::from(format!("{:>8}{:>8}", fmt_pct(d7.within_hour_rate()), fmt_pct(d30.within_hour_rate()))),
        Span::from(format!("{:>28}", format!("{} / {} items", d7.total_items(), d30.total_items()))).style(label_style),
    ]));
    out.push(Line::from(vec![
        Span::from(format!(" {:<14}", "SLA targets")).style(label_style),
        Span::from(format!("{} (P0/P1/P2/P3)", sla_targets(&d7.sla))).style(label_style),
    ]));
    out
}

/// The Digest: what changed since the board was last open, by group, newest first.
fn render_digest(frame: &mut Frame, area: Rect, app: &App, digest: &DigestState) {
    let now = now_secs();
    let since = app.last_seen_secs.map_or("ever".to_string(), |s| format!("{} ago", age_secs(now.saturating_sub(s))));
    let entries = digest::entries(&app.tasks, app.last_seen_secs);
    let mut lines = vec![Line::from(Span::from(format!(" Digest · since {since} · {} change(s)", entries.len())).fg(c(ACCENT)).bold())];
    if entries.is_empty() {
        lines.push(Line::default());
        lines.push(Line::from(Span::from("  ✓ nothing new").fg(c(GREEN))));
    }
    let cursor = digest.cursor.min(entries.len().saturating_sub(1));
    let mut last_group = None;
    for (row, (group, i)) in entries.iter().enumerate() {
        if last_group != Some(*group) {
            lines.push(Line::default());
            lines.push(Line::from(Span::from(format!(" {}", group.label())).fg(c(SUBTEXT0)).bold()));
            last_group = Some(*group);
        }
        let task = &app.tasks[*i];
        let look = task.look_at(now);
        let selected = row == cursor;
        let what = task.reason.clone().unwrap_or_else(|| task.status_label());
        let repo = task.repo_name().map(|r| format!("{r} · ")).unwrap_or_default();
        let mut line = vec![
            Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
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
    let scope = floor.focused_name().map_or(String::new(), |name| format!(" {name} ·"));
    let mut lines = vec![Line::from(
        Span::from(format!(" Floor ·{scope} since {} (7d) · {} (30d)", since(&floor.d7), since(&floor.d30))).style(head_style),
    )];
    if floor.d7.is_none() && floor.d30.is_none() {
        lines.push(Line::from(Span::from(" no numbers yet; R to retry").style(label_style)));
    }

    // The per-repo table takes the bottom when there is more than one repo to compare.
    let repo_height = if floor.repos.is_empty() { 0 } else { (floor.repos.len() as u16 + 3).min(area.height / 3) };
    let [top, repo_area] = Layout::vertical([Constraint::Min(0), Constraint::Length(repo_height)]).areas(area);
    let wide = top.width >= 110;
    let [table_area, stage_area] = if wide {
        Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(top)
    } else {
        Layout::vertical([Constraint::Length(lines.len() as u16 + floor_rows(floor).len() as u16 + 1), Constraint::Min(0)]).areas(top)
    };
    if repo_height > 0 {
        render_floor_repos(frame, repo_area, floor, head_style, label_style);
    }

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
    // The Slack block takes the bottom of the stage area when there is one and it fits.
    let slack_lines = floor.slack.as_ref().map(|(d7, d30)| slack_metric_lines(d7, d30, head_style, label_style)).unwrap_or_default();
    let slack_height = slack_lines.len() as u16 + 1;
    let [stage_area, slack_area] = if !slack_lines.is_empty() && stage_area.height >= slack_height + 4 {
        Layout::vertical([Constraint::Min(0), Constraint::Length(slack_height)]).areas(stage_area)
    } else {
        Layout::vertical([Constraint::Min(0), Constraint::Length(0)]).areas(stage_area)
    };
    if slack_area.height > 0 {
        let [_, slack_body] = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(slack_area);
        frame.render_widget(Paragraph::new(slack_lines), slack_body);
    }
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

/// One row per repo over 7d, `all` first; `▌` marks the focus `tab` moves.
fn render_floor_repos(frame: &mut Frame, area: Rect, floor: &FloorState, head_style: Style, label_style: Style) {
    let row = |mark: &str, name: &str, closed: &str, open: &str, needs: &str, esc: &str, first: &str, cost: &str| {
        format!("{mark}{:<16}{:>7}{:>6}{:>10}{:>7}{:>11}{:>9}", truncate(name, 15), closed, open, needs, esc, first, cost)
    };
    let mut out = vec![
        Line::from(Span::from(row("  ", "repo · 7d", "closed", "open", "needs you", "esc", "first-pass", "cost")).style(head_style)),
    ];
    let room = (area.height as usize).saturating_sub(1);
    let all = floor.d7.as_ref().filter(|_| floor.cursor == 0);
    let all_row = row(
        if floor.cursor == 0 { "▌ " } else { "  " },
        "all",
        &all.map_or("–".to_string(), |m| m.tasks.closed.to_string()),
        &all.map_or("–".to_string(), |m| m.tasks.open.to_string()),
        &all.map_or("–".to_string(), |m| m.tasks.waiting_on_you.to_string()),
        &all.map_or("–".to_string(), |m| fmt_pct(m.escalations.rate)),
        &all.map_or("–".to_string(), |m| fmt_pct(m.first_pass_rate.verifying)),
        &all.map_or("–".to_string(), |m| fmt_usd(Some(m.cost.total_usd))),
    );
    out.push(Line::from(Span::from(all_row).style(if floor.cursor == 0 { Style::new().fg(c(ACCENT)).bold() } else { label_style })));
    for (i, r) in floor.repos.iter().enumerate().take(room.saturating_sub(1)) {
        let focused = floor.cursor == i + 1;
        let text = row(
            if focused { "▌ " } else { "  " },
            r.name(),
            &r.tasks.closed.to_string(),
            &r.tasks.open.to_string(),
            &r.tasks.waiting_on_you.to_string(),
            &fmt_pct(r.escalation_rate),
            &fmt_pct(r.first_pass_verifying),
            &fmt_usd(Some(r.cost_usd)),
        );
        out.push(Line::from(Span::from(text).style(if focused { Style::new().fg(c(ACCENT)).bold() } else { Style::new() })));
    }
    frame.render_widget(Paragraph::new(out), area);
}

fn render_actions(frame: &mut Frame, app: &App, cursor: usize) {
    let title = app
        .selected_task()
        .map_or(" Actions ".to_string(), |t| format!(" #{} {} ", t.short_id(), t.title));
    render_menu(frame, title, Vec::new(), &keys::menu(app, Scope::Board), cursor, 56);
}

/// The `:` prompt's completions, over the footer: up to six commands the text is a prefix of,
/// each with its label; the picked one (tab) bright.
fn render_completions(frame: &mut Frame, text: &str, pick: Option<usize>) {
    const SHOWN: usize = 6;
    let matches = keys::completions(text);
    if matches.is_empty() || (matches.len() == 1 && matches[0].0 == text) {
        return;
    }
    let shown: Vec<&(&str, &keys::Binding)> = matches.iter().take(SHOWN).collect();
    let name_width = shown.iter().map(|(n, _)| n.chars().count()).max().unwrap_or(0) + 2;
    let longest = shown.iter().map(|(_, b)| name_width + b.label.chars().count()).max().unwrap_or(20);
    let more = matches.len() > SHOWN;
    let height = shown.len() as u16 + u16::from(more);
    let frame_area = frame.area();
    let width = (longest as u16 + 6).min(frame_area.width);
    let area = Rect::new(frame_area.x, frame_area.bottom().saturating_sub(1 + height), width, height.min(frame_area.height.saturating_sub(1)));
    frame.render_widget(Clear, area);
    let mut lines: Vec<Line> = shown
        .iter()
        .enumerate()
        .map(|(i, (name, b))| {
            let picked = pick == Some(i);
            let style = if picked { Style::new().fg(c(ACCENT)).bold() } else { Style::new() };
            Line::from(vec![
                Span::from(if picked { " ▌ :" } else { "   :" }).fg(c(ACCENT)),
                Span::from(format!("{name:<name_width$}")).style(style),
                Span::from(b.label).fg(c(SUBTEXT0)),
            ])
        })
        .collect();
    if more {
        lines.push(Line::from(Span::from(format!("    … {} more", matches.len() - SHOWN)).fg(c(SUBTEXT0))));
    }
    frame.render_widget(Paragraph::new(lines).style(Style::new().bg(c(SURFACE0))), area);
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

/// `J`'s prompt: the query, then `+ create an issue from this ticket` and one row per hit as
/// `PLAT-123  In Progress  summary`, the cursor's row in the accent colour.
fn render_jira_link(frame: &mut Frame, task: &Task, query: &str, hits: &[JiraIssueHit], cursor: usize) {
    const VISIBLE_ROWS: usize = 10;
    let width = 90.min(frame.area().width.saturating_sub(2));
    let area = centered(frame.area(), width, VISIBLE_ROWS as u16 + 7);
    frame.render_widget(Clear, area);

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(format!(" Jira issue for #{} {} ", task.short_id(), task.title)).bold());
    let row_style = |selected: bool| if selected { Style::new().fg(c(ACCENT)).bold() } else { Style::new() };
    let mut lines = vec![
        Line::from(vec![Span::from(" search: ").fg(c(ACCENT)).bold(), Span::from(format!("{query}▏"))]),
        Line::default(),
        Line::from(vec![
            Span::from(if cursor == 0 { "▌ " } else { "  " }).fg(c(ACCENT)),
            Span::from("+ create an issue from this ticket (ctrl+n)").style(row_style(cursor == 0)),
        ]),
    ];
    if hits.is_empty() {
        let hint = if query.trim().chars().count() < 3 { "type a key or three letters to search" } else { "no matches" };
        lines.push(Line::from(Span::from(format!("  {hint}")).fg(c(SUBTEXT0))));
    }
    let room = usize::from(width).saturating_sub(6 + 11 + 2 + 14 + 2).max(8);
    let start = cursor.saturating_sub(VISIBLE_ROWS / 2).min(hits.len().saturating_sub(VISIBLE_ROWS));
    for (i, hit) in hits.iter().enumerate().skip(start).take(VISIBLE_ROWS) {
        let selected = i + 1 == cursor;
        lines.push(Line::from(vec![
            Span::from(if selected { "▌ " } else { "  " }).fg(c(ACCENT)),
            Span::from(format!("{:<11}", truncate(&hit.key, 11))).style(row_style(selected)),
            Span::from(format!("{:<14}", truncate(hit.status.as_deref().unwrap_or("–"), 14))).fg(c(SUBTEXT0)),
            Span::from(truncate(&hit.summary, room)).style(row_style(selected)),
        ]));
    }
    if hits.len() > VISIBLE_ROWS {
        lines.push(Line::from(Span::from(format!("  … {} of {} issues", cursor.max(1), hits.len())).fg(c(SUBTEXT0))));
    }
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

/// A frame this wide or wider lays the sheet out in two columns of groups.
const HELP_WIDE_FROM: u16 = 100;
const HELP_COLUMN_GAP: usize = 3;

/// One laid-out line of the sheet: its spans and, for a key row, which runnable row it is.
struct HelpLine {
    spans: Vec<Span<'static>>,
    row: Option<usize>,
}

/// The `?` sheet: the registry's keys for the sheet's scope, the bright ones as `key  label`,
/// the dim ones as `key  (reason)`, dense groups folded to a strip unless `long`, two columns
/// from `HELP_WIDE_FROM`. The layer under a popup folds to one line at the bottom. Scrolls to
/// keep the cursor's row in view and records how far it can scroll.
fn render_help(frame: &mut Frame, app: &App) {
    let Mode::Help { scope, long, query, cursor } = &app.mode else { return };
    let (scope, long, cursor) = (*scope, *long, *cursor);
    let frame_area = frame.area();
    let wide = frame_area.width >= HELP_WIDE_FROM && query.is_none();
    let box_width = frame_area.width.min(if wide { 150 } else { 84 });
    // Two border cells and two padding cells on each side.
    let inner_width = usize::from(box_width.saturating_sub(6));
    let sections = keys::help_sections(app, scope, long, query.as_deref());
    let mut lines = help_layout(&sections, inner_width, wide);
    if let Some(query) = query {
        lines.insert(0, HelpLine { spans: vec![Span::from(" / ").fg(c(BASE)).bg(c(ACCENT)).bold(), Span::from(format!(" {query}▏"))], row: None });
        lines.insert(1, HelpLine { spans: Vec::new(), row: None });
    } else {
        lines.insert(0, HelpLine { spans: vec![Span::from("/ search").fg(c(SUBTEXT0))], row: None });
        lines.insert(1, HelpLine { spans: Vec::new(), row: None });
    }
    if let Some(under) = keys::help_under_line(app, scope) {
        lines.push(HelpLine { spans: Vec::new(), row: None });
        lines.push(HelpLine { spans: vec![Span::from(truncate(&under, inner_width)).fg(c(SUBTEXT0))], row: None });
    }
    let total = lines.len();
    let runnable = lines.iter().filter(|l| l.row.is_some()).count();

    let height = u16::try_from(total + 2).unwrap_or(u16::MAX).min(frame_area.height);
    let area = centered(frame_area, box_width, height);
    frame.render_widget(Clear, area);

    let viewport = usize::from(height.saturating_sub(2));
    let max = total.saturating_sub(viewport);
    // The cursor's line stays in view; otherwise the scroll is where the keys left it.
    let mut start = usize::from(app.help_scroll.get()).min(max);
    if cursor == 0 {
        start = 0;
    } else if let Some(at) = lines.iter().position(|l| l.row == Some(cursor)) {
        if at < start {
            start = at;
        } else if viewport > 0 && at >= start + viewport {
            start = at + 1 - viewport;
        }
    }
    app.help_scroll.set(u16::try_from(start).unwrap_or(u16::MAX));
    app.help_max.set(u16::try_from(max).unwrap_or(u16::MAX));
    app.help_viewport.set(u16::try_from(viewport).unwrap_or(u16::MAX));

    let seen = (start + viewport).min(total);
    let bottom = format!(" enter runs · esc closes · ? {} · {seen}/{total} ", if long { "short form" } else { "long form" });
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c(ACCENT)))
        .padding(Padding::horizontal(2))
        .title(Line::from(keys::help_title(app, scope)).bold())
        .title_bottom(Line::from(bottom).fg(c(SUBTEXT0)));
    let visible: Vec<Line> = lines
        .into_iter()
        .skip(start)
        .take(viewport)
        .map(|l| {
            let line = Line::from(l.spans);
            if l.row == Some(cursor) && runnable > 0 { line.style(selection_style()) } else { line }
        })
        .collect();
    frame.render_widget(Paragraph::new(visible).block(block), area);
}

/// The sections stacked, or split over two columns at the group boundary that balances them.
fn help_layout(sections: &[Vec<HelpRow>], inner_width: usize, two_columns: bool) -> Vec<HelpLine> {
    let mut row = 0;
    if !two_columns || sections.len() < 2 {
        let rendered: Vec<Vec<HelpLine>> = sections.iter().map(|s| help_section_lines(s, inner_width, &mut row)).collect();
        return join_help_sections(rendered);
    }
    let col = inner_width.saturating_sub(HELP_COLUMN_GAP) / 2;
    let rendered: Vec<Vec<HelpLine>> = sections.iter().map(|s| help_section_lines(s, col, &mut row)).collect();
    let height = |part: &[Vec<HelpLine>]| part.iter().map(Vec::len).sum::<usize>() + part.len().saturating_sub(1);
    let split = (1..rendered.len()).min_by_key(|k| height(&rendered[..*k]).max(height(&rendered[*k..]))).unwrap_or(1);
    let mut rendered = rendered.into_iter();
    let left: Vec<Vec<HelpLine>> = rendered.by_ref().take(split).collect();
    let right: Vec<Vec<HelpLine>> = rendered.collect();
    let left = join_help_sections(left);
    let right = join_help_sections(right);
    let mut left = left.into_iter();
    let mut right = right.into_iter();
    let mut out = Vec::new();
    loop {
        let (l, r) = (left.next(), right.next());
        if l.is_none() && r.is_none() {
            break;
        }
        let mut spans = Vec::new();
        let mut row = None;
        let mut used = 0;
        if let Some(l) = l {
            used = l.spans.iter().map(Span::width).sum::<usize>();
            spans.extend(l.spans);
            row = l.row;
        }
        if let Some(r) = r {
            spans.push(Span::raw(" ".repeat(col.saturating_sub(used) + HELP_COLUMN_GAP)));
            spans.extend(r.spans);
            // A line holding two key rows answers to the left one; the right one is reached
            // through its own line in the cursor order (left column first).
            row = row.or(r.row);
        }
        out.push(HelpLine { spans, row });
    }
    out
}

fn join_help_sections(sections: Vec<Vec<HelpLine>>) -> Vec<HelpLine> {
    let mut out = Vec::new();
    for (i, lines) in sections.into_iter().enumerate() {
        if i > 0 {
            out.push(HelpLine { spans: Vec::new(), row: None });
        }
        out.extend(lines);
    }
    out
}

/// One group: its heading, then `key  label` rows (dim `key  (reason)` for an off key, `in
/// Pulls` after a search hit from another view), or its strip. `row` numbers the key rows.
fn help_section_lines(section: &[HelpRow], width: usize, row: &mut usize) -> Vec<HelpLine> {
    let key_width = section
        .iter()
        .filter_map(|r| match r {
            HelpRow::Key { binding, .. } => Some(binding.keys.chars().count()),
            _ => None,
        })
        .max()
        .unwrap_or(0)
        + 2;
    let mut lines = Vec::new();
    for item in section {
        match item {
            HelpRow::Heading(heading) => lines.push(HelpLine { spans: vec![Span::from(*heading).fg(c(SUBTEXT0)).bold()], row: None }),
            HelpRow::Strip(strip) => lines.push(HelpLine { spans: vec![Span::from(truncate(strip, width)).fg(c(ACCENT)).bold()], row: None }),
            HelpRow::Key { binding, avail, foreign } => {
                let room = width.saturating_sub(key_width).max(1);
                let (key, text) = match avail {
                    Avail::Off(why) => (
                        Span::from(format!("{:<key_width$}", binding.keys)).fg(c(MUTED)),
                        Span::from(truncate(&format!("({why})"), room)).fg(c(MUTED)),
                    ),
                    _ => (Span::from(format!("{:<key_width$}", binding.keys)).fg(c(ACCENT)).bold(), Span::from(truncate(binding.label, room))),
                };
                let mut spans = vec![key, text];
                if *foreign {
                    spans.push(Span::from(format!("  in {}", binding.scope.name())).fg(c(SUBTEXT0)));
                }
                lines.push(HelpLine { spans, row: Some(*row) });
                *row += 1;
            }
        }
    }
    lines
}

/// A `width` x `height` rectangle centred in `area`.
pub(crate) fn centered(area: Rect, width: u16, height: u16) -> Rect {
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

    fn find(text: &str, needle: &str) -> Option<(usize, usize)> {
        text.lines().enumerate().find_map(|(row, line)| line.find(needle).map(|col| (row, col)))
    }

    pub(super) fn floor() -> FloorState {
        let json = r#"{"since":"2026-10-16T00:00:00.000Z","until":"2026-10-23T00:00:00.000Z",
          "tasks":{"created":9,"closed":6,"open":3,"waitingOnYou":1,"running":1,"queued":0},
          "cycleTimeMs":{"task":{"median":5400000,"p90":null},"perStage":{
            "verifying":{"median":90000,"p90":120000,"runs":7},
            "implementing":{"median":null,"p90":null,"runs":0}}},
          "firstPassRate":{"verifying":0.83,"ci_watch":null,"implementing":0.5},
          "escalations":{"rate":0.25,"topReasons":[{"reason":"a very long escalation reason that cannot fit","count":2}]},
          "retries":{"perTask":{"median":1,"p90":3},"byLoop":{"verify":2,"e2e":0,"ci":1}},
          "cost":{"totalUsd":12.5,"perTaskUsd":{"median":1.234,"p90":null},"byStage":{"verifying":2.5,"shipping":0.4}},
          "queue":{"depth":2,"slots":{"max":4,"active":1},"utilisation":null},
          "gates":{"withinSla":0.75,"answered":8,"waitMs":{"awaiting_approval":{"median":1800000,"p90":5400000},"awaiting_ship":{"median":null,"p90":null}}}}"#;
        let m: Metrics = serde_json::from_str(json).unwrap();
        FloorState { d7: Some(m.clone()), d30: Some(m), ..FloorState::default() }
    }

    fn repos() -> Vec<crate::model::RepoMetrics> {
        serde_json::from_str(
            r#"[{"repo":"/r/alpha","tasks":{"created":4,"closed":3,"open":1,"waitingOnYou":1,"running":0,"queued":0},
                 "escalationRate":0.6,"firstPassVerifying":0.5,"costUsd":9.5},
                {"repo":"/r/beta","tasks":{"created":5,"closed":3,"open":2,"waitingOnYou":0,"running":1,"queued":0},
                 "escalationRate":0,"firstPassVerifying":1,"costUsd":3},
                {"repo":null,"tasks":{"created":0,"closed":0,"open":0,"waitingOnYou":0,"running":0,"queued":0},
                 "escalationRate":null,"firstPassVerifying":null,"costUsd":0}]"#,
        )
        .unwrap()
    }

    #[test]
    fn floor_lists_every_repo_with_its_own_numbers_and_marks_the_focused_one() {
        let mut state = floor();
        state.repos = repos();
        let text = render(140, 36, &state);
        assert!(text.contains("repo"), "{text}");
        let alpha = text.lines().find(|l| l.contains("alpha")).unwrap_or_default().to_string();
        assert!(alpha.contains("3") && alpha.contains("60%") && alpha.contains("50%") && alpha.contains("$9.50"), "{alpha}");
        assert!(text.lines().any(|l| l.contains("(none)")), "{text}");
        assert!(text.contains("▌ all"), "{text}");

        state.cursor = 1;
        let text = render(140, 36, &state);
        assert!(text.contains("▌ alpha"), "{text}");
        assert!(text.contains("Floor · alpha ·"), "{text}");
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
        let status_line = |row: usize| text.lines().nth(row + 2).unwrap_or("").to_string();
        assert!(status_line(row3).contains('$'), "the expensive card is marked: {text}");
        assert!(!status_line(row0).contains('$'), "a cheap card is not: {text}");
    }

    #[test]
    fn a_card_leads_with_its_title_and_names_its_repo_on_the_second_line() {
        const TASK: &str = r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/Developer/projects/luna-tui","branch":null,"worktreePath":null,"state":"draft","column":"Intake",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#;
        let task: Task = serde_json::from_str(TASK).unwrap();
        let lines: Vec<String> = card_lines(&task, None, false, false, Density::Cozy, 40).iter().map(|l| l.to_string()).collect();
        assert_eq!(lines[0], "▌Login page", "a repo bar, then the title, nothing else in the way");
        assert_eq!(lines[1], "  #abcdef12 · luna-tui");
        assert!(lines[2].contains("○ intake · "), "{}", lines[2]);
        assert_eq!(lines.len(), 3);
        let mut bare = task.clone();
        bare.repo_path = None;
        let lines: Vec<String> = card_lines(&bare, None, false, false, Density::Cozy, 40).iter().map(|l| l.to_string()).collect();
        assert_eq!(lines[0], "Login page");
        assert_eq!(lines[1], "  #abcdef12");
        assert!(lines[2].contains("no repo"), "{}", lines[2]);
        let compact: Vec<String> = card_lines(&task, None, true, false, Density::Compact, 24).iter().map(|l| l.to_string()).collect();
        assert_eq!(compact.len(), 1);
        assert!(compact[0].starts_with("◆ ○ Login page "), "{}", compact[0]);
        let long: Vec<String> = card_lines(&task, None, false, false, Density::Compact, 12).iter().map(|l| l.to_string()).collect();
        assert!(long[0].contains('…') && long[0].chars().count() <= 12, "the title is cut to the width: {}", long[0]);
    }

    #[test]
    fn glyphs_tell_waiting_on_you_from_waiting_on_the_window_from_stale() {
        assert_eq!(look_glyph(Look::NeedsYou), "⏸");
        assert_eq!(look_glyph(Look::Paused), "⏳");
        assert_eq!(look_glyph(Look::Stale), "⌛");
    }

    #[test]
    fn a_comfortable_card_s_fourth_line_is_the_triad_when_the_task_has_one() {
        const TASK: &str = r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/app","branch":null,"worktreePath":null,"state":"implementing","column":"Build",
            "waitingOnYou":false,"running":true,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":1},"resumeTo":null,"reason":null,
            "workedMs":240000,"diff":{"added":142,"removed":18},"tests":{"passed":7,"total":9},
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#;
        let task: Task = serde_json::from_str(TASK).unwrap();
        let lines: Vec<String> = card_lines(&task, None, false, false, Density::Comfortable, 60).iter().map(|l| l.to_string()).collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[3].contains("worked 4m · +142 −18 · tests 7/9"), "{lines:?}");
        assert!(lines[2].contains("implementing · "), "the status line keeps the stage and age: {lines:?}");
        let mut bare = task.clone();
        bare.worked_ms = None;
        bare.diff = None;
        bare.tests = None;
        let lines: Vec<String> = card_lines(&bare, None, false, false, Density::Comfortable, 60).iter().map(|l| l.to_string()).collect();
        assert_eq!(lines[3].trim(), "", "no numbers, no line: {lines:?}");
        assert_eq!(card_lines(&task, None, false, false, Density::Cozy, 60).len(), 3, "cozy drops the triad");
    }

    #[test]
    fn ordering_by_repo_names_each_group_and_keeps_the_selection_on_its_card() {
        let mut app = App::new(crate::Machine::from_env());
        for (i, repo) in ["/r/notch", "/r/luna-tui", "/r/notch"].iter().enumerate() {
            let task: Task = serde_json::from_str(&format!(
                r#"{{"id":"{i}{i}{i}{i}{i}{i}{i}{i}0000","title":"Ticket {i}","description":"","criteria":[],
                "repoPath":"{repo}","branch":null,"worktreePath":null,"state":"draft","column":"Intake",
                "waitingOnYou":false,"running":false,"queued":false,
                "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
                "createdAt":"2026-10-2{i}T10:00:00.000Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
            ))
            .unwrap();
            app.tasks.push(task);
        }
        app.group = GroupBy::Repo;
        app.selection[0] = 2;
        let mut terminal = Terminal::new(TestBackend::new(60, 24)).unwrap();
        terminal.draw(|f| render_column(f, f.area(), &app, 0, true)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let rows: Vec<String> = (0..24).map(|y| (0..60).map(|x| buffer[(x, y)].symbol().to_string()).collect()).collect();
        let text = rows.join("\n");
        assert!(text.contains("── luna-tui 1 ──"), "{text}");
        assert!(text.contains("── notch 2 ──"), "{text}");
        let luna = rows.iter().position(|r| r.contains("── luna-tui")).unwrap();
        let notch = rows.iter().position(|r| r.contains("── notch")).unwrap();
        assert!(luna < notch, "groups in name order: {text}");
        let selected = rows.iter().find(|r| r.contains("▌ ")).expect("a highlighted row");
        assert!(selected.contains("Ticket"), "the highlight sits on a card, not a separator: {selected}");
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
    fn a_marked_card_wears_a_diamond_and_the_header_counts_the_marks() {
        let mut app = App::new(crate::Machine::from_env());
        let task: Task = serde_json::from_str(
            r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/app","branch":null,"worktreePath":null,"state":"draft","column":"Intake",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#,
        )
        .unwrap();
        app.tasks.push(task.clone());
        assert!(!card_head(&task, false, false).to_string().contains('◆'));
        assert!(card_head(&task, true, false).to_string().contains('◆'));
        app.marked.insert(task.id.clone());
        app.online = true;
        let text: String = header_line(&app).spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("1 marked"), "{text}");
    }

    #[test]
    fn the_header_shows_running_over_slots_and_a_draining_chip() {
        let mut app = App::new(crate::Machine::from_env());
        app.online = true;
        let text = |app: &App| header_line(app).spans.iter().map(|s| s.content.to_string()).collect::<String>();
        assert!(text(&app).contains("0 running"), "{}", text(&app));
        app.slots = Some(crate::model::Slots { max: 4, active: 3, draining: false });
        assert!(text(&app).contains("0/4 running"), "{}", text(&app));
        assert!(!text(&app).contains("DRAINING"));
        app.slots = Some(crate::model::Slots { max: 4, active: 3, draining: true });
        assert!(text(&app).contains("[DRAINING]"), "{}", text(&app));
    }

    #[test]
    fn a_card_that_changed_since_the_board_was_last_open_wears_a_dot() {
        let task: Task = serde_json::from_str(
            r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/luna-tui","branch":null,"worktreePath":null,"state":"escalated","column":"Build",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":"deliver failed",
            "createdAt":"2026-10-22T20:00:00.000Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#,
        )
        .unwrap();
        assert!(card_head(&task, false, true).to_string().contains('•'));
        assert!(!card_head(&task, false, false).to_string().contains('•'));
    }

    #[test]
    fn the_digest_groups_what_changed_newest_first() {
        let mut app = App::new(crate::Machine::from_env());
        app.last_seen_secs = crate::model::unix_secs("2026-10-22T21:00:00Z");
        let task: Task = serde_json::from_str(
            r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/luna-tui","branch":null,"worktreePath":null,"state":"escalated","column":"Build",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":"deliver failed",
            "createdAt":"2026-10-22T20:00:00.000Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#,
        )
        .unwrap();
        app.tasks.push(task);
        app.digest = Some(DigestState::default());
        let mut terminal = Terminal::new(TestBackend::new(120, 12)).unwrap();
        terminal.draw(|f| render_digest(f, f.area(), &app, app.digest.as_ref().unwrap())).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text = (0..12).map(|y| (0..120).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("Escalated"), "{text}");
        assert!(text.contains("luna-tui · Login page"), "{text}");
        assert!(text.contains("deliver failed"), "{text}");
        assert_eq!(age_secs(7200), "2h");
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
    fn the_floor_lists_the_gates_answered_within_sla_and_the_wait_per_gate() {
        let text = render(80, 24, &floor());
        assert!(text.contains("Gates answered · within SLA"), "{text}");
        assert!(text.contains("8 · 75%"), "{text}");
        assert!(text.contains("wait approval median") && text.contains("30m"), "{text}");
        assert!(text.contains("wait ship median"), "a gate with no median still has its row: {text}");
    }

    #[test]
    fn an_overdue_ticket_s_card_leads_with_a_red_bang_names_its_issue_and_a_warning_stage_turns_the_age_yellow() {
        let task: Task = serde_json::from_str(&crate::model::tests::jira_task_json()).unwrap();
        let lines = card_lines(&task, None, false, false, Density::Cozy, 60);
        let text: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        assert!(text[0].contains("‼ Login page"), "{}", text[0]);
        let bang = lines[0].spans.iter().find(|s| s.content.contains('‼')).unwrap();
        assert_eq!(bang.style.fg, Some(c(RED)));
        assert!(bang.style.add_modifier.contains(Modifier::BOLD));
        let title = lines[0].spans.iter().find(|s| s.content == "Login page").unwrap();
        assert_eq!(title.style.fg, Some(c(RED)), "the head line is red");
        assert_eq!(text[1], "  #abcdef12 · PLAT-123");
        let age = lines[2].spans.iter().find(|s| s.content.starts_with(" · ")).unwrap();
        assert_eq!(age.style.fg, Some(c(RED)), "an overdue card's age is red too");
        let compact = card_lines(&task, None, false, false, Density::Compact, 40);
        assert!(compact[0].to_string().starts_with("‼ "), "{}", compact[0]);

        let mut warn = task.clone();
        warn.sla.as_mut().unwrap().gate = None;
        let lines = card_lines(&warn, None, false, false, Density::Cozy, 60);
        assert!(!lines[0].to_string().contains('‼'), "no clock past: no bang");
        let age = lines[2].spans.iter().find(|s| s.content.starts_with(" · ")).unwrap();
        assert_eq!(age.style.fg, Some(c(YELLOW)), "the stage past 80% turns the age yellow");
        let mut unlinked = warn.clone();
        unlinked.jira = None;
        assert_eq!(card_lines(&unlinked, None, false, false, Density::Cozy, 60)[1].to_string(), "  #abcdef12");
    }

    #[test]
    fn the_header_counts_the_overdue_tickets_with_a_red_bang() {
        let mut app = App::new(crate::Machine::from_env());
        app.online = true;
        let task: Task = serde_json::from_str(&crate::model::tests::jira_task_json()).unwrap();
        app.tasks.push(task);
        let line = header_line(&app);
        let text: String = line.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("‼ 1 overdue"), "{text}");
        assert_eq!(line.spans.iter().find(|s| s.content.contains('‼')).unwrap().style.fg, Some(c(RED)));
        app.tasks[0].sla = None;
        let text: String = header_line(&app).spans.iter().map(|s| s.content.to_string()).collect();
        assert!(!text.contains('‼'), "no count at zero: {text}");
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
}

#[cfg(test)]
mod pr_tests {
    use ratatui::{Terminal, backend::TestBackend};

    use super::*;
    use crate::client::Machine;
    use crate::model::{PrSnapshot, PullRequest};

    fn pr(number: u64, title: &str, split: &str, checks: &str, local: bool, task: bool) -> PullRequest {
        let local = if local { "\"/r/app\"" } else { "null" };
        let task = if task { r#"{"id":"t1","state":"ci_watch","route":"ci_fix"}"# } else { "null" };
        let failed = if checks == "failure" { r#"[{"name":"lint","state":"FAILURE","url":null}]"# } else { "[]" };
        serde_json::from_str(&format!(
            r#"{{"repo":"acme/app","number":{number},"title":"{title}","url":"u","author":"them","mine":false,"reviewRequested":true,
            "isDraft":false,"headRef":"h","baseRef":"main","fromFork":false,"reviewDecision":"APPROVED","mergeable":"MERGEABLE",
            "checks":{{"state":"{checks}","passed":2,"total":3,"failed":{failed}}},"unresolvedThreads":2,"split":"{split}",
            "localPath":{local},"task":{task},"updatedAt":"2026-10-27T09:00:00Z"}}"#
        ))
        .unwrap()
    }

    fn app_with(prs: Vec<PullRequest>) -> App {
        let mut app = App::new(Machine::from_env());
        app.tasks.clear();
        app.prs = PrSnapshot { prs, polled_at: Some("2026-10-27T10:00:00Z".to_string()), error: None };
        app.pulls = Some(PullsState::default());
        app.online = true;
        app.toast = None;
        app
    }

    fn render(width: u16, height: u16, app: &App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| draw(f, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_header_counts_every_split_and_a_row_shows_checks_review_threads_and_its_tag() {
        let app = app_with(vec![
            pr(12, "Export CSV", "review_requested", "failure", true, false),
            pr(13, "A very long pull request title that will not fit in a narrow terminal at all", "review_requested", "pending", false, false),
            pr(14, "Ready one", "ready_to_merge", "success", true, true),
        ]);
        let text = render(120, 20, &app);
        assert!(text.contains("Review requested 2"), "{text}");
        assert!(text.contains("Ready to merge 1"), "{text}");
        assert!(text.contains("polled"), "{text}");
        let row = text.lines().find(|l| l.contains("#12") && l.contains("Export CSV")).unwrap_or_default().to_string();
        assert!(row.starts_with("│▌ ✗ ▌app "), "selected, red checks, the repo bar then the repo's name without its owner: {row}");
        assert!(!row.contains("@them") && !row.contains("lint"), "author and check names leave the row: {row}");
        let second = text.lines().find(|l| l.contains("#13")).unwrap_or_default().to_string();
        let col = |line: &str, needle: &str| line.find(needle).map(|i| line[..i].chars().count());
        assert_eq!(col(&row, "#12"), col(&second, "#13"), "numbers line up");
        assert_eq!(col(&row, "Export"), col(&second, "A very"), "titles line up");
        assert!(second.contains("…") && second.contains("⌂"), "a long title is cut, no checkout is a tag: {second}");
        let mut ready = app_with(vec![pr(14, "Ready one", "ready_to_merge", "success", true, true)]);
        ready.pulls = Some(PullsState { split: PrSplit::ReadyToMerge, cursor: 0 });
        let third = render(120, 20, &ready).lines().find(|l| l.contains("#14") && l.contains("Ready one")).unwrap_or_default().to_string();
        assert!(third.contains("⚙") && third.contains("✓"), "a running task is a tag: {third}");
        // The detail pane shows the selected PR with the fields the row dropped.
        assert!(text.contains("acme/app#12  Export CSV"), "{text}");
        assert!(text.contains("@them · h → main"), "{text}");
        assert!(text.contains("✗ lint") && text.contains("✗ 1 of 3 failed"), "{text}");
        assert!(text.contains("approved · 2 unresolved threads"), "{text}");
        assert!(text.contains("m ") && text.contains("off: not ready to merge"), "{text}");
        assert!(text.contains("[pulls]"), "{text}");

        let text = render(80, 20, &app);
        assert!(!text.contains("@them"), "no detail pane under 100 columns: {text}");
        let row = text.lines().find(|l| l.contains("#12")).unwrap_or_default().to_string();
        assert!(row.contains("Export CSV") && row.contains("✗"), "{row}");
        assert!(!text.contains("\u{2588}"), "nothing overflows: {text}");
    }

    #[test]
    fn the_list_scrolls_to_keep_the_selected_pr_in_view() {
        let prs: Vec<PullRequest> = (1..=40).map(|n| pr(n, &format!("Pull {n}"), "review_requested", "success", true, false)).collect();
        let mut app = app_with(prs);
        app.pulls = Some(PullsState { split: PrSplit::ReviewRequested, cursor: 30 });
        let text = render(80, 14, &app);
        assert!(text.contains("#31") && text.contains("Pull 31"), "the selected row shows: {text}");
        assert!(!text.contains("#1 ") && !text.contains("#40"), "a window around the cursor, not the top: {text}");
        let mut owner_less = app_with(vec![pr(7, "Bare", "review_requested", "success", true, false)]);
        owner_less.prs.prs[0].repo = "app".into();
        assert!(render(80, 14, &owner_less).contains("▌app "), "a repo without an owner prints whole");
    }

    #[test]
    fn the_header_says_it_is_polling_while_a_poll_runs() {
        let mut app = app_with(vec![pr(14, "Ready one", "ready_to_merge", "success", true, false)]);
        assert!(!render(100, 14, &app).contains("polling GitHub"));
        app.prs_polling = true;
        let text = render(100, 14, &app);
        assert!(text.contains("polling GitHub…") && !text.contains("polled "), "{text}");
    }

    #[test]
    fn the_merge_confirm_the_clone_prompt_and_the_actions_menu_draw_over_the_view() {
        let mut app = app_with(vec![pr(14, "Ready one", "ready_to_merge", "success", true, false)]);
        app.pulls = Some(PullsState { split: PrSplit::ReadyToMerge, cursor: 0 });
        app.mode = Mode::ConfirmMerge { repo: "acme/app".into(), number: 14 };
        assert!(render(100, 14, &app).contains("acme/app#14 is squash-merged"));
        app.mode = Mode::ClonePrompt { repo: "acme/app".into(), query: "proj".into(), all: vec!["/r".into(), "/r/projects".into()], cursor: 0, then: crate::model::PrAction::Review };
        let text = render(100, 20, &app);
        assert!(text.contains("clone acme/app into") && text.contains("/r/projects/app") && !text.contains("▌ /r/app"), "{text}");
        app.mode = Mode::PrActions { cursor: 0 };
        let text = render(100, 30, &app);
        assert!(text.contains("merge: squash, delete the branch") && !text.contains("review is for other people's PRs"), "{text}");
        assert!(text.contains("↳ threads are answered on your own PRs"), "{text}");
        assert!(text.contains("@them · h → main"), "the menu carries the PR widget: {text}");
    }
}

#[cfg(test)]
mod slack_render_tests {
    use ratatui::{Terminal, backend::TestBackend};

    use super::*;
    use crate::client::Machine;
    use crate::model::{SlackMetrics, SlackSnapshot, unix_secs};
    use crate::slack::{WatchesState, fixtures::snapshot};

    fn app_with(snapshot: SlackSnapshot) -> App {
        let mut app = App::new(Machine::from_env());
        app.tasks.clear();
        app.slack_snapshot = snapshot;
        app.slack = Some(SlackState::default());
        app.online = true;
        app.toast = None;
        app
    }

    fn render(width: u16, height: u16, app: &App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| draw(f, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_wide_view_is_a_strip_a_list_and_a_pane_and_the_narrow_one_shortens_the_strip() {
        let mut snapshot = snapshot();
        snapshot.items[0].count = 3;
        let app = app_with(snapshot);
        let text = render(120, 40, &app);
        assert!(text.contains("Needs reply 1") && text.contains("Waiting on them 0") && text.contains("FYI 1") && text.contains("Done 0"), "{text}");
        assert!(text.contains("polled") && text.contains("⚡") && text.contains("live") && text.contains("[slack]"), "{text}");
        let row = text.lines().find(|l| l.contains("approve rollback") && l.contains("@marta")).unwrap_or_default().to_string();
        assert!(row.starts_with("│▌ P0 ▌#payments-oncall"), "selected, the priority, the channel bar then the name: {row}");
        assert!(row.contains("approve rollback ×3") && row.contains("⎇"), "a collapsed thread says how many, a thread wears its tag: {row}");
        assert!(!row.contains("checkout is returning"), "the message text stays in the pane: {row}");
        assert!(text.contains("#payments-oncall · @marta") && text.contains("· thread") && text.contains("(3 replies) · 3 messages"), "{text}");
        assert!(text.contains("@joão  I can run the rollback"), "the context, muted: {text}");
        assert!(text.contains("P0 · blocker · reply expected"), "{text}");
        assert!(text.contains("why      production incident"), "{text}");
        assert!(text.contains("acme/app#212 (ci failed) · INC-4411"), "the linked PR's split and the refs: {text}");
        assert!(text.contains("draft    Approve the rollback"), "{text}");
        assert!(text.contains("r  reply     ready") && text.contains("N  nudge     off: only while waiting on them"), "{text}");
        assert!(text.contains("off: already P0"), "{text}");

        let text = render(80, 30, &app);
        assert!(text.contains("Reply 1") && text.contains("Wait 0") && text.contains("Snz 0"), "short labels under 100 columns: {text}");
        assert!(!text.contains("Waiting on them"), "the strip drops the long labels; the list keeps its title: {text}");
        assert!(!text.contains("· @marta ·"), "no pane under 100 columns: {text}");
        let row = text.lines().find(|l| l.contains("approve rollback")).unwrap_or_default().to_string();
        assert!(row.contains("P0") && row.contains("#payments-oncall") && row.contains("@marta"), "{row}");
        assert!(!text.contains("\u{2588}"), "nothing overflows: {text}");
    }

    #[test]
    fn a_reopened_item_a_socket_outage_and_an_error_all_show() {
        let mut broken = snapshot();
        broken.items[0].reopened_at = Some("2026-10-28T10:00:00Z".into());
        broken.items[0].linked.task_id = Some("abcdef123456".into());
        broken.socket = "disconnected".into();
        broken.error = Some("rate limited".into());
        let app = app_with(broken);
        let text = render(120, 40, &app);
        assert!(text.contains("⚡") && text.contains("socket down") && text.contains("⚠ rate limited"), "{text}");
        assert!(text.contains("new since you cleared it"), "{text}");
        let row = text.lines().find(|l| l.contains("approve rollback")).unwrap_or_default().to_string();
        assert!(row.contains("↺⚙"), "reopened and already a ticket: {row}");
        assert!(text.contains("off: already a ticket") && text.contains("ticket   #abcdef12"), "{text}");
        let mut off = app_with(snapshot());
        off.slack_snapshot.socket = "off".into();
        assert!(!render(120, 40, &off).contains("⚡"), "no socket indicator without an app token");
    }

    #[test]
    fn an_overdue_item_is_red_with_its_tag_leads_its_split_and_is_counted_on_the_strip() {
        let now = unix_secs("2026-10-28T10:00:00Z").unwrap();
        let app = app_with(snapshot());
        let text = render(120, 40, &app);
        assert!(text.contains("‼ 1 overdue"), "the strip counts the overdue Decide item: {text}");
        let row = text.lines().find(|l| l.contains("approve rollback")).unwrap_or_default().to_string();
        assert!(!row.contains('‼'), "the P0 in Needs reply is due, not overdue: {row}");
        assert!(text.contains("due      in") || text.contains("due      overdue"), "the pane says when the reply is due: {text}");

        let mut app = app;
        app.slack.as_mut().unwrap().split = SlackSplit::Decide;
        app.slack.as_mut().unwrap().cursor = 0;
        let text = render(120, 40, &app);
        let row = text.lines().find(|l| l.contains("approve rollback") && l.contains("@marta")).unwrap_or_default().to_string();
        assert!(row.contains("‼⎇"), "the overdue tag leads the thread's: {row}");
        assert!(row.contains("P2 ▌#payments-oncall"), "the priority cell keeps its own text: {row}");
        assert!(text.contains("due      overdue") && text.contains("(P2 · 1h SLA)"), "{text}");

        let items = &app.slack_snapshot.items;
        let late = slack_row(&items[2], false, 110, now);
        let red: Vec<&Span> = late.spans.iter().filter(|s| s.style.fg == Some(c(RED))).collect();
        assert!(red.iter().any(|s| s.content.contains("approve rollback")), "the summary is red: {late:?}");
        assert!(red.iter().any(|s| s.content.contains("2h")), "the age is red: {late:?}");
        assert!(red.iter().any(|s| s.content.contains('‼')), "the tag is red: {late:?}");
        assert!(late.spans.iter().any(|s| s.content.starts_with("P2") && s.style.fg != Some(c(RED))), "the prio cell keeps its colour: {late:?}");
        let soon = slack_row(&items[0], false, 110, now - 180);
        assert!(soon.spans.iter().any(|s| s.content.contains("9m") && s.style.fg == Some(c(YELLOW))), "due in a minute, the age is yellow: {soon:?}");
        let calm = slack_row(&items[0], false, 110, now - 600);
        assert!(calm.spans.iter().any(|s| s.content.contains("2m") && s.style.fg == Some(c(SUBTEXT0))), "eight minutes out it is plain: {calm:?}");
        assert_eq!(slack_tag(&items[0]).chars().count(), 2);
        assert_eq!(slack_tag(&items[2]).chars().count(), 3);

        let lines = slack_detail_lines(&items[0], 600, now - 300);
        let due = lines.iter().find(|l| l.to_string().starts_with("due")).map(|l| l.to_string()).unwrap_or_default();
        assert_eq!(due, "due      due in 3m (P0 · 10m SLA)");
        let lines = slack_detail_lines(&items[2], 3600, now);
        let due = lines.iter().find(|l| l.to_string().starts_with("due")).map(|l| l.to_string()).unwrap_or_default();
        assert_eq!(due, "due      overdue 1h (P2 · 1h SLA)");
        let lines = slack_detail_lines(&items[2], 0, now);
        assert!(lines.iter().any(|l| l.to_string() == "due      overdue 1h (P2)"), "no SLA figure when the machine has none");
        let lines = slack_detail_lines(&items[1], 3600, now);
        assert!(!lines.iter().any(|l| l.to_string().starts_with("due")), "nothing due, no line");

        let mut none = app_with(snapshot());
        none.slack_snapshot.items[2].overdue = false;
        let strip = render(120, 40, &none).lines().next().unwrap_or_default().to_string();
        assert!(!strip.contains('‼'), "no count at zero: {strip}");
    }

    #[test]
    fn the_popups_draw_over_the_view() {
        let mut app = app_with(snapshot());
        app.slack.as_mut().unwrap().watches = Some(WatchesState { cursor: 1 });
        let text = render(120, 40, &app);
        assert!(text.contains(" Watches "), "{text}");
        assert!(text.contains("@platform-team") && text.contains("usergroup") && text.contains("S04ABCD") && text.contains("as mention"), "{text}");
        let here = text.lines().find(|l| l.contains("@here")).unwrap_or_default().to_string();
        assert!(here.contains("› on") && here.contains("broadcast") && here.contains("P2 · built-in"), "{here}");
        assert!(text.contains("n add  e floor  d delete  space on/off  esc"), "{text}");
        app.slack.as_mut().unwrap().watches = None;

        app.mode = Mode::SlackReply { id: "C0123:1730112345.0001".into(), area: TextArea::new(vec!["Approve the rollback, I'm on it.".into()]), vim: crate::vim::Vim::new(), nudge: false };
        let text = render(120, 40, &app);
        assert!(text.contains(" reply · #payments-oncall · thread with @marta "), "{text}");
        assert!(text.contains("ctrl+s send  esc back") && text.contains(" NORMAL "), "{text}");
        assert!(text.contains("─ context ─") && text.contains("@marta   checkout is returning 500s") && text.contains("@joão"), "{text}");
        assert!(text.contains("Approve the rollback, I'm on it."), "{text}");

        app.mode = Mode::SlackSnooze { id: "C0123:1730112345.0001".into(), cursor: 2 };
        let text = render(120, 40, &app);
        assert!(text.contains(" snooze until ") && text.contains("▌ 3  tomorrow 9:00") && text.contains("next Monday 9:00"), "{text}");

        app.mode = Mode::SlackTask { id: "C0123:1730112345.0001".into(), title: "approve rollback".into(), repo: None };
        let text = render(120, 40, &app);
        assert!(text.contains(" ticket from #payments-oncall? ") && text.contains("title  approve rollback") && text.contains("none guessed"), "{text}");

        app.mode = Mode::SlackWatchAdd { query: "@pl".into(), cursor: 0 };
        let text = render(120, 40, &app);
        assert!(text.contains(" add a watch ") && text.contains("@pl▏") && text.contains("a user group") && text.contains("loading…"), "{text}");
        app.mode = Mode::SlackWatchAdd { query: "luna-tui".into(), cursor: 0 };
        assert!(render(120, 40, &app).contains("a keyword"));

        app.mode = Mode::SlackActions { cursor: 0 };
        let text = render(80, 40, &app);
        assert!(text.contains("reply: edit the draft, ctrl+s posts") && text.contains("↳ only while waiting on them"), "{text}");
        assert!(text.contains("checkout is returning 500s since the 14:02"), "the menu carries the item under 100 columns: {text}");
    }

    #[test]
    fn the_floor_gains_a_slack_block_when_the_metrics_came() {
        let metrics: SlackMetrics = serde_json::from_str(
            r#"{"since":"2026-10-21T00:00:00.000Z","items":{"P0":1,"P1":4,"P2":10,"P3":20},"replied":{"P0":1,"P1":3,"P2":2,"P3":0},
            "withinHour":3,"withinSla":{"P0":1,"P1":2,"P2":0,"P3":0},"sla":{"P0":600,"P1":1800,"P2":3600,"P3":3600},
            "timeToReply":{"P0":{"median":600,"p90":600},"P1":{"median":3600,"p90":7200},"P2":{"median":null,"p90":null},"P3":{"median":null,"p90":null}},"byDay":[]}"#,
        )
        .unwrap();
        let mut floor = super::tests::floor();
        floor.slack = Some((metrics.clone(), metrics));
        let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
        terminal.draw(|f| render_floor(f, f.area(), &floor)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text: String = (0..40).map(|y| (0..140).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>() + "\n").collect();
        assert!(text.contains("Slack · 7d / 30d") && text.contains("within SLA") && text.contains("median / p90"), "{text}");
        let p1 = text.lines().find(|l| l.trim_start().starts_with("P1")).unwrap_or_default().to_string();
        assert!(p1.contains("4 / 4") && p1.contains("3 / 3") && p1.contains("2 · 67%") && p1.contains("1h / 2h"), "{p1}");
        let p3 = text.lines().find(|l| l.trim_start().starts_with("P3")).unwrap_or_default().to_string();
        assert!(p3.contains("0 · –"), "nothing replied, no share: {p3}");
        assert!(text.contains("within 1h") && text.contains("50%"), "{text}");
        assert!(text.contains("SLA targets") && text.contains("10m/30m/1h/1h (P0/P1/P2/P3)"), "{text}");
        floor.slack = None;
        terminal.draw(|f| render_floor(f, f.area(), &floor)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text: String = (0..40).map(|y| (0..140).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect();
        assert!(!text.contains("Slack ·"), "nothing without the metrics");
    }
}

#[cfg(test)]
mod help_sheet_tests {
    use ratatui::{
        Terminal,
        backend::TestBackend,
        crossterm::event::{KeyCode, KeyEvent, KeyModifiers},
    };

    use super::*;
    use crate::client::Machine;
    use crate::model::Task;

    fn task(id: &str, state: &str, repo: bool) -> Task {
        let repo = if repo { "\"/r/app\"" } else { "null" };
        let waiting = state.starts_with("awaiting");
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","title":"Login page","description":"","criteria":[],
            "repoPath":{repo},"branch":null,"worktreePath":null,"state":"{state}","column":"Approved",
            "waitingOnYou":{waiting},"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
        ))
        .unwrap()
    }

    fn app_with(state: &str, repo: bool) -> App {
        let mut app = App::new(Machine::from_env());
        app.tasks = vec![task("a1b2c3d4e5f6", state, repo)];
        app.focus = app.tasks[0].column_index();
        app.toast = None;
        app
    }

    /// The whole app, as the user sees it.
    fn screen(app: &App, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| draw(f, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect()).collect()
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    fn footer(app: &App) -> String {
        footer_line(app).spans.iter().map(|s| s.content.to_string()).collect()
    }

    #[test]
    fn the_sheet_names_the_ticket_and_its_state_and_dims_what_does_not_apply() {
        let mut app = app_with("awaiting_approval", true);
        press(&mut app, KeyCode::Char('?'));
        press(&mut app, KeyCode::Char('?'));
        let text = screen(&app, 120, 40).join("\n");
        assert!(text.contains(" Keys · ticket #a1b2c3d4 Login page · approve plan "), "{text}");
        assert!(text.contains("/ search"), "{text}");
        assert!(text.contains("a         approve the plan") || text.contains("a    approve the plan"), "the gate's a, bright: {text}");
        assert!(text.contains("(not at the ship gate)"), "x S dim with its reason: {text}");
        assert!(text.contains("(no memory review waiting)"), "{text}");
        assert!(!text.contains("approve the setup") && !text.contains("a    start"), "the other a meanings are hidden: {text}");
        assert!(text.contains("h l  j k  gg  G  1-8  ] [  enter"), "Move folds to a strip: {text}");
        assert!(text.contains("enter runs · esc closes · ? long form"), "{text}");
        for heading in ["Gate", "Ticket", "Move", "Filter & order", "Views", "Marks & bulk", "App", "Commands (type after :)"] {
            assert!(text.contains(heading), "heading {heading}: {text}");
        }
        press(&mut app, KeyCode::Char('?'));
        let long = screen(&app, 120, 50).join("\n");
        assert!(long.contains("previous / next column") && !long.contains("h l  j k"), "the long form has rows: {long}");
        assert!(long.contains("? short form"), "{long}");
    }

    #[test]
    fn the_sheet_is_two_columns_from_100_and_one_below_and_the_popup_folds_the_board() {
        let mut app = app_with("draft", false);
        press(&mut app, KeyCode::Char('?'));
        press(&mut app, KeyCode::Char('?'));
        let wide = screen(&app, 120, 50);
        let col = |rows: &[String], needle: &str| rows.iter().find_map(|r| r.find(needle).map(|i| r[..i].chars().count()));
        assert!(col(&wide, "Gate").unwrap() + 20 < col(&wide, "Commands (type after :)").unwrap(), "Commands sits in the right column: {}", wide.join("\n"));
        let narrow = screen(&app, 90, 60);
        assert_eq!(col(&narrow, "Gate"), col(&narrow, "Commands (type after :)"), "one column under 100: {}", narrow.join("\n"));
        assert!(narrow.join("\n").contains(" Keys · ticket #a1b2c3d4 Login page · intake "));
        press(&mut app, KeyCode::Esc);
        app.mode = Mode::Detail("a1b2c3d4e5f6".into());
        press(&mut app, KeyCode::Char('?'));
        let text = screen(&app, 120, 50).join("\n");
        assert!(text.contains("▸ board keys: "), "the layer under the popup folds to one line: {text}");
        assert!(text.contains("S         (not at the ship gate)") || text.contains("(not at the ship gate)"), "{text}");
    }

    #[test]
    fn search_lists_other_views_keys_with_where_they_live() {
        let mut app = app_with("draft", true);
        press(&mut app, KeyCode::Char('?'));
        press(&mut app, KeyCode::Char('/'));
        for ch in "poll".chars() {
            press(&mut app, KeyCode::Char(ch));
        }
        let text = screen(&app, 120, 40).join("\n");
        assert!(text.contains(" poll▏"), "{text}");
        assert!(text.contains("poll GitHub now") && text.contains("in Pulls"), "{text}");
        assert!(text.contains("poll Slack now") && text.contains("in Slack"), "{text}");
        assert!(!text.contains("Commands (type after :)"), "a search is one flat section: {text}");
    }

    #[test]
    fn the_cursor_stays_in_view_and_the_footer_counts_rows() {
        let mut app = app_with("awaiting_approval", true);
        press(&mut app, KeyCode::Char('?'));
        press(&mut app, KeyCode::Char('?'));
        let top = screen(&app, 80, 24);
        assert!(top[23].contains("22/"), "{}", top[23]);
        for _ in 0..500 {
            press(&mut app, KeyCode::Char('j'));
        }
        let last = screen(&app, 80, 24);
        assert_ne!(last, top);
        assert!(last.join("\n").contains(":help"), "the last rows show: {}", last.join("\n"));
        let total = last[23].split('/').next_back().and_then(|t| t.split_whitespace().next()).and_then(|n| n.parse::<usize>().ok()).unwrap();
        assert!(last[23].contains(&format!("{total}/{total}")), "{}", last[23]);
        for _ in 0..500 {
            press(&mut app, KeyCode::Char('k'));
        }
        assert_eq!(screen(&app, 80, 24), top, "back at the top");
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(screen(&app, 80, 24)[1..23], top[1..23], "two rows down still fits the first page");
        app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL));
        assert!(matches!(app.mode, Mode::Help { .. }));
    }

    #[test]
    fn growing_the_terminal_pulls_a_scrolled_sheet_back_to_the_top() {
        let mut app = app_with("awaiting_approval", true);
        press(&mut app, KeyCode::Char('?'));
        press(&mut app, KeyCode::Char('?'));
        let top = screen(&app, 80, 24);
        for _ in 0..30 {
            press(&mut app, KeyCode::Char('j'));
        }
        assert_ne!(screen(&app, 80, 24), top, "scrolled at 80x24");
        let wide = screen(&app, 200, 60).join("\n");
        assert!(wide.contains("Commands (type after :)") && wide.contains("Gate"), "everything fits at 200x60: {wide}");
        for _ in 0..40 {
            press(&mut app, KeyCode::Char('k'));
        }
        assert_eq!(screen(&app, 80, 24), top, "back at 80x24 the sheet starts at the top again");
    }

    #[test]
    fn every_view_draws_its_sheet_at_any_size_without_panicking() {
        for (w, h) in [(1, 1), (6, 3), (10, 4), (20, 6), (80, 24), (120, 40), (200, 50)] {
            let mut app = app_with("awaiting_ship", true);
            press(&mut app, KeyCode::Char('?'));
            assert_eq!(screen(&app, w, h).len(), usize::from(h));
            press(&mut app, KeyCode::Esc);
            type Toggle = fn(&mut App);
            let views: [(Toggle, Toggle); 6] = [
                (|a| a.floor = Some(FloorState::default()), |a| a.floor = None),
                (|a| a.inbox = Some(InboxState::default()), |a| a.inbox = None),
                (|a| a.digest = Some(DigestState::default()), |a| a.digest = None),
                (|a| a.pulls = Some(PullsState::default()), |a| a.pulls = None),
                (|a| a.slack = Some(SlackState::default()), |a| a.slack = None),
                (|a| a.slack = Some(SlackState { watches: Some(Default::default()), ..Default::default() }), |a| a.slack = None),
            ];
            for (open, close) in views {
                open(&mut app);
                press(&mut app, KeyCode::Char('?'));
                assert!(matches!(app.mode, Mode::Help { .. }));
                for _ in 0..3 {
                    press(&mut app, KeyCode::Char('j'));
                    assert_eq!(screen(&app, w, h).len(), usize::from(h));
                }
                press(&mut app, KeyCode::Esc);
                assert!(matches!(app.mode, Mode::Normal));
                close(&mut app);
            }
            app.mode = Mode::Detail("a1b2c3d4e5f6".to_string());
            press(&mut app, KeyCode::Char('?'));
            assert_eq!(screen(&app, w, h).len(), usize::from(h));
            press(&mut app, KeyCode::Esc);
            assert!(matches!(&app.mode, Mode::Detail(id) if id == "a1b2c3d4e5f6"));
        }
    }

    #[test]
    fn floor_and_digest_stay_open_after_closing_help_and_the_sheet_draws_over_them() {
        let mut app = App::new(Machine::from_env());
        app.floor = Some(FloorState::default());
        press(&mut app, KeyCode::Char('?'));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Floor, .. }));
        let text = screen(&app, 120, 40).join("\n");
        assert!(text.contains(" Keys · Floor ") && text.contains("refresh the numbers"), "a small group reads as rows: {text}");
        press(&mut app, KeyCode::Esc);
        assert!(app.floor.is_some() && matches!(app.mode, Mode::Normal));
        app.floor = None;

        app.digest = Some(DigestState::default());
        press(&mut app, KeyCode::Char('?'));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Digest, .. }));
        assert!(screen(&app, 120, 40).join("\n").contains(" Keys · Digest "));
        press(&mut app, KeyCode::Esc);
        assert!(app.digest.is_some() && matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn the_footer_is_a_few_short_words_per_view() {
        let board = footer(&app_with("awaiting_approval", true));
        assert!(board.starts_with("  ?  help   n  new   a  advance   enter  open   x  actions   =  density   /  filter   q  quit"), "{board}");
        let mut pulls = App::new(Machine::from_env());
        pulls.pulls = Some(PullsState::default());
        pulls.toast = None;
        let line = footer(&pulls);
        assert!(line.contains(" m  merge ") && line.contains(" c/v/t  CI fix / review / threads ") && line.contains(" R  poll "), "{line}");
        let mut floor = App::new(Machine::from_env());
        floor.floor = Some(FloorState::default());
        floor.toast = None;
        assert!(footer(&floor).contains(" r  refresh "), "{}", footer(&floor));
        let mut help = app_with("draft", true);
        press(&mut help, KeyCode::Char('?'));
        let line = footer(&help);
        assert!(line.contains(" enter  run the row's key ") && line.contains(" /  search every view's keys "), "{line}");
    }

    #[test]
    fn the_which_key_strip_replaces_the_footer_after_the_delay() {
        let mut app = app_with("draft", true);
        press(&mut app, KeyCode::Char('g'));
        assert!(!footer(&app).contains("▸"), "{}", footer(&app));
        app.age_prefix();
        let line = footer(&app);
        assert!(line.starts_with(" g ▸ "), "{line}");
        assert!(line.contains(" g first ticket in the column") && line.contains(" s order columns by stage") && line.ends_with("esc"), "{line}");
        press(&mut app, KeyCode::Char('s'));
        press(&mut app, KeyCode::Char('z'));
        app.age_prefix();
        assert!(footer(&app).contains(" c fold the focused column"), "{}", footer(&app));
    }

    #[test]
    fn the_editors_title_carries_the_mode_key_line() {
        let mut app = app_with("draft", true);
        press(&mut app, KeyCode::Char('e'));
        assert!(matches!(app.mode, Mode::EditTicket { .. }));
        let text = screen(&app, 140, 40).join("\n");
        assert!(text.contains("· normal · i a o insert · dd x delete · u ^r undo · ctrl+s save · esc q cancel"), "{text}");
        press(&mut app, KeyCode::Char('i'));
        let text = screen(&app, 140, 40).join("\n");
        assert!(text.contains("· insert · esc normal · ctrl+s save") && !text.contains("dd x delete"), "{text}");
        let line = footer(&app);
        assert!(line.contains(" esc  normal ") && line.contains(" ctrl+s  save "), "{line}");
    }

    #[test]
    fn the_colon_prompt_lists_completions_and_the_picked_one_is_marked() {
        let mut app = app_with("draft", true);
        press(&mut app, KeyCode::Char(':'));
        press(&mut app, KeyCode::Char('f'));
        let text = screen(&app, 100, 24).join("\n");
        assert!(text.contains(":filter") && text.contains(":fold") && text.contains(":floor"), "{text}");
        assert!(text.contains("filter: title, #id or repo (bare clears)"), "{text}");
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Tab);
        let text = screen(&app, 100, 24).join("\n");
        assert!(text.contains("▌ :fold"), "{text}");
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Char(':'));
        let text = screen(&app, 100, 24);
        let listed = text.iter().filter(|r| r.contains("   :")).count();
        assert!(listed <= 7 && text.join("\n").contains("more"), "six at most, then a count: {}", text.join("\n"));
    }

    #[test]
    fn the_ticket_menu_lists_the_registry_rows_dim_with_reasons() {
        let mut app = app_with("awaiting_approval", true);
        press(&mut app, KeyCode::Char('x'));
        let text = screen(&app, 100, 40).join("\n");
        assert!(text.contains(" #a1b2c3d4 Login page "), "{text}");
        assert!(text.contains("P   resume every ticket paused on the limit"), "{text}");
        assert!(text.contains("S   ship: approve and open the PR") && text.contains("↳ not at the ship gate"), "{text}");
        assert!(text.contains("a   approve the plan") && text.contains("R   set the repo"), "{text}");
        assert!(text.contains("↳ has a repo; x or :repo <name> replaces it"), "{text}");
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::Normal), "a menu key runs and closes");
    }
}
