//! Board state and everything that changes it: keys, machine calls and the event stream.
//! The machine owns the tickets; the board shows them and sends your decisions.

use std::{
    cell::{Cell, RefCell},
    env, fs, io,
    process::Command,
    sync::mpsc::{self, Receiver},
    thread,
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

use std::collections::BTreeSet;

use crate::inbox::{self, InboxState, Split};
use crate::model::now_secs;
use crate::notify::{self, Notice};
use crate::{
    client::{Incoming, Machine},
    discover::{discover_repos, repos_root},
    herdr,
    model::{
        COLUMNS, Look, Metrics, StreamMessage, Task, TaskDetail, TicketText, answers_markdown, parse_answers,
        parse_plan, parse_ticket, plan_edit_of, plan_markdown, questions_of, short_id, ticket_markdown,
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
pub const ACTIONS: [(char, &str); 11] = [
    ('P', "resume every ticket paused on the usage window"),
    ('a', "advance: start, approve, answer, retry, resume"),
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
pub const HELP: [(&str, &str); 26] = [
    ("h / l", "previous / next column"),
    ("j / k", "previous / next ticket"),
    ("enter", "open details"),
    ("n", "new ticket, then edit it in place"),
    ("e", "edit title, description and criteria in place (ctrl+s saves)"),
    ("R", "search for its repo under HARDNESS_REPOS_DIR / ~/Developer"),
    ("a", "advance: move to intake, start, approve, answer, retry an escalation, resume"),
    ("S", "ship: approve the Ship gate and open the PR (same as a there)"),
    ("A", "memory review: approve without applying the proposed rules"),
    ("r", "send the plan or tests back, with a reason"),
    ("X", "abort the running stage (asks first)"),
    ("w", "kill its worktree once you are done with it (asks first)"),
    ("d", "delete (asks first)"),
    ("f", "focus the agent's watch tab in herdr"),
    ("o", "open the linked GitHub issue in the browser"),
    ("/", "filter by title, #id or repo"),
    ("!", "show only tickets that need you"),
    ("@", "show only tickets for this repo"),
    ("z", "fold: show every column, only the focused one expanded"),
    ("F", "Floor: 7d and 30d metrics (r refreshes, esc closes)"),
    ("I", "Inbox: what needs you, split by why; a/r/e act in place, A approves the split, enter opens"),
    ("v / V", "mark the ticket / the column; a, X, d, w then act on the marked set"),
    ("x", "actions for the selected ticket (P resumes every paused one)"),
    ("esc", "clear the filter"),
    ("?", "this help"),
    ("q", "quit"),
];

/// The Floor view's numbers, one window each. A window stays `None` until its first fetch
/// succeeds; a failed refresh keeps what was there.
#[derive(Default)]
pub struct FloorState {
    pub d7: Option<Metrics>,
    pub d30: Option<Metrics>,
}

/// What `X`, `w` and `d` do to a marked set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BulkAction {
    Abort,
    Worktree,
    Delete,
}

impl BulkAction {
    pub fn question(self, n: usize) -> String {
        match self {
            BulkAction::Abort => format!("Abort the running stage on {n} ticket(s)? They then wait for you."),
            BulkAction::Worktree => format!("Kill the worktree of {n} ticket(s)? Branches and commits stay."),
            BulkAction::Delete => format!("Delete {n} ticket(s)? Runs and history go too."),
        }
    }
    fn done(self) -> &'static str {
        match self {
            BulkAction::Abort => "aborted",
            BulkAction::Worktree => "worktree removed on",
            BulkAction::Delete => "deleted",
        }
    }
}

/// The marked ids `action` can apply to: `X` needs something running or paused, `w` a
/// worktree with nothing running on it, `d` takes any.
pub fn bulk_targets(tasks: &[Task], ids: &[String], action: BulkAction) -> Vec<String> {
    ids.iter()
        .filter(|id| {
            tasks.iter().find(|t| &t.id == *id).is_some_and(|t| match action {
                BulkAction::Abort => t.running || t.state == "paused_rate_limit",
                BulkAction::Worktree => t.worktree_path.is_some() && !t.running,
                BulkAction::Delete => true,
            })
        })
        .cloned()
        .collect()
}

/// Every ticket waiting on the usage window.
pub fn paused_ids(tasks: &[Task]) -> Vec<String> {
    tasks.iter().filter(|t| t.state == "paused_rate_limit").map(|t| t.id.clone()).collect()
}

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
    /// Which side of `EditPlan` has keyboard focus. Tab switches; a save covers both.
    /// Editing triage's plan and the ticket side by side: left the plan (brief, criteria,
    /// assumptions — slices stay as triage wrote them), right the ticket's own text. Open
    /// while a ticket is `awaiting_approval`, in place of the plain ticket editor.
    EditPlan {
        id: String,
        plan_area: TextArea<'static>,
        ticket_area: TextArea<'static>,
        focus: PlanPane,
        plan_vim: Vim,
        ticket_vim: Vim,
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
    /// `A` in the Inbox: approve every ticket in the split, after one yes.
    ConfirmApproveAll(Vec<String>),
    /// A destructive key over the marked set: one yes for all of them.
    ConfirmMany { action: BulkAction, ids: Vec<String> },
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlanPane {
    Plan,
    Ticket,
}

/// Whether `task` is at the plan gate with its plan already fetched into `detail`, so `e`
/// opens the two-pane plan editor instead of the plain ticket editor.
fn has_open_plan(task: &Task, detail: Option<&TaskDetail>) -> bool {
    task.state == "awaiting_approval" && detail.is_some_and(|d| d.task.id == task.id && d.open_approval().is_some())
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
    /// What herdr (or the terminal bell) should tell you; the main loop drains it.
    notices: Vec<Notice>,
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
    /// The full-screen Floor view, open while this is `Some`.
    pub floor: Option<FloorState>,
    /// The Inbox view, open while this is `Some`.
    pub inbox: Option<InboxState>,
    /// Tickets marked with `v`/`V`: `a`, `X`, `d`, `w` act on all of them.
    pub marked: BTreeSet<String>,
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
        machine.follow_stream(tx);
        let mut app = Self {
            machine,
            stream: rx,
            tasks: Vec::new(),
            online: false,
            notices: Vec::new(),
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
            floor: None,
            inbox: None,
            marked: BTreeSet::new(),
            home_repo: herdr::workspace_repo(),
            column_rects: RefCell::new(Vec::new()),
            detail_scroll: Cell::new(0),
            imported: false,
        };
        app.reload();
        if !app.online {
            let url = app.machine_url();
            app.notify(format!("can't reach the machine at {url} — start it with `pnpm start` or `pnpm dev`"), true);
        }
        app
    }

    pub fn machine_url(&self) -> String {
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
                Incoming::Online => {
                    self.reload();
                    self.catch_up_watch_tabs();
                }
                Incoming::Offline(reason) => self.went_offline(reason),
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
                // herdr calls are subprocesses, so they stay off the UI thread.
                Incoming::Message(StreamMessage::StageStarted { task_id, label, cwd, container }) => {
                    thread::spawn(move || herdr::follow(short_id(&task_id), &label, &cwd, &container));
                }
                Incoming::Message(StreamMessage::Closed { id }) => {
                    thread::spawn(move || herdr::close_task_tab(short_id(&id)));
                }
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
        let before = self.tasks.iter().find(|t| t.id == task.id).map(Task::look);
        if let Some(notice) = notify::notice_for(before, &task) {
            self.notices.push(notice);
        }
        match self.tasks.iter_mut().find(|t| t.id == task.id) {
            Some(existing) => *existing = task,
            None => self.tasks.push(task),
        }
        self.clamp_selection();
        if let Some(id) = selected {
            self.select(&id, false);
        }
    }

    /// The machine stopped answering: remembered, and told once per outage.
    pub fn went_offline(&mut self, reason: String) {
        if self.online {
            self.notices.push(notify::offline_notice(&reason));
        }
        self.online = false;
        self.offline_reason = reason;
    }

    /// Everything queued for you since the last call.
    pub fn take_notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }

    /// How many tickets wait on you right now: the Board tab's badge.
    pub fn needs_you_count(&self) -> usize {
        self.tasks.iter().filter(|t| matches!(t.look(), Look::NeedsYou | Look::Escalated)).count()
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

    /// Watch tabs for stages that started before the board connected.
    fn catch_up_watch_tabs(&self) {
        let tasks: Vec<(String, String, String)> = self
            .tasks
            .iter()
            .filter_map(|t| Some((t.id.clone(), format!("#{} {}", t.short_id(), t.title), t.worktree_path.clone()?)))
            .collect();
        thread::spawn(move || herdr::catch_up(&tasks));
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
            || task.repo_name().is_some_and(|r| r.to_lowercase().contains(&query))
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

    /// Opens triage's plan and the ticket side by side: left the plan, right the ticket's
    /// own text. Only reachable while the ticket is `awaiting_approval` with its plan
    /// already fetched (`has_open_plan`), so the plan pane always has something to show.
    fn open_plan_editor(&mut self, id: &str) {
        let Some(task) = self.task(id).cloned() else {
            return;
        };
        let Some(requested) = self.detail.as_ref().and_then(TaskDetail::open_approval).map(|a| a.requested.clone()) else {
            return;
        };
        let plan_edit = plan_edit_of(&requested);
        let ticket_text = TicketText {
            title: task.title.clone(),
            description: task.description.clone(),
            criteria: task.criteria.clone(),
            repo_path: task.repo_path.clone(),
        };

        let mut plan_area = TextArea::new(plan_markdown(&plan_edit).lines().map(str::to_string).collect());
        plan_area.move_cursor(tui_textarea::CursorMove::Jump(0, 0));
        plan_area.set_block(
            ratatui::widgets::Block::bordered()
                .padding(ratatui::widgets::Padding::new(2, 2, 1, 1))
                .title(" plan — tab switches panes, ctrl+s saves both "),
        );

        let mut ticket_area = TextArea::new(ticket_markdown(&ticket_text).lines().map(str::to_string).collect());
        ticket_area.move_cursor(tui_textarea::CursorMove::Jump(0, 0));
        ticket_area.set_block(
            ratatui::widgets::Block::bordered()
                .padding(ratatui::widgets::Padding::new(2, 2, 1, 1))
                .title(format!(" ticket #{} {} ", task.short_id(), task.title)),
        );

        self.mode = Mode::EditPlan {
            id: id.to_string(),
            plan_area,
            ticket_area,
            focus: PlanPane::Plan,
            plan_vim: Vim::new(),
            ticket_vim: Vim::new(),
        };
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
            'A' => {
                if task.state == "reviewing_memory" {
                    self.act(|m| m.approve_skipping_rules(id), "approved, rules skipped");
                } else {
                    self.notify("no memory review waiting on this ticket", false);
                }
            }
            'S' => {
                if task.state == "awaiting_ship" {
                    return self.advance(id);
                }
                self.notify("nothing waiting to ship on this ticket", false);
            }
            'e' => {
                if has_open_plan(&task, self.detail.as_ref()) {
                    self.open_plan_editor(id);
                } else {
                    self.open_ticket_editor(id);
                }
            }
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
        if self.floor.is_some() && matches!(self.mode, Mode::Normal) {
            return self.handle_floor(key);
        }
        if self.inbox.is_some() && matches!(self.mode, Mode::Normal) {
            return self.handle_inbox(key);
        }
        match &self.mode {
            Mode::Normal => self.handle_normal(key),
            Mode::Detail(id) => {
                let id = id.clone();
                self.handle_detail(key, &id)
            }
            Mode::Adding(_) => self.handle_adding(key),
            Mode::EditTicket { .. } => self.handle_edit_ticket(key),
            Mode::EditPlan { .. } => self.handle_edit_plan(key),
            Mode::Filter => self.handle_filter(key),
            Mode::Reason { .. } => self.handle_reason(key),
            Mode::ConfirmDelete(id) | Mode::ConfirmAbort(id) | Mode::ConfirmWorktree(id) => {
                let id = id.clone();
                self.handle_confirm(key, &id)
            }
            Mode::ConfirmApproveAll(_) => self.handle_confirm_approve_all(key),
            Mode::ConfirmMany { .. } => self.handle_confirm_many(key),
            Mode::Actions { .. } => self.handle_actions(key),
            Mode::RepoPicker { .. } => self.handle_repo_picker(key),
            Mode::Help => {
                self.mode = Mode::Normal;
                Outcome::Continue
            }
        }
    }

    /// Fetches both Floor windows. A failure shows in the footer and keeps the old numbers.
    fn refresh_floor(&mut self) {
        let mut errors = Vec::new();
        let d7 = self.machine.metrics("7d");
        let d30 = self.machine.metrics("30d");
        let Some(floor) = self.floor.as_mut() else {
            return;
        };
        match d7 {
            Ok(m) => floor.d7 = Some(m),
            Err(e) => errors.push(e),
        }
        match d30 {
            Ok(m) => floor.d30 = Some(m),
            Err(e) => errors.push(e),
        }
        if let Some(error) = errors.into_iter().next() {
            self.notify(format!("floor: {error}"), true);
        }
    }

    fn handle_floor(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Esc | KeyCode::Char('F') | KeyCode::Char('q') => self.floor = None,
            KeyCode::Char('r') => self.refresh_floor(),
            _ => {}
        }
        Outcome::Continue
    }

    /// The Inbox's keys: move, switch split, act in place, open, approve the split.
    fn handle_inbox(&mut self, key: KeyEvent) -> Outcome {
        let now = now_secs();
        let Some(state) = self.inbox.clone() else {
            return Outcome::Continue;
        };
        let ids: Vec<String> = inbox::items(&self.tasks, state.split, now).iter().map(|&i| self.tasks[i].id.clone()).collect();
        let under_cursor = ids.get(state.cursor.min(ids.len().saturating_sub(1))).cloned();
        let mut next = state.clone();
        match key.code {
            KeyCode::Esc | KeyCode::Char('I') | KeyCode::Char('q') => {
                self.inbox = None;
                return Outcome::Continue;
            }
            KeyCode::Char('j') | KeyCode::Down => next.cursor = (state.cursor + 1).min(ids.len().saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => next.cursor = state.cursor.saturating_sub(1),
            KeyCode::Char('l') | KeyCode::Right | KeyCode::Tab => {
                next.split = state.split.next();
                next.cursor = 0;
            }
            KeyCode::Char('h') | KeyCode::Left | KeyCode::BackTab => {
                next.split = state.split.prev();
                next.cursor = 0;
            }
            KeyCode::Char(d @ '1'..='5') => {
                next.split = Split::ALL[(d as usize) - ('1' as usize)];
                next.cursor = 0;
            }
            KeyCode::Enter => {
                if let Some(id) = under_cursor {
                    self.inbox = None;
                    self.select(&id, true);
                    self.detail_stale = true;
                    self.detail_scroll.set(0);
                    self.mode = Mode::Detail(id);
                }
                return Outcome::Continue;
            }
            KeyCode::Char('A') => {
                let approve: Vec<String> = inbox::items(&self.tasks, Split::Approve, now).iter().map(|&i| self.tasks[i].id.clone()).collect();
                if approve.is_empty() {
                    self.notify("nothing to approve", false);
                } else {
                    self.mode = Mode::ConfirmApproveAll(approve);
                }
                return Outcome::Continue;
            }
            KeyCode::Char(c) => {
                if let Some(id) = under_cursor {
                    return self.ticket_key(c, &id);
                }
            }
            _ => {}
        }
        self.inbox = Some(next);
        Outcome::Continue
    }

    fn handle_confirm_approve_all(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('y') => {
                let Mode::ConfirmApproveAll(ids) = std::mem::replace(&mut self.mode, Mode::Normal) else {
                    return Outcome::Continue;
                };
                let total = ids.len();
                let mut done = 0;
                for id in ids {
                    if self.machine.decide(&id, true, None).is_ok() {
                        done += 1;
                    }
                }
                self.notify(format!("approved {done} of {total}"), done < total);
            }
            KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
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
            KeyCode::Char('z') => self.fold = !self.fold,
            KeyCode::Char('F') => {
                self.floor = Some(FloorState::default());
                self.refresh_floor();
            }
            KeyCode::Char('I') => self.inbox = Some(InboxState::default()),
            KeyCode::Char('v') => {
                // Toggle: remove it if it was marked, else mark it.
                if let Some(id) = self.selected_id().filter(|id| !self.marked.remove(id)) {
                    self.marked.insert(id);
                }
            }
            KeyCode::Char('V') => {
                let ids: Vec<String> = self.indices(self.focus).iter().map(|&i| self.tasks[i].id.clone()).collect();
                if !ids.is_empty() && ids.iter().all(|id| self.marked.contains(id)) {
                    for id in &ids {
                        self.marked.remove(id);
                    }
                } else {
                    self.marked.extend(ids);
                }
            }
            KeyCode::Char('?') => self.mode = Mode::Help,
            KeyCode::Esc => {
                self.filter.clear();
                self.needs_only = false;
                self.this_repo_only = false;
                self.marked.clear();
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
                if !self.marked.is_empty() && matches!(c, 'a' | 'X' | 'd' | 'w') {
                    return self.bulk_key(c);
                }
                if let Some(id) = self.selected_id() {
                    return self.ticket_key(c, &id);
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// `a`, `X`, `d` or `w` over the marked set. `a` goes straight to the machine for the
    /// tickets whose next step needs no words from you; the destructive three ask once.
    fn bulk_key(&mut self, c: char) -> Outcome {
        let ids: Vec<String> = self.marked.iter().cloned().collect();
        if c == 'a' {
            let (mut done, mut skipped) = (0, 0);
            for id in &ids {
                let Some(task) = self.task(id).cloned() else { continue };
                let ok = match task.state.as_str() {
                    "draft" if task.repo_path.is_some() => self.machine.start(id).is_ok(),
                    "paused_rate_limit" => self.machine.resume(id).is_ok(),
                    "awaiting_answers" | "escalated" | "reviewing_memory" => {
                        skipped += 1;
                        continue;
                    }
                    _ if task.waiting_on_you => self.machine.decide(id, true, None).is_ok(),
                    _ => {
                        skipped += 1;
                        continue;
                    }
                };
                if ok {
                    done += 1;
                }
            }
            self.marked.clear();
            let skip = if skipped > 0 { format!("; {skipped} need words from you or are running") } else { String::new() };
            self.notify(format!("advanced {done} of {}{skip}", ids.len()), false);
            return Outcome::Continue;
        }
        let action = match c {
            'X' => BulkAction::Abort,
            'w' => BulkAction::Worktree,
            _ => BulkAction::Delete,
        };
        let targets = bulk_targets(&self.tasks, &ids, action);
        if targets.is_empty() {
            self.notify("none of the marked tickets can take that", false);
        } else {
            self.mode = Mode::ConfirmMany { action, ids: targets };
        }
        Outcome::Continue
    }

    fn handle_confirm_many(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('y') => {
                let Mode::ConfirmMany { action, ids } = std::mem::replace(&mut self.mode, Mode::Normal) else {
                    return Outcome::Continue;
                };
                let mut done = 0;
                for id in &ids {
                    let ok = match action {
                        BulkAction::Abort => self.machine.abort(id).is_ok(),
                        BulkAction::Worktree => self.machine.remove_worktree(id).is_ok(),
                        BulkAction::Delete => self.machine.delete(id).map(|()| self.forget(id)).is_ok(),
                    };
                    if ok {
                        done += 1;
                    }
                }
                self.marked.clear();
                self.notify(format!("{} {done} of {}", action.done(), ids.len()), done < ids.len());
            }
            KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
    }

    /// `x` → `P`: every ticket paused on the usage window gets its stage re-run.
    fn resume_all_paused(&mut self) {
        let ids = paused_ids(&self.tasks);
        if ids.is_empty() {
            self.notify("nothing is paused", false);
            return;
        }
        let done = ids.iter().filter(|id| self.machine.resume(id).is_ok()).count();
        self.notify(format!("resumed {done} of {}", ids.len()), done < ids.len());
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
    /// Tab always switches panes (never a literal tab in either text), ctrl+s saves what
    /// changed in both, esc in either pane's normal mode cancels the whole editor.
    fn handle_edit_plan(&mut self, key: KeyEvent) -> Outcome {
        if key.code == KeyCode::Tab {
            if let Mode::EditPlan { focus, .. } = &mut self.mode {
                *focus = match focus {
                    PlanPane::Plan => PlanPane::Ticket,
                    PlanPane::Ticket => PlanPane::Plan,
                };
            }
            return Outcome::Continue;
        }
        let Mode::EditPlan { plan_area, ticket_area, focus, plan_vim, ticket_vim, .. } = &mut self.mode else {
            return Outcome::Continue;
        };
        let outcome = match focus {
            PlanPane::Plan => plan_vim.handle(plan_area, key),
            PlanPane::Ticket => ticket_vim.handle(ticket_area, key),
        };
        match outcome {
            crate::vim::Outcome::Continue => {}
            crate::vim::Outcome::Cancel => self.mode = Mode::Normal,
            crate::vim::Outcome::Save => self.save_plan_editor(),
        }
        Outcome::Continue
    }

    /// Saves whichever pane(s) changed: the plan via `PATCH .../plan`, the ticket via the
    /// usual `update`. Either can fail without undoing the other.
    fn save_plan_editor(&mut self) {
        let Mode::EditPlan { id, plan_area, ticket_area, .. } = &self.mode else {
            return;
        };
        let id = id.clone();
        let plan_markdown_text = plan_area.lines().join("
");
        let ticket_markdown_text = ticket_area.lines().join("
");
        self.mode = Mode::Normal;

        let Some(task) = self.task(&id).cloned() else {
            return;
        };
        let before_plan = self
            .detail
            .as_ref()
            .and_then(TaskDetail::open_approval)
            .map(|a| plan_edit_of(&a.requested))
            .unwrap_or_default();
        let edited_plan = parse_plan(&plan_markdown_text);
        let before_ticket = TicketText {
            title: task.title.clone(),
            description: task.description.clone(),
            criteria: task.criteria.clone(),
            repo_path: task.repo_path.clone(),
        };
        let edited_ticket = TicketText { repo_path: task.repo_path.clone(), ..parse_ticket(&ticket_markdown_text, &task.title) };

        let mut changed = false;
        if edited_plan != before_plan {
            changed = true;
            match self.machine.edit_plan(&id, &edited_plan) {
                Ok(task) => {
                    self.upsert(task);
                    self.detail_stale = true;
                }
                Err(error) => {
                    self.notify(error, true);
                    return;
                }
            }
        }
        if edited_ticket != before_ticket {
            changed = true;
            match self.machine.update(&id, &edited_ticket) {
                Ok(task) => self.upsert(task),
                Err(error) => {
                    self.notify(error, true);
                    return;
                }
            }
        }
        self.select(&id, true);
        self.notify(if changed { "saved" } else { "nothing changed" }, false);
    }

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
            if c == 'P' {
                self.resume_all_paused();
                return Outcome::Continue;
            }
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

    fn task_at(state: &str) -> Task {
        let json = format!(
            r#"{{"id":"t1","title":"Login page","description":"","criteria":[],
            "repoPath":null,"branch":null,"worktreePath":null,"state":"{state}","column":"Approved",
            "waitingOnYou":true,"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
        );
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn has_open_plan_true_only_for_awaiting_approval_with_an_open_gate() {
        let task = task_at("awaiting_approval");
        let detail: TaskDetail = serde_json::from_str(r#"{"task":{"id":"t1","title":"x","description":"","criteria":[],
            "repoPath":null,"branch":null,"worktreePath":null,"state":"awaiting_approval","column":"Approved",
            "waitingOnYou":true,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"},
            "stageRuns":[],"approvals":[{"requested":{"brief":"b"},"decision":null}],"events":[]}"#).unwrap();

        assert!(has_open_plan(&task, Some(&detail)));
        assert!(!has_open_plan(&task_at("draft"), Some(&detail)));
        assert!(!has_open_plan(&task, None));

        let mismatched = task_at("awaiting_approval");
        let other_detail: TaskDetail = serde_json::from_str(r#"{"task":{"id":"other","title":"x","description":"","criteria":[],
            "repoPath":null,"branch":null,"worktreePath":null,"state":"awaiting_approval","column":"Approved",
            "waitingOnYou":true,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"},
            "stageRuns":[],"approvals":[{"requested":{"brief":"b"},"decision":null}],"events":[]}"#).unwrap();
        assert!(!has_open_plan(&mismatched, Some(&other_detail)));
    }

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

    fn plan_editor() -> Mode {
        Mode::EditPlan {
            id: "t1".to_string(),
            plan_area: TextArea::new(vec!["# Plan".to_string()]),
            ticket_area: TextArea::new(vec!["# Ticket".to_string()]),
            focus: PlanPane::Plan,
            plan_vim: Vim::new(),
            ticket_vim: Vim::new(),
        }
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, ratatui::crossterm::event::KeyModifiers::NONE)
    }

    #[test]
    fn tab_switches_focus_between_the_plan_and_ticket_panes() {
        // SAFETY: every test here sets the same value, so a parallel run can't race on it.
        unsafe { std::env::set_var("HARDNESS_MACHINE_URL", "http://127.0.0.1:1") };
        let mut app = App::new(Machine::from_env());
        app.mode = plan_editor();

        app.handle_key(key(KeyCode::Tab));
        let Mode::EditPlan { focus, .. } = &app.mode else { panic!("still editing") };
        assert_eq!(*focus, PlanPane::Ticket);

        app.handle_key(key(KeyCode::Tab));
        let Mode::EditPlan { focus, .. } = &app.mode else { panic!("still editing") };
        assert_eq!(*focus, PlanPane::Plan);
    }

    #[test]
    fn esc_in_normal_mode_cancels_the_whole_plan_editor() {
        // SAFETY: every test here sets the same value, so a parallel run can't race on it.
        unsafe { std::env::set_var("HARDNESS_MACHINE_URL", "http://127.0.0.1:1") };
        let mut app = App::new(Machine::from_env());
        app.mode = plan_editor();

        app.handle_key(key(KeyCode::Esc));
        assert!(matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn ctrl_s_returns_to_normal_whether_or_not_the_save_reaches_the_machine() {
        // SAFETY: every test here sets the same value, so a parallel run can't race on it.
        unsafe { std::env::set_var("HARDNESS_MACHINE_URL", "http://127.0.0.1:1") };
        let mut app = App::new(Machine::from_env());
        app.mode = plan_editor();

        app.handle_key(KeyEvent::new(KeyCode::Char('s'), ratatui::crossterm::event::KeyModifiers::CONTROL));
        assert!(matches!(app.mode, Mode::Normal));
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
    fn the_filter_matches_the_repo_name_as_well_as_title_and_id() {
        let mut app = App::new(Machine::from_env());
        let mut task: Task = serde_json::from_str(
            r#"{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/Developer/projects/luna-tui","branch":null,"worktreePath":null,"state":"draft","column":"Intake",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}"#,
        )
        .unwrap();
        app.filter = "luna".into();
        assert!(app.passes_filter(&task), "the repo basename matches");
        app.filter = "projects".into();
        assert!(!app.passes_filter(&task), "only the basename, not the whole path");
        task.repo_path = None;
        app.filter = "luna".into();
        assert!(!app.passes_filter(&task));
    }

    #[test]
    fn a_ticket_reaching_a_gate_queues_a_notice_once_and_going_offline_queues_one() {
        let mut app = App::new(Machine::from_env());
        let json = |state: &str, waiting: bool| -> Task {
            serde_json::from_str(&format!(
                r#"{{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
                "repoPath":null,"branch":null,"worktreePath":null,"state":"{state}","column":"Build",
                "waitingOnYou":{waiting},"running":false,"queued":false,
                "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
                "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
            ))
            .unwrap()
        };
        app.upsert(json("implementing", false));
        assert!(app.take_notices().is_empty());
        app.upsert(json("awaiting_approval", true));
        let notices = app.take_notices();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].title, "Needs you");
        assert_eq!(app.needs_you_count(), 1);
        app.upsert(json("awaiting_approval", true));
        assert!(app.take_notices().is_empty(), "an update that stays at the gate is not news");

        app.online = true;
        app.went_offline("connection refused".into());
        app.went_offline("connection refused".into());
        let notices = app.take_notices();
        assert_eq!(notices.len(), 1, "offline is told once per outage");
        assert_eq!(notices[0].title, "Machine offline");
    }

    #[test]
    fn the_inbox_opens_with_i_moves_within_its_split_switches_splits_and_closes() {
        let mut app = App::new(Machine::from_env());
        for (id, state) in [("aaaaaaaa0000", "awaiting_approval"), ("bbbbbbbb0000", "awaiting_approval"), ("cccccccc0000", "escalated")] {
            app.tasks.push(serde_json::from_str(&format!(
                r#"{{"id":"{id}","title":"t","description":"","criteria":[],
                "repoPath":null,"branch":null,"worktreePath":null,"state":"{state}","column":"Build",
                "waitingOnYou":true,"running":false,"queued":false,
                "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
                "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
            )).unwrap());
        }
        let press = |app: &mut App, code: KeyCode| { app.handle_key(KeyEvent::from(code)); };
        press(&mut app, KeyCode::Char('I'));
        assert_eq!(app.inbox.as_ref().map(|i| i.split), Some(Split::Approve));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.inbox.as_ref().map(|i| i.cursor), Some(1), "two approve tickets: the cursor stops at the last");
        press(&mut app, KeyCode::Char('l'));
        assert_eq!(app.inbox.as_ref().map(|i| (i.split, i.cursor)), Some((Split::Review, 0)));
        press(&mut app, KeyCode::Char('3'));
        assert_eq!(app.inbox.as_ref().map(|i| i.split), Some(Split::Failed));
        press(&mut app, KeyCode::Char('A'));
        assert!(matches!(app.mode, Mode::ConfirmApproveAll(ref ids) if ids.len() == 2), "approve-all asks once, for the Approve split");
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal));
        press(&mut app, KeyCode::Esc);
        assert!(app.inbox.is_none());
    }

    fn ticket(id: &str, state: &str, running: bool, worktree: bool) -> Task {
        let wt = if worktree { "\"/wt\"" } else { "null" };
        let column = if state == "draft" { "Intake" } else { "Build" };
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","title":"t","description":"","criteria":[],
            "repoPath":"/r/app","branch":null,"worktreePath":{wt},"state":"{state}","column":"{column}",
            "waitingOnYou":false,"running":{running},"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn v_marks_a_ticket_capital_v_marks_the_column_and_esc_clears_the_marks() {
        let mut app = App::new(Machine::from_env());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.tasks.push(ticket("bbbbbbbb0000", "implementing", true, true));
        app.tasks.push(ticket("cccccccc0000", "draft", false, false));
        app.focus = app.tasks[0].column_index();
        let press = |app: &mut App, code: KeyCode| { app.handle_key(KeyEvent::from(code)); };
        press(&mut app, KeyCode::Char('v'));
        assert_eq!(app.marked.len(), 1);
        press(&mut app, KeyCode::Char('v'));
        assert!(app.marked.is_empty(), "v toggles");
        press(&mut app, KeyCode::Char('V'));
        assert_eq!(app.marked.len(), 2, "the Build column's two tickets");
        press(&mut app, KeyCode::Char('V'));
        assert!(app.marked.is_empty(), "V on a fully marked column unmarks it");
        press(&mut app, KeyCode::Char('V'));
        press(&mut app, KeyCode::Char('X'));
        assert!(matches!(&app.mode, Mode::ConfirmMany { action: BulkAction::Abort, ids } if ids.len() == 2), "X with marks asks once for the set");
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Esc);
        assert!(app.marked.is_empty(), "esc clears the marks");
    }

    #[test]
    fn bulk_targets_keep_only_the_tickets_the_action_applies_to() {
        let running = ticket("aaaaaaaa0000", "implementing", true, true);
        let idle = ticket("bbbbbbbb0000", "awaiting_approval", false, true);
        let bare = ticket("cccccccc0000", "draft", false, false);
        let tasks = vec![running.clone(), idle.clone(), bare.clone()];
        let all: Vec<String> = tasks.iter().map(|t| t.id.clone()).collect();
        assert_eq!(bulk_targets(&tasks, &all, BulkAction::Abort), vec![running.id.clone()]);
        assert_eq!(bulk_targets(&tasks, &all, BulkAction::Worktree), vec![idle.id.clone()], "a running worktree is not killed");
        assert_eq!(bulk_targets(&tasks, &all, BulkAction::Delete), all);
        assert_eq!(paused_ids(&tasks), Vec::<String>::new());
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
