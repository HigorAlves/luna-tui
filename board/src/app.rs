//! Board state and everything that changes it: keys, machine calls and the event stream.
//! The machine owns the tickets; the board shows them and sends your decisions.

use std::{
    cell::{Cell, RefCell},
    env, fs, io,
    process::Command,
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

use ratatui::{
    DefaultTerminal,
    crossterm::{
        event::{DisableMouseCapture, EnableMouseCapture, KeyCode, KeyEvent},
        execute,
    },
    layout::Rect,
};
use tui_textarea::TextArea;

use crate::{
    client::{Incoming, Machine, spawn_stream},
    discover::{discover_repos, repos_root},
    herdr,
    model::{
        COLUMNS, Look, StreamMessage, Task, TaskDetail, TicketText, answers_markdown, parse_answers,
        parse_ticket, questions_of, ticket_markdown,
    },
    store,
    vim::Vim,
};

const INFO_TOAST_FOR: Duration = Duration::from_secs(3);
/// The platform's "open this URL" program and its arguments.
fn opener_command(url: &str) -> (&'static str, Vec<String>) {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    (program, vec![url.to_string()])
}

/// Rows one card takes on the board, including its spacer line.
pub const CARD_HEIGHT: usize = 3;

/// Actions in the `x` menu for the selected ticket, as the key each one is.
pub const ACTIONS: [(char, &str); 10] = [
    ('a', "advance: start, approve, answer, resume"),
    ('S', "ship: approve the Ship gate and open the PR"),
    ('r', "send back with a reason"),
    ('e', "edit the ticket"),
    ('R', "search for its repo"),
    ('f', "focus the agent's tab"),
    ('o', "open the linked GitHub issue"),
    ('X', "abort the running stage"),
    ('w', "kill its worktree"),
    ('d', "delete"),
];

/// Keys shown in the help overlay, as (keys, what they do).
pub const HELP: [(&str, &str); 22] = [
    ("h / l", "previous / next column"),
    ("j / k", "previous / next ticket"),
    ("enter", "open details"),
    ("n", "new ticket, then edit it in place"),
    ("e", "edit title, description and criteria in place (ctrl+s saves)"),
    ("R", "search for its repo under HARDNESS_REPOS_DIR / ~/Developer"),
    ("a", "advance: move to intake, start, approve, answer, add guidance, resume"),
    ("S", "ship: approve the Ship gate and open the PR (same as a there)"),
    ("r", "send the plan or tests back, with a reason"),
    ("X", "abort the running stage (asks first)"),
    ("w", "kill its worktree once you are done with it (asks first)"),
    ("d", "delete (asks first)"),
    ("f", "focus the agent's watch tab in herdr"),
    ("o", "open the linked GitHub issue in the browser"),
    ("/", "filter by title or #id"),
    ("!", "show only tickets that need you"),
    ("@", "show only tickets for this repo"),
    ("F", "fold: show every column, only the focused one expanded"),
    ("x", "actions for the selected ticket"),
    ("esc", "clear the filter"),
    ("?", "this help"),
    ("q", "quit"),
];

pub enum Mode {
    Normal,
    Adding(String),
    /// Typing the filter. The text lives in `App::filter`.
    Filter,
    Detail(String),
    /// Editing a ticket's markdown in place: title, description, criteria, repo.
    EditTicket {
        id: String,
        area: TextArea<'static>,
        vim: Vim,
    },
    /// Typing a reason: required to send back, optional guidance for an escalation.
    Reason {
        id: String,
        approve: bool,
        text: String,
    },
    ConfirmDelete(String),
    ConfirmAbort(String),
    ConfirmWorktree(String),
    Actions {
        cursor: usize,
    },
    /// Searching for a repo to set on a ticket, type to filter. `all` is every repo found
    /// under the repos root, `cursor` indexes into whichever of those match `query`.
    RepoPicker {
        id: String,
        query: String,
        all: Vec<String>,
        cursor: usize,
    },
    Help,
}

/// What the event loop must do after a key press.
pub enum Outcome {
    Continue,
    Quit,
    /// Answer this ticket's triage questions in `$EDITOR`.
    Answer(String),
}

pub struct Toast {
    pub text: String,
    pub error: bool,
    at: Instant,
}

pub struct App {
    machine: Machine,
    stream: Receiver<Incoming>,
    pub tasks: Vec<Task>,
    pub online: bool,
    pub offline_reason: String,
    /// Details of the ticket being viewed or previewed.
    pub detail: Option<TaskDetail>,
    detail_stale: bool,
    pub focus: usize,
    pub selection: [usize; COLUMNS.len()],
    pub mode: Mode,
    pub toast: Option<Toast>,
    pub filter: String,
    pub needs_only: bool,
    pub this_repo_only: bool,
    /// Shows every column at once, unfocused ones collapsed to their header bar. For screens
    /// too narrow to fit all columns at a readable width.
    pub fold: bool,
    /// The repo this board defaults new tickets to, for the `@` filter. `None` if it
    /// isn't inside one.
    pub home_repo: Option<String>,
    /// Column rectangles from the last frame, for mouse clicks.
    pub column_rects: RefCell<Vec<(usize, Rect)>>,
    /// How far the open ticket's detail popup is scrolled. `ui` clamps it to the content's
    /// actual height, which only it knows (it depends on the terminal width).
    pub detail_scroll: Cell<u16>,
    imported: bool,
}

impl App {
    pub fn new(machine: Machine) -> Self {
        let (tx, rx) = mpsc::channel();
        spawn_stream(machine.base().to_string(), tx);
        let mut app = Self {
            machine,
            stream: rx,
            tasks: Vec::new(),
            online: false,
            offline_reason: "connecting".to_string(),
            detail: None,
            detail_stale: true,
            focus: 0,
            selection: [0; COLUMNS.len()],
            mode: Mode::Normal,
            toast: None,
            filter: String::new(),
            needs_only: false,
            this_repo_only: false,
            fold: false,
            home_repo: herdr::workspace_repo(),
            column_rects: RefCell::new(Vec::new()),
            detail_scroll: Cell::new(0),
            imported: false,
        };
        app.reload();
        if !app.online {
            let url = app.machine_url().to_string();
            app.notify(format!("can't reach the machine at {url} — start it with `pnpm dev`"), true);
        }
        app
    }

    pub fn machine_url(&self) -> &str {
        self.machine.base()
    }

    pub fn notify(&mut self, text: impl Into<String>, error: bool) {
        self.toast = Some(Toast {
            text: text.into(),
            error,
            at: Instant::now(),
        });
    }

    /// Drops info messages once they are old. Errors stay until the next key press.
    pub fn tick(&mut self) {
        if self
            .toast
            .as_ref()
            .is_some_and(|t| !t.error && t.at.elapsed() > INFO_TOAST_FOR)
        {
            self.toast = None;
        }
    }

    /// Fetches every ticket again, e.g. after reconnecting.
    fn reload(&mut self) {
        match self.machine.tasks() {
            Ok(tasks) => {
                let selected = self.selected_id();
                self.tasks = tasks;
                self.online = true;
                self.detail_stale = true;
                self.clamp_selection();
                if let Some(id) = selected {
                    self.select(&id, false);
                }
                self.import_legacy();
            }
            Err(error) => {
                self.online = false;
                self.offline_reason = error;
            }
        }
    }

    /// Moves the old local tickets into the machine, once.
    fn import_legacy(&mut self) {
        if self.imported {
            return;
        }
        self.imported = true;
        let Some(tickets) = store::read_legacy() else {
            return;
        };
        for ticket in &tickets {
            match self.machine.create(ticket) {
                Ok(task) => self.upsert(task),
                Err(error) => {
                    self.notify(format!("importing the old board stopped: {error}"), true);
                    return;
                }
            }
        }
        match store::mark_imported() {
            Ok(()) => self.notify(format!("imported {} ticket(s) from the old board", tickets.len()), false),
            Err(error) => self.notify(format!("imported, but could not rename board.json: {error}"), true),
        }
    }

    /// Applies everything the stream thread reported since the last frame.
    pub fn pump(&mut self) {
        while let Ok(incoming) = self.stream.try_recv() {
            match incoming {
                Incoming::Online => self.reload(),
                Incoming::Offline(reason) => {
                    self.online = false;
                    self.offline_reason = reason;
                }
                Incoming::Message(StreamMessage::Updated { task }) => {
                    if self.shows_detail_of(&task.id) {
                        self.detail_stale = true;
                    }
                    self.upsert(task);
                }
                Incoming::Message(StreamMessage::Event { event }) => {
                    if self.shows_detail_of(&event.task_id) {
                        self.detail_stale = true;
                    }
                }
                Incoming::Message(StreamMessage::Deleted { id }) => self.forget(&id),
            }
        }
    }

    fn shows_detail_of(&self, id: &str) -> bool {
        self.detail.as_ref().is_some_and(|d| d.task.id == id)
    }

    /// Adds or replaces a ticket. The highlight stays on the same ticket even when the change
    /// re-sorts its column, so the next key never lands on a different ticket.
    fn upsert(&mut self, task: Task) {
        let selected = self.selected_id();
        match self.tasks.iter_mut().find(|t| t.id == task.id) {
            Some(existing) => *existing = task,
            None => self.tasks.push(task),
        }
        self.clamp_selection();
        if let Some(id) = selected {
            self.select(&id, false);
        }
    }

    /// Highlights a ticket. With `follow`, the board also moves to the ticket's column.
    fn select(&mut self, id: &str, follow: bool) {
        let Some(column) = self.task(id).map(Task::column_index) else {
            return;
        };
        if !follow && column != self.focus {
            return;
        }
        self.focus = column;
        if let Some(row) = self.indices(column).iter().position(|&i| self.tasks[i].id == id) {
            self.selection[column] = row;
        }
    }

    fn forget(&mut self, id: &str) {
        self.tasks.retain(|t| t.id != id);
        if self.shows_detail_of(id) {
            self.detail = None;
        }
        if matches!(&self.mode, Mode::Detail(open) if open == id) {
            self.mode = Mode::Normal;
        }
        self.clamp_selection();
    }

    /// Keeps `detail` in step with the ticket being viewed or previewed.
    pub fn ensure_detail(&mut self) {
        let target = match &self.mode {
            Mode::Detail(id) => Some(id.clone()),
            _ => self.selected_task().map(|t| t.id.clone()),
        };
        let Some(id) = target else {
            self.detail = None;
            return;
        };
        if (self.shows_detail_of(&id) && !self.detail_stale) || !self.online {
            return;
        }
        self.detail = self.machine.detail(&id).ok();
        self.detail_stale = false;
    }

    pub fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }

    /// Repos from `all` whose path contains `query`, case-insensitively.
    pub fn matching_repos<'a>(all: &'a [String], query: &str) -> Vec<&'a str> {
        let query = query.to_lowercase();
        all.iter()
            .map(String::as_str)
            .filter(|r| query.is_empty() || r.to_lowercase().contains(&query))
            .collect()
    }

    fn passes_filter(&self, task: &Task) -> bool {
        if self.needs_only && !matches!(task.look(), Look::NeedsYou | Look::Escalated) {
            return false;
        }
        if self.this_repo_only && task.repo_path != self.home_repo {
            return false;
        }
        let query = self.filter.trim().to_lowercase();
        query.is_empty()
            || task.title.to_lowercase().contains(&query)
            || format!("#{}", task.short_id()).contains(&query)
    }

    /// Indices into `tasks` for the visible tickets in `column`, most urgent first.
    pub fn indices(&self, column: usize) -> Vec<usize> {
        let mut found: Vec<usize> = self
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.column_index() == column && self.passes_filter(t))
            .map(|(i, _)| i)
            .collect();
        found.sort_by(|&a, &b| {
            let (a, b) = (&self.tasks[a], &self.tasks[b]);
            (a.look(), &a.created_at).cmp(&(b.look(), &b.created_at))
        });
        found
    }

    fn selected_index(&self) -> Option<usize> {
        self.indices(self.focus)
            .get(self.selection[self.focus])
            .copied()
    }

    pub fn selected_task(&self) -> Option<&Task> {
        self.selected_index().map(|i| &self.tasks[i])
    }

    fn selected_id(&self) -> Option<String> {
        self.selected_task().map(|t| t.id.clone())
    }

    fn clamp_selection(&mut self) {
        for column in 0..COLUMNS.len() {
            let len = self.indices(column).len();
            self.selection[column] = self.selection[column].min(len.saturating_sub(1));
        }
    }

    /// Mouse wheel: scrolls the detail popup if it's open, otherwise moves the board selection.
    pub fn scroll(&mut self, delta: i16) {
        if matches!(self.mode, Mode::Detail(_)) {
            self.scroll_detail(delta);
        } else {
            self.move_selection(delta as isize);
        }
    }

    pub fn move_selection(&mut self, delta: isize) {
        let len = self.indices(self.focus).len() as isize;
        let next = self.selection[self.focus] as isize + delta;
        self.selection[self.focus] = next.clamp(0, (len - 1).max(0)) as usize;
    }

    fn switch_column(&mut self, delta: isize) {
        let next = self.focus as isize + delta;
        self.focus = next.clamp(0, COLUMNS.len() as isize - 1) as usize;
    }

    /// Clicking a card focuses its column and selects it. Ignores list scrolling.
    pub fn click(&mut self, x: u16, y: u16) {
        if !matches!(self.mode, Mode::Normal) {
            return;
        }
        let hit = self
            .column_rects
            .borrow()
            .iter()
            .find(|(_, rect)| x >= rect.x && x < rect.right() && y >= rect.y && y < rect.bottom())
            .copied();
        let Some((column, rect)) = hit else {
            return;
        };
        self.focus = column;
        let row = y.saturating_sub(rect.y + 1) as usize;
        let len = self.indices(column).len();
        if len > 0 {
            self.selection[column] = (row / CARD_HEIGHT).min(len - 1);
        }
    }

    /// Runs a machine command and shows the updated ticket, or the machine's error.
    fn act(&mut self, call: impl FnOnce(&Machine) -> Result<Task, String>, done: &str) {
        match call(&self.machine) {
            Ok(task) => {
                let id = task.id.clone();
                self.upsert(task);
                // You acted on this ticket: follow it, even into another column.
                self.select(&id, true);
                self.detail_stale = true;
                self.notify(done, false);
            }
            Err(error) => self.notify(error, true),
        }
    }

    /// Opens the ticket's markdown for editing in place: title, description, criteria, repo.
    fn open_ticket_editor(&mut self, id: &str) {
        let Some(task) = self.task(id) else {
            return;
        };
        let text = TicketText {
            title: task.title.clone(),
            description: task.description.clone(),
            criteria: task.criteria.clone(),
            repo_path: task.repo_path.clone(),
        };
        let title = format!(" editing #{} {} ", task.short_id(), task.title);
        let mut area = TextArea::new(ticket_markdown(&text).lines().map(str::to_string).collect());
        area.move_cursor(tui_textarea::CursorMove::Jump(0, 0));
        area.set_block(
            ratatui::widgets::Block::bordered()
                .padding(ratatui::widgets::Padding::new(2, 2, 1, 1))
                .title(title),
        );
        self.mode = Mode::EditTicket { id: id.to_string(), area, vim: Vim::new() };
    }

    /// Opens the repo search for `id`: type to filter, enter to set it on the ticket.
    fn open_repo_picker(&mut self, id: &str) {
        let all = repos_root().map(|root| discover_repos(&root)).unwrap_or_default();
        if all.is_empty() {
            self.notify("no repos found under HARDNESS_REPOS_DIR or ~/Developer; `e` to type one", true);
            return;
        }
        self.mode = Mode::RepoPicker { id: id.to_string(), query: String::new(), all, cursor: 0 };
    }

    /// `a`: the one obvious next step for the ticket.
    fn advance(&mut self, id: &str) -> Outcome {
        let Some(task) = self.task(id).cloned() else {
            return Outcome::Continue;
        };
        match task.state.as_str() {
            "backlog" => self.act(|m| m.start(id), "moved to intake"),
            "draft" if task.repo_path.is_none() => {
                self.notify("set a repo before starting", true);
                self.open_repo_picker(id);
            }
            "draft" => self.act(|m| m.start(id), "started"),
            "awaiting_answers" => return Outcome::Answer(id.to_string()),
            "escalated" if task.repo_path.is_none() => {
                self.notify("set a repo before continuing", true);
                self.open_repo_picker(id);
            }
            "escalated" => {
                self.mode = Mode::Reason {
                    id: id.to_string(),
                    approve: true,
                    text: String::new(),
                }
            }
            "paused_rate_limit" => self.act(|m| m.resume(id), "resumed"),
            "closed" => self.notify("this ticket is closed", false),
            _ if task.waiting_on_you => self.act(|m| m.decide(id, true, None), "approved"),
            _ => self.notify(format!("{} is running; X aborts it", task.status_label()), false),
        }
        Outcome::Continue
    }

    /// A key that acts on one ticket, from the board, its details, or the actions menu.
    fn ticket_key(&mut self, key: char, id: &str) -> Outcome {
        let Some(task) = self.task(id).cloned() else {
            return Outcome::Continue;
        };
        match key {
            'a' => return self.advance(id),
            'S' => {
                if task.state == "awaiting_ship" {
                    return self.advance(id);
                }
                self.notify("nothing waiting to ship on this ticket", false);
            }
            'e' => self.open_ticket_editor(id),
            'R' => self.open_repo_picker(id),
            'r' => {
                if matches!(task.state.as_str(), "awaiting_approval" | "awaiting_test_check") {
                    self.mode = Mode::Reason {
                        id: id.to_string(),
                        approve: false,
                        text: String::new(),
                    };
                } else {
                    self.notify("only a plan or tests waiting for you can be sent back", false);
                }
            }
            'X' => {
                if task.running || task.state == "paused_rate_limit" {
                    self.mode = Mode::ConfirmAbort(id.to_string());
                } else {
                    self.notify("nothing is running on this ticket", false);
                }
            }
            'w' => {
                if task.worktree_path.is_none() {
                    self.notify("no worktree for this ticket", false);
                } else if task.running {
                    self.notify("a stage is running on this worktree; X aborts it first", false);
                } else {
                    self.mode = Mode::ConfirmWorktree(id.to_string());
                }
            }
            'd' => self.mode = Mode::ConfirmDelete(id.to_string()),
            'f' => {
                if !herdr::focus_task_tab(task.short_id()) {
                    self.notify(format!("no watch tab for #{} yet; it opens when an agent runs", task.short_id()), false);
                }
            }
            'o' => match &task.source {
                Some(source) => {
                    let (program, args) = opener_command(&source.url);
                    // Detached: spawn and move on, never wait on the browser.
                    if Command::new(program).args(args).spawn().is_err() {
                        self.notify(format!("could not open {}", source.url), true);
                    }
                }
                None => self.notify("no issue linked", false),
            },
            _ => {}
        }
        Outcome::Continue
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if self.toast.as_ref().is_some_and(|t| t.error) {
            self.toast = None;
        }
        match &self.mode {
            Mode::Normal => self.handle_normal(key),
            Mode::Detail(id) => {
                let id = id.clone();
                self.handle_detail(key, &id)
            }
            Mode::Adding(_) => self.handle_adding(key),
            Mode::EditTicket { .. } => self.handle_edit_ticket(key),
            Mode::Filter => self.handle_filter(key),
            Mode::Reason { .. } => self.handle_reason(key),
            Mode::ConfirmDelete(id) | Mode::ConfirmAbort(id) | Mode::ConfirmWorktree(id) => {
                let id = id.clone();
                self.handle_confirm(key, &id)
            }
            Mode::Actions { .. } => self.handle_actions(key),
            Mode::RepoPicker { .. } => self.handle_repo_picker(key),
            Mode::Help => {
                self.mode = Mode::Normal;
                Outcome::Continue
            }
        }
    }

    fn handle_normal(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('q') => return Outcome::Quit,
            KeyCode::Char('h') | KeyCode::Left => self.switch_column(-1),
            KeyCode::Char('l') | KeyCode::Right => self.switch_column(1),
            KeyCode::Char('j') | KeyCode::Down => self.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_selection(-1),
            KeyCode::Char('n') => self.mode = Mode::Adding(String::new()),
            KeyCode::Char('x') => self.mode = Mode::Actions { cursor: 0 },
            KeyCode::Char('/') => self.mode = Mode::Filter,
            KeyCode::Char('!') => {
                self.needs_only = !self.needs_only;
                self.clamp_selection();
            }
            KeyCode::Char('@') => {
                if self.home_repo.is_none() {
                    self.notify("this board isn't inside a repo", true);
                } else {
                    self.this_repo_only = !self.this_repo_only;
                    self.clamp_selection();
                }
            }
            KeyCode::Char('F') => self.fold = !self.fold,
            KeyCode::Char('?') => self.mode = Mode::Help,
            KeyCode::Esc => {
                self.filter.clear();
                self.needs_only = false;
                self.this_repo_only = false;
                self.clamp_selection();
            }
            KeyCode::Enter => {
                if let Some(id) = self.selected_id() {
                    self.detail_stale = true;
                    self.detail_scroll.set(0);
                    self.mode = Mode::Detail(id);
                }
            }
            KeyCode::Char(c) => {
                if let Some(id) = self.selected_id() {
                    return self.ticket_key(c, &id);
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    fn handle_detail(&mut self, key: KeyEvent, id: &str) -> Outcome {
        match key.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => self.mode = Mode::Normal,
            KeyCode::Char('j') | KeyCode::Down => self.scroll_detail(1),
            KeyCode::Char('k') | KeyCode::Up => self.scroll_detail(-1),
            KeyCode::Char(c) => return self.ticket_key(c, id),
            _ => {}
        }
        Outcome::Continue
    }

    /// Scrolls the open detail popup. `ui` clamps this to the content's actual height on the
    /// next frame, since only it knows that (it depends on the terminal width).
    fn scroll_detail(&self, delta: i16) {
        let next = self.detail_scroll.get() as i16 + delta;
        self.detail_scroll.set(next.max(0) as u16);
    }

    /// Vim-style modal editing, like `$EDITOR` gave before editing moved in place: normal mode
    /// navigates, `i`/`a`/`o`/... enter insert mode, ctrl+s saves (either mode), esc in normal
    /// mode cancels. Saving parses the same markdown `e` used to write to `$EDITOR`.
    fn handle_edit_ticket(&mut self, key: KeyEvent) -> Outcome {
        let Mode::EditTicket { id, area, vim } = &mut self.mode else {
            return Outcome::Continue;
        };
        match vim.handle(area, key) {
            crate::vim::Outcome::Continue => {}
            crate::vim::Outcome::Cancel => self.mode = Mode::Normal,
            crate::vim::Outcome::Save => {
                let id = id.clone();
                let markdown = area.lines().join("\n");
                self.mode = Mode::Normal;
                let Some(task) = self.task(&id) else {
                    return Outcome::Continue;
                };
                let before = TicketText {
                    title: task.title.clone(),
                    description: task.description.clone(),
                    criteria: task.criteria.clone(),
                    repo_path: task.repo_path.clone(),
                };
                // The repo isn't part of this text (see `ticket_markdown`), so carry the
                // ticket's current one over rather than letting a parse with none wipe it.
                let edited = TicketText { repo_path: task.repo_path.clone(), ..parse_ticket(&markdown, &task.title) };
                if edited != before {
                    self.act(|m| m.update(&id, &edited), "saved");
                } else {
                    self.notify("nothing changed", false);
                }
            }
        }
        Outcome::Continue
    }

    fn handle_adding(&mut self, key: KeyEvent) -> Outcome {
        let Mode::Adding(buf) = &mut self.mode else {
            return Outcome::Continue;
        };
        match key.code {
            KeyCode::Char(c) => buf.push(c),
            KeyCode::Backspace => {
                buf.pop();
            }
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                let title = buf.trim().to_string();
                self.mode = Mode::Normal;
                if title.is_empty() {
                    return Outcome::Continue;
                }
                let text = TicketText {
                    title,
                    repo_path: herdr::workspace_repo(),
                    ..Default::default()
                };
                match self.machine.create(&text) {
                    Ok(task) => {
                        let id = task.id.clone();
                        self.upsert(task);
                        self.select(&id, true);
                        self.open_ticket_editor(&id);
                    }
                    Err(error) => self.notify(error, true),
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    fn handle_filter(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char(c) => self.filter.push(c),
            KeyCode::Backspace => {
                self.filter.pop();
            }
            KeyCode::Enter => self.mode = Mode::Normal,
            KeyCode::Esc => {
                self.filter.clear();
                self.mode = Mode::Normal;
            }
            _ => {}
        }
        self.clamp_selection();
        Outcome::Continue
    }

    fn handle_reason(&mut self, key: KeyEvent) -> Outcome {
        let Mode::Reason { id, approve, text } = &mut self.mode else {
            return Outcome::Continue;
        };
        match key.code {
            KeyCode::Char(c) => text.push(c),
            KeyCode::Backspace => {
                text.pop();
            }
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                let (id, approve, reason) = (id.clone(), *approve, text.trim().to_string());
                if !approve && reason.is_empty() {
                    self.notify("say why it goes back; the stage reads your reason", true);
                    return Outcome::Continue;
                }
                self.mode = Mode::Normal;
                let reason = (!reason.is_empty()).then_some(reason);
                let done = if approve { "continuing with your guidance" } else { "sent back" };
                self.act(|m| m.decide(&id, approve, reason.as_deref()), done);
            }
            _ => {}
        }
        Outcome::Continue
    }

    fn handle_confirm(&mut self, key: KeyEvent, id: &str) -> Outcome {
        match key.code {
            KeyCode::Char('y') => {
                let mode = std::mem::replace(&mut self.mode, Mode::Normal);
                match mode {
                    Mode::ConfirmDelete(_) => match self.machine.delete(id) {
                        Ok(()) => {
                            self.forget(id);
                            self.notify("deleted", false);
                        }
                        Err(error) => self.notify(error, true),
                    },
                    Mode::ConfirmWorktree(_) => {
                        self.act(|m| m.remove_worktree(id), "worktree removed");
                    }
                    _ => self.act(|m| m.abort(id), "aborted; it waits for you"),
                }
            }
            KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
    }

    /// Type to filter, up/down to move, enter to set the highlighted repo on the ticket.
    fn handle_repo_picker(&mut self, key: KeyEvent) -> Outcome {
        let Mode::RepoPicker { id, query, all, cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        match key.code {
            KeyCode::Char(c) => {
                query.push(c);
                *cursor = 0;
            }
            KeyCode::Backspace => {
                query.pop();
                *cursor = 0;
            }
            KeyCode::Down => {
                let len = Self::matching_repos(all, query).len();
                if len > 0 {
                    *cursor = (*cursor + 1).min(len - 1);
                }
            }
            KeyCode::Up => *cursor = cursor.saturating_sub(1),
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                let matches = Self::matching_repos(all, query);
                let Some(repo) = matches.get(*cursor).map(|r| r.to_string()) else {
                    return Outcome::Continue;
                };
                let id = id.clone();
                self.mode = Mode::Normal;
                let Some(task) = self.task(&id).cloned() else {
                    return Outcome::Continue;
                };
                let text = TicketText {
                    title: task.title,
                    description: task.description,
                    criteria: task.criteria,
                    repo_path: Some(repo),
                };
                self.act(|m| m.update(&id, &text), "repo set");
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// Runs the chosen action as if its key were pressed on the selected ticket.
    fn handle_actions(&mut self, key: KeyEvent) -> Outcome {
        let Mode::Actions { cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        let mut chosen = None;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => *cursor = (*cursor + 1).min(ACTIONS.len() - 1),
            KeyCode::Up | KeyCode::Char('k') => *cursor = cursor.saturating_sub(1),
            KeyCode::Enter => chosen = Some(ACTIONS[*cursor].0),
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            KeyCode::Char(c) if ACTIONS.iter().any(|(k, _)| *k == c) => chosen = Some(c),
            _ => {}
        }
        if let Some(c) = chosen {
            self.mode = Mode::Normal;
            if let Some(id) = self.selected_id() {
                return self.ticket_key(c, &id);
            }
        }
        Outcome::Continue
    }

    /// Opens `content` in `$EDITOR` and returns the saved text, or None if cancelled.
    fn run_editor(&mut self, terminal: &mut DefaultTerminal, name: &str, content: &str) -> Option<String> {
        let path = env::temp_dir().join(name);
        if let Err(error) = fs::write(&path, content) {
            self.notify(format!("could not write {}: {error}", path.display()), true);
            return None;
        }

        let _ = execute!(io::stdout(), DisableMouseCapture);
        ratatui::restore();
        let editor = env::var("EDITOR").unwrap_or_else(|_| "vi".to_string());
        let status = Command::new("sh")
            .arg("-c")
            .arg(format!("{editor} \"$1\""))
            .arg("sh")
            .arg(&path)
            .status();
        *terminal = ratatui::init();
        let _ = execute!(io::stdout(), EnableMouseCapture);

        let saved = match status {
            Ok(status) if status.success() => fs::read_to_string(&path).ok(),
            Ok(status) => {
                self.notify(format!("editor exited with {status}"), true);
                None
            }
            Err(error) => {
                self.notify(format!("could not start the editor: {error}"), true);
                None
            }
        };
        let _ = fs::remove_file(&path);
        saved
    }

    /// Answers triage's questions in `$EDITOR`, starting from its recommended answers.
    pub fn answer_questions(&mut self, terminal: &mut DefaultTerminal, id: &str) {
        let detail = match self.machine.detail(id) {
            Ok(detail) => detail,
            Err(error) => return self.notify(error, true),
        };
        let questions = detail.open_approval().map(questions_of).unwrap_or_default();
        if questions.is_empty() {
            return self.notify("triage left no questions to answer", true);
        }
        let name = format!("hardness-answers-{}.md", detail.task.short_id());
        let Some(saved) = self.run_editor(terminal, &name, &answers_markdown(&detail.task, &questions)) else {
            return;
        };
        let answers = parse_answers(&saved);
        if answers.len() != questions.len() || answers.iter().any(|(_, a)| a.is_empty()) {
            return self.notify("answer every question, keeping the `## Q:` lines", true);
        }
        self.act(|m| m.answer(id, &answers), "answers sent; triage runs again");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_when_the_machine_is_unreachable_on_startup() {
        // SAFETY: this test does not run alongside another that reads this var.
        unsafe { std::env::set_var("HARDNESS_MACHINE_URL", "http://127.0.0.1:1") };
        let app = App::new(Machine::from_env());
        assert!(!app.online);
        let toast = app.toast.expect("a warning toast on startup");
        assert!(toast.error);
        assert!(toast.text.contains("pnpm dev"), "toast was: {}", toast.text);
    }

    #[test]
    fn opener_command_uses_open_on_macos_and_xdg_open_elsewhere() {
        let (program, args) = opener_command("https://github.com/acme/app/issues/42");
        if cfg!(target_os = "macos") {
            assert_eq!(program, "open");
        } else {
            assert_eq!(program, "xdg-open");
        }
        assert_eq!(args, vec!["https://github.com/acme/app/issues/42".to_string()]);
    }

    #[test]
    fn matching_repos_filters_case_insensitively_and_keeps_order() {
        let all = vec![
            "/Developer/hardness-herdr".to_string(),
            "/Developer/project-x/backend".to_string(),
            "/Developer/project-x/frontend".to_string(),
        ];
        assert_eq!(App::matching_repos(&all, ""), all.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(
            App::matching_repos(&all, "PROJECT-X"),
            vec!["/Developer/project-x/backend", "/Developer/project-x/frontend"],
        );
        assert_eq!(App::matching_repos(&all, "nope"), Vec::<&str>::new());
    }
}
