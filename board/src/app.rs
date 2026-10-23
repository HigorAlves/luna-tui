//! Board state and everything that changes it: keys, machine calls and the event stream.
//! The machine owns the tickets; the board shows them and sends your decisions.

use std::{
    cell::RefCell,
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

use crate::{
    client::{Incoming, Machine, spawn_stream},
    herdr,
    model::{
        COLUMNS, Look, StreamMessage, Task, TaskDetail, TicketText, answers_markdown, parse_answers,
        parse_ticket, questions_of, ticket_markdown,
    },
    store,
};

const INFO_TOAST_FOR: Duration = Duration::from_secs(3);
/// Rows one card takes on the board, including its spacer line.
pub const CARD_HEIGHT: usize = 3;

/// Actions in the `x` menu for the selected ticket, as the key each one is.
pub const ACTIONS: [(char, &str); 6] = [
    ('a', "advance: start, approve, answer, resume"),
    ('r', "send back with a reason"),
    ('e', "edit the ticket"),
    ('f', "focus the agent's tab"),
    ('X', "abort the running stage"),
    ('d', "delete"),
];

/// Keys shown in the help overlay, as (keys, what they do).
pub const HELP: [(&str, &str); 16] = [
    ("h / l", "previous / next column"),
    ("j / k", "previous / next ticket"),
    ("enter", "open details"),
    ("n", "new ticket, then edit it in $EDITOR"),
    ("e", "edit title, description, criteria and repo"),
    ("a", "advance: start a draft, approve, answer, add guidance, resume"),
    ("r", "send the plan or tests back, with a reason"),
    ("X", "abort the running stage (asks first)"),
    ("d", "delete (asks first)"),
    ("f", "focus the agent's watch tab in herdr"),
    ("/", "filter by title or #id"),
    ("!", "show only tickets that need you"),
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
    /// Typing a reason: required to send back, optional guidance for an escalation.
    Reason {
        id: String,
        approve: bool,
        text: String,
    },
    ConfirmDelete(String),
    ConfirmAbort(String),
    Actions {
        cursor: usize,
    },
    Help,
}

/// What the event loop must do after a key press.
pub enum Outcome {
    Continue,
    Quit,
    /// Edit this ticket in `$EDITOR`.
    Edit(String),
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
    /// Column rectangles from the last frame, for mouse clicks.
    pub column_rects: RefCell<Vec<(usize, Rect)>>,
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
            column_rects: RefCell::new(Vec::new()),
            imported: false,
        };
        app.reload();
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

    pub fn detail_task(&self) -> Option<&Task> {
        match &self.mode {
            Mode::Detail(id) => self.task(id),
            _ => None,
        }
    }

    fn passes_filter(&self, task: &Task) -> bool {
        if self.needs_only && !matches!(task.look(), Look::NeedsYou | Look::Escalated) {
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

    /// `a`: the one obvious next step for the ticket.
    fn advance(&mut self, id: &str) -> Outcome {
        let Some(task) = self.task(id).cloned() else {
            return Outcome::Continue;
        };
        match task.state.as_str() {
            "draft" => self.act(|m| m.start(id), "started"),
            "awaiting_answers" => return Outcome::Answer(id.to_string()),
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
            'e' => return Outcome::Edit(id.to_string()),
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
            'd' => self.mode = Mode::ConfirmDelete(id.to_string()),
            'f' => {
                if !herdr::focus_task_tab(task.short_id()) {
                    self.notify(format!("no watch tab for #{} yet; it opens when an agent runs", task.short_id()), false);
                }
            }
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
            Mode::Filter => self.handle_filter(key),
            Mode::Reason { .. } => self.handle_reason(key),
            Mode::ConfirmDelete(id) | Mode::ConfirmAbort(id) => {
                let id = id.clone();
                self.handle_confirm(key, &id)
            }
            Mode::Actions { .. } => self.handle_actions(key),
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
            KeyCode::Char('?') => self.mode = Mode::Help,
            KeyCode::Esc => {
                self.filter.clear();
                self.needs_only = false;
                self.clamp_selection();
            }
            KeyCode::Enter => {
                if let Some(id) = self.selected_id() {
                    self.detail_stale = true;
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
            KeyCode::Char(c) => return self.ticket_key(c, id),
            _ => {}
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
                        return Outcome::Edit(id);
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
                let deleting = matches!(self.mode, Mode::ConfirmDelete(_));
                self.mode = Mode::Normal;
                if deleting {
                    match self.machine.delete(id) {
                        Ok(()) => {
                            self.forget(id);
                            self.notify("deleted", false);
                        }
                        Err(error) => self.notify(error, true),
                    }
                } else {
                    self.act(|m| m.abort(id), "aborted; it waits for you");
                }
            }
            KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
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
            KeyCode::Esc => self.mode = Mode::Normal,
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

    /// Edits the ticket's title, description, criteria and repo in `$EDITOR`.
    pub fn edit_ticket(&mut self, terminal: &mut DefaultTerminal, id: &str) {
        let Some(task) = self.task(id).cloned() else {
            return;
        };
        let text = TicketText {
            title: task.title.clone(),
            description: task.description.clone(),
            criteria: task.criteria.clone(),
            repo_path: task.repo_path.clone(),
        };
        let name = format!("hardness-ticket-{}.md", task.short_id());
        let Some(saved) = self.run_editor(terminal, &name, &ticket_markdown(&text)) else {
            return;
        };
        let edited = parse_ticket(&saved, &task.title);
        if edited != text {
            self.act(|m| m.update(id, &edited), "saved");
        }
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
