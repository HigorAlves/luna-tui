//! Board state and everything that changes it: keys, machine calls and the event stream.
//! The machine owns the tickets; the board shows them and sends your decisions.

use std::{
    cell::{Cell, RefCell},
    process::Command,
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant},
};

use ratatui::{
    crossterm::event::{KeyCode, KeyEvent},
    layout::Rect,
};
use tui_textarea::TextArea;

use std::collections::BTreeSet;

use crate::detail::Section;
use crate::digest::{self, DigestState};
use crate::inbox::{self, InboxState, Split};
use crate::model::now_secs;
use crate::notify::{self, Notice};
use crate::pulls::{self, PrKey, PrSplit, PullsState};
use crate::{
    client::{Incoming, Machine},
    discover::{discover_folders, discover_repos, repos_root},
    herdr,
    model::{
        COLUMNS, Look, Metrics, PrAction, PrSnapshot, PullRequest, RepoMetrics, StreamMessage, Task, TaskDetail, TaskDiff, TicketText, answers_markdown, parse_answers,
        parse_plan, parse_ticket, plan_edit_of, plan_markdown, questions_of, short_id, ticket_markdown, Slots,
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
pub const ACTIONS: [(char, &str); 14] = [
    ('P', "resume every ticket paused on the usage window"),
    ('D', "drain / carry on: take no new work, or pick the queue back up"),
    ('+', "one more slot"),
    ('-', "one slot fewer"),
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

/// Which view `?` was pressed in: the sheet shows that view's keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelpFor {
    Board,
    Floor,
    Inbox,
    Digest,
    Detail,
    Pulls,
}

impl HelpFor {
    pub fn title(self) -> &'static str {
        match self {
            HelpFor::Board => " Keys · any key closes ",
            HelpFor::Floor => " Floor keys · any key closes ",
            HelpFor::Inbox => " Inbox keys · any key closes ",
            HelpFor::Digest => " Digest keys · any key closes ",
            HelpFor::Detail => " Ticket keys · any key closes ",
            HelpFor::Pulls => " Pulls keys · any key closes ",
        }
    }

    /// The keys that work in this view, as (keys, what they do).
    #[cfg(test)]
    pub fn keys(self) -> &'static [(&'static str, &'static str)] {
        match self {
            HelpFor::Board => HELP,
            HelpFor::Floor => FLOOR_HELP,
            HelpFor::Inbox => INBOX_HELP,
            HelpFor::Digest => DIGEST_HELP,
            HelpFor::Detail => DETAIL_HELP,
            HelpFor::Pulls => PULLS_HELP,
        }
    }

    /// The same keys as `keys()` (the board's also holds the `:` commands), grouped under headings.
    pub fn sections(self) -> &'static [HelpSection] {
        match self {
            HelpFor::Board => BOARD_SECTIONS,
            HelpFor::Floor => FLOOR_SECTIONS,
            HelpFor::Inbox => INBOX_SECTIONS,
            HelpFor::Digest => DIGEST_SECTIONS,
            HelpFor::Detail => DETAIL_SECTIONS,
            HelpFor::Pulls => PULLS_SECTIONS,
        }
    }
}

/// A heading and the (keys, what they do) rows under it.
#[derive(Clone, Copy, Debug)]
pub struct HelpSection {
    pub heading: &'static str,
    pub rows: &'static [(&'static str, &'static str)],
}

const fn section(heading: &'static str, rows: &'static [(&'static str, &'static str)]) -> HelpSection {
    HelpSection { heading, rows }
}

pub const BOARD_SECTIONS: &[HelpSection] = &[
    section(
        "Move",
        &[
            ("h / l", "previous / next column"),
            ("j / k", "previous / next ticket"),
            ("gg / G", "first / last ticket in the column"),
            ("1 … 8", "jump to that column"),
            ("] / [", "next / previous ticket that needs you, across the board"),
            ("enter", "open details"),
        ],
    ),
    section(
        "Ticket",
        &[
            ("n", "new ticket, then edit it in place"),
            ("e", "edit title, description and criteria in place (ctrl+s saves)"),
            ("R", "search for its repo under HARDNESS_REPOS_DIR / ~/Developer"),
            ("a", "advance: start, approve, answer triage in place (ctrl+s sends), retry an escalation, resume"),
            ("S", "ship: approve the Ship gate and open the PR (same as a there)"),
            ("A", "memory review: approve without applying the proposed rules"),
            ("r", "send the plan or tests back, with a reason"),
            ("X", "abort the running stage (asks first)"),
            ("w", "kill its worktree once you are done with it (asks first)"),
            ("d", "delete (asks first)"),
            ("f", "focus the agent's watch tab in herdr"),
            ("o", "open the linked GitHub issue in the browser"),
        ],
    ),
    section(
        "Filter & order",
        &[
            ("/", "filter by title, #id or repo"),
            ("!", "show only tickets that need you"),
            ("@", "show only tickets for this repo"),
            ("zc / zo", "fold / unfold the focused column (Done starts folded)"),
            ("zz", "fold every column but the focused one"),
            ("gs / gr / ga", "order columns by stage, by repo, by age"),
        ],
    ),
    section(
        "Views",
        &[
            ("F", "Floor: 7d and 30d metrics, a row per repo (tab focuses one, r refreshes, esc closes)"),
            ("I", "Inbox: what needs you, split by why; a/r/e act in place, A approves the split, enter opens"),
            ("D", "Digest: what changed since you last had the board open; enter jumps, o opens the PR"),
            ("P", "Pulls: every open PR involving you, split by what you do; m merges, c/v/t dispatch an agent"),
        ],
    ),
    section(
        "Marks & bulk",
        &[
            ("v / V", "mark the ticket / the column; a, X, d, w then act on the marked set"),
            ("x", "actions for the selected ticket (P resumes every paused one)"),
        ],
    ),
    section(
        "App",
        &[
            (":", "command palette: q, new, filter, repo, open, group, fold, setup, slots, drain, floor, inbox, digest, prs"),
            ("esc", "clear the filter"),
            ("?", "this help"),
            ("q", "quit"),
        ],
    ),
    section(
        "Commands (type after :)",
        &[
            ("q", "quit"),
            ("new <title>", "new ticket, then edit it in place"),
            ("filter <text>", "filter by title, #id or repo (bare: clear)"),
            ("repo <name>", "show only that repo"),
            ("open <#id>", "open a ticket by id prefix"),
            ("group stage|repo|age", "order columns"),
            ("fold / unfold", "fold / unfold the focused column"),
            ("setup <repo>", "propose the repo's luna.yaml (a name under HARDNESS_REPOS_DIR, or a path)"),
            ("slots <n>", "resize the pool"),
            ("drain / resume", "take no new work / carry on"),
            ("floor / inbox / digest / prs", "open that view"),
            ("help", "this sheet"),
        ],
    ),
];

pub const FLOOR_SECTIONS: &[HelpSection] = &[section(
    "Floor",
    &[
        ("tab / shift+tab", "focus the next / previous repo; the numbers follow"),
        ("r", "refresh"),
        ("esc", "close"),
    ],
)];

pub const INBOX_SECTIONS: &[HelpSection] = &[
    section(
        "Navigate",
        &[
            ("j / k", "previous / next ticket"),
            ("h / l", "previous / next split (1-5 jump)"),
            ("enter", "open the ticket"),
            ("esc", "close"),
        ],
    ),
    section(
        "Act",
        &[
            ("a", "advance: approve, answer, retry"),
            ("r", "send back with a reason"),
            ("e", "edit in place"),
            ("A", "approve every ticket in the split, after one yes"),
        ],
    ),
];

pub const DIGEST_SECTIONS: &[HelpSection] = &[section(
    "Digest",
    &[
        ("j / k", "previous / next entry"),
        ("enter", "jump to the ticket"),
        ("o", "open its PR or issue in the browser"),
        ("esc", "close"),
    ],
)];

pub const PULLS_SECTIONS: &[HelpSection] = &[
    section(
        "Move",
        &[
            ("j / k", "previous / next PR"),
            ("h / l", "previous / next split (1-6 jump)"),
            ("enter", "jump to its task on the board, else open the PR"),
            ("o", "open the PR in the browser"),
        ],
    ),
    section(
        "Act",
        &[
            ("m", "merge: squash and delete the branch, after a yes (Ready to merge only)"),
            ("c", "CI fix: an agent diagnoses the red run and pushes a fix"),
            ("v", "review: an agent posts line comments; approve / request changes waits for you"),
            ("t", "threads: an agent answers every unresolved review thread on your PR"),
            ("x", "the same actions as a menu, with why a key is off"),
        ],
    ),
    section("Other", &[("R", "poll GitHub now"), ("esc", "close")]),
];

pub const DETAIL_SECTIONS: &[HelpSection] = &[
    section(
        "Read",
        &[
            ("h / l, 1-8", "previous / next section: Overview, Plan, Tests, Runs, Diff, Evidence, PR, Activity"),
            ("j / k", "scroll the section, or pick a run / file where it lists them"),
            ("+", "toggle the popup between most of the screen and all of it"),
            ("esc", "close"),
        ],
    ),
    section(
        "Act",
        &[
            ("a", "advance: start, approve, answer, retry, resume"),
            ("S", "ship"),
            ("r", "send back with a reason"),
            ("e", "edit in place"),
            ("X / w / d", "abort / kill the worktree / delete (each asks)"),
            ("f", "focus its herdr tab"),
            ("o", "open the linked issue"),
        ],
    ),
];

#[cfg(test)]
pub const FLOOR_HELP: &[(&str, &str)] = &[
    ("tab / shift+tab", "focus the next / previous repo; the numbers follow"),
    ("r", "refresh"),
    ("esc", "close"),
];

#[cfg(test)]
pub const INBOX_HELP: &[(&str, &str)] = &[
    ("j / k", "previous / next ticket"),
    ("h / l", "previous / next split (1-5 jump)"),
    ("a", "advance: approve, answer, retry"),
    ("r", "send back with a reason"),
    ("e", "edit in place"),
    ("A", "approve every ticket in the split, after one yes"),
    ("enter", "open the ticket"),
    ("esc", "close"),
];

#[cfg(test)]
pub const PULLS_HELP: &[(&str, &str)] = &[
    ("j / k", "previous / next PR"),
    ("h / l", "previous / next split (1-6 jump)"),
    ("o", "open the PR in the browser"),
    ("enter", "jump to its task on the board, else open the PR"),
    ("m", "merge: squash and delete the branch, after a yes (Ready to merge only)"),
    ("c", "CI fix: an agent diagnoses the red run and pushes a fix"),
    ("v", "review: an agent posts line comments; approve / request changes waits for you"),
    ("t", "threads: an agent answers every unresolved review thread on your PR"),
    ("R", "poll GitHub now"),
    ("x", "the same actions as a menu, with why a key is off"),
    ("esc", "close"),
];

#[cfg(test)]
pub const DIGEST_HELP: &[(&str, &str)] = &[
    ("j / k", "previous / next entry"),
    ("enter", "jump to the ticket"),
    ("o", "open its PR or issue in the browser"),
    ("esc", "close"),
];

#[cfg(test)]
pub const DETAIL_HELP: &[(&str, &str)] = &[
    ("h / l, 1-8", "previous / next section: Overview, Plan, Tests, Runs, Diff, Evidence, PR, Activity"),
    ("j / k", "scroll the section, or pick a run / file where it lists them"),
    ("+", "toggle the popup between most of the screen and all of it"),
    ("a", "advance: start, approve, answer, retry, resume"),
    ("S", "ship"),
    ("r", "send back with a reason"),
    ("e", "edit in place"),
    ("X / w / d", "abort / kill the worktree / delete (each asks)"),
    ("f", "focus its herdr tab"),
    ("o", "open the linked issue"),
    ("esc", "close"),
];

/// What `:` understands. Typed as `:name args`.
#[cfg(test)]
pub const COMMANDS: &[(&str, &str)] = &[
    ("q", "quit"),
    ("new <title>", "new ticket, then edit it in place"),
    ("filter <text>", "filter by title, #id or repo (bare: clear)"),
    ("repo <name>", "show only that repo"),
    ("open <#id>", "open a ticket by id prefix"),
    ("group stage|repo|age", "order columns"),
    ("fold / unfold", "fold / unfold the focused column"),
    ("setup <repo>", "propose the repo's luna.yaml (a name under HARDNESS_REPOS_DIR, or a path)"),
    ("slots <n>", "resize the pool"),
    ("drain / resume", "take no new work / carry on"),
    ("floor / inbox / digest / prs", "open that view"),
    ("help", "this sheet"),
];

/// Keys shown in the help overlay, as (keys, what they do).
#[cfg(test)]
pub const HELP: &[(&str, &str)] = &[
    ("h / l", "previous / next column"),
    ("j / k", "previous / next ticket"),
    ("gg / G", "first / last ticket in the column"),
    ("1 … 8", "jump to that column"),
    ("] / [", "next / previous ticket that needs you, across the board"),
    ("enter", "open details"),
    ("n", "new ticket, then edit it in place"),
    ("e", "edit title, description and criteria in place (ctrl+s saves)"),
    ("R", "search for its repo under HARDNESS_REPOS_DIR / ~/Developer"),
    ("a", "advance: start, approve, answer triage in place (ctrl+s sends), retry an escalation, resume"),
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
    ("zc / zo", "fold / unfold the focused column (Done starts folded)"),
    ("zz", "fold every column but the focused one"),
    ("gs / gr / ga", "order columns by stage, by repo, by age"),
    ("F", "Floor: 7d and 30d metrics, a row per repo (tab focuses one, r refreshes, esc closes)"),
    ("I", "Inbox: what needs you, split by why; a/r/e act in place, A approves the split, enter opens"),
    ("D", "Digest: what changed since you last had the board open; enter jumps, o opens the PR"),
    ("P", "Pulls: every open PR involving you, split by what you do; m merges, c/v/t dispatch an agent"),
    ("v / V", "mark the ticket / the column; a, X, d, w then act on the marked set"),
    ("x", "actions for the selected ticket (P resumes every paused one)"),
    (":", "command palette: q, new, filter, repo, open, group, fold, setup, slots, drain, floor, inbox, digest, prs"),
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
    /// One row per repo over 7d; the table under the numbers.
    pub repos: Vec<RepoMetrics>,
    /// 0 is every repo; `i` is `repos[i - 1]`, and the numbers above are that repo's.
    pub cursor: usize,
}

impl FloorState {
    /// `None` for every repo; `Some(repo)` for one, where the repo may itself be `None`
    /// (the tasks with no repo).
    pub fn focused(&self) -> Option<Option<&str>> {
        if self.cursor == 0 {
            return None;
        }
        self.repos.get(self.cursor - 1).map(|r| r.repo.as_deref())
    }

    /// The focused repo's name for the header; `None` when every repo is in.
    pub fn focused_name(&self) -> Option<&str> {
        if self.cursor == 0 {
            return None;
        }
        self.repos.get(self.cursor - 1).map(RepoMetrics::name)
    }

    fn cycle(&mut self, by: isize) {
        let n = self.repos.len() + 1;
        self.cursor = (self.cursor as isize + by).rem_euclid(n as isize) as usize;
    }
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

/// A burst of events for the open ticket becomes one detail refetch, not one per event.
const DETAIL_DEBOUNCE: Duration = Duration::from_millis(300);

/// How the tickets inside a column are ordered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum GroupBy {
    /// Most urgent look first, then oldest created: the default.
    #[default]
    Stage,
    /// By repo name, then as Stage: one board reads per repo.
    Repo,
    /// Oldest created first, whatever the look.
    Age,
}

pub enum Mode {
    Normal,
    Adding(String),
    /// Typing the filter. The text lives in `App::filter`.
    Filter,
    /// Typing a `:` command; enter runs it, esc closes.
    Command(String),
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
    /// Answering triage's questions in place: the same markdown `$EDITOR` used to get,
    /// one `## Q:` heading per question with the recommended answer under it; ctrl+s sends.
    Answer {
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
    /// `m` on a ready PR: one yes, then the machine squash-merges it.
    ConfirmMerge { repo: String, number: u64 },
    /// A dispatch on a PR the machine has no checkout of: pick the folder to clone it into
    /// (the same filter-as-you-type list `R` uses, over folders); `then` runs once it lands.
    ClonePrompt {
        repo: String,
        query: String,
        all: Vec<String>,
        cursor: usize,
        then: PrAction,
    },
    /// `x` in the PR view: the keys for the selected PR, each with why it is off when it is.
    PrActions { cursor: usize },
    Help(HelpFor),
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
}

pub struct Toast {
    pub text: String,
    pub error: bool,
    at: Instant,
}

pub struct App {
    machine: Machine,
    stream: Receiver<Incoming>,
    /// Our end of the stream, for work that answers from another thread (the detail fetch).
    tx: Sender<Incoming>,
    /// The ticket whose detail is being fetched right now, if any.
    pub detail_pending: Option<String>,
    /// When the last detail fetch started: a burst of events coalesces into one refetch.
    detail_fetched_at: Option<Instant>,
    /// `indices()` per column for the current tasks, filter and order; see `order_key`.
    order_cache: RefCell<Option<(u64, Vec<Vec<usize>>)>>,
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
    /// The PR inbox as the machine last sent it; empty until the first `github.prs` event.
    pub prs: PrSnapshot,
    /// The PR view, open while this is `Some`.
    pub pulls: Option<PullsState>,
    /// A dispatch waiting for a clone to land: the PR's key and the action to run then.
    pending_dispatch: Option<(String, PrAction)>,
    /// Tickets marked with `v`/`V`: `a`, `X`, `d`, `w` act on all of them.
    pub marked: BTreeSet<String>,
    /// The stage pool as `/health` last reported it; None until the first answer.
    pub slots: Option<Slots>,
    /// The Digest view, open while this is `Some`.
    pub digest: Option<DigestState>,
    /// Columns folded to their header; Done starts folded, it grows forever.
    pub folded: BTreeSet<usize>,
    /// How tickets are ordered inside a column (`gs`/`gr`/`ga`).
    pub group: GroupBy,
    /// A two-key sequence in flight: `z` (fold) or `g` (group).
    prefix: Option<char>,
    /// When the board was last open (unix seconds): the Digest's since, the cards' new dot.
    pub last_seen_secs: Option<u64>,
    /// The repo this board defaults new tickets to, for the `@` filter. `None` if it
    /// isn't inside one.
    pub home_repo: Option<String>,
    /// Column rectangles from the last frame, for mouse clicks.
    pub column_rects: RefCell<Vec<(usize, Rect)>>,
    /// How far the open ticket's detail popup is scrolled. `ui` clamps it to the content's
    /// actual height, which only it knows (it depends on the terminal width).
    pub detail_scroll: Cell<u16>,
    /// Which section of the workspace popup is open, and the selected row in sections that
    /// have one (runs, files). `+` toggles the popup between most of the screen and all of it.
    pub detail_section: Section,
    pub detail_cursor: usize,
    pub detail_full: bool,
    /// The branch diff of the ticket whose popup is open, once fetched: (task id, diff).
    pub diff: Option<(String, TaskDiff)>,
    diff_pending: Option<(String, Option<String>)>,
    /// A diff fetch that failed for this ticket; no retry until the section is reopened.
    diff_failed: Option<String>,
    /// How far the help sheet is scrolled, and the furthest `ui` found it can scroll.
    pub help_scroll: Cell<u16>,
    pub help_max: Cell<u16>,
    /// The ticket whose Detail `?` was pressed in; closing the help returns to it.
    help_return: Option<String>,
    imported: bool,
}

impl App {
    pub fn new(machine: Machine) -> Self {
        let (tx, rx) = mpsc::channel();
        machine.follow_stream(tx.clone());
        let mut app = Self {
            machine,
            stream: rx,
            tx,
            detail_pending: None,
            detail_fetched_at: None,
            order_cache: RefCell::new(None),
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
            prs: PrSnapshot::default(),
            pulls: None,
            pending_dispatch: None,
            marked: BTreeSet::new(),
            slots: None,
            digest: None,
            folded: COLUMNS.iter().position(|c| *c == "Done").into_iter().collect(),
            group: GroupBy::default(),
            prefix: None,
            last_seen_secs: store::last_seen_secs_at(&store::state_path()),
            home_repo: herdr::workspace_repo(),
            column_rects: RefCell::new(Vec::new()),
            detail_scroll: Cell::new(0),
            detail_section: Section::Overview,
            detail_cursor: 0,
            detail_full: false,
            diff: None,
            diff_pending: None,
            diff_failed: None,
            help_scroll: Cell::new(0),
            help_max: Cell::new(0),
            help_return: None,
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
        self.slots = self.machine.health().ok().map(|h| h.slots);
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
                Incoming::Detail { id, detail } => {
                    if self.detail_pending.as_deref() == Some(id.as_str()) {
                        self.detail_pending = None;
                    }
                    let wanted = match &self.mode {
                        Mode::Detail(open) => open == &id,
                        _ => self.selected_id().as_deref() == Some(id.as_str()),
                    };
                    if wanted {
                        self.detail = detail;
                    }
                }
                Incoming::Diff { id, file, diff } => {
                    if self.diff_pending.as_ref().is_some_and(|(pending, _)| *pending == id) {
                        self.diff_pending = None;
                    }
                    match diff {
                        Ok(mut diff) => {
                            diff.file = file;
                            self.diff = Some((id, diff));
                        }
                        Err(error) => {
                            self.diff_failed = Some(id);
                            self.notify(format!("diff: {error}"), true);
                        }
                    }
                }
                Incoming::Message(StreamMessage::Updated { task }) => {
                    if self.shows_detail_of(&task.id) {
                        self.detail_stale = true;
                    }
                    if self.diff.as_ref().is_some_and(|(id, _)| *id == task.id) && task.running != self.task(&task.id).is_some_and(|t| t.running) {
                        // A stage started or ended: the branch may have moved.
                        self.diff = None;
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
                Incoming::Message(StreamMessage::BudgetAlert { alert }) => {
                    let line = alert.line();
                    self.notices.push(Notice { title: "Budget".to_string(), body: line.clone() });
                    self.notify(format!("budget: {line}"), alert.pct >= 100);
                }
                Incoming::Message(StreamMessage::Prs { snapshot }) => self.take_prs(snapshot),
            }
        }
    }

    /// A fresh PR snapshot: notices for the PRs that moved into a split that needs you, the
    /// dispatch a clone was holding, and the view's cursor kept inside its split.
    fn take_prs(&mut self, snapshot: PrSnapshot) {
        let before: std::collections::HashMap<String, Option<PrSplit>> =
            self.prs.prs.iter().map(|p| (p.key(), p.split_enum())).collect();
        for pr in &snapshot.prs {
            if let Some(notice) = notify::pr_notice(before.get(&pr.key()).copied().flatten(), pr) {
                self.notices.push(notice);
            }
        }
        self.prs = snapshot;
        if let Some(state) = self.pulls.as_mut() {
            state.cursor = state.cursor.min(pulls::items(&self.prs.prs, state.split).len().saturating_sub(1));
        }
        if let Some((key, action)) = self.pending_dispatch.clone()
            && let Some(pr) = self.prs.prs.iter().find(|p| p.key() == key && p.local_path.is_some()).cloned()
        {
            self.pending_dispatch = None;
            self.dispatch_pr(&pr, action);
        }
    }

    /// The PR under the cursor of the open PR view.
    pub fn pr_under_cursor(&self) -> Option<PullRequest> {
        let state = self.pulls.as_ref()?;
        let items = pulls::items(&self.prs.prs, state.split);
        items.get(state.cursor.min(items.len().saturating_sub(1))).map(|&i| self.prs.prs[i].clone())
    }

    /// Opens the workspace popup on `id`, on the section its open gate concerns.
    pub fn open_detail(&mut self, id: String) {
        self.detail_stale = true;
        self.detail_scroll.set(0);
        self.detail_cursor = 0;
        self.diff_failed = None;
        self.detail_section = self.task(&id).map(Section::for_task).unwrap_or_default();
        self.mode = Mode::Detail(id);
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
        let tickets = self.tasks.iter().filter(|t| matches!(t.look(), Look::NeedsYou | Look::Escalated)).count();
        let prs = self.prs.prs.iter().filter(|p| p.split_enum().is_some_and(PrSplit::needs_me)).count();
        tickets + prs
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
        // One fetch at a time, off the UI thread, and not more often than every 300ms: a burst
        // of events for the open ticket becomes one refetch instead of a frozen board.
        if self.detail_pending.is_some() {
            return;
        }
        if self.detail_stale && self.detail_fetched_at.is_some_and(|t| t.elapsed() < DETAIL_DEBOUNCE) {
            return;
        }
        let machine = self.machine.clone();
        let tx = self.tx.clone();
        let fetching = id.clone();
        thread::spawn(move || {
            let detail = machine.detail(&fetching).ok();
            let _ = tx.send(Incoming::Detail { id: fetching, detail });
        });
        self.detail_pending = Some(id);
        self.detail_fetched_at = Some(Instant::now());
        self.detail_stale = false;
    }

    /// Fetches the open ticket's diff while its Diff section shows: the file list first, then
    /// the selected file's patch, one request at a time, off the UI thread.
    pub fn ensure_diff(&mut self) {
        let Mode::Detail(id) = &self.mode else { return };
        if self.detail_section != Section::Diff || !self.online || self.diff_pending.is_some() {
            return;
        }
        let id = id.clone();
        if self.diff_failed.as_deref() == Some(id.as_str()) || self.task(&id).is_none_or(|t| t.branch.is_none()) {
            return;
        }
        let have = self.diff.as_ref().filter(|(for_id, _)| *for_id == id).map(|(_, d)| d);
        let file = match have {
            None => None,
            Some(diff) => {
                let wanted = diff.files.get(self.detail_cursor.min(diff.files.len().saturating_sub(1))).map(|f| f.path.clone());
                if wanted.is_none() || (diff.file == wanted && diff.patch.is_some()) {
                    return;
                }
                wanted
            }
        };
        let machine = self.machine.clone();
        let tx = self.tx.clone();
        let (fetching, wanted) = (id.clone(), file.clone());
        thread::spawn(move || {
            let diff = machine.diff(&fetching, wanted.as_deref());
            let _ = tx.send(Incoming::Diff { id: fetching, file: wanted, diff });
        });
        self.diff_pending = Some((id, file));
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
        let key = self.order_key();
        if let Some((cached_key, columns)) = self.order_cache.borrow().as_ref()
            && *cached_key == key
        {
            return columns.get(column).cloned().unwrap_or_default();
        }
        let columns: Vec<Vec<usize>> = (0..COLUMNS.len()).map(|c| self.order(c)).collect();
        let found = columns.get(column).cloned().unwrap_or_default();
        *self.order_cache.borrow_mut() = Some((key, columns));
        found
    }

    /// True when `indices()` would answer from the cache right now (tests).
    #[cfg(test)]
    pub fn order_cached(&self) -> bool {
        self.order_cache.borrow().as_ref().is_some_and(|(k, _)| *k == self.order_key())
    }

    /// Everything the order of a column depends on, hashed: the tasks (what sorts and filters
    /// them), the filter, the toggles, the group. Cheaper than sorting nine columns a frame.
    fn order_key(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for t in &self.tasks {
            (&t.id, &t.updated_at, &t.state, t.queued, t.running, t.waiting_on_you, &t.column, &t.repo_path, &t.created_at, &t.title).hash(&mut h);
        }
        (&self.filter, self.needs_only, self.this_repo_only, &self.home_repo, self.group as u8).hash(&mut h);
        h.finish()
    }

    fn order(&self, column: usize) -> Vec<usize> {
        let mut found: Vec<usize> = self
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.column_index() == column && self.passes_filter(t))
            .map(|(i, _)| i)
            .collect();
        let done = COLUMNS.iter().position(|c| *c == "Done");
        found.sort_by(|&a, &b| {
            let (a, b) = (&self.tasks[a], &self.tasks[b]);
            // Done reads newest first: the one that just closed is the one you want.
            if Some(column) == done {
                return b.created_at.cmp(&a.created_at);
            }
            match self.group {
                GroupBy::Stage => (a.look(), &a.created_at).cmp(&(b.look(), &b.created_at)),
                GroupBy::Repo => (a.repo_name(), a.look(), &a.created_at).cmp(&(b.repo_name(), b.look(), &b.created_at)),
                GroupBy::Age => a.created_at.cmp(&b.created_at),
            }
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
            "awaiting_answers" => self.open_answer_editor(id),
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
                if matches!(task.state.as_str(), "awaiting_setup" | "awaiting_approval" | "awaiting_test_check") {
                    self.mode = Mode::Reason {
                        id: id.to_string(),
                        approve: false,
                        text: String::new(),
                    };
                } else {
                    self.notify("only a setup, a plan or tests waiting for you can be sent back", false);
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
        if self.digest.is_some() && matches!(self.mode, Mode::Normal) {
            return self.handle_digest(key);
        }
        if self.pulls.is_some() && matches!(self.mode, Mode::Normal) {
            return self.handle_pulls(key);
        }
        match &self.mode {
            Mode::Normal => self.handle_normal(key),
            Mode::Detail(id) => {
                let id = id.clone();
                self.handle_detail(key, &id)
            }
            Mode::Adding(_) => self.handle_adding(key),
            Mode::EditTicket { .. } => self.handle_edit_ticket(key),
            Mode::Answer { .. } => self.handle_answer(key),
            Mode::EditPlan { .. } => self.handle_edit_plan(key),
            Mode::Filter => self.handle_filter(key),
            Mode::Command(_) => self.handle_command(key),
            Mode::Reason { .. } => self.handle_reason(key),
            Mode::ConfirmDelete(id) | Mode::ConfirmAbort(id) | Mode::ConfirmWorktree(id) => {
                let id = id.clone();
                self.handle_confirm(key, &id)
            }
            Mode::ConfirmApproveAll(_) => self.handle_confirm_approve_all(key),
            Mode::ConfirmMany { .. } => self.handle_confirm_many(key),
            Mode::Actions { .. } => self.handle_actions(key),
            Mode::RepoPicker { .. } => self.handle_repo_picker(key),
            Mode::ConfirmMerge { .. } => self.handle_confirm_merge(key),
            Mode::ClonePrompt { .. } => self.handle_clone_prompt(key),
            Mode::PrActions { .. } => self.handle_pr_actions(key),
            Mode::Help(_) => {
                let scroll = self.help_scroll.get();
                match key.code {
                    KeyCode::Char('j') | KeyCode::Down => {
                        self.help_scroll.set((scroll + 1).min(self.help_max.get()));
                    }
                    KeyCode::Char('k') | KeyCode::Up => self.help_scroll.set(scroll.saturating_sub(1)),
                    _ => {
                        self.help_scroll.set(0);
                        self.mode = match self.help_return.take() {
                            Some(id) => Mode::Detail(id),
                            None => Mode::Normal,
                        };
                    }
                }
                Outcome::Continue
            }
        }
    }

    /// Fetches both Floor windows, for every repo or the focused one, and the per-repo
    /// rows. A failure shows in the footer and keeps the old numbers.
    fn refresh_floor(&mut self) {
        let mut errors = Vec::new();
        let Some(repo) = self.floor.as_ref().map(FloorState::focused) else {
            return;
        };
        let focused = repo.is_some();
        let repo = repo.map(|r| r.map(str::to_string));
        let d7 = self.machine.metrics_for("7d", repo.as_ref().map(|r| r.as_deref()), !focused);
        let d30 = self.machine.metrics_for("30d", repo.as_ref().map(|r| r.as_deref()), false);
        // The rows are the 7d answer's when it covers every repo; one more call otherwise.
        let rows = if focused { Some(self.machine.metrics_for("7d", None, true)) } else { None };
        let Some(floor) = self.floor.as_mut() else {
            return;
        };
        match d7 {
            Ok(m) => {
                if let Some(by_repo) = m.by_repo.clone() {
                    floor.repos = by_repo;
                }
                floor.d7 = Some(m);
            }
            Err(e) => errors.push(e),
        }
        match d30 {
            Ok(m) => floor.d30 = Some(m),
            Err(e) => errors.push(e),
        }
        match rows {
            Some(Ok(m)) => floor.repos = m.by_repo.unwrap_or_default(),
            Some(Err(e)) => errors.push(e),
            None => {}
        }
        if floor.cursor > floor.repos.len() {
            floor.cursor = 0;
        }
        if let Some(error) = errors.into_iter().next() {
            self.notify(format!("floor: {error}"), true);
        }
    }

    fn handle_floor(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Esc | KeyCode::Char('F') | KeyCode::Char('q') => self.floor = None,
            KeyCode::Char('?') => self.mode = Mode::Help(HelpFor::Floor),
            KeyCode::Char('r') => self.refresh_floor(),
            KeyCode::Tab | KeyCode::BackTab => {
                if let Some(floor) = self.floor.as_mut() {
                    floor.cycle(if key.code == KeyCode::Tab { 1 } else { -1 });
                }
                if self.online {
                    self.refresh_floor();
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// The second key of `z…` (fold) and `g…` (group): `zc`/`zo` fold/unfold the focused
    /// column, `zz` the whole board; `gs`/`gr`/`ga` order columns by stage, repo or age.
    fn prefixed(&mut self, prefix: char, c: char) {
        match (prefix, c) {
            ('z', 'c') => {
                self.folded.insert(self.focus);
            }
            ('z', 'o') => {
                self.folded.remove(&self.focus);
            }
            ('z', 'z') => self.fold = !self.fold,
            ('g', 's') => self.group = GroupBy::Stage,
            ('g', 'r') => self.group = GroupBy::Repo,
            ('g', 'a') => self.group = GroupBy::Age,
            ('g', 'g') => self.selection[self.focus] = 0,
            _ => self.notify(format!("{prefix}{c} is not a key; zc/zo fold, zz folds all, gs/gr/ga group, gg top"), false),
        }
        self.clamp_selection();
    }

    /// `]` / `[`: the next / previous ticket that needs you, in board order (column, then row),
    /// wrapping around. Says so when nothing does.
    fn hop_needs_you(&mut self, forward: bool) {
        let mut stops: Vec<(usize, usize, String)> = Vec::new();
        for column in 0..COLUMNS.len() {
            for (row, &i) in self.indices(column).iter().enumerate() {
                let task = &self.tasks[i];
                if matches!(task.look(), Look::NeedsYou | Look::Escalated) {
                    stops.push((column, row, task.id.clone()));
                }
            }
        }
        if stops.is_empty() {
            return self.notify("nothing needs you", false);
        }
        let here = (self.focus, self.selection[self.focus]);
        let at_or_after = stops.iter().position(|(c, r, _)| (*c, *r) >= here);
        let next = if forward {
            match at_or_after {
                Some(i) if (stops[i].0, stops[i].1) == here => (i + 1) % stops.len(),
                Some(i) => i,
                None => 0,
            }
        } else {
            match at_or_after {
                Some(i) if i > 0 => i - 1,
                _ => stops.len() - 1,
            }
        };
        let (column, row, _) = &stops[next];
        self.focus = *column;
        self.selection[*column] = *row;
    }

    /// True when the ticket changed since the board was last open.
    pub fn is_new(&self, task: &Task) -> bool {
        digest::is_new(task, self.last_seen_secs)
    }

    /// The Digest's keys: move, jump to the ticket, open its PR, close.
    fn handle_digest(&mut self, key: KeyEvent) -> Outcome {
        let Some(state) = self.digest.clone() else {
            return Outcome::Continue;
        };
        let entries = digest::entries(&self.tasks, self.last_seen_secs);
        let under_cursor = entries.get(state.cursor.min(entries.len().saturating_sub(1))).map(|(_, i)| self.tasks[*i].id.clone());
        let mut next = state.clone();
        match key.code {
            KeyCode::Esc | KeyCode::Char('D') | KeyCode::Char('q') => {
                self.digest = None;
                return Outcome::Continue;
            }
            KeyCode::Char('?') => {
                self.mode = Mode::Help(HelpFor::Digest);
                return Outcome::Continue;
            }
            KeyCode::Char('j') | KeyCode::Down => next.cursor = (state.cursor + 1).min(entries.len().saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => next.cursor = state.cursor.saturating_sub(1),
            KeyCode::Enter => {
                if let Some(id) = under_cursor {
                    self.digest = None;
                    self.select(&id, true);
                    self.open_detail(id);
                }
                return Outcome::Continue;
            }
            KeyCode::Char('o') => {
                if let Some(id) = under_cursor {
                    self.open_pr_or_issue(&id);
                }
                return Outcome::Continue;
            }
            _ => {}
        }
        self.digest = Some(next);
        Outcome::Continue
    }

    /// Opens the ticket's PR (from its Ship gate) in the browser, else its issue, else says so.
    fn open_pr_or_issue(&mut self, id: &str) {
        let pr = self
            .machine
            .detail(id)
            .ok()
            .and_then(|d| d.approvals.iter().find_map(|a| a.requested["prUrl"].as_str().map(String::from)));
        let issue = self.task(id).and_then(|t| t.source.as_ref().map(|s| s.url.clone()));
        match pr.or(issue) {
            Some(url) => {
                let (program, args) = opener_command(&url);
                if Command::new(program).args(args).spawn().is_err() {
                    self.notify(format!("could not open {url}"), true);
                }
            }
            None => self.notify("no PR or issue linked to this ticket yet", false),
        }
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
            KeyCode::Char('?') => {
                self.mode = Mode::Help(HelpFor::Inbox);
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
                    self.open_detail(id);
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

    /// Opens the PR view, refreshing the snapshot from the machine when the stream has not sent one yet.
    fn open_pulls(&mut self) {
        if self.prs.polled_at.is_none()
            && let Ok(snapshot) = self.machine.prs()
        {
            self.take_prs(snapshot);
        }
        self.pulls = Some(PullsState::default());
    }

    /// The PR view's keys: move, switch split, open, merge, dispatch an agent, refresh.
    fn handle_pulls(&mut self, key: KeyEvent) -> Outcome {
        let Some(state) = self.pulls.clone() else {
            return Outcome::Continue;
        };
        let count = pulls::items(&self.prs.prs, state.split).len();
        let under = self.pr_under_cursor();
        let mut next = state.clone();
        match key.code {
            KeyCode::Esc | KeyCode::Char('P') | KeyCode::Char('q') => {
                self.pulls = None;
                return Outcome::Continue;
            }
            KeyCode::Char('?') => {
                self.mode = Mode::Help(HelpFor::Pulls);
                return Outcome::Continue;
            }
            KeyCode::Char('j') | KeyCode::Down => next.cursor = (state.cursor + 1).min(count.saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => next.cursor = state.cursor.saturating_sub(1),
            KeyCode::Char('l') | KeyCode::Right | KeyCode::Tab => {
                next.split = state.split.next();
                next.cursor = 0;
            }
            KeyCode::Char('h') | KeyCode::Left | KeyCode::BackTab => {
                next.split = state.split.prev();
                next.cursor = 0;
            }
            KeyCode::Char(d @ '1'..='6') => {
                next.split = PrSplit::ALL[(d as usize) - ('1' as usize)];
                next.cursor = 0;
            }
            KeyCode::Char('R') => {
                match self.machine.refresh_prs() {
                    Ok(snapshot) => {
                        self.take_prs(snapshot);
                        self.notify("polled GitHub", false);
                    }
                    Err(error) => self.notify(error, true),
                }
                return Outcome::Continue;
            }
            KeyCode::Char('o') => {
                if let Some(pr) = under {
                    self.open_url(&pr.url);
                }
                return Outcome::Continue;
            }
            KeyCode::Enter => {
                if let Some(pr) = under {
                    match pr.task.as_ref().map(|t| t.id.clone()) {
                        Some(id) if self.task(&id).is_some() => {
                            self.pulls = None;
                            self.select(&id, true);
                            self.open_detail(id);
                        }
                        _ => self.open_url(&pr.url),
                    }
                }
                return Outcome::Continue;
            }
            KeyCode::Char('x') => {
                if under.is_some() {
                    self.mode = Mode::PrActions { cursor: 0 };
                }
                return Outcome::Continue;
            }
            KeyCode::Char(c) => {
                if let (Some(pr), Some(key)) = (under, PrKey::ALL.iter().copied().find(|k| k.key() == c)) {
                    self.pr_key(key, &pr);
                }
                return Outcome::Continue;
            }
            _ => {}
        }
        self.pulls = Some(next);
        Outcome::Continue
    }

    /// Opens a URL in the browser, detached; says so when it cannot.
    fn open_url(&mut self, url: &str) {
        let (program, args) = opener_command(url);
        if Command::new(program).args(args).spawn().is_err() {
            self.notify(format!("could not open {url}"), true);
        }
    }

    /// One of `m`, `c`, `v`, `t` on a PR: the blocker as a toast, a merge confirm, or a dispatch
    /// (through the clone prompt when the machine has no checkout of the repo).
    fn pr_key(&mut self, key: PrKey, pr: &PullRequest) {
        if key != PrKey::Merge && pr.local_path.is_none() && pr.task.is_none() {
            if let Some(action) = key.action() {
                self.open_clone_prompt(pr, action);
            }
            return;
        }
        if let Some(why) = pulls::blocker(pr, key) {
            self.notify(why, false);
            return;
        }
        match key.action() {
            None => self.mode = Mode::ConfirmMerge { repo: pr.repo.clone(), number: pr.number },
            Some(action) => self.dispatch_pr(pr, action),
        }
    }

    fn dispatch_pr(&mut self, pr: &PullRequest, action: PrAction) {
        match self.machine.pr_action(&pr.repo, pr.number, action) {
            Ok(task) => {
                let id = task.id.clone();
                self.upsert(task);
                self.notify(format!("dispatched {} on {}: #{}", action.wire(), pr.key(), short_id(&id)), false);
            }
            Err(error) => self.notify(error, true),
        }
    }

    fn open_clone_prompt(&mut self, pr: &PullRequest, then: PrAction) {
        let all = repos_root().map(|root| discover_folders(&root)).unwrap_or_default();
        if all.is_empty() {
            self.notify(format!("no checkout of {}, and no HARDNESS_REPOS_DIR to clone into", pr.repo), true);
            return;
        }
        self.mode = Mode::ClonePrompt { repo: pr.repo.clone(), query: String::new(), all, cursor: 0, then };
    }

    fn handle_confirm_merge(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('y') => {
                let Mode::ConfirmMerge { repo, number } = std::mem::replace(&mut self.mode, Mode::Normal) else {
                    return Outcome::Continue;
                };
                match self.machine.merge_pr(&repo, number) {
                    Ok(()) => self.notify(format!("merged {repo}#{number}"), false),
                    Err(error) => self.notify(error, true),
                }
            }
            KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
    }

    /// The clone prompt: filter the folders, enter clones `<folder>/<name>` and holds the
    /// dispatch until the next snapshot shows the checkout, esc leaves the PR read-only.
    fn handle_clone_prompt(&mut self, key: KeyEvent) -> Outcome {
        let Mode::ClonePrompt { repo, query, all, cursor, then } = &mut self.mode else {
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
                let Some(folder) = matches.get(*cursor).map(|f| f.to_string()) else {
                    return Outcome::Continue;
                };
                let (repo, then) = (repo.clone(), *then);
                let name = repo.rsplit('/').next().unwrap_or(&repo).to_string();
                let dest = format!("{}/{name}", folder.trim_end_matches('/'));
                self.mode = Mode::Normal;
                match self.machine.clone_repo(&repo, &dest) {
                    Ok(()) => {
                        self.pending_dispatch = Some((repo.clone(), then));
                        self.notify(format!("cloning {repo} into {dest}; {} runs when it lands", then.wire()), false);
                    }
                    Err(error) => self.notify(error, true),
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// `x` in the PR view: a menu of the four keys, each line saying why it is off when it is.
    fn handle_pr_actions(&mut self, key: KeyEvent) -> Outcome {
        let Mode::PrActions { cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        let mut chosen = None;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => *cursor = (*cursor + 1).min(PrKey::ALL.len() - 1),
            KeyCode::Up | KeyCode::Char('k') => *cursor = cursor.saturating_sub(1),
            KeyCode::Enter => chosen = Some(PrKey::ALL[*cursor]),
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            KeyCode::Char(c) => chosen = PrKey::ALL.iter().copied().find(|k| k.key() == c),
            _ => {}
        }
        if let Some(key) = chosen {
            self.mode = Mode::Normal;
            if let Some(pr) = self.pr_under_cursor() {
                self.pr_key(key, &pr);
            }
        }
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
        if let Some(prefix) = self.prefix.take() {
            if let KeyCode::Char(c) = key.code {
                self.prefixed(prefix, c);
            }
            return Outcome::Continue;
        }
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
            KeyCode::Char('z') | KeyCode::Char('g') => {
                if let KeyCode::Char(c) = key.code {
                    self.prefix = Some(c);
                }
            }
            KeyCode::Char('G') => {
                self.selection[self.focus] = self.indices(self.focus).len().saturating_sub(1);
            }
            KeyCode::Char(d @ '1'..='8') => {
                let column = (d as usize) - ('1' as usize);
                if column < COLUMNS.len() {
                    self.focus = column;
                }
            }
            KeyCode::Char(']') => self.hop_needs_you(true),
            KeyCode::Char('[') => self.hop_needs_you(false),
            KeyCode::Char('F') => {
                self.floor = Some(FloorState::default());
                self.refresh_floor();
            }
            KeyCode::Char('I') => self.inbox = Some(InboxState::default()),
            KeyCode::Char('D') => self.digest = Some(DigestState::default()),
            KeyCode::Char('P') => self.open_pulls(),
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
            KeyCode::Char('?') => self.mode = Mode::Help(HelpFor::Board),
            KeyCode::Char(':') => self.mode = Mode::Command(String::new()),
            KeyCode::Esc => {
                self.filter.clear();
                self.needs_only = false;
                self.this_repo_only = false;
                self.marked.clear();
                self.clamp_selection();
            }
            KeyCode::Enter => {
                if let Some(id) = self.selected_id() {
                    self.open_detail(id);
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

    /// `x` → `D`, `+`, `-`: drain or carry on, grow or shrink the pool.
    fn pool_key(&mut self, c: char) {
        let draining = self.slots.as_ref().is_some_and(|s| s.draining);
        let max = self.slots.as_ref().map_or(1, |s| s.max);
        let result = match c {
            'D' if draining => self.machine.resume_claims().map(|s| (s, "carrying on: the queue is picked up again")),
            'D' => self.machine.drain().map(|s| (s, "draining: running stages finish, nothing new is claimed")),
            '+' => self.machine.set_slots(max + 1).map(|s| (s, "one more slot")),
            _ if max <= 1 => Err("already at one slot".to_string()),
            _ => self.machine.set_slots(max - 1).map(|s| (s, "one slot fewer")),
        };
        match result {
            Ok((slots, done)) => {
                self.slots = Some(slots);
                self.notify(done, false);
            }
            Err(error) => self.notify(error, true),
        }
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
            KeyCode::Char('j') | KeyCode::Down => self.move_in_detail(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_in_detail(-1),
            KeyCode::Char('l') | KeyCode::Right | KeyCode::Tab => self.set_section(self.detail_section.next()),
            KeyCode::Char('h') | KeyCode::Left | KeyCode::BackTab => self.set_section(self.detail_section.prev()),
            KeyCode::Char(digit @ '1'..='8') => {
                if let Some(section) = Section::from_digit(digit) {
                    self.set_section(section);
                }
            }
            KeyCode::Char('+') | KeyCode::Char('=') => self.detail_full = !self.detail_full,
            KeyCode::Char('?') => {
                self.help_return = Some(id.to_string());
                self.mode = Mode::Help(HelpFor::Detail);
            }
            KeyCode::Char(c) => return self.ticket_key(c, id),
            _ => {}
        }
        Outcome::Continue
    }

    /// Switches the popup's section; each starts at the top with the first row selected.
    fn set_section(&mut self, section: Section) {
        if section != self.detail_section {
            self.detail_section = section;
            self.detail_scroll.set(0);
            self.detail_cursor = 0;
            self.diff_failed = None;
        }
    }

    /// `j`/`k` in the popup: the next row where the section has rows, else a line of scroll.
    fn move_in_detail(&mut self, delta: i16) {
        if self.detail_section.has_cursor() {
            let rows = self.detail_rows();
            let next = (self.detail_cursor as i64 + i64::from(delta)).clamp(0, rows.saturating_sub(1) as i64);
            self.detail_cursor = next as usize;
        } else {
            self.scroll_detail(delta);
        }
    }

    /// How many rows the open section's cursor can land on.
    fn detail_rows(&self) -> usize {
        let detail = self.detail.as_ref().filter(|d| matches!(&self.mode, Mode::Detail(id) if *id == d.task.id));
        match self.detail_section {
            Section::Runs => detail.map_or(0, |d| d.stage_runs.len()),
            Section::Evidence => detail.map_or(0, |d| d.artifacts.len()),
            Section::Diff => self.diff.as_ref().map_or(0, |(_, d)| d.files.len()),
            _ => 0,
        }
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

    /// Typing a `:` command.
    fn handle_command(&mut self, key: KeyEvent) -> Outcome {
        let Mode::Command(text) = &mut self.mode else {
            return Outcome::Continue;
        };
        match key.code {
            KeyCode::Char(c) => text.push(c),
            KeyCode::Backspace => {
                if text.pop().is_none() {
                    self.mode = Mode::Normal;
                }
            }
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                let line = text.trim().to_string();
                self.mode = Mode::Normal;
                return self.run_command(&line);
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// Runs one palette command: `name` and whatever follows it.
    fn run_command(&mut self, line: &str) -> Outcome {
        let (name, rest) = line.split_once(char::is_whitespace).map_or((line, ""), |(n, r)| (n, r.trim()));
        match name {
            "" => {}
            "q" | "quit" => return Outcome::Quit,
            "new" if rest.is_empty() => self.mode = Mode::Adding(String::new()),
            "new" => {
                self.mode = Mode::Adding(rest.to_string());
                return self.handle_adding(KeyEvent::from(KeyCode::Enter));
            }
            "filter" => {
                self.filter = rest.to_string();
                self.needs_only = false;
                self.clamp_selection();
            }
            "repo" => {
                self.filter = rest.to_string();
                self.clamp_selection();
            }
            "open" => {
                let wanted = rest.trim_start_matches('#');
                match self.tasks.iter().find(|t| !wanted.is_empty() && t.id.starts_with(wanted)).map(|t| t.id.clone()) {
                    Some(id) => {
                        self.select(&id, true);
                        self.open_detail(id);
                    }
                    None => self.notify(format!("no ticket starts with #{wanted}"), true),
                }
            }
            "group" => match rest {
                "stage" => self.group = GroupBy::Stage,
                "repo" => self.group = GroupBy::Repo,
                "age" => self.group = GroupBy::Age,
                _ => self.notify("group takes stage, repo or age", true),
            },
            "fold" => {
                self.folded.insert(self.focus);
            }
            "unfold" => {
                self.folded.remove(&self.focus);
            }
            "setup" => match setup_repo_path(rest, repos_root()) {
                Ok(path) => {
                    let path = path.to_string_lossy().into_owned();
                    self.act(|m| m.setup_repo(&path), "setup started: approve its luna.yaml when it asks");
                }
                Err(error) => self.notify(error, true),
            },
            "slots" => match rest.parse::<u64>() {
                Ok(n) if n >= 1 => match self.machine.set_slots(n) {
                    Ok(slots) => {
                        self.slots = Some(slots);
                        self.notify(format!("{n} slot(s)"), false);
                    }
                    Err(error) => self.notify(error, true),
                },
                _ => self.notify("slots takes a number, e.g. :slots 3", true),
            },
            "drain" => self.pool_key('D'),
            "resume" => match self.machine.resume_claims() {
                Ok(slots) => {
                    self.slots = Some(slots);
                    self.notify("carrying on: the queue is picked up again", false);
                }
                Err(error) => self.notify(error, true),
            },
            "floor" => {
                self.floor = Some(FloorState::default());
                self.refresh_floor();
            }
            "inbox" => self.inbox = Some(InboxState::default()),
            "digest" => self.digest = Some(DigestState::default()),
            "prs" | "pulls" => self.open_pulls(),
            "help" | "?" => self.mode = Mode::Help(HelpFor::Board),
            other => self.notify(format!("unknown command: {other} (try :help)"), true),
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
            if matches!(c, 'D' | '+' | '-') {
                self.pool_key(c);
                return Outcome::Continue;
            }
            if let Some(id) = self.selected_id() {
                return self.ticket_key(c, &id);
            }
        }
        Outcome::Continue
    }

    /// Opens triage's questions in place, each with its recommended answer ready to edit.
    /// The questions come from the ticket's detail: the one already shown, or fetched now.
    fn open_answer_editor(&mut self, id: &str) {
        let detail = if self.shows_detail_of(id) {
            self.detail.clone()
        } else {
            match self.machine.detail(id) {
                Ok(detail) => Some(detail),
                Err(error) => return self.notify(error, true),
            }
        };
        let Some(detail) = detail else {
            return;
        };
        let questions = detail.open_approval().map(questions_of).unwrap_or_default();
        if questions.is_empty() {
            return self.notify("triage left no questions to answer", true);
        }
        let title = format!(" answers for #{} {} ", detail.task.short_id(), detail.task.title);
        let mut area = TextArea::new(answers_markdown(&detail.task, &questions).lines().map(str::to_string).collect());
        area.move_cursor(tui_textarea::CursorMove::Jump(0, 0));
        area.set_block(
            ratatui::widgets::Block::bordered()
                .padding(ratatui::widgets::Padding::new(2, 2, 1, 1))
                .title(title),
        );
        self.mode = Mode::Answer { id: id.to_string(), area, vim: Vim::new() };
    }

    /// The answer editor's keys: vim moves and edits, ctrl+s sends, esc in normal mode cancels.
    fn handle_answer(&mut self, key: KeyEvent) -> Outcome {
        let Mode::Answer { id, area, vim } = &mut self.mode else {
            return Outcome::Continue;
        };
        match vim.handle(area, key) {
            crate::vim::Outcome::Continue => {}
            crate::vim::Outcome::Cancel => self.mode = Mode::Normal,
            crate::vim::Outcome::Save => {
                let id = id.clone();
                let markdown = area.lines().join("\n");
                self.mode = Mode::Normal;
                let answers = parse_answers(&markdown);
                if answers.is_empty() || answers.iter().any(|(_, a)| a.is_empty()) {
                    self.notify("answer every question, keeping the `## Q:` lines", true);
                    return Outcome::Continue;
                }
                self.act(|m| m.answer(&id, &answers), "answers sent; triage runs again");
            }
        }
        Outcome::Continue
    }
}

/// The checkout `:setup <repo>` means: a path as given when it is absolute (or starts with
/// `~`, `.`), otherwise a name under the repos root. It must exist and hold a `.git`.
fn setup_repo_path(arg: &str, root: Option<std::path::PathBuf>) -> Result<std::path::PathBuf, String> {
    let arg = arg.trim();
    if arg.is_empty() {
        return Err("setup takes a repo: a name under HARDNESS_REPOS_DIR / ~/Developer, or a path".to_string());
    }
    let path = if let Some(rest) = arg.strip_prefix("~/") {
        std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(rest)).ok_or("HOME is not set")?
    } else if arg.starts_with('/') || arg.starts_with('.') {
        std::path::PathBuf::from(arg)
    } else {
        root.ok_or("HARDNESS_REPOS_DIR / HOME is not set; give a path")?.join(arg)
    };
    if !path.join(".git").exists() {
        return Err(format!("{} is not a git checkout", path.display()));
    }
    Ok(path)
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
    fn setup_resolves_a_name_under_the_repos_root_and_a_path_as_given_and_refuses_what_is_not_a_checkout() {
        let root = std::env::temp_dir().join(format!("luna-setup-{}", std::process::id()));
        let repo = root.join("app");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        assert_eq!(setup_repo_path("app", Some(root.clone())).unwrap(), repo);
        assert_eq!(setup_repo_path(&repo.to_string_lossy(), None).unwrap(), repo);
        assert!(setup_repo_path("missing", Some(root.clone())).unwrap_err().contains("not a git checkout"));
        assert!(setup_repo_path("", Some(root.clone())).unwrap_err().contains("setup takes a repo"));
        assert!(setup_repo_path("app", None).unwrap_err().contains("give a path"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_setup_command_asks_the_machine_and_reports_its_answer() {
        let root = std::env::temp_dir().join(format!("luna-setup-cmd-{}", std::process::id()));
        std::fs::create_dir_all(root.join("app").join(".git")).unwrap();
        let mut app = App::new(Machine::from_env());
        type_command(&mut app, &format!("setup {}", root.join("app").display()));
        // Offline machine: the call fails and the toast carries the error, which proves it was made.
        assert!(app.toast.as_ref().is_some_and(|t| t.error), "an offline machine answers with an error toast: {:?}", app.toast.as_ref().map(|t| &t.text));
        type_command(&mut app, "setup");
        assert!(app.toast.as_ref().is_some_and(|t| t.text.contains("setup takes a repo")), "{:?}", app.toast.as_ref().map(|t| &t.text));
        std::fs::remove_dir_all(&root).unwrap();
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
    fn a_ticket_is_new_when_it_changed_after_the_board_was_last_open() {
        let mut app = App::new(Machine::from_env());
        let closed = ticket("aaaaaaaa0000", "closed", false, false);
        app.last_seen_secs = None;
        assert!(!app.is_new(&closed), "a first run has no since");
        app.last_seen_secs = crate::model::unix_secs("2026-10-22T21:00:00Z");
        assert!(app.is_new(&closed));
        app.last_seen_secs = crate::model::unix_secs("2026-10-23T21:00:00Z");
        assert!(!app.is_new(&closed));
    }

    #[test]
    fn the_digest_opens_with_d_moves_and_closes() {
        let mut app = App::new(Machine::from_env());
        app.last_seen_secs = crate::model::unix_secs("2026-10-22T21:00:00Z");
        app.tasks.push(ticket("aaaaaaaa0000", "closed", false, false));
        app.tasks.push(ticket("bbbbbbbb0000", "escalated", false, false));
        let press = |app: &mut App, code: KeyCode| { app.handle_key(KeyEvent::from(code)); };
        press(&mut app, KeyCode::Char('D'));
        assert_eq!(app.digest.as_ref().map(|d| d.cursor), Some(0));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.digest.as_ref().map(|d| d.cursor), Some(1), "two entries: the cursor stops at the last");
        press(&mut app, KeyCode::Esc);
        assert!(app.digest.is_none());
    }

    #[test]
    fn done_is_folded_by_default_and_sorted_newest_first_and_z_prefix_folds_a_column() {
        let mut app = App::new(Machine::from_env());
        let done = COLUMNS.iter().position(|c| *c == "Done").unwrap();
        assert!(app.folded.contains(&done), "Done starts folded");
        let mut old = ticket("aaaaaaaa0000", "closed", false, false);
        old.column = "Done".into();
        old.created_at = "2026-10-20T10:00:00.000Z".into();
        let mut new = ticket("bbbbbbbb0000", "closed", false, false);
        new.column = "Done".into();
        new.created_at = "2026-10-22T10:00:00.000Z".into();
        app.tasks.push(old);
        app.tasks.push(new);
        let ids: Vec<&str> = app.indices(done).iter().map(|&i| app.tasks[i].id.as_str()).collect();
        assert_eq!(ids, vec!["bbbbbbbb0000", "aaaaaaaa0000"], "newest first in Done");
        app.focus = done;
        let press = |app: &mut App, code: KeyCode| { app.handle_key(KeyEvent::from(code)); };
        press(&mut app, KeyCode::Char('z'));
        press(&mut app, KeyCode::Char('o'));
        assert!(!app.folded.contains(&done), "zo unfolds");
        press(&mut app, KeyCode::Char('z'));
        press(&mut app, KeyCode::Char('c'));
        assert!(app.folded.contains(&done), "zc folds");
        press(&mut app, KeyCode::Char('z'));
        press(&mut app, KeyCode::Char('z'));
        assert!(app.fold, "zz folds the whole board");
    }

    #[test]
    fn g_prefix_groups_a_column_by_stage_repo_or_age() {
        let mut app = App::new(Machine::from_env());
        let mut a = ticket("aaaaaaaa0000", "implementing", true, true);
        a.repo_path = Some("/r/zeta".into());
        a.created_at = "2026-10-22T10:00:00.000Z".into();
        let mut b = ticket("bbbbbbbb0000", "implementing", true, true);
        b.repo_path = Some("/r/alpha".into());
        b.created_at = "2026-10-21T10:00:00.000Z".into();
        app.tasks.push(a);
        app.tasks.push(b);
        let build = app.tasks[0].column_index();
        let ids = |app: &App| app.indices(build).iter().map(|&i| app.tasks[i].id.clone()).collect::<Vec<String>>();
        assert_eq!(ids(&app), ["bbbbbbbb0000", "aaaaaaaa0000"], "by stage: same look, oldest created first");
        let press = |app: &mut App, code: KeyCode| { app.handle_key(KeyEvent::from(code)); };
        press(&mut app, KeyCode::Char('g'));
        press(&mut app, KeyCode::Char('r'));
        assert_eq!(app.group, GroupBy::Repo);
        assert_eq!(ids(&app), ["bbbbbbbb0000", "aaaaaaaa0000"], "alpha before zeta");
        app.tasks[1].repo_path = Some("/r/zz".into());
        assert_eq!(ids(&app), ["aaaaaaaa0000", "bbbbbbbb0000"], "repo name decides");
        press(&mut app, KeyCode::Char('g'));
        press(&mut app, KeyCode::Char('a'));
        assert_eq!(app.group, GroupBy::Age);
        assert_eq!(ids(&app), ["bbbbbbbb0000", "aaaaaaaa0000"], "oldest first, whatever the look");
        press(&mut app, KeyCode::Char('g'));
        press(&mut app, KeyCode::Char('s'));
        assert_eq!(app.group, GroupBy::Stage);
    }

    #[test]
    fn the_detail_is_fetched_off_the_ui_thread_and_lands_through_the_stream() {
        let mut app = App::new(Machine::from_env());
        app.online = true;
        let task = ticket("aaaaaaaa0000", "awaiting_approval", false, false);
        app.tasks.push(task.clone());
        app.mode = Mode::Detail(task.id.clone());
        app.detail_stale = true;
        let before = std::time::Instant::now();
        app.ensure_detail();
        assert!(before.elapsed() < std::time::Duration::from_millis(100), "ensure_detail must not block on the machine");
        assert_eq!(app.detail_pending.as_deref(), Some(task.id.as_str()));
        app.ensure_detail();
        assert_eq!(app.detail_pending.as_deref(), Some(task.id.as_str()), "one fetch in flight at a time");
        let detail: TaskDetail = serde_json::from_str(&format!(
            r#"{{"task":{},"stageRuns":[],"approvals":[],"events":[]}}"#,
            serde_json::to_string(&serde_json::json!({
                "id": task.id, "title": "t", "description": "", "criteria": [], "repoPath": null, "branch": null,
                "worktreePath": null, "state": "awaiting_approval", "column": "Triage", "waitingOnYou": true,
                "running": false, "queued": false, "retries": {"verify":0,"e2e":0,"ci":0,"total":0}, "resumeTo": null,
                "reason": null, "createdAt": "2026-10-22T23:24:22.089Z", "updatedAt": "2026-10-22T23:24:22.089Z"
            })).unwrap()
        )).unwrap();
        app.tx.send(Incoming::Detail { id: task.id.clone(), detail: Some(detail) }).unwrap();
        app.pump();
        assert!(app.detail_pending.is_none());
        assert!(app.shows_detail_of(&task.id), "the answer landed");
    }

    #[test]
    fn tab_in_the_floor_cycles_through_all_then_each_repo() {
        let mut app = App::new(Machine::from_env());
        app.floor = Some(FloorState::default());
        let repos: Vec<crate::model::RepoMetrics> = serde_json::from_str(
            r#"[{"repo":"/r/alpha","tasks":{"created":1,"closed":0,"open":1,"waitingOnYou":0,"running":0,"queued":0},
                 "escalationRate":null,"firstPassVerifying":null,"costUsd":0},
                {"repo":null,"tasks":{"created":1,"closed":0,"open":1,"waitingOnYou":0,"running":0,"queued":0},
                 "escalationRate":null,"firstPassVerifying":null,"costUsd":0}]"#,
        )
        .unwrap();
        app.floor.as_mut().unwrap().repos = repos;
        assert_eq!(app.floor.as_ref().unwrap().focused(), None);
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.floor.as_ref().unwrap().focused(), Some(Some("/r/alpha")));
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.floor.as_ref().unwrap().focused(), Some(None), "the tasks with no repo");
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.floor.as_ref().unwrap().focused(), None, "back to all");
        app.handle_key(KeyEvent::from(KeyCode::BackTab));
        assert_eq!(app.floor.as_ref().unwrap().focused(), Some(None));
    }

    #[test]
    fn a_budget_alert_becomes_a_notice_and_a_toast_that_turns_red_at_the_ceiling() {
        let mut app = App::new(Machine::from_env());
        let alert = |pct: u8| {
            serde_json::from_str::<StreamMessage>(&format!(
                r#"{{"type":"budget.alert","alert":{{"scope":"repo","taskId":"aaaaaaaa0000","repo":"/r/luna-tui","pct":{pct},"spentUsd":18,"limitUsd":20}}}}"#
            ))
            .unwrap()
        };
        app.tx.send(Incoming::Message(alert(90))).unwrap();
        app.pump();
        let notices = app.take_notices();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].title, "Budget");
        assert_eq!(notices[0].body, "repo luna-tui at 90%: $18.00 of $20.00 this month");
        let toast = app.toast.as_ref().expect("a toast");
        assert!(!toast.error);
        app.tx.send(Incoming::Message(alert(100))).unwrap();
        app.pump();
        assert!(app.toast.as_ref().unwrap().error, "the ceiling itself reads as an error");
    }

    fn questions_detail(id: &str) -> TaskDetail {
        serde_json::from_str(&format!(
            r#"{{"task":{{"id":"{id}","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/app","branch":null,"worktreePath":null,"state":"awaiting_answers","column":"Triage",
            "waitingOnYou":true,"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}},
            "stageRuns":[],"approvals":[{{"requested":{{"questions":[
              {{"question":"Email or username?","recommended":"email"}},
              {{"question":"Remember me?","recommended":"yes, 30 days"}}]}},"decision":null}}],"events":[]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn a_on_a_ticket_awaiting_answers_opens_the_answers_in_place_and_ctrl_s_sends_them() {
        let mut app = App::new(Machine::from_env());
        let mut task = ticket("aaaaaaaa0000", "awaiting_answers", false, false);
        task.waiting_on_you = true;
        app.tasks.push(task);
        app.detail = Some(questions_detail("aaaaaaaa0000"));
        app.toast = None;
        app.ticket_key('a', "aaaaaaaa0000");
        let Mode::Answer { id, area, .. } = &app.mode else { panic!("expected the answer editor") };
        assert_eq!(id, "aaaaaaaa0000");
        let text = area.lines().join("\n");
        assert!(text.contains("## Q: Email or username?") && text.contains("yes, 30 days"), "{text}");

        // Saving as recommended sends two answers; the machine is offline here, so the toast says so.
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), ratatui::crossterm::event::KeyModifiers::CONTROL));
        assert!(matches!(app.mode, Mode::Normal));
        assert!(app.toast.as_ref().is_some_and(|t| t.error), "offline machine: an error toast, no panic");

        // An emptied answer is refused before anything is sent.
        app.toast = None;
        app.ticket_key('a', "aaaaaaaa0000");
        if let Mode::Answer { area, .. } = &mut app.mode {
            let lines: Vec<String> = area.lines().iter().map(|l| if l == "email" { String::new() } else { l.clone() }).collect();
            *area = TextArea::new(lines);
        }
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), ratatui::crossterm::event::KeyModifiers::CONTROL));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("answer every question, keeping the `## Q:` lines"));
    }

    #[test]
    fn gg_and_g_jump_within_the_column_and_a_digit_jumps_to_that_column() {
        let mut app = App::new(Machine::from_env());
        for (i, id) in ["aaaaaaaa0000", "bbbbbbbb0000", "cccccccc0000"].iter().enumerate() {
            let mut t = ticket(id, "implementing", true, true);
            t.created_at = format!("2026-10-2{i}T00:00:00.000Z");
            app.tasks.push(t);
        }
        let build = app.tasks[0].column_index();
        app.focus = build;
        app.handle_key(KeyEvent::from(KeyCode::Char('G')));
        assert_eq!(app.selection[build], 2);
        app.handle_key(KeyEvent::from(KeyCode::Char('g')));
        app.handle_key(KeyEvent::from(KeyCode::Char('g')));
        assert_eq!(app.selection[build], 0);
        app.handle_key(KeyEvent::from(KeyCode::Char('1')));
        assert_eq!(app.focus, 0, "1 is the first column");
        app.handle_key(KeyEvent::from(KeyCode::Char('8')));
        assert_eq!(app.focus, COLUMNS.len() - 1, "8 is Done");
        app.handle_key(KeyEvent::from(KeyCode::Char('9')));
        assert_eq!(app.focus, COLUMNS.len() - 1, "9 is no column");
    }

    #[test]
    fn bracket_keys_hop_between_the_tickets_that_need_you_across_the_board() {
        let mut app = App::new(Machine::from_env());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        let mut plan = ticket("bbbbbbbb0000", "awaiting_approval", false, false);
        plan.waiting_on_you = true;
        plan.column = "Triage".to_string();
        app.tasks.push(plan);
        let mut escalated = ticket("cccccccc0000", "escalated", false, true);
        escalated.column = "Verify".to_string();
        app.tasks.push(escalated);
        app.focus = 0;
        app.handle_key(KeyEvent::from(KeyCode::Char(']')));
        assert_eq!(app.selected_id().as_deref(), Some("bbbbbbbb0000"));
        app.handle_key(KeyEvent::from(KeyCode::Char(']')));
        assert_eq!(app.selected_id().as_deref(), Some("cccccccc0000"));
        app.handle_key(KeyEvent::from(KeyCode::Char(']')));
        assert_eq!(app.selected_id().as_deref(), Some("bbbbbbbb0000"), "wraps around");
        app.handle_key(KeyEvent::from(KeyCode::Char('[')));
        assert_eq!(app.selected_id().as_deref(), Some("cccccccc0000"));
        app.tasks.retain(|t| !t.waiting_on_you && t.state != "escalated");
        app.handle_key(KeyEvent::from(KeyCode::Char(']')));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("nothing needs you"));
    }

    fn type_command(app: &mut App, text: &str) -> Outcome {
        app.handle_key(KeyEvent::from(KeyCode::Char(':')));
        assert!(matches!(app.mode, Mode::Command(_)), "colon opens the palette");
        for ch in text.chars() {
            app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
        }
        app.handle_key(KeyEvent::from(KeyCode::Enter))
    }

    #[test]
    fn the_colon_palette_runs_board_commands_by_name() {
        let mut app = App::new(Machine::from_env());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.tasks.push(ticket("bbbbbbbb0000", "implementing", true, true));
        app.toast = None;

        type_command(&mut app, "group repo");
        assert_eq!(app.group, GroupBy::Repo);
        type_command(&mut app, "filter bbbb");
        assert_eq!(app.filter, "bbbb");
        assert_eq!(app.indices(app.tasks[0].column_index()).len(), 1);
        type_command(&mut app, "filter");
        assert_eq!(app.filter, "", "bare filter clears it");
        type_command(&mut app, "open aaaaaaaa");
        assert!(matches!(&app.mode, Mode::Detail(id) if id == "aaaaaaaa0000"), "open by id prefix");
        app.mode = Mode::Normal;
        type_command(&mut app, "fold");
        assert!(app.folded.contains(&app.focus));
        type_command(&mut app, "unfold");
        assert!(!app.folded.contains(&app.focus));
        type_command(&mut app, "inbox");
        assert!(app.inbox.is_some());
        app.inbox = None;
        type_command(&mut app, "digest");
        assert!(app.digest.is_some());
        app.digest = None;
        type_command(&mut app, "help");
        assert!(matches!(app.mode, Mode::Help(_)));
        app.mode = Mode::Normal;
        type_command(&mut app, "slots x");
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("slots takes a number, e.g. :slots 3"));
        type_command(&mut app, "frobnicate");
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("unknown command: frobnicate (try :help)"));
        assert!(matches!(type_command(&mut app, "q"), Outcome::Quit));

        app.handle_key(KeyEvent::from(KeyCode::Char(':')));
        app.handle_key(KeyEvent::from(KeyCode::Char('x')));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(matches!(app.mode, Mode::Normal), "esc closes the palette");
    }

    #[test]
    fn closing_help_returns_to_the_ticket_detail() {
        let mut app = App::new(Machine::from_env());
        app.mode = Mode::Detail("aaaaaaaa0000".to_string());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help(HelpFor::Detail)));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(matches!(&app.mode, Mode::Detail(id) if id == "aaaaaaaa0000"));
        app.mode = Mode::Normal;
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn help_scrolls_with_j_and_k_and_clamps() {
        let mut app = App::new(Machine::from_env());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        app.help_max.set(2);
        for _ in 0..5 {
            app.handle_key(KeyEvent::from(KeyCode::Char('j')));
        }
        assert_eq!(app.help_scroll.get(), 2);
        assert!(matches!(app.mode, Mode::Help(_)));
        for _ in 0..5 {
            app.handle_key(KeyEvent::from(KeyCode::Up));
        }
        assert_eq!(app.help_scroll.get(), 0);
        app.help_max.set(0);
        app.handle_key(KeyEvent::from(KeyCode::Down));
        assert_eq!(app.help_scroll.get(), 0, "nothing to scroll");
        assert!(matches!(app.mode, Mode::Help(_)));
    }

    #[test]
    fn question_mark_shows_the_keys_of_the_view_you_are_in() {
        let mut app = App::new(Machine::from_env());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help(HelpFor::Board)));
        app.handle_key(KeyEvent::from(KeyCode::Char('x')));
        assert!(matches!(app.mode, Mode::Normal), "any key closes it");

        app.inbox = Some(InboxState::default());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help(HelpFor::Inbox)));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(app.inbox.is_some(), "closing the help keeps the view");
        app.inbox = None;

        app.digest = Some(DigestState::default());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help(HelpFor::Digest)));
        app.mode = Mode::Normal;
        app.digest = None;

        app.floor = Some(FloorState::default());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help(HelpFor::Floor)));
        app.mode = Mode::Normal;
        app.floor = None;

        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.mode = Mode::Detail("aaaaaaaa0000".to_string());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help(HelpFor::Detail)));
        assert!(HelpFor::Inbox.keys().iter().any(|(k, _)| *k == "A"));
        assert!(HelpFor::Floor.keys().iter().any(|(k, _)| k.starts_with("tab")));
        assert!(HelpFor::Digest.keys().iter().any(|(k, _)| *k == "o"));
        assert!(HelpFor::Detail.keys().iter().any(|(k, _)| *k == "j / k"));
    }

    fn flattened(ctx: HelpFor) -> Vec<(&'static str, &'static str)> {
        let mut v: Vec<_> = ctx.sections().iter().flat_map(|s| s.rows.iter().copied()).collect();
        v.sort();
        v
    }

    #[test]
    fn help_sections_hold_exactly_the_legacy_pairs() {
        let sorted = |tables: &[&[(&'static str, &'static str)]]| {
            let mut v: Vec<_> = tables.iter().flat_map(|t| t.iter().copied()).collect();
            v.sort();
            v
        };
        assert_eq!(flattened(HelpFor::Board), sorted(&[HELP, COMMANDS]));
        assert_eq!(flattened(HelpFor::Floor), sorted(&[FLOOR_HELP]));
        assert_eq!(flattened(HelpFor::Inbox), sorted(&[INBOX_HELP]));
        assert_eq!(flattened(HelpFor::Digest), sorted(&[DIGEST_HELP]));
        assert_eq!(flattened(HelpFor::Detail), sorted(&[DETAIL_HELP]));
        assert_eq!(flattened(HelpFor::Pulls), sorted(&[PULLS_HELP]));
    }

    #[test]
    fn help_sections_are_named_and_not_empty() {
        for ctx in [HelpFor::Board, HelpFor::Floor, HelpFor::Inbox, HelpFor::Digest, HelpFor::Detail, HelpFor::Pulls] {
            assert!(!ctx.sections().is_empty());
            assert!(ctx.sections().iter().all(|s| !s.heading.is_empty() && !s.rows.is_empty()));
        }
        assert!(HelpFor::Board.sections().len() >= 4);
        let commands: Vec<_> =
            HelpFor::Board.sections().iter().filter(|s| s.heading == "Commands (type after :)").collect();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].rows, COMMANDS);
    }

    #[test]
    fn column_order_is_cached_per_frame_and_still_sees_a_new_ticket() {
        let mut app = App::new(Machine::from_env());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        let build = app.tasks[0].column_index();
        assert_eq!(app.indices(build), vec![0]);
        assert!(app.order_cached(), "the second call in a frame is a cache hit");
        app.tasks.push(ticket("bbbbbbbb0000", "implementing", true, true));
        assert_eq!(app.indices(build).len(), 2, "a changed task list invalidates the cache");
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

#[cfg(test)]
mod pr_tests {
    use super::*;
    use crate::model::{PrSnapshot, PullRequest};
    use crate::pulls::PrSplit;

    fn pr(number: u64, split: &str, mine: bool, local: bool) -> PullRequest {
        let local = if local { "\"/r/app\"" } else { "null" };
        let author = if mine { "me" } else { "them" };
        serde_json::from_str(&format!(
            r#"{{"repo":"acme/app","number":{number},"title":"PR {number}","url":"https://github.com/acme/app/pull/{number}",
            "author":"{author}","mine":{mine},"reviewRequested":{},"isDraft":false,"headRef":"feat/{number}","baseRef":"main",
            "fromFork":false,"reviewDecision":null,"mergeable":"MERGEABLE","checks":{{"state":"none","passed":0,"total":0,"failed":[]}},
            "unresolvedThreads":0,"split":"{split}","localPath":{local},"task":null,"updatedAt":"2026-10-27T0{number}:00:00Z"}}"#,
            !mine
        ))
        .unwrap()
    }

    fn type_command(app: &mut App, text: &str) -> Outcome {
        app.handle_key(KeyEvent::from(KeyCode::Char(':')));
        for ch in text.chars() {
            app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
        }
        app.handle_key(KeyEvent::from(KeyCode::Enter))
    }

    fn app_with(prs: Vec<PullRequest>) -> App {
        let mut app = App::new(Machine::from_env());
        app.tasks.clear();
        app.toast = None;
        app.take_notices();
        app.tx.send(Incoming::Message(StreamMessage::Prs { snapshot: PrSnapshot { prs, polled_at: None, error: None } })).unwrap();
        app.pump();
        app
    }

    #[test]
    fn p_opens_the_pr_view_and_its_keys_move_between_splits_and_rows() {
        let mut app = app_with(vec![pr(1, "ready_to_merge", true, true), pr(2, "ready_to_merge", true, true), pr(3, "review_requested", false, true)]);
        app.handle_key(KeyEvent::from(KeyCode::Char('P')));
        let state = app.pulls.clone().expect("the PR view opens");
        assert_eq!(state.split, PrSplit::ReviewRequested);
        app.handle_key(KeyEvent::from(KeyCode::Char('l')));
        assert_eq!(app.pulls.as_ref().unwrap().split, PrSplit::ReadyToMerge);
        app.handle_key(KeyEvent::from(KeyCode::Char('j')));
        assert_eq!(app.pulls.as_ref().unwrap().cursor, 1);
        assert_eq!(app.pr_under_cursor().map(|p| p.number), Some(2));
        app.handle_key(KeyEvent::from(KeyCode::Char('j')));
        assert_eq!(app.pulls.as_ref().unwrap().cursor, 1, "stops at the last row");
        app.handle_key(KeyEvent::from(KeyCode::Char('3')));
        assert_eq!(app.pulls.as_ref().unwrap().split, PrSplit::CiFailed);
        assert_eq!(app.pulls.as_ref().unwrap().cursor, 0);
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help(HelpFor::Pulls)));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(app.pulls.is_none());
        type_command(&mut app, "prs");
        assert!(app.pulls.is_some(), ":prs opens it too");
    }

    #[test]
    fn m_asks_before_merging_a_ready_pr_and_refuses_the_rest() {
        let mut app = app_with(vec![pr(1, "ready_to_merge", true, true), pr(2, "ci_running", true, true)]);
        app.handle_key(KeyEvent::from(KeyCode::Char('P')));
        app.handle_key(KeyEvent::from(KeyCode::Char('2')));
        app.handle_key(KeyEvent::from(KeyCode::Char('m')));
        assert!(matches!(&app.mode, Mode::ConfirmMerge { repo, number } if repo == "acme/app" && *number == 1));
        app.handle_key(KeyEvent::from(KeyCode::Char('n')));
        assert!(matches!(app.mode, Mode::Normal));
        app.handle_key(KeyEvent::from(KeyCode::Char('4')));
        app.handle_key(KeyEvent::from(KeyCode::Char('m')));
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("not ready to merge"));
    }

    #[test]
    fn dispatch_keys_follow_the_blockers_and_a_missing_checkout_opens_the_clone_prompt() {
        let mut app = app_with(vec![pr(1, "review_requested", false, false), pr(2, "ci_failed", true, true)]);
        app.handle_key(KeyEvent::from(KeyCode::Char('P')));
        app.handle_key(KeyEvent::from(KeyCode::Char('v')));
        let Mode::ClonePrompt { repo, then, .. } = &app.mode else { panic!("no checkout opens the clone prompt: {:?}", app.toast.as_ref().map(|t| t.text.clone())) };
        assert_eq!(repo, "acme/app");
        assert_eq!(*then, PrAction::Review);
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(matches!(app.mode, Mode::Normal), "esc keeps the row read-only");
        assert!(app.pulls.is_some());

        app.handle_key(KeyEvent::from(KeyCode::Char('3')));
        app.handle_key(KeyEvent::from(KeyCode::Char('v')));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("review is for other people's PRs"));
        app.handle_key(KeyEvent::from(KeyCode::Char('c')));
        let toast = app.toast.as_ref().map(|t| t.text.clone()).unwrap_or_default();
        assert!(toast.contains("machine unreachable") || toast.contains("unreachable"), "the dispatch reached the machine call: {toast}");
        app.handle_key(KeyEvent::from(KeyCode::Char('x')));
        assert!(matches!(app.mode, Mode::PrActions { .. }));
    }

    #[test]
    fn prs_that_need_you_count_on_the_badge_and_raise_a_notice_once() {
        let mut app = app_with(vec![pr(1, "review_requested", false, true), pr(2, "mine", true, true)]);
        assert_eq!(app.needs_you_count(), 1);
        let notices = app.take_notices();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].title, "Review requested");
        app.tx.send(Incoming::Message(StreamMessage::Prs { snapshot: PrSnapshot { prs: vec![pr(1, "review_requested", false, true), pr(2, "ci_failed", true, true)], polled_at: None, error: None } })).unwrap();
        app.pump();
        let notices = app.take_notices();
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["CI failed"], "staying put is not news; a new split is");
        assert_eq!(app.needs_you_count(), 2);
    }
}

#[cfg(test)]
mod workspace_key_tests {
    use ratatui::crossterm::event::{KeyCode, KeyEvent};

    use super::*;

    fn task(state: &str) -> Task {
        serde_json::from_str(&format!(
            r#"{{"id":"abcdef123456","title":"Add CSV export","description":"","criteria":[],
            "repoPath":"/r/app","branch":"task/abcdef12","worktreePath":"/w","state":"{state}","column":"Build",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
        ))
        .unwrap()
    }

    fn detail_with_runs(task: &Task, runs: usize) -> TaskDetail {
        let runs: Vec<String> = (0..runs).map(|i| format!(r#"{{"stage":"implementing","attempt":{},"status":"passed"}}"#, i + 1)).collect();
        serde_json::from_str(&format!(
            r#"{{"task":{},"stageRuns":[{}],"approvals":[],"events":[]}}"#,
            serde_json::to_string(&serde_json::json!({
                "id": task.id, "title": task.title, "description": "", "criteria": [], "repoPath": "/r/app", "branch": "task/abcdef12",
                "worktreePath": "/w", "state": task.state, "column": "Build", "waitingOnYou": false, "running": false, "queued": false,
                "retries": {"verify":0,"e2e":0,"ci":0,"total":0}, "resumeTo": null, "reason": null,
                "createdAt": "2026-10-22T23:24:22.089Z", "updatedAt": "2026-10-22T23:24:22.089Z"
            }))
            .unwrap(),
            runs.join(",")
        ))
        .unwrap()
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    fn open(state: &str) -> App {
        let mut app = App::new(crate::Machine::from_env());
        let task = task(state);
        app.tasks.push(task.clone());
        app.open_detail(task.id);
        app
    }

    #[test]
    fn enter_opens_on_the_section_the_gate_concerns_and_h_l_digits_switch() {
        let app = open("awaiting_approval");
        assert_eq!(app.detail_section, Section::Plan);
        let mut app = open("implementing");
        assert_eq!(app.detail_section, Section::Overview);
        press(&mut app, KeyCode::Char('l'));
        assert_eq!(app.detail_section, Section::Plan);
        press(&mut app, KeyCode::Char('h'));
        press(&mut app, KeyCode::Char('h'));
        assert_eq!(app.detail_section, Section::Activity, "h wraps around");
        press(&mut app, KeyCode::Char('4'));
        assert_eq!(app.detail_section, Section::Runs);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.detail_section, Section::Diff);
        assert!(matches!(app.mode, Mode::Detail(_)), "still open");
    }

    #[test]
    fn j_k_pick_a_run_in_runs_and_scroll_elsewhere_and_plus_toggles_the_size() {
        let mut app = open("implementing");
        app.detail = Some(detail_with_runs(&app.tasks[0], 3));
        press(&mut app, KeyCode::Char('4'));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.detail_cursor, 2, "the cursor stops at the last run");
        assert_eq!(app.detail_scroll.get(), 0, "picking does not scroll");
        press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.detail_cursor, 1);
        press(&mut app, KeyCode::Char('2'));
        assert_eq!(app.detail_cursor, 0, "a new section starts at its first row");
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.detail_scroll.get(), 1, "the Plan section scrolls");
        assert!(!app.detail_full);
        press(&mut app, KeyCode::Char('+'));
        assert!(app.detail_full);
        press(&mut app, KeyCode::Char('+'));
        assert!(!app.detail_full);
    }

    #[test]
    fn the_diff_is_fetched_only_while_its_section_shows_and_never_blocks() {
        let mut app = open("implementing");
        app.online = true;
        app.ensure_diff();
        assert!(app.diff_pending.is_none(), "Overview asks for no diff");
        press(&mut app, KeyCode::Char('5'));
        let before = std::time::Instant::now();
        app.ensure_diff();
        assert!(before.elapsed() < std::time::Duration::from_millis(100), "the fetch runs off the UI thread");
        assert_eq!(app.diff_pending.as_ref().map(|(id, file)| (id.as_str(), file.is_none())), Some(("abcdef123456", true)));
        app.ensure_diff();
        assert!(app.diff_pending.is_some(), "one fetch at a time");
        let files: TaskDiff = serde_json::from_str(r#"{"base":"b","head":"h","files":[{"path":"a.rs","status":"M","added":1,"removed":0},{"path":"b.rs","status":"A","added":2,"removed":0}]}"#).unwrap();
        app.diff_pending = None;
        app.diff = Some(("abcdef123456".into(), files));
        app.ensure_diff();
        assert_eq!(app.diff_pending.as_ref().and_then(|(_, f)| f.as_deref()), Some("a.rs"), "then the selected file's patch");
        app.diff_pending = None;
        let mut with_patch = app.diff.clone().unwrap().1;
        with_patch.file = Some("a.rs".into());
        with_patch.patch = Some("@@".into());
        app.diff = Some(("abcdef123456".into(), with_patch));
        app.ensure_diff();
        assert!(app.diff_pending.is_none(), "nothing left to fetch for this file");
        press(&mut app, KeyCode::Char('j'));
        app.ensure_diff();
        assert_eq!(app.diff_pending.as_ref().and_then(|(_, f)| f.as_deref()), Some("b.rs"), "moving the cursor asks for the next file");
        let mut offline = open("implementing");
        press(&mut offline, KeyCode::Char('5'));
        offline.ensure_diff();
        assert!(offline.diff_pending.is_none(), "offline: nothing to fetch from");
    }
}
