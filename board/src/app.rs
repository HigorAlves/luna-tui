//! Board state and everything that changes it: keys, machine calls and the event stream.
//! The machine owns the tickets; the board shows them and sends your decisions.

use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant},
};

use ratatui::{
    crossterm::event::{KeyCode, KeyEvent, KeyModifiers},
    layout::Rect,
};
use tui_textarea::TextArea;

use std::collections::BTreeSet;

use crate::detail::{EvidenceHit, Section};
use crate::digest::{self, DigestState};
use crate::inbox::{self, InboxState, Split};
use crate::keys::{self, Scope};
use crate::model::now_secs;
use crate::notify::{self, Notice};
use crate::backlog::{BacklogEntry, BacklogState};
use crate::economy::{Economy, EconomyState, Row, RowKind};
use crate::tickets::{TicketEntry, TicketsState};
use crate::pulls::{self, PrKey, PrSplit, PullsState};
use crate::slack::{self, SlackKey, SlackSplit, SlackState, WatchesState};
use crate::{
    client::{Incoming, Machine},
    discover::{discover_folders, discover_repos, repos_root},
    herdr,
    model::{
        ARCHIVE_REASONS, COLUMNS, RECORD_FIELDS, TriageRecord, EngineCatalog, EngineInfo, EngineMetrics, JiraIssueHit, Metrics, PrAction, PrSnapshot, PullRequest, RepoMetrics, SlackItem, SlackMetrics, SlackOption, SlackSnapshot, SlackWatch,
        StreamMessage, Task, TaskDetail, TaskDiff, TicketText, answers_markdown, iso_of, parse_answers, parse_cases, parse_plan, parse_ticket, plan_edit_of,
        plan_markdown, priority_step, questions_of, short_id, ticket_markdown, cases_markdown, Slots,
    },
    store,
    vim::Vim,
};

/// Two clicks on one file row within this long open it.
const DOUBLE_CLICK: Duration = Duration::from_millis(500);
const INFO_TOAST_FOR: Duration = Duration::from_secs(3);
/// How long a prefix key (`g`, `z`) waits before the footer lists its second keys.
pub const WHICH_KEY_DELAY: Duration = Duration::from_millis(400);
/// The PATCH body of a done tap: `done: true`, and the reason a draft was dismissed when there is one.
fn dismiss_patch(reason: Option<&str>) -> serde_json::Value {
    match reason {
        Some(reason) => serde_json::json!({ "done": true, "reason": reason }),
        None => serde_json::json!({ "done": true }),
    }
}

/// The local zone's seconds east of UTC, from `date +%z` (`+0100` → 3600); 0 when it cannot
/// be read. Snooze times are typed as local 9:00 and sent as UTC.
fn local_offset_secs() -> i64 {
    let out = Command::new("date").arg("+%z").output().ok();
    let text = out.and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
    parse_offset(text.trim()).unwrap_or(0)
}

/// `+0100` → 3600, `-0330` → -12600.
fn parse_offset(text: &str) -> Option<i64> {
    let (sign, digits) = text.split_at_checked(1)?;
    let sign = match sign {
        "+" => 1,
        "-" => -1,
        _ => return None,
    };
    if digits.len() != 4 {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = digits[2..].parse().ok()?;
    Some(sign * (hours * 3600 + minutes * 60))
}

/// Where a section's cursor starts: Runs and Evidence on their latest row (`usize::MAX`
/// resolves to the last once the rows are known), everything else on the first.
fn start_cursor(section: Section) -> usize {
    match section {
        Section::Runs | Section::Evidence => usize::MAX,
        _ => 0,
    }
}

/// The Floor view's numbers, one window each. A window stays `None` until its first fetch
/// succeeds; a failed refresh keeps what was there.
#[derive(Default)]
pub struct FloorState {
    pub d7: Option<Metrics>,
    pub d30: Option<Metrics>,
    /// One row per repo over 7d; the table under the numbers.
    pub repos: Vec<RepoMetrics>,
    /// Each repository's image and graph (`GET /repos`); empty from a machine without it.
    pub health: Vec<crate::model::RepoHealth>,
    /// 0 is every repo; `i` is `repos[i - 1]`, and the numbers above are that repo's.
    pub cursor: usize,
    /// How fast you answer on Slack, 7d and 30d; None until both fetches succeed.
    pub slack: Option<(SlackMetrics, SlackMetrics)>,
    /// One row per engine over 7d; None while the machine does not report engines.
    pub by_engine: Option<Vec<EngineMetrics>>,
    /// Each engine's month against its cap (`GET /engines`); empty from a machine without it.
    pub engines: Vec<EngineInfo>,
}

impl FloorState {
    /// The repositories the machine knows (`GET /repos`) that have no task-metrics row yet: a repository just configured. They
    /// follow the metrics rows in the focus order, so tab reaches them and `A` can approve their base.
    pub fn health_only(&self) -> Vec<&crate::model::RepoHealth> {
        self.health.iter().filter(|h| !self.repos.iter().any(|r| r.repo.as_deref() == Some(h.repo.as_str()))).collect()
    }

    /// How many repositories tab can focus: the metrics rows, then the health-only ones.
    pub fn focusable(&self) -> usize {
        self.repos.len() + self.health_only().len()
    }

    /// The focused repository's path; `None` for every repo, `Some(None)` for the tasks with no repo.
    fn focused_repo(&self) -> Option<Option<&str>> {
        if self.cursor == 0 {
            return None;
        }
        match self.repos.get(self.cursor - 1) {
            Some(r) => Some(r.repo.as_deref()),
            None => self.health_only().get(self.cursor - 1 - self.repos.len()).map(|h| Some(h.repo.as_str())),
        }
    }

    /// `None` for every repo; `Some(repo)` for one, where the repo may itself be `None`
    /// (the tasks with no repo).
    pub fn focused(&self) -> Option<Option<&str>> {
        self.focused_repo()
    }

    /// The focused repo's name for the header; `None` when every repo is in.
    pub fn focused_name(&self) -> Option<&str> {
        if self.cursor == 0 {
            return None;
        }
        match self.repos.get(self.cursor - 1) {
            Some(r) => Some(r.name()),
            None => self.health_only().get(self.cursor - 1 - self.repos.len()).map(|h| h.name()),
        }
    }

    fn cycle(&mut self, by: isize) {
        let n = self.focusable() + 1;
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

/// The link of the issue a ticket came from or is linked to (its source's, else Jira's): `o` on the board and `i` in the task view open it.
pub(crate) fn issue_link(task: &Task) -> Option<String> {
    task.source.as_ref().and_then(|s| s.link().map(str::to_string)).or_else(|| task.jira.as_ref().map(|j| j.url.clone()))
}

/// Every ticket waiting on the usage window.
pub fn paused_ids(tasks: &[Task]) -> Vec<String> {
    tasks.iter().filter(|t| t.state == "paused_rate_limit").map(|t| t.id.clone()).collect()
}

/// A burst of events for the open ticket becomes one detail refetch, not one per event.
const DETAIL_DEBOUNCE: Duration = Duration::from_millis(300);
/// How long the `J` prompt waits after a keystroke before asking the machine to search.
const JIRA_SEARCH_DEBOUNCE: Duration = Duration::from_millis(250);

/// The `:` commands that act on one ticket: typed in the task view they run on the open one and
/// the view stays open.
const CARD_COMMANDS: &[&str] = &["start", "whole", "dismiss", "finding", "dedup", "context", "dup", "undup", "repo", "jira", "ticket-edit"];

/// How tall a card is: three lines (title; id and repo; status), four with the worked / diff /
/// tests line, or one (glyph, title, age) so a busy column shows twice the tickets.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Density {
    #[default]
    Cozy,
    Comfortable,
    Compact,
}

impl Density {
    pub fn next(self) -> Density {
        match self {
            Density::Cozy => Density::Comfortable,
            Density::Comfortable => Density::Compact,
            Density::Compact => Density::Cozy,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Density::Cozy => "3 lines",
            Density::Comfortable => "4 lines with worked · diff · tests",
            Density::Compact => "1 line",
        }
    }
}

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

/// What an approval box was opened for: the card, the gate and the words it asked. `y` sends only while the card still waits
/// at that gate (the same ask, when the machine gave it an id).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldApproval {
    pub id: String,
    pub gate: &'static str,
    pub question: String,
    pub approval: Option<String>,
    /// `A` at the retro: approve and skip its rules.
    pub skip_rules: bool,
}

/// The gate a card waits at, as an approval names it.
pub struct Gate {
    pub kind: &'static str,
    pub question: String,
}

/// The full-screen views. At most one is open: opening one closes the others, and `App::active_view` is the one
/// place that says which takes the keys and the screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Floor,
    Inbox,
    Digest,
    Pulls,
    Backlog,
    Economy,
    Tickets,
    Slack,
}

/// What the box says when the card changed under it.
const MOVED_ON: &str = "the card moved on; nothing was approved";

pub enum Mode {
    Normal,
    Adding(String),
    /// Typing the filter. The text lives in `App::filter`.
    Filter,
    /// Typing a `:` command; `pick` is the highlighted completion (tab cycles), enter runs.
    Command { text: String, pick: Option<usize> },
    Detail(String),
    /// Editing a ticket's markdown in place: title, description, criteria, repo.
    EditTicket {
        id: String,
        area: TextArea<'static>,
        vim: Vim,
    },
    /// `e` on the Review page while the cases wait for your check: which of the plan, the cases or the ticket to edit.
    EditChoice(String),
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
    /// Editing test_design's cases in place while they wait for your check, as the markdown
    /// `cases_markdown` writes; ctrl+s saves.
    EditCases {
        id: String,
        area: TextArea<'static>,
        vim: Vim,
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
    /// `N` at the plan gate: the comment a rejection carries (required: the card ends, archived as rejected).
    Reject { id: String, text: String },
    /// `n` on a card with an Evidence Pack: why it was not useful (a note is optional).
    EvidenceNote { id: String, text: String },
    /// `Z` on a ticket: pick why it is archived; enter archives it.
    ArchiveReason { id: String, cursor: usize },
    /// `E` on an escalated ticket: pick the reason the escalation really had; enter sends the correction.
    EscalationReason { id: String, cursor: usize },
    /// `T`: correct the Triage Record. `field` is the row, `picks` the value index of each `RECORD_FIELDS` row.
    RecordEdit { id: String, field: usize, picks: [usize; 5] },
    ConfirmDelete(String),
    ConfirmAbort(String),
    ConfirmWorktree(String),
    /// `a` inside the open task at any gate: one yes names what is approved and the card, then the decision goes.
    /// The box holds what it was opened for and never re-reads the card to decide what `y` does.
    ConfirmApprove(HeldApproval),
    /// `q` on the board while a card needs you or runs.
    ConfirmQuit,
    /// `A` in the Inbox: approve every ticket in the split, after one yes.
    ConfirmApproveAll(Vec<String>),
    /// A destructive key over the marked set: one yes for all of them.
    ConfirmMany { action: BulkAction, ids: Vec<String> },
    /// `a` over marked cards at a gate that commits something: one yes names the count and the kinds, then
    /// every decision goes. `before` is what the other marked cards got already (they commit nothing).
    ConfirmApproveMany { ids: Vec<String>, before: String },
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
    /// `m` on a ready PR: one yes, then the machine merges it the way the repo allows (squash, else merge, else rebase).
    ConfirmMerge { repo: String, number: u64 },
    /// `X` on a PR: one yes, then the machine closes it without merging.
    ConfirmClose { repo: String, number: u64 },
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
    /// `s` on a Slack item: pick how long it sleeps.
    SlackSnooze { id: String, cursor: usize },
    /// `d` on an item with a waiting draft: why it is dismissed (n: no reply needed, b: bad draft, s or enter: no reason).
    SlackDismiss { id: String },
    /// `c` (the kind) or `L` (the relation) on a Slack thread: a picker over the machine's own list.
    SlackPick { id: String, relation: bool, cursor: usize },
    /// `r` (or `n`) on a Slack item: the reply, pre-filled with triage's draft (or a nudge);
    /// ctrl+s posts it as you. `nudge`: the machine prefixes a mention of the author.
    SlackReply {
        id: String,
        area: TextArea<'static>,
        vim: Vim,
        nudge: bool,
        /// The id and hash of the draft the editor was opened on; a typed reply or a nudge has none.
        draft: Option<(String, String)>,
    },
    /// `t` on a Slack item: one yes, then a Backlog ticket with `title`, in `repo` when guessed.
    SlackTask { id: String, title: String, repo: Option<String> },
    /// `n` in Watches: type `@handle`, `#channel` or a word; the first two complete from Slack.
    SlackWatchAdd { query: String, cursor: usize },
    /// `x` in the Slack view: the keys for the selected item, each with why it is off when it is.
    SlackActions { cursor: usize },
    /// `J` on a ticket with no Jira issue: type a key or words, the machine searches from three
    /// characters on, `hits` are what it found; row 0 creates an issue from the ticket, the
    /// rest link one. `cursor` indexes rows, create row included.
    JiraLink {
        id: String,
        query: String,
        hits: Vec<JiraIssueHit>,
        cursor: usize,
    },
    /// `J` on a linked ticket: one yes, then the link is dropped (the issue stays).
    ConfirmJiraUnlink(String),
    /// `E` in the popup's Engines section: the engines `pack` may run on for ticket `id`;
    /// enter sets the one under `cursor`, esc goes back to the popup.
    EnginePicker { id: String, pack: String, cursor: usize },
    /// The `?` sheet for `scope`: `long` shows every group as rows, `query` is the `/` search
    /// while typing, `cursor` the row enter runs. How far it is scrolled lives in `help_scroll`.
    Help {
        scope: Scope,
        long: bool,
        query: Option<String>,
        cursor: usize,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlanPane {
    Plan,
    Ticket,
}

/// Whether `task` is at the plan gate with its plan already fetched into `detail`, so `e`
/// opens the two-pane plan editor instead of the plain ticket editor.
fn has_open_plan(task: &Task, detail: Option<&TaskDetail>) -> bool {
    task.state == "awaiting_approval" && detail.is_some_and(|d| d.task.id == task.id && d.open_approval().is_some_and(|a| !matches!(a.outcome(), Some("split" | "split_failed"))))
}

/// Whether the plan may still be edited: at its own gate, or at the test check, before anything
/// is built. The machine refuses the edit after that.
fn plan_editable(task: &Task, detail: Option<&TaskDetail>) -> bool {
    matches!(task.state.as_str(), "awaiting_approval" | "awaiting_test_check")
        && detail.is_some_and(|d| d.task.id == task.id && d.latest_approval("awaiting_approval").is_some_and(|a| !(a.decision.is_none() && matches!(a.outcome(), Some("split" | "split_failed")))))
}

/// Whether the cases may be edited: only while they wait for your check, on the plan gate that
/// carries them or a legacy test check.
fn cases_editable(task: &Task, detail: Option<&TaskDetail>) -> bool {
    matches!(task.state.as_str(), "awaiting_test_check" | "awaiting_approval")
        && detail.is_some_and(|d| d.task.id == task.id && d.cases_approval().is_some_and(|a| a.decision.is_none()) && !d.cases().is_empty())
}

/// What the event loop must do after a key press.
pub enum Outcome {
    Continue,
    Quit,
}

/// What `o` opens in the task view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenTarget {
    Url(String),
    Path { path: String, what: String },
    EvidenceFolder,
}

pub struct Toast {
    pub text: String,
    pub error: bool,
    at: Instant,
}

pub struct App {
    pub(crate) machine: Machine,
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
    /// `R` asked GitHub for a fresh poll and the answer has not come back yet.
    pub prs_polling: bool,
    /// The same for Slack.
    pub slack_polling: bool,
    /// The PR view, open while this is `Some`.
    pub pulls: Option<PullsState>,
    /// The Backlog view, open while this is `Some`, and the ranked items it fetched when it opened.
    pub backlog: Option<BacklogState>,
    pub backlog_items: Vec<BacklogEntry>,
    /// The Economy view, open while this is `Some`, and what the machine said about its repository.
    pub economy: Option<EconomyState>,
    pub economy_data: Economy,
    /// The Tickets view, open while this is `Some`, and the tickets it fetched when it opened.
    pub tickets: Option<TicketsState>,
    pub ticket_items: Vec<TicketEntry>,
    /// A dispatch waiting for a clone to land: the PR's key and the action to run then.
    pending_dispatch: Option<(String, PrAction)>,
    /// The Slack inbox as the machine last sent it; empty until the first `slack.items` event.
    pub slack_snapshot: SlackSnapshot,
    /// The Slack view, open while this is `Some`.
    pub slack: Option<SlackState>,
    /// The watch picker's completions (user groups, channels), fetched once per session, off the UI thread.
    slack_catalog: Option<(Vec<SlackOption>, Vec<SlackOption>)>,
    /// A catalogue fetch is in flight; the picker says "loading…" meanwhile.
    slack_catalog_pending: bool,
    /// Tickets marked with `v`/`V`: `a`, `X`, `d`, `w` act on all of them.
    pub marked: BTreeSet<String>,
    /// The stage pool as `/health` last reported it; None until the first answer.
    pub slots: Option<Slots>,
    /// The Digest view, open while this is `Some`.
    pub digest: Option<DigestState>,
    /// Columns folded to their header by hand (`zc`). The board also narrows columns by itself when the width is short.
    pub folded: BTreeSet<usize>,
    /// How tickets are ordered inside a column (`gs`/`gr`/`ga`).
    pub group: GroupBy,
    /// How tall the cards are (`=` cycles).
    pub density: Density,
    /// A two-key sequence in flight: `z` (fold) or `g` (group), and when it started: after
    /// `WHICH_KEY_DELAY` the footer lists the second keys.
    prefix: Option<char>,
    prefix_at: Option<Instant>,
    /// When the board was last open (unix seconds): the Digest's since, the cards' new dot.
    pub last_seen_secs: Option<u64>,
    /// The repo this board defaults new tickets to, for the `@` filter. `None` if it
    /// isn't inside one.
    pub home_repo: Option<String>,
    /// Column rectangles from the last frame, for mouse clicks.
    pub column_rects: RefCell<Vec<(usize, Rect)>>,
    /// The Evidence section's folder line and file rows from the last frame, for mouse clicks.
    pub evidence_hits: RefCell<Vec<(Rect, EvidenceHit)>>,
    /// The file row last clicked and when, for the double click that opens it.
    last_click: Option<(usize, Instant)>,
    /// What starts the platform's opener; tests record the call instead of spawning.
    pub(crate) launch: crate::open::Launcher,
    /// How far the open ticket's detail popup is scrolled. `ui` clamps it to the content's
    /// actual height, which only it knows (it depends on the terminal width).
    pub detail_scroll: Cell<u16>,
    /// The pane's height on the last frame, for the page keys; and whether the next frame
    /// should bring the selected row into view (set when the cursor moves, cleared by `ui`).
    pub detail_viewport: Cell<u16>,
    pub detail_follow: Cell<bool>,
    /// Which section of the workspace popup is open, and the selected row in sections that
    /// have one (runs, files). `usize::MAX` means the last row, resolved against the rows
    /// once they are known (`detail_row`). `+` toggles the popup between most of the screen
    /// and all of it.
    pub detail_section: Section,
    pub detail_cursor: usize,
    /// The reference groups of the open section: which are open, and whether they hold the keys (`tab`). Reset with each card.
    pub detail_refs: crate::reference::RefState,
    pub detail_full: bool,
    /// The branch diff of the ticket whose popup is open, once fetched: (task id, diff).
    pub diff: Option<(String, TaskDiff)>,
    diff_pending: Option<(String, Option<String>)>,
    /// Bumped whenever `diff` is reset; an answer tagged with an older one is dropped.
    pub diff_generation: u64,
    /// A diff fetch that failed for this ticket; no retry until the section is reopened.
    diff_failed: Option<String>,
    /// `GET /packs` and `GET /engines`, fetched each time the Engines section opens.
    pub engine_catalog: Option<Result<EngineCatalog, String>>,
    /// The `J` prompt's query waiting to be searched, and when it was typed; see `ensure_jira_search`.
    jira_search_due: Option<(String, Instant)>,
    /// How far the help sheet is scrolled, the furthest `ui` found it can scroll, and how many
    /// rows it showed last frame (the page the ctrl+d / ctrl+u keys move by).
    pub help_scroll: Cell<u16>,
    pub help_max: Cell<u16>,
    pub help_viewport: Cell<u16>,
    /// The task view a prompt, picker, editor, palette or help sheet was opened from: when it
    /// closes the app returns there (`settle_return`), unless the card is gone.
    pub(crate) return_to: Option<String>,
    /// The card a palette command acts on while it runs: the open task's, when the palette was opened over one.
    command_card: Option<String>,
    imported: bool,
    /// The latest stage container per task id, for `f` to open a watch tab on.
    stages: std::collections::HashMap<String, herdr::Stage>,
    /// Stages found running at connect: recorded for `f` without re-pointing any tab.
    scan_tx: Sender<(String, herdr::Stage)>,
    scan_rx: Receiver<(String, herdr::Stage)>,
}

impl App {
    pub fn new(machine: Machine) -> Self {
        let (tx, rx) = mpsc::channel();
        let (scan_tx, scan_rx) = mpsc::channel();
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
            prs_polling: false,
            slack_polling: false,
            pulls: None,
            backlog: None,
            backlog_items: Vec::new(),
            economy: None,
            economy_data: Economy::default(),
            tickets: None,
            ticket_items: Vec::new(),
            pending_dispatch: None,
            slack_snapshot: SlackSnapshot::default(),
            slack: None,
            slack_catalog: None,
            slack_catalog_pending: false,
            marked: BTreeSet::new(),
            slots: None,
            digest: None,
            folded: BTreeSet::new(),
            group: GroupBy::default(),
            density: Density::default(),
            prefix: None,
            prefix_at: None,
            last_seen_secs: store::last_seen_secs_at(&store::state_path()),
            home_repo: herdr::workspace_repo(),
            column_rects: RefCell::new(Vec::new()),
            evidence_hits: RefCell::new(Vec::new()),
            last_click: None,
            launch: Box::new(crate::open::spawn_detached),
            detail_scroll: Cell::new(0),
            detail_viewport: Cell::new(0),
            detail_follow: Cell::new(false),
            detail_section: Section::Overview,
            detail_cursor: 0,
            detail_refs: Default::default(),
            detail_full: false,
            diff: None,
            diff_pending: None,
            diff_generation: 0,
            diff_failed: None,
            engine_catalog: None,
            jira_search_due: None,
            help_scroll: Cell::new(0),
            help_max: Cell::new(0),
            help_viewport: Cell::new(0),
            return_to: None,
            command_card: None,
            imported: false,
            stages: std::collections::HashMap::new(),
            scan_tx,
            scan_rx,
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
        self.settle_confirm();
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
                self.follow_open_card();
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
        while let Ok((id, stage)) = self.scan_rx.try_recv() {
            // A stage the stream reported meanwhile is newer than the scan.
            self.stages.entry(id).or_insert(stage);
        }
        while let Ok(incoming) = self.stream.try_recv() {
            self.take_incoming(incoming);
        }
    }

    /// Applies one message from the stream thread or a background fetch.
    fn take_incoming(&mut self, incoming: Incoming) {
        {
            match incoming {
                Incoming::Online => {
                    // Containers seen before the outage may have finished; the scan
                    // below refills `stages` with what is running now.
                    self.stages.clear();
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
                Incoming::Diff { id, file, diff, generation } => {
                    if generation != self.diff_generation {
                        // The branch moved while this was in flight; the next frame asks again.
                        return;
                    }
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
                Incoming::PrsPolled(result) => {
                    self.prs_polling = false;
                    match result {
                        Ok(snapshot) => {
                            self.take_prs(snapshot);
                            self.notify("polled GitHub", false);
                        }
                        Err(error) => self.notify(error, true),
                    }
                }
                Incoming::SlackPolled(result) => {
                    self.slack_polling = false;
                    match result {
                        Ok(snapshot) => {
                            self.take_slack(snapshot);
                            self.notify("polled Slack", false);
                        }
                        Err(error) => self.notify(error, true),
                    }
                }
                Incoming::JiraHits { query, hits } => {
                    // An answer for what the prompt still says; anything typed since makes it stale.
                    let Mode::JiraLink { query: current, hits: shown, cursor, .. } = &mut self.mode else { return };
                    if current.trim() != query {
                        return;
                    }
                    match hits {
                        Ok(found) => {
                            *cursor = (*cursor).min(found.len());
                            *shown = found;
                        }
                        Err(error) => self.notify(format!("jira search: {error}"), true),
                    }
                }
                Incoming::Message(StreamMessage::Updated { task }) => {
                    if self.shows_detail_of(&task.id) {
                        self.detail_stale = true;
                    }
                    let diff_of_it = self.diff.as_ref().is_some_and(|(id, _)| *id == task.id) || self.diff_pending.as_ref().is_some_and(|(id, _)| *id == task.id);
                    if diff_of_it && task.running != self.task(&task.id).is_some_and(|t| t.running) {
                        // A stage started or ended: the branch may have moved.
                        self.reset_diff();
                    }
                    self.upsert(task);
                }
                Incoming::Message(StreamMessage::Event { event }) => {
                    if self.shows_detail_of(&event.task_id) {
                        self.detail_stale = true;
                    }
                    if let Some(notice) = self.task(&event.task_id).and_then(|t| notify::jira_moved_notice(t, &event)) {
                        self.notices.push(notice);
                    }
                }
                Incoming::Message(StreamMessage::Deleted { id }) => self.forget(&id),
                // herdr calls are subprocesses, so they stay off the UI thread.
                // Recorded for `f`; an existing watch tab is re-pointed, none is ever opened.
                Incoming::Message(StreamMessage::StageStarted { task_id, label, cwd, container }) => {
                    self.stages.insert(task_id.clone(), herdr::Stage { label, cwd, container: container.clone() });
                    thread::spawn(move || herdr::follow(short_id(&task_id), &container));
                }
                Incoming::Message(StreamMessage::Closed { id }) => {
                    self.stages.remove(&id);
                    thread::spawn(move || herdr::close_task_tab(short_id(&id)));
                }
                Incoming::Message(StreamMessage::BudgetAlert { alert }) => {
                    let line = alert.line();
                    self.notices.push(Notice { title: "Budget".to_string(), body: line.clone() });
                    self.notify(format!("budget: {line}"), alert.pct >= 100);
                }
                Incoming::Message(StreamMessage::TaskShipped { shipped }) => {
                    let line = format!("Shipped: {} → PR #{}", shipped.title, shipped.number);
                    self.notices.push(Notice { title: "Shipped".to_string(), body: line.clone() });
                    self.notify(line, false);
                }
                Incoming::Message(StreamMessage::Prs { snapshot }) => self.take_prs(snapshot),
                Incoming::Message(StreamMessage::Slack { snapshot }) => self.take_slack(snapshot),
                Incoming::SlackCatalog { groups, channels } => {
                    self.slack_catalog = Some((groups, channels));
                    self.slack_catalog_pending = false;
                }
            }
        }
    }

    /// A fresh Slack snapshot: notices for the P0/P1 items that moved into Needs reply or
    /// Decide, for items that went past their reply SLA and for threads that came back after
    /// you cleared them (a P0's only, inside the rules file's quiet hours); the view's cursors
    /// kept inside their lists.
    fn take_slack(&mut self, snapshot: SlackSnapshot) {
        let before: std::collections::HashMap<&str, (Option<SlackSplit>, Option<&str>, bool)> =
            self.slack_snapshot.items.iter().map(|i| (i.id.as_str(), (i.split_enum(), i.reopened_at.as_deref(), i.overdue))).collect();
        let mut notices = Vec::new();
        for item in &snapshot.items {
            if notify::muted_by_quiet_hours(snapshot.quiet, item) {
                continue;
            }
            let old = before.get(item.id.as_str());
            if let Some(notice) = notify::slack_notice(old.and_then(|o| o.0), old.and_then(|o| o.1), old.is_some_and(|o| o.2), item) {
                notices.push(notice);
            }
        }
        self.notices.extend(notices);
        self.slack_snapshot = snapshot;
        self.clamp_slack_cursor();
    }

    fn clamp_slack_cursor(&mut self) {
        let items = self.slack.as_ref().map(|s| slack::items(&self.slack_snapshot.items, s.split).len()).unwrap_or(0);
        let watches = self.slack_snapshot.watches.len();
        if let Some(state) = self.slack.as_mut() {
            state.cursor = state.cursor.min(items.saturating_sub(1));
            if let Some(open) = state.watches.as_mut() {
                open.cursor = open.cursor.min(watches.saturating_sub(1));
            }
        }
    }

    /// The item under the cursor of the open Slack view.
    pub fn slack_under_cursor(&self) -> Option<&SlackItem> {
        let state = self.slack.as_ref()?;
        let items = slack::items(&self.slack_snapshot.items, state.split);
        items.get(state.cursor.min(items.len().saturating_sub(1))).map(|&i| &self.slack_snapshot.items[i])
    }

    pub fn slack_item(&self, id: &str) -> Option<&SlackItem> {
        self.slack_snapshot.items.iter().find(|i| i.id == id)
    }

    fn slack_item_mut(&mut self, id: &str) -> Option<&mut SlackItem> {
        self.slack_snapshot.items.iter_mut().find(|i| i.id == id)
    }

    /// True while the watch picker's catalogue is still on its way from the machine.
    pub fn slack_catalog_loading(&self) -> bool {
        self.slack_catalog.is_none()
    }

    /// Fetches the user groups and channels the watch picker completes from, off the UI
    /// thread, once per session: started when the Slack view opens so `n` finds them ready.
    fn prefetch_slack_catalog(&mut self) {
        if self.slack_catalog.is_some() || self.slack_catalog_pending {
            return;
        }
        self.slack_catalog_pending = true;
        let machine = self.machine.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let groups = machine.slack_usergroups().unwrap_or_default();
            let channels = machine.slack_channels().unwrap_or_default();
            let _ = tx.send(Incoming::SlackCatalog { groups, channels });
        });
    }

    /// The watch picker's completions for `query`: user groups for `@…`, channels for `#…`,
    /// nothing for a keyword. Case-insensitive, in the machine's order.
    pub fn slack_watch_matches(&self, query: &str) -> Vec<&SlackOption> {
        let (kind, text) = slack::watch_kind_of(query);
        let Some((groups, channels)) = self.slack_catalog.as_ref() else {
            return Vec::new();
        };
        let pool = match kind {
            "usergroup" => groups,
            "channel" => channels,
            _ => return Vec::new(),
        };
        let needle = text.to_lowercase();
        pool.iter().filter(|o| o.label.to_lowercase().contains(&needle) || o.id.to_lowercase() == needle).collect()
    }

    /// A fresh PR snapshot: notices for the PRs that moved into a split that needs you, the
    /// dispatch a clone was holding, and the view's cursor kept inside its split.
    /// `R` in Pulls: asks the machine to poll GitHub now. A poll reads every PR, so it runs off the
    /// UI thread and the view says `polling GitHub…` until the answer comes back.
    fn poll_prs(&mut self) {
        if self.prs_polling {
            self.notify("already polling GitHub", false);
            return;
        }
        self.prs_polling = true;
        let (machine, tx) = (self.machine.clone(), self.tx.clone());
        thread::spawn(move || {
            let _ = tx.send(Incoming::PrsPolled(machine.refresh_prs()));
        });
    }

    /// `R` in Slack, the same way.
    fn poll_slack(&mut self) {
        if self.slack_polling {
            self.notify("already polling Slack", false);
            return;
        }
        self.slack_polling = true;
        let (machine, tx) = (self.machine.clone(), self.tx.clone());
        thread::spawn(move || {
            let _ = tx.send(Incoming::SlackPolled(machine.refresh_slack()));
        });
    }

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
        self.diff_failed = None;
        self.detail_section = self.task(&id).map(Section::for_task).unwrap_or_default();
        self.detail_cursor = start_cursor(self.detail_section);
        self.detail_refs.reset();
        self.detail_follow.set(true);
        self.mode = Mode::Detail(id);
    }

    /// Forgets the open ticket's diff and any fetch in flight; a late answer is then stale.
    fn reset_diff(&mut self) {
        self.diff = None;
        self.diff_pending = None;
        self.diff_generation += 1;
    }

    fn shows_detail_of(&self, id: &str) -> bool {
        self.detail.as_ref().is_some_and(|d| d.task.id == id)
    }

    /// Adds or replaces a ticket. The highlight stays on the same ticket even when the change
    /// re-sorts its column, so the next key never lands on a different ticket.
    fn upsert(&mut self, task: Task) {
        let selected = self.selected_id();
        let previous = self.tasks.iter().find(|t| t.id == task.id);
        let before = previous.map(Task::look);
        let sla_before = previous.and_then(|t| t.sla.clone());
        if let Some(notice) = notify::notice_for(before, &task) {
            self.notices.push(notice);
        }
        self.notices.extend(notify::sla_notices(sla_before.as_ref(), &task));
        match self.tasks.iter_mut().find(|t| t.id == task.id) {
            Some(existing) => *existing = task,
            None => self.tasks.push(task),
        }
        self.clamp_selection();
        if let Some(id) = selected {
            self.select(&id, false);
        }
        self.follow_open_card();
    }

    /// The open card changed state under the view: when the page it is on is no longer in its rail, the view moves to the
    /// card's first page and says so. A page that still exists stays where it is.
    fn follow_open_card(&mut self) {
        let id = match &self.mode {
            Mode::Detail(id) => id.clone(),
            _ => match self.over_task() {
                Some(id) => id.to_string(),
                None => return,
            },
        };
        let Some(task) = self.task(&id) else { return };
        if crate::detail::order(task).contains(&self.detail_section) {
            return;
        }
        let (first, column) = (Section::for_task(task), task.column.clone());
        self.set_section(first);
        self.notify(format!("the card moved to {}", crate::model::plain(&column, 40)), false);
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

    /// How many tickets wait on you right now: the Board tab's badge. On Slack that is every
    /// P0/P1 in Needs reply or Decide plus every open item past its reply SLA, each once.
    pub fn needs_you_count(&self) -> usize {
        let tickets = self.tasks.iter().filter(|t| t.look().needs_person()).count();
        let prs = self.prs.prs.iter().filter(|p| p.split_enum().is_some_and(PrSplit::needs_me)).count();
        let slack = self
            .slack_snapshot
            .items
            .iter()
            .filter(|i| {
                let split = i.split_enum();
                (i.urgent() && split.is_some_and(SlackSplit::needs_me)) || (i.overdue && split.is_some_and(SlackSplit::open))
            })
            .count();
        tickets + prs + slack
    }

    /// Tickets past one of their SLA clocks: the header's `‼ N` and the badge's second number.
    /// They already count above when they wait on you; this only adds the bang.
    pub fn overdue_count(&self) -> usize {
        self.tasks.iter().filter(|t| t.overdue()).count()
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

    /// Records stages that started before the board connected, so `f` can open them. Opens
    /// no tabs and re-points none: the scan only fills `stages` (see `scan_rx`).
    fn catch_up_watch_tabs(&self) {
        let tasks: Vec<(String, String, String)> = self
            .tasks
            .iter()
            .filter_map(|t| Some((t.id.clone(), format!("#{} {}", t.short_id(), t.title), t.worktree_path.clone()?)))
            .collect();
        let tx = self.scan_tx.clone();
        thread::spawn(move || {
            for (container, task_id) in herdr::running_containers() {
                if let Some((id, label, cwd)) = tasks.iter().find(|(id, ..)| *id == task_id) {
                    let stage = herdr::Stage { label: label.clone(), cwd: cwd.clone(), container };
                    let _ = tx.send((id.clone(), stage));
                }
            }
        });
    }

    /// `f`: focus the ticket's watch tab, opening it first if a stage is running.
    fn watch(&mut self, task: &Task) {
        if !herdr::available() {
            self.notify("the watch tab needs herdr; run the board inside it", false);
            return;
        }
        self.watch_with(task, herdr::has_task_tab(task.short_id()));
    }

    /// The decision half of `f`, given whether the task already has a tab. A recorded stage
    /// only counts while the task is still running: a finished stage leaves nothing to tail.
    fn watch_with(&mut self, task: &Task, has_tab: bool) {
        let short = task.short_id().to_string();
        let stage = self.stages.get(&task.id).filter(|_| task.running).cloned();
        match herdr::watch_action(has_tab, stage.as_ref()) {
            herdr::WatchAction::FocusExisting => {
                herdr::focus_task_tab(&short);
            }
            herdr::WatchAction::OpenAndFocus(stage) => {
                thread::spawn(move || herdr::open_and_focus(&short, &stage));
            }
            herdr::WatchAction::NothingToWatch => {
                self.notify(format!("nothing is running on #{short} to watch"), false);
            }
        }
    }

    fn forget(&mut self, id: &str) {
        self.stages.remove(id);
        self.tasks.retain(|t| t.id != id);
        if self.shows_detail_of(id) {
            self.detail = None;
        }
        if matches!(&self.mode, Mode::Detail(open) if open == id) {
            self.mode = Mode::Normal;
        }
        self.settle_confirm();
        self.clamp_selection();
    }

    /// Keeps `detail` in step with the ticket being viewed or previewed.
    pub fn ensure_detail(&mut self) {
        let target = match &self.mode {
            Mode::Detail(id) => Some(id.clone()),
            _ => self.over_task().map(str::to_string).or_else(|| self.selected_task().map(|t| t.id.clone())),
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
                let wanted = diff.files.get(self.detail_row()).map(|f| f.path.clone());
                if wanted.is_none() || (diff.file == wanted && diff.patch.is_some()) {
                    return;
                }
                wanted
            }
        };
        let machine = self.machine.clone();
        let tx = self.tx.clone();
        let (fetching, wanted, generation) = (id.clone(), file.clone(), self.diff_generation);
        thread::spawn(move || {
            let diff = machine.diff(&fetching, wanted.as_deref());
            let _ = tx.send(Incoming::Diff { id: fetching, file: wanted, diff, generation });
        });
        self.diff_pending = Some((id, file));
    }

    pub fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }

    /// The ticket a key would act on: the open popup's (also under its `?` sheet), the Inbox
    /// row's, else the board's selection. The registry's predicates read it.
    pub fn focus_task(&self) -> Option<&Task> {
        match &self.mode {
            Mode::Detail(id) => return self.task(id),
            _ if self.over_task().is_some() => return self.over_task().and_then(|id| self.task(id)),
            _ => {}
        }
        if let Some(state) = &self.inbox {
            let ids = inbox::items(&self.tasks, state.split, now_secs());
            return ids.get(state.cursor.min(ids.len().saturating_sub(1))).map(|&i| &self.tasks[i]);
        }
        self.selected_task()
    }

    /// The vim state of the editor that has the keyboard, if one is open.
    pub fn editor_vim(&self) -> Option<&Vim> {
        match &self.mode {
            Mode::EditTicket { vim, .. } | Mode::EditCases { vim, .. } | Mode::Answer { vim, .. } | Mode::SlackReply { vim, .. } => Some(vim),
            Mode::EditPlan { focus: PlanPane::Plan, plan_vim, .. } => Some(plan_vim),
            Mode::EditPlan { focus: PlanPane::Ticket, ticket_vim, .. } => Some(ticket_vim),
            _ => None,
        }
    }

    /// The watch under the cursor of the open Watches popup.
    pub fn watch_under_cursor(&self) -> Option<&SlackWatch> {
        let open = self.slack.as_ref()?.watches.as_ref()?;
        let count = self.slack_snapshot.watches.len();
        self.slack_snapshot.watches.get(open.cursor.min(count.saturating_sub(1)))
    }

    /// The which-key strip: the prefix in flight and its second keys, once it has waited
    /// `WHICH_KEY_DELAY` for one. Read every frame; the 200 ms poll makes the frame.
    pub fn which_key(&self) -> Option<(char, Vec<(char, &'static str)>)> {
        let prefix = self.prefix?;
        if self.prefix_at.is_some_and(|at| at.elapsed() >= WHICH_KEY_DELAY) { Some((prefix, keys::which_key(prefix))) } else { None }
    }

    /// Tests: makes the prefix in flight old enough for the strip.
    #[cfg(test)]
    pub fn age_prefix(&mut self) {
        self.prefix_at = self.prefix_at.map(|at| at - WHICH_KEY_DELAY);
    }

    /// `?`: the sheet for whatever has the keyboard, scrolled to the top.
    fn open_help(&mut self) {
        let scope = keys::active_scope(self);
        self.help_scroll.set(0);
        self.mode = Mode::Help { scope, long: true, query: None, cursor: 0 };
    }

    /// Closes the sheet: back to the popup it was opened over, else the view under it.
    fn close_help(&mut self) {
        self.help_scroll.set(0);
        self.back_from_overlay();
    }

    /// The keys `handle_help` matches, besides the view's own that it passes on.
    #[cfg(test)]
    pub(crate) const HANDLED_HELP: &[&str] = &["j", "k", "ctrl+d", "ctrl+u", "/", "?", "enter", "esc", "q"];

    /// The sheet's keys. `j`/`k` and ctrl+d/ctrl+u move the cursor, `/` searches every view's
    /// keys, `?` toggles the long form, enter runs the row (in its own view only), esc and `q`
    /// close. Any other key that is bright in the sheet closes it and runs as if pressed on the
    /// view; a dim or unknown one only says why.
    fn handle_help(&mut self, key: KeyEvent) -> Outcome {
        let Mode::Help { scope, long, query, .. } = &self.mode else {
            return Outcome::Continue;
        };
        let scope = *scope;
        let rows = keys::help_rows_for(self, scope, *long, query.as_deref());
        let runnable = rows.iter().filter(|r| matches!(r, keys::HelpRow::Key { .. })).count();
        let Mode::Help { long, query, cursor, .. } = &mut self.mode else {
            return Outcome::Continue;
        };
        let page = usize::from(self.help_viewport.get() / 2).max(1);
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('d') => *cursor = (*cursor + page).min(runnable.saturating_sub(1)),
                KeyCode::Char('u') => *cursor = cursor.saturating_sub(page),
                _ => {}
            }
            return Outcome::Continue;
        }
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => *cursor = (*cursor + 1).min(runnable.saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => *cursor = cursor.saturating_sub(1),
            KeyCode::PageDown => *cursor = (*cursor + page).min(runnable.saturating_sub(1)),
            KeyCode::PageUp => *cursor = cursor.saturating_sub(page),
            KeyCode::Esc if query.is_some() => {
                *query = None;
                *cursor = 0;
            }
            KeyCode::Esc => self.close_help(),
            KeyCode::Backspace => {
                if let Some(q) = query.as_mut() {
                    if q.pop().is_none() {
                        *query = None;
                    }
                    *cursor = 0;
                }
            }
            KeyCode::Char(c) if query.is_some() => {
                if let Some(q) = query.as_mut() {
                    q.push(c);
                }
                *cursor = 0;
            }
            KeyCode::Char('q') => self.close_help(),
            KeyCode::Char('/') => {
                *query = Some(String::new());
                *cursor = 0;
            }
            KeyCode::Char('?') => {
                *long = !*long;
                *cursor = 0;
            }
            KeyCode::Enter => {
                let at = *cursor;
                let row = rows.iter().filter(|r| matches!(r, keys::HelpRow::Key { .. })).nth(at);
                if let Some(keys::HelpRow::Key { binding, avail, .. }) = row {
                    let (binding, avail) = (*binding, *avail);
                    if binding.scope != scope {
                        self.notify(format!("open {} first", binding.scope.name()), false);
                    } else if let keys::Avail::Off(why) = avail {
                        self.notify(why, false);
                    } else {
                        self.close_help();
                        for event in keys::key_events(binding.first()) {
                            if let Outcome::Quit = self.handle_key(event) {
                                return Outcome::Quit;
                            }
                        }
                    }
                }
            }
            KeyCode::Char(c) => {
                let hit = keys::bindings_for(self, scope).into_iter().find(|(b, _)| b.menu_key().is_none() && b.group != keys::Group::Commands && b.matches_char(c));
                match hit {
                    Some((_, keys::Avail::On)) => {
                        self.close_help();
                        return self.handle_key(key);
                    }
                    Some((_, keys::Avail::Off(why))) => self.notify(why, false),
                    _ => self.notify(format!("{c} is not a key here; esc closes"), false),
                }
            }
            _ => {}
        }
        Outcome::Continue
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
        if self.needs_only && !task.look().needs_person() {
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
            (&t.id, &t.updated_at, &t.state, t.queued, t.running, t.waiting_on_you, &t.column, &t.repo_path, &t.created_at, &t.title, t.gate_overdue()).hash(&mut h);
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
            // A gate past its SLA sorts first whatever the order: it has waited longest on you.
            let (late_a, late_b) = (!a.gate_overdue(), !b.gate_overdue());
            match self.group {
                GroupBy::Stage => (late_a, a.look(), &a.created_at).cmp(&(late_b, b.look(), &b.created_at)),
                GroupBy::Repo => (a.repo_name(), late_a, a.look(), &a.created_at).cmp(&(b.repo_name(), late_b, b.look(), &b.created_at)),
                GroupBy::Age => (late_a, &a.created_at).cmp(&(late_b, &b.created_at)),
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

    /// The full-screen view that owns the screen and the keys: the one function draw, dispatch and the key tables ask.
    pub fn active_view(&self) -> Option<View> {
        [
            (View::Floor, self.floor.is_some()),
            (View::Inbox, self.inbox.is_some()),
            (View::Digest, self.digest.is_some()),
            (View::Pulls, self.pulls.is_some()),
            (View::Backlog, self.backlog.is_some()),
            (View::Economy, self.economy.is_some()),
            (View::Tickets, self.tickets.is_some()),
            (View::Slack, self.slack.is_some()),
        ]
        .into_iter()
        .find_map(|(view, open)| open.then_some(view))
    }

    /// Closes every full-screen view; a view that opens calls this first, so two are never open at once. (A task opened
    /// from a view does not: the view waits under it and `esc` brings it back.)
    fn close_views(&mut self) {
        self.floor = None;
        self.inbox = None;
        self.digest = None;
        self.pulls = None;
        self.backlog = None;
        self.economy = None;
        self.tickets = None;
        self.slack = None;
    }

    /// The card a command on "the ticket" acts on: the open task's when the command was typed over one, else the board's selection.
    fn card_target(&self) -> Option<String> {
        self.command_card.clone().or_else(|| self.selected_id())
    }

    fn clamp_selection(&mut self) {
        for column in 0..COLUMNS.len() {
            let len = self.indices(column).len();
            self.selection[column] = self.selection[column].min(len.saturating_sub(1));
        }
    }

    /// Mouse wheel: scrolls the detail popup if it's open, does nothing under a prompt over a task, otherwise moves the board selection.
    pub fn scroll(&mut self, delta: i16) {
        if matches!(self.mode, Mode::Detail(_)) {
            self.scroll_detail(delta);
        } else if self.over_task().is_none() {
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
        if matches!(self.mode, Mode::Detail(_)) {
            return self.click_detail(x, y);
        }
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
        if !self.indices(column).is_empty() {
            self.selection[column] = crate::ui::card_at_row(self, column, rect.width, row);
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
        let Some(requested) = self.detail.as_ref().and_then(|d| d.latest_approval("awaiting_approval")).map(|a| a.requested.clone()) else {
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

    /// Opens test_design's cases for editing, as markdown grouped by the criterion each proves.
    fn open_cases_editor(&mut self, id: &str) {
        let Some(task) = self.task(id) else {
            return;
        };
        let Some(cases) = self.detail.as_ref().filter(|d| d.task.id == id).map(TaskDetail::cases) else {
            return;
        };
        let mut area = TextArea::new(cases_markdown(&cases).lines().map(str::to_string).collect());
        area.move_cursor(tui_textarea::CursorMove::Jump(0, 0));
        area.set_block(
            ratatui::widgets::Block::bordered()
                .padding(ratatui::widgets::Padding::new(2, 2, 1, 1))
                .title(format!(" cases for #{} {} — ## criterion, - case, its approach under it ", task.short_id(), task.title)),
        );
        self.mode = Mode::EditCases { id: id.to_string(), area, vim: Vim::new() };
    }

    fn handle_edit_cases(&mut self, key: KeyEvent) -> Outcome {
        let Mode::EditCases { id, area, vim } = &mut self.mode else {
            return Outcome::Continue;
        };
        match vim.handle(area, key) {
            crate::vim::Outcome::Continue => {}
            crate::vim::Outcome::Cancel => self.mode = Mode::Detail(id.clone()),
            crate::vim::Outcome::Save => {
                let id = id.clone();
                let markdown = area.lines().join("\n");
                self.mode = Mode::Detail(id.clone());
                // The baseline is what the editor opened with, read back the same way, so
                // whitespace the markdown never carried does not count as a change.
                let before: Vec<crate::model::TestCase> =
                    self.detail.as_ref().filter(|d| d.task.id == id).map(|d| parse_cases(&cases_markdown(&d.cases()))).unwrap_or_default();
                let edited = parse_cases(&markdown);
                if edited.is_empty() {
                    self.notify("keep at least one case; r sends the whole set back instead", true);
                } else if edited != before {
                    match self.machine.edit_cases(&id, &edited) {
                        Ok(task) => {
                            self.upsert(task);
                            self.detail_stale = true;
                            self.notify("cases saved", false);
                        }
                        Err(error) => self.notify(error, true),
                    }
                } else {
                    self.notify("nothing changed", false);
                }
            }
        }
        Outcome::Continue
    }

    /// The chooser `e` opens on the Review page: `p` the plan, `c` the cases, `t` the ticket; esc goes back to the task.
    fn handle_edit_choice(&mut self, key: KeyEvent, id: &str) -> Outcome {
        let Some(task) = self.task(id).cloned() else {
            self.mode = Mode::Normal;
            return Outcome::Continue;
        };
        match key.code {
            KeyCode::Char('p') if plan_editable(&task, self.detail.as_ref()) || has_open_plan(&task, self.detail.as_ref()) => self.open_plan_editor(id),
            KeyCode::Char('p') => self.notify("the plan can no longer be edited", false),
            KeyCode::Char('c') => self.open_cases_editor(id),
            KeyCode::Char('t') => self.open_ticket_editor(id),
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
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

    /// Opens the approval box for `task`, holding the card, its gate and the words. Says so, and opens nothing, while the
    /// card's detail is still on its way: the gate's kind (plan or split, ship or release) is read from it.
    fn hold_approval(&mut self, task: &Task, skip_rules: bool) {
        if matches!(task.state.as_str(), "awaiting_approval" | "awaiting_ship") && !self.shows_detail_of(&task.id) {
            return self.notify("still reading this card; press again in a moment", false);
        }
        let Some(gate) = self.approval_gate(task) else { return };
        let question = if skip_rules { format!("approve the retro of #{} and skip its rules?", task.short_id()) } else { gate.question };
        let approval = self.open_approval_id(&task.id);
        self.mode = Mode::ConfirmApprove(HeldApproval { id: task.id.clone(), gate: gate.kind, question, approval, skip_rules });
    }

    /// The machine's id of the approval open on `id`, when its detail is the one loaded.
    fn open_approval_id(&self, id: &str) -> Option<String> {
        self.detail.as_ref().filter(|d| d.task.id == id).and_then(|d| d.open_approval()).and_then(|a| a.id.clone())
    }

    /// Whether the task view of `id` is where this key was pressed: the task itself, or a prompt or command opened over it.
    fn task_is_open(&self, id: &str) -> bool {
        matches!(&self.mode, Mode::Detail(open) if open == id) || self.command_card.as_deref() == Some(id) || self.over_task() == Some(id)
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
            "archived" => self.notify("this ticket is archived", false),
            _ if task.waiting_on_you && self.approval_gate(&task).is_some() => self.hold_approval(&task, false),
            _ => self.notify(format!("{} is running; X aborts it", task.status_label()), false),
        }
        Outcome::Continue
    }

    /// A key that acts on one ticket, from the board, its details, or the actions menu.
    fn ticket_key(&mut self, key: char, id: &str) -> Outcome {
        let Some(task) = self.task(id).cloned() else {
            return Outcome::Continue;
        };
        // No gate is approved unseen: from anywhere but the open task, the key opens the task on its first page instead.
        let approves = match key {
            'a' | 'S' => task.waiting_on_you && self.approval_gate(&task).is_some(),
            'A' => task.state == "reviewing_memory" && task.waiting_on_you,
            _ => false,
        };
        if approves && !self.task_is_open(id) {
            self.open_detail(id.to_string());
            return Outcome::Continue;
        }
        match key {
            'a' => return self.advance(id),
            'A' => {
                if task.state == "reviewing_memory" && task.waiting_on_you {
                    self.hold_approval(&task, true);
                } else if task.state == "reviewing_memory" {
                    self.notify("the retro is still running", false);
                } else {
                    self.notify("no memory review waiting on this ticket", false);
                }
            }
            'S' => {
                if task.state == "awaiting_ship" && task.waiting_on_you {
                    return self.advance(id);
                }
                self.notify(if task.state == "awaiting_ship" { "the machine is watching the PR; nothing to ship yet" } else { "nothing waiting to ship on this ticket" }, false);
            }
            'e' => {
                if let Some(why) = crate::keys::edit_blocked(self, &task) {
                    self.notify(why, false);
                    return Outcome::Continue;
                }
                let in_popup = matches!(&self.mode, Mode::Detail(open) if open == id);
                let section = self.detail_section;
                if in_popup && section == Section::Review && cases_editable(&task, self.detail.as_ref()) {
                    self.mode = Mode::EditChoice(id.to_string());
                } else if in_popup && section == Section::Tests && cases_editable(&task, self.detail.as_ref()) {
                    self.open_cases_editor(id);
                } else if (in_popup && section == Section::Plan && plan_editable(&task, self.detail.as_ref())) || has_open_plan(&task, self.detail.as_ref()) {
                    self.open_plan_editor(id);
                } else {
                    self.open_ticket_editor(id);
                }
            }
            'y' | 'n' => {
                if task.evidence.is_none() {
                    self.notify("this ticket has no Evidence Pack yet", false);
                } else if key == 'y' {
                    self.act(|m| m.evidence_feedback(id, true, None), "noted: the pack was useful");
                } else {
                    self.mode = Mode::EvidenceNote { id: id.to_string(), text: String::new() };
                }
            }
            'R' => self.open_repo_picker(id),
            'N' => {
                if crate::keys::rejectable(self, &task) {
                    self.mode = Mode::Reject { id: id.to_string(), text: String::new() };
                } else {
                    self.notify("only the plan gate and the release question reject", false);
                }
            }
            'r' => {
                if crate::keys::sendable_back_now(self, &task) {
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
            'Z' => {
                if matches!(task.state.as_str(), "closed" | "archived") {
                    self.notify(format!("this ticket is already {}", task.state), false);
                } else {
                    self.mode = Mode::ArchiveReason { id: id.to_string(), cursor: 0 };
                }
            }
            'C' => {
                if task.state == "escalated" {
                    self.mode = Mode::EscalationReason { id: id.to_string(), cursor: 0 };
                } else {
                    self.notify("this ticket is not escalated", false);
                }
            }
            'p' => {
                if task.state == "awaiting_answers" {
                    self.act(|m| m.post_questions(id), "questions posted where the ticket came from");
                } else {
                    self.notify("no questions are waiting on this ticket", false);
                }
            }
            'T' => match record_edit_mode(&task) {
                Ok(mode) => self.mode = mode,
                Err(why) => self.notify(why, false),
            },
            'd' => self.mode = Mode::ConfirmDelete(id.to_string()),
            'f' => self.watch(&task),
            'o' | 'i' => match issue_link(&task) {
                Some(url) => self.open_url(&url),
                None => self.notify("no issue linked", false),
            },
            'J' => match task.jira_key() {
                Some(_) => self.mode = Mode::ConfirmJiraUnlink(id.to_string()),
                None => self.open_jira_link(id),
            },
            _ => {}
        }
        Outcome::Continue
    }

    /// The Jira search for a ticket: empty until three characters are typed. A machine with no
    /// Jira configured says so in the footer instead.
    fn open_jira_link(&mut self, id: &str) {
        match self.machine.jira_status() {
            Ok(status) if !status.configured => {
                let why = status.error.unwrap_or_else(|| "set MACHINE_JIRA_SITE, _EMAIL and _TOKEN".to_string());
                self.notify(format!("Jira is not configured on the machine: {why}"), true);
                return;
            }
            Err(error) => self.notify(format!("jira status: {error}"), true),
            Ok(_) => {}
        }
        self.mode = Mode::JiraLink { id: id.to_string(), query: String::new(), hits: Vec::new(), cursor: 0 };
    }

    /// Links `key` to the ticket; a bad key is refused here, before the machine sees it.
    fn link_jira(&mut self, id: &str, key: &str) {
        let key = key.trim().to_uppercase();
        if !looks_like_jira_key(&key) {
            self.notify(format!("{key:?} is not a Jira key like PLAT-123"), true);
            return;
        }
        self.act(|m| m.link_jira(id, &key), &format!("linked {key}"));
    }

    /// Type to search, `enter` links the row (row 0 creates an issue instead), `ctrl+n` creates
    /// one straight away, `esc` backs out. From three characters on the machine is asked, off the
    /// UI thread and a quarter second after the last keystroke (`ensure_jira_search`); a failed
    /// search shows in the footer and keeps the last hits.
    fn handle_jira_link(&mut self, key: KeyEvent) -> Outcome {
        let Mode::JiraLink { id, query, hits, cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        let id = id.clone();
        match key.code {
            KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.mode = Mode::Normal;
                self.jira_search_due = None;
                self.act(|m| m.create_jira(&id, None), "Jira issue created and linked");
            }
            KeyCode::Char(_) | KeyCode::Backspace => {
                match key.code {
                    KeyCode::Char(c) => query.push(c),
                    _ => {
                        query.pop();
                    }
                }
                *cursor = 0;
                if query.trim().chars().count() >= 3 {
                    self.jira_search_due = Some((query.trim().to_string(), Instant::now()));
                } else {
                    hits.clear();
                    self.jira_search_due = None;
                }
            }
            KeyCode::Down => *cursor = (*cursor + 1).min(hits.len()),
            KeyCode::Up => *cursor = cursor.saturating_sub(1),
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.jira_search_due = None;
            }
            KeyCode::Enter => {
                let chosen = cursor.checked_sub(1).and_then(|i| hits.get(i)).map(|h| h.key.clone());
                let typed = query.trim().to_uppercase();
                self.mode = Mode::Normal;
                self.jira_search_due = None;
                match chosen {
                    Some(key) => self.link_jira(&id, &key),
                    // Row 0 is "create", unless what was typed is itself a key: then link that.
                    None if looks_like_jira_key(&typed) => self.link_jira(&id, &typed),
                    None => self.act(|m| m.create_jira(&id, None), "Jira issue created and linked"),
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// Runs the `J` prompt's search once the typing has paused, on a background thread; the
    /// answer comes back through the stream as `Incoming::JiraHits` and is dropped if the
    /// query has changed by then. Called every frame.
    pub fn ensure_jira_search(&mut self) {
        if !matches!(self.mode, Mode::JiraLink { .. }) {
            self.jira_search_due = None;
            return;
        }
        let Some((query, at)) = self.jira_search_due.as_ref() else { return };
        if at.elapsed() < JIRA_SEARCH_DEBOUNCE {
            return;
        }
        let query = query.clone();
        self.jira_search_due = None;
        let machine = self.machine.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let hits = machine.jira_search(&query);
            let _ = tx.send(Incoming::JiraHits { query, hits });
        });
    }

    /// Tests: runs a due search now and waits for its answer.
    #[cfg(test)]
    fn settle_jira_search(&mut self) {
        if let Some((query, _)) = self.jira_search_due.take() {
            self.jira_search_due = Some((query, Instant::now() - JIRA_SEARCH_DEBOUNCE));
        }
        self.ensure_jira_search();
        loop {
            let incoming = self.stream.recv_timeout(Duration::from_secs(5)).expect("the search answers");
            let done = matches!(incoming, Incoming::JiraHits { .. });
            self.take_incoming(incoming);
            if done {
                return;
            }
        }
    }

    fn handle_confirm_jira_unlink(&mut self, key: KeyEvent) -> Outcome {
        let Mode::ConfirmJiraUnlink(id) = &self.mode else {
            return Outcome::Continue;
        };
        let id = id.clone();
        match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                self.mode = Mode::Normal;
                self.act(|m| m.unlink_jira(&id), "Jira issue unlinked");
            }
            KeyCode::Char('n') | KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
    }

    /// The card whose task view a prompt, picker, editor or sheet is open over: the task stays on
    /// screen behind it, and `settle_return` brings the view back when it closes.
    pub fn over_task(&self) -> Option<&str> {
        match self.mode {
            Mode::Normal | Mode::Detail(_) => None,
            _ => self.return_to.as_deref(),
        }
    }

    /// Closes an overlay: back to the task view it was opened over, else the board.
    fn back_from_overlay(&mut self) {
        self.mode = match self.return_to.take() {
            Some(id) if self.task(&id).is_some() => Mode::Detail(id),
            _ => Mode::Normal,
        };
    }

    /// After every key: a mode opened from the task view remembers it, a mode that closed to the
    /// board returns to it (the card may be gone by then, and then the board is right), and the task
    /// view itself holds no way back.
    fn settle_return(&mut self, from: Option<String>) {
        match &self.mode {
            Mode::Detail(_) => self.return_to = None,
            Mode::Normal => self.back_from_overlay(),
            _ => {
                if from.is_some() {
                    self.return_to = from;
                }
            }
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        let from = match &self.mode {
            Mode::Detail(id) => Some(id.clone()),
            _ => None,
        };
        let outcome = self.dispatch_key(key);
        self.settle_return(from);
        outcome
    }

    fn dispatch_key(&mut self, key: KeyEvent) -> Outcome {
        if self.toast.as_ref().is_some_and(|t| t.error) {
            self.toast = None;
        }
        if matches!(self.mode, Mode::Normal) {
            match self.active_view() {
                Some(View::Floor) => return self.handle_floor(key),
                Some(View::Inbox) => return self.handle_inbox(key),
                Some(View::Digest) => return self.handle_digest(key),
                Some(View::Pulls) => return self.handle_pulls(key),
                Some(View::Backlog) => return self.handle_backlog(key),
                Some(View::Economy) => return self.handle_economy(key),
                Some(View::Tickets) => return self.handle_tickets(key),
                Some(View::Slack) => return self.handle_slack(key),
                None => {}
            }
        }
        match &self.mode {
            Mode::Normal => self.handle_normal(key),
            Mode::Detail(id) => {
                let id = id.clone();
                self.handle_detail(key, &id)
            }
            Mode::Adding(_) => self.handle_adding(key),
            Mode::EditTicket { .. } => self.handle_edit_ticket(key),
            Mode::EditCases { .. } => self.handle_edit_cases(key),
            Mode::EditChoice(id) => {
                let id = id.clone();
                self.handle_edit_choice(key, &id)
            }
            Mode::Answer { .. } => self.handle_answer(key),
            Mode::EditPlan { .. } => self.handle_edit_plan(key),
            Mode::Filter => self.handle_filter(key),
            Mode::Command { .. } => self.handle_command(key),
            Mode::Reason { .. } => self.handle_reason(key),
            Mode::Reject { .. } => self.handle_reject(key),
            Mode::EvidenceNote { .. } => self.handle_evidence_note(key),
            Mode::ConfirmApprove(_) => self.handle_confirm_approve(key),
            Mode::ConfirmDelete(id) | Mode::ConfirmAbort(id) | Mode::ConfirmWorktree(id) => {
                let id = id.clone();
                self.handle_confirm(key, &id)
            }
            Mode::ConfirmQuit => self.handle_confirm_quit(key),
            Mode::ArchiveReason { .. } => self.handle_archive_reason(key),
            Mode::EscalationReason { .. } => self.handle_escalation_reason(key),
            Mode::RecordEdit { .. } => self.handle_record_edit(key),
            Mode::ConfirmApproveAll(_) => self.handle_confirm_approve_all(key),
            Mode::ConfirmMany { .. } => self.handle_confirm_many(key),
            Mode::ConfirmApproveMany { .. } => self.handle_confirm_approve_many(key),
            Mode::Actions { .. } => self.handle_actions(key),
            Mode::RepoPicker { .. } => self.handle_repo_picker(key),
            Mode::ConfirmMerge { .. } => self.handle_confirm_merge(key),
            Mode::ConfirmClose { .. } => self.handle_confirm_close(key),
            Mode::ClonePrompt { .. } => self.handle_clone_prompt(key),
            Mode::PrActions { .. } => self.handle_pr_actions(key),
            Mode::SlackSnooze { .. } => self.handle_slack_snooze(key),
            Mode::SlackDismiss { .. } => self.handle_slack_dismiss(key),
            Mode::SlackPick { .. } => self.handle_slack_pick(key),
            Mode::SlackReply { .. } => self.handle_slack_reply(key),
            Mode::SlackTask { .. } => self.handle_slack_task(key),
            Mode::SlackWatchAdd { .. } => self.handle_slack_watch_add(key),
            Mode::SlackActions { .. } => self.handle_slack_actions(key),
            Mode::JiraLink { .. } => self.handle_jira_link(key),
            Mode::ConfirmJiraUnlink(_) => self.handle_confirm_jira_unlink(key),
            Mode::EnginePicker { .. } => self.handle_engine_picker(key),
            Mode::Help { .. } => self.handle_help(key),
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
        let d7 = self.machine.metrics_for("7d", repo.as_ref().map(|r| r.as_deref()), (!focused).then_some("repo"));
        let d30 = self.machine.metrics_for("30d", repo.as_ref().map(|r| r.as_deref()), None);
        // The rows are the 7d answer's when it covers every repo; one more call otherwise.
        let rows = if focused { Some(self.machine.metrics_for("7d", None, Some("repo"))) } else { None };
        // Engines are a bonus too: a machine from before them answers groupBy=engine with a 400.
        let by_engine = self.machine.metrics_for("7d", repo.as_ref().map(|r| r.as_deref()), Some("engine")).ok().and_then(|m| m.by_engine);
        let health = self.machine.repo_health().unwrap_or_default();
        let engines = self.machine.engines().ok().filter(|e| e.iter().any(|e| e.spent_this_month_usd.is_some()));
        // The Slack block is a bonus: a machine without the inbox leaves it out, nothing else changes.
        let slack = self.machine.slack_metrics("7d").and_then(|d7| self.machine.slack_metrics("30d").map(|d30| (d7, d30))).ok();
        let Some(floor) = self.floor.as_mut() else {
            return;
        };
        floor.slack = slack;
        floor.by_engine = by_engine;
        floor.health = health;
        floor.engines = engines.unwrap_or_default();
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
        if floor.cursor > floor.focusable() {
            floor.cursor = 0;
        }
        if let Some(error) = errors.into_iter().next() {
            self.notify(format!("floor: {error}"), true);
        }
    }

    /// The keys `handle_floor` matches; the registry's Floor scope must list exactly these.
    #[cfg(test)]
    pub(crate) const HANDLED_FLOOR: &[&str] = &["esc", "F", "q", "?", "R", "A", "tab", "shift+tab"];

    fn handle_floor(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Esc | KeyCode::Char('F') | KeyCode::Char('q') => self.floor = None,
            KeyCode::Char('?') => self.open_help(),
            KeyCode::Char('R') => self.refresh_floor(),
            KeyCode::Char('A') => self.approve_pending_base(),
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

    /// A: approves the base the focused repository is waiting on (the machine checks it is the one in its luna.yaml).
    fn approve_pending_base(&mut self) {
        let Some(floor) = self.floor.as_ref() else { return };
        let Some(repo) = floor.focused_repo().flatten().map(str::to_string) else {
            self.notify("focus a repository (tab) to approve its base".to_string(), true);
            return;
        };
        let Some(base) = floor.health.iter().find(|h| h.repo == repo).and_then(|h| h.image.pending_base.clone()) else {
            self.notify("that repository has no base waiting".to_string(), false);
            return;
        };
        match self.machine.approve_base(&repo, &base) {
            Ok(()) => {
                self.notify(format!("approved base {}", crate::model::plain(&base, 60)), false);
                self.refresh_floor();
            }
            Err(e) => self.notify(format!("approve base: {e}"), true),
        }
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
                if task.look().needs_person() {
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

    /// The keys `handle_digest` matches.
    #[cfg(test)]
    pub(crate) const HANDLED_DIGEST: &[&str] = &["esc", "D", "q", "?", "j", "k", "enter", "o"];

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
                self.open_help();
                return Outcome::Continue;
            }
            KeyCode::Char('j') | KeyCode::Down => next.cursor = (state.cursor + 1).min(entries.len().saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => next.cursor = state.cursor.saturating_sub(1),
            KeyCode::Enter => {
                if let Some(id) = under_cursor {
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
        let issue = self.task(id).and_then(|t| t.source.as_ref().and_then(|s| s.link().map(str::to_string)).or_else(|| t.jira.as_ref().map(|j| j.url.clone())));
        match pr.or(issue) {
            Some(url) => self.open_url(&url),
            None => self.notify("no PR or issue linked to this ticket yet", false),
        }
    }

    /// The keys `handle_inbox` matches: its own, then everything `ticket_key` takes (`A` is its
    /// own: the split's approval, not the memory review).
    #[cfg(test)]
    pub(crate) const HANDLED_INBOX: &[&str] =
        &["esc", "I", "q", "?", "j", "k", "l", "h", "1-5", "enter", "A", "a", "S", "e", "R", "r", "N", "X", "w", "Z", "C", "d", "f", "o", "J", "T", "p"];

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
                self.open_help();
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
                    self.select(&id, true);
                    self.open_detail(id);
                }
                return Outcome::Continue;
            }
            KeyCode::Char('A') => {
                let approve: Vec<String> = inbox::items(&self.tasks, Split::Approve, now).iter().map(|&i| &self.tasks[i]).filter(|t| self.committing_kind(t).is_some()).map(|t| t.id.clone()).collect();
                if approve.is_empty() {
                    self.notify("nothing to approve together; enter opens a card to approve it", false);
                } else {
                    self.mode = Mode::ConfirmApproveAll(approve);
                }
                return Outcome::Continue;
            }
            KeyCode::Char(c) => {
                if let Some(id) = under_cursor {
                    return self.board_key(c, &id);
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
        self.close_views();
        self.pulls = Some(PullsState::default());
    }

    /// The keys `handle_pulls` matches, `PrKey::ALL` included.
    #[cfg(test)]
    pub(crate) const HANDLED_PULLS: &[&str] = &["esc", "P", "q", "?", "j", "k", "l", "h", "1-6", "R", "o", "enter", "x", "m", "c", "v", "t", "X"];

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
                self.open_help();
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
                self.poll_prs();
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

    /// The item under the Backlog cursor.
    pub fn backlog_under_cursor(&self) -> Option<BacklogEntry> {
        let state = self.backlog.as_ref()?;
        self.backlog_items.get(state.cursor.min(self.backlog_items.len().saturating_sub(1))).cloned()
    }

    /// Fetches the ranked backlog; a failure is a toast and the list stays as it was.
    fn refresh_backlog(&mut self) {
        match self.machine.backlog() {
            Ok(items) => {
                self.backlog_items = items;
                if let Some(state) = self.backlog.as_mut() {
                    state.cursor = state.cursor.min(self.backlog_items.len().saturating_sub(1));
                }
            }
            Err(error) => self.notify(format!("backlog: {error}"), true),
        }
    }

    fn open_backlog(&mut self) {
        self.close_views();
        self.backlog = Some(BacklogState::default());
        self.refresh_backlog();
    }

    /// The keys `handle_backlog` matches.
    #[cfg(test)]
    pub(crate) const HANDLED_BACKLOG: &[&str] = &["esc", "B", "q", "?", "j", "k", "R", "p", "b", "d"];

    /// The Backlog view's keys: move, promote, bump, decline, refetch.
    fn handle_backlog(&mut self, key: KeyEvent) -> Outcome {
        let Some(state) = self.backlog.clone() else {
            return Outcome::Continue;
        };
        let count = self.backlog_items.len();
        match key.code {
            KeyCode::Esc | KeyCode::Char('B') | KeyCode::Char('q') => self.backlog = None,
            KeyCode::Char('?') => self.open_help(),
            KeyCode::Char('j') | KeyCode::Down => self.backlog = Some(BacklogState { cursor: (state.cursor + 1).min(count.saturating_sub(1)) }),
            KeyCode::Char('k') | KeyCode::Up => self.backlog = Some(BacklogState { cursor: state.cursor.saturating_sub(1) }),
            KeyCode::Char('R') => self.refresh_backlog(),
            KeyCode::Char(c @ ('p' | 'b' | 'd')) => {
                let Some(item) = self.backlog_under_cursor() else {
                    self.notify("no item selected", true);
                    return Outcome::Continue;
                };
                let (action, done) = match c {
                    'p' => ("promote", "promoted to a ticket"),
                    'b' => ("bump", "bumped"),
                    _ => ("decline", "declined"),
                };
                match self.machine.backlog_act(&item.id, action) {
                    Ok(()) => {
                        self.notify(done, false);
                        self.refresh_backlog();
                    }
                    Err(error) => self.notify(format!("backlog: {error}"), true),
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// The row under the Economy cursor.
    pub fn economy_row(&self) -> Option<Row> {
        self.economy_data.row_at(self.economy.as_ref()?.cursor)
    }

    /// Fetches the repository's economy; a failure is a toast and the view keeps what it had.
    fn refresh_economy(&mut self) -> bool {
        let Some(repo) = self.economy.as_ref().map(|s| s.repo.clone()) else {
            return false;
        };
        match self.machine.economy(&repo) {
            Ok(data) => {
                self.economy_data = data;
                let last = self.economy_data.rows().len().saturating_sub(1);
                if let Some(state) = self.economy.as_mut() {
                    state.cursor = state.cursor.min(last);
                }
                true
            }
            Err(error) => {
                self.notify(error, true);
                false
            }
        }
    }

    /// Opens the view for the repository of the card under the cursor.
    fn open_economy(&mut self) {
        let Some(repo) = self.selected_task().and_then(|t| t.repo_path.clone()).filter(|p| !p.trim().is_empty()) else {
            self.notify("select a card with a repository", true);
            return;
        };
        self.economy_data = Economy::default();
        self.close_views();
        self.economy = Some(EconomyState { repo, cursor: 0 });
        if !self.refresh_economy() {
            self.economy = None;
        }
    }

    /// The keys `handle_economy` matches.
    #[cfg(test)]
    pub(crate) const HANDLED_ECONOMY: &[&str] = &["esc", "q", "?", "j", "k", "R", "d", "a", "r", "I"];

    /// The Economy view's keys: move, refetch, drop a fact, approve or restore the mask, import past runs.
    fn handle_economy(&mut self, key: KeyEvent) -> Outcome {
        let Some(state) = self.economy.clone() else {
            return Outcome::Continue;
        };
        let count = self.economy_data.rows().len();
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => self.economy = None,
            KeyCode::Char('?') => self.open_help(),
            KeyCode::Char('j') | KeyCode::Down => self.economy = Some(EconomyState { cursor: (state.cursor + 1).min(count.saturating_sub(1)), ..state }),
            KeyCode::Char('k') | KeyCode::Up => self.economy = Some(EconomyState { cursor: state.cursor.saturating_sub(1), ..state }),
            KeyCode::Char('R') => {
                self.refresh_economy();
            }
            KeyCode::Char('I') => match self.machine.economy_act("import", &state.repo, serde_json::json!({})) {
                Ok(body) => {
                    self.refresh_economy();
                    self.notify(format!("imported {} runs", body["runs"].as_u64().unwrap_or(0)), false);
                }
                Err(error) => self.notify(error, true),
            },
            KeyCode::Char(c @ ('d' | 'a' | 'r')) => {
                let Some(row) = self.economy_row() else {
                    self.notify("no row selected", true);
                    return Outcome::Continue;
                };
                let call = match (c, &row.kind) {
                    ('d', RowKind::Fact(i)) if row.can_drop(&self.economy_data) => Some((format!("facts/{}/drop", self.economy_data.facts[*i].id), serde_json::json!({}), "dropped", "nothing to drop", "dropped")),
                    ('a', RowKind::Proposed { pack, .. }) => Some(("mask/approve".to_string(), serde_json::json!({ "pack": pack }), "approved", "nothing to approve", "approved")),
                    ('r', RowKind::Masked { pack, unit } | RowKind::Proposed { pack, unit, .. }) => Some(("mask/restore".to_string(), serde_json::json!({ "pack": pack, "unit": unit }), "restored", "nothing to restore", "restored")),
                    _ => None,
                };
                let Some((path, extra, done, nothing, field)) = call else {
                    self.notify(match c {
                        'd' => "only a candidate or active fact can be dropped",
                        'a' => "only a proposed mask can be approved",
                        _ => "only a masked or proposed tool can be restored",
                    }, true);
                    return Outcome::Continue;
                };
                match self.machine.economy_act(&path, &state.repo, extra) {
                    Ok(body) => {
                        let did = body.get(field).and_then(|v| v.as_bool()).unwrap_or(false);
                        self.refresh_economy();
                        self.notify(if did { done } else { nothing }, false);
                    }
                    Err(error) => self.notify(error, true),
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// The ticket under the Tickets cursor.
    pub fn ticket_under_cursor(&self) -> Option<TicketEntry> {
        let state = self.tickets.as_ref()?;
        self.ticket_items.get(state.cursor.min(self.ticket_items.len().saturating_sub(1))).cloned()
    }

    /// Fetches the tickets the machine holds; a failure is a toast and the list stays as it was.
    fn refresh_tickets(&mut self) {
        match self.machine.tickets() {
            Ok(items) => {
                self.ticket_items = items;
                if let Some(state) = self.tickets.as_mut() {
                    state.cursor = state.cursor.min(self.ticket_items.len().saturating_sub(1));
                }
            }
            Err(error) => self.notify(format!("tickets: {error}"), true),
        }
    }

    fn open_tickets(&mut self) {
        self.close_views();
        self.tickets = Some(TicketsState::default());
        self.refresh_tickets();
    }

    /// The keys `handle_tickets` matches.
    #[cfg(test)]
    pub(crate) const HANDLED_TICKETS: &[&str] = &["esc", "K", "q", "?", "j", "k", "R", "a", "e", "x", "c", "s"];

    /// `:ticket-edit <text>`: the person's own text is posted in place of the selected ticket's waiting draft. The machine flattens it and refuses a token.
    fn ticket_edit(&mut self, rest: &str) {
        let (Some(t), text) = (self.ticket_under_cursor(), rest.trim()) else {
            self.notify("open the Tickets view and select a ticket first", true);
            return;
        };
        let Some(d) = t.waiting().first().map(|d| (*d).clone()) else {
            self.notify("no draft waiting on it", true);
            return;
        };
        if text.is_empty() {
            self.notify("say what to post: :ticket-edit <text>", true);
            return;
        }
        match self.machine.ticket_act(&t.key, "edit", serde_json::json!({"draft": d.id, "hash": d.hash, "text": text})) {
            Ok(()) => {
                self.notify("posted your text", false);
                self.refresh_tickets();
            }
            Err(error) => self.notify(format!("tickets: {error}"), true),
        }
    }

    /// The Tickets view's keys: move, approve, edit (prefills the command line), ignore, card, schedule, refetch. Each tap sends the draft's hash.
    fn handle_tickets(&mut self, key: KeyEvent) -> Outcome {
        let Some(state) = self.tickets.clone() else {
            return Outcome::Continue;
        };
        let count = self.ticket_items.len();
        match key.code {
            KeyCode::Esc | KeyCode::Char('K') | KeyCode::Char('q') => self.tickets = None,
            KeyCode::Char('?') => self.open_help(),
            KeyCode::Char('j') | KeyCode::Down => self.tickets = Some(TicketsState { cursor: (state.cursor + 1).min(count.saturating_sub(1)) }),
            KeyCode::Char('k') | KeyCode::Up => self.tickets = Some(TicketsState { cursor: state.cursor.saturating_sub(1) }),
            KeyCode::Char('R') => self.refresh_tickets(),
            KeyCode::Char(c @ ('a' | 'e' | 'x' | 'c' | 's')) => {
                let Some(t) = self.ticket_under_cursor() else {
                    self.notify("no ticket selected", true);
                    return Outcome::Continue;
                };
                let draft = t.waiting().first().map(|d| (*d).clone());
                let (action, body, done) = match (c, draft) {
                    ('c', _) => ("card", serde_json::json!({}), "made a ticket on the board"),
                    ('s', _) => ("backlog", serde_json::json!({}), "sent to the backlog"),
                    ('e', Some(_)) => {
                        self.mode = Mode::Command { text: "ticket-edit ".to_string(), pick: None };
                        return Outcome::Continue;
                    }
                    ('a', Some(d)) => ("approve", serde_json::json!({"draft": d.id, "hash": d.hash}), "posted"),
                    ('x', Some(d)) => ("ignore", serde_json::json!({"draft": d.id}), "ignored: kept, not posted"),
                    _ => {
                        self.notify("no draft waiting on it", true);
                        return Outcome::Continue;
                    }
                };
                match self.machine.ticket_act(&t.key, action, body) {
                    Ok(()) => {
                        self.notify(done, false);
                        self.refresh_tickets();
                    }
                    Err(error) => self.notify(format!("tickets: {error}"), true),
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// `:dedup duplicate <slot> | related <slots> | neither` on the selected ticket: the answer to Intake's dedup gate.
    fn answer_dedup(&mut self, rest: &str) {
        let Some(id) = self.card_target() else {
            self.notify("select a ticket first", true);
            return;
        };
        let listed = self.detail.as_ref().filter(|d| d.task.id == id).and_then(|d| d.open_approval()).map(|a| crate::intake::candidates(&a.requested)).unwrap_or_default();
        if listed.is_empty() {
            self.notify("this ticket is not waiting on a duplicate question (open its detail first)", true);
            return;
        }
        match crate::intake::parse_answer(rest, &listed) {
            Ok((choice, of)) => self.act(|m| m.answer_dedup(&id, &choice, &of), "answered"),
            Err(why) => self.notify(why, true),
        }
    }

    /// `:dup <id prefix>`: the selected ticket is a duplicate of that one.
    fn merge_selected(&mut self, rest: &str) {
        let Some(id) = self.card_target() else {
            self.notify("select a ticket first", true);
            return;
        };
        match crate::intake::resolve_prefix(rest, self.tasks.iter().map(|t| t.id.as_str()).filter(|t| *t != id)) {
            Ok(into) => self.act(|m| m.merge_into(&id, &into), "merged: it closes as a duplicate"),
            Err(why) => self.notify(why, true),
        }
    }

    /// `:undup`: the selected, merged ticket comes back as a new card.
    fn unmerge_selected(&mut self) {
        let Some(id) = self.card_target() else {
            self.notify("select a ticket first", true);
            return;
        };
        if self.task(&id).is_some_and(|t| t.merged_into.is_none()) {
            self.notify("this ticket was not merged into another", true);
            return;
        }
        self.act(|m| m.unmerge(&id), "unmerged: it is a new card");
    }

    /// `:context repo|project|text <value>` on the selected ticket: what Intake's gate asked for.
    fn give_context(&mut self, rest: &str) {
        let Some(id) = self.card_target() else {
            self.notify("select a ticket first", true);
            return;
        };
        let (field, value) = rest.split_once(char::is_whitespace).map_or((rest, ""), |(f, v)| (f, v.trim()));
        let key = match field {
            "repo" => "repoPath",
            "project" => "project",
            "text" => "text",
            _ => {
                self.notify("use :context repo|project|text <value>", true);
                return;
            }
        };
        if value.is_empty() {
            self.notify(format!("{field}: give a value"), true);
            return;
        }
        match self.machine.give_context(&id, serde_json::json!({ key: value })) {
            Ok(_) => self.notify("Intake checked the ticket again", false),
            Err(error) => self.notify(format!("context: {error}"), true),
        }
    }

    /// Opens a link in the browser through `open`, which refuses anything but a plain https link; says so when it cannot.
    fn open_url(&mut self, url: &str) {
        if let Err(why) = crate::open::open_url_with(&mut *self.launch, url) {
            self.notify(why, true);
        }
    }

    /// Opens a file or folder; `what` is what the toast says it opened. The card's roots are the machine's state folder and
    /// the repository and worktree of the card (`open::open_path` refuses anything that resolves outside them).
    fn open_file(&mut self, id: &str, path: &str, what: &str) {
        let mut roots: Vec<PathBuf> = crate::open::state_dir().into_iter().collect();
        if let Some(task) = self.task(id) {
            roots.extend(task.repo_path.iter().chain(task.worktree_path.iter()).map(PathBuf::from));
        }
        match crate::open::open_path_with(&mut *self.launch, Path::new(path), &roots) {
            Ok(crate::open::Opened::Opened) => self.notify(format!("opened {what}"), false),
            Ok(crate::open::Opened::Revealed) => self.notify(format!("revealed {what} in the folder"), false),
            Err(why) => self.notify(why, true),
        }
    }

    /// One of `m`, `c`, `v`, `t` on a PR: the blocker as a toast, a merge confirm, or a dispatch
    /// (through the clone prompt when the machine has no checkout of the repo).
    fn pr_key(&mut self, key: PrKey, pr: &PullRequest) {
        if key.action().is_some() && pr.local_path.is_none() && pr.task.is_none() {
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
            None if key == PrKey::Close => self.mode = Mode::ConfirmClose { repo: pr.repo.clone(), number: pr.number },
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

    fn handle_confirm_close(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('y') => {
                let Mode::ConfirmClose { repo, number } = std::mem::replace(&mut self.mode, Mode::Normal) else {
                    return Outcome::Continue;
                };
                match self.machine.close_pr(&repo, number) {
                    Ok(()) => self.notify(format!("closed {repo}#{number}"), false),
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

    /// Opens the Slack view, fetching the snapshot when the stream has not sent one yet.
    fn open_slack(&mut self) {
        if self.slack_snapshot.polled_at.is_none()
            && let Ok(snapshot) = self.machine.slack()
        {
            self.take_slack(snapshot);
        }
        self.close_views();
        self.slack = Some(SlackState::default());
        self.prefetch_slack_catalog();
    }

    /// The keys `handle_slack` matches, `SlackKey::ALL` included.
    #[cfg(test)]
    pub(crate) const HANDLED_SLACK: &[&str] = &["esc", "S", "q", "?", "j", "k", "l", "h", "1-6", "R", "W", "enter", "x", "r", "t", "d", "s", "o", "N", "!", "-", "c", "L"];

    /// The Slack view's keys: move, switch split, open, act on the item, Watches, refresh.
    fn handle_slack(&mut self, key: KeyEvent) -> Outcome {
        let Some(state) = self.slack.clone() else {
            return Outcome::Continue;
        };
        if state.watches.is_some() {
            return self.handle_slack_watches(key);
        }
        let count = slack::items(&self.slack_snapshot.items, state.split).len();
        let under = self.slack_under_cursor().cloned();
        let mut next = state.clone();
        match key.code {
            KeyCode::Esc | KeyCode::Char('S') | KeyCode::Char('q') => {
                self.slack = None;
                return Outcome::Continue;
            }
            KeyCode::Char('?') => {
                self.open_help();
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
                next.split = SlackSplit::ALL[(d as usize) - ('1' as usize)];
                next.cursor = 0;
            }
            KeyCode::Char('R') => {
                self.poll_slack();
                return Outcome::Continue;
            }
            KeyCode::Char('W') => {
                // The popup edits them, so it opens on the machine's current list, not a stale snapshot.
                if let Ok(watches) = self.machine.slack_watches() {
                    self.slack_snapshot.watches = watches;
                }
                next.watches = Some(WatchesState::default());
            }
            KeyCode::Enter => {
                if let Some(item) = under {
                    match item.task_id() {
                        Some(id) if self.task(id).is_some() => {
                            let id = id.to_string();
                            self.select(&id, true);
                            self.open_detail(id);
                        }
                        _ => self.open_url(&item.permalink),
                    }
                }
                return Outcome::Continue;
            }
            KeyCode::Char('x') => {
                if under.is_some() {
                    self.mode = Mode::SlackActions { cursor: 0 };
                }
                return Outcome::Continue;
            }
            KeyCode::Char(c) => {
                if let (Some(item), Some(key)) = (under, SlackKey::from_char(c)) {
                    self.slack_key(key, &item);
                }
                return Outcome::Continue;
            }
            _ => {}
        }
        self.slack = Some(next);
        Outcome::Continue
    }

    /// One of the item keys: the blocker as a toast, else the popup or the call it stands for.
    fn slack_key(&mut self, key: SlackKey, item: &SlackItem) {
        if let Some(why) = slack::blocker(item, key) {
            self.notify(why, false);
            return;
        }
        let id = item.id.clone();
        match key {
            SlackKey::Open => self.open_url(&item.permalink),
            SlackKey::Reply => {
                let seen = item.draft.as_ref().filter(|d| !d.id.is_empty() && !d.hash.is_empty()).map(|d| (d.id.clone(), d.hash.clone()));
                // The waiting draft's own text is what its id and hash stand for; the classifier's reply (`triage.draft`) is the fallback when no draft waits or the snapshot predates the text.
                let text = item.draft.as_ref().map(|d| d.text.clone()).filter(|t| !t.is_empty()).or_else(|| item.triage.as_ref().and_then(|t| t.draft.clone())).unwrap_or_default();
                self.open_slack_reply(item, text, false, seen)
            }
            // The mention itself is built on the machine, by id; the editor shows the words only.
            SlackKey::Nudge => self.open_slack_reply(item, "gentle nudge on this one: any news?".to_string(), true, None),
            SlackKey::Snooze => self.mode = Mode::SlackSnooze { id, cursor: 0 },
            SlackKey::Kind => self.mode = Mode::SlackPick { id, relation: false, cursor: 0 },
            SlackKey::Relation => self.mode = Mode::SlackPick { id, relation: true, cursor: 0 },
            SlackKey::Task => {
                let title = item.summary().to_string();
                let repo = self.guess_repo(&item.channel.name);
                self.mode = Mode::SlackTask { id, title, repo };
            }
            // A waiting draft is dismissed with a reason (one more key, or skip); an item with none is just done.
            SlackKey::Done if item.draft.is_some() => self.mode = Mode::SlackDismiss { id },
            SlackKey::Done => self.slack_done(&id, None),
            SlackKey::Bump | SlackKey::Lower => {
                let Some(next) = item.priority().and_then(|p| priority_step(p, key == SlackKey::Bump)) else {
                    return;
                };
                let toast = format!("{} → {next}", item.priority().unwrap_or("?"));
                self.patch_slack(&id, serde_json::json!({ "priority": next }), &toast, move |item| {
                    if let Some(triage) = item.triage.as_mut() {
                        triage.priority = next.to_string();
                        triage.overridden = true;
                    }
                });
            }
        }
    }

    /// PATCHes one item and, when the machine took it, applies the same change to the local
    /// snapshot so the view moves at once instead of on the next poll.
    fn patch_slack(&mut self, id: &str, patch: serde_json::Value, toast: &str, apply: impl FnOnce(&mut SlackItem)) {
        match self.machine.patch_slack_item(id, patch) {
            Ok(_) => {
                if let Some(item) = self.slack_item_mut(id) {
                    apply(item);
                }
                self.clamp_slack_cursor();
                self.notify(toast, false);
            }
            Err(error) => self.notify(error, true),
        }
    }

    /// The repo a channel most likely belongs to: a repo of a ticket on the board whose name
    /// and the channel's share a word. None when nothing matches.
    fn guess_repo(&self, channel: &str) -> Option<String> {
        let channel = channel.to_lowercase();
        let mut repos: Vec<&str> = self.tasks.iter().filter_map(|t| t.repo_path.as_deref()).collect();
        repos.sort_unstable();
        repos.dedup();
        repos
            .into_iter()
            .find(|path| {
                let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_lowercase();
                !name.is_empty() && (channel.contains(&name) || name.contains(&channel))
            })
            .map(str::to_string)
    }

    /// The reply editor over `item`, pre-filled with `text`; the same vim keys as every editor.
    /// `nudge` asks the machine to open the message with a mention of the author.
    fn open_slack_reply(&mut self, item: &SlackItem, text: String, nudge: bool, draft: Option<(String, String)>) {
        let lines: Vec<String> = if text.is_empty() { vec![String::new()] } else { text.lines().map(str::to_string).collect() };
        let mut area = TextArea::new(lines);
        area.move_cursor(tui_textarea::CursorMove::Jump(0, 0));
        self.mode = Mode::SlackReply { id: item.id.clone(), area, vim: Vim::new(), nudge, draft };
    }

    fn handle_slack_reply(&mut self, key: KeyEvent) -> Outcome {
        let Mode::SlackReply { id, area, vim, nudge, draft } = &mut self.mode else {
            return Outcome::Continue;
        };
        match vim.handle(area, key) {
            crate::vim::Outcome::Continue => {}
            crate::vim::Outcome::Cancel => self.mode = Mode::Normal,
            crate::vim::Outcome::Save => {
                let id = id.clone();
                let nudge = *nudge;
                let draft = draft.clone();
                let text = area.lines().join("\n").trim().to_string();
                if text.is_empty() {
                    self.notify("nothing to send", true);
                    return Outcome::Continue;
                }
                self.mode = Mode::Normal;
                match self.machine.slack_reply(&id, &text, nudge, draft.as_ref().map(|(i, h)| (i.as_str(), h.as_str()))) {
                    Ok(()) => {
                        let now = iso_of(now_secs());
                        if let Some(item) = self.slack_item_mut(&id) {
                            item.split = SlackSplit::Done.wire().to_string();
                            item.you_replied = true;
                            item.done_at = Some(now);
                        }
                        self.clamp_slack_cursor();
                        self.notify("sent", false);
                    }
                    Err(error) => self.notify(error, true),
                }
            }
        }
        Outcome::Continue
    }

    /// The `c` and `L` pickers: j/k move, enter stores the answer on the machine (a stored answer and a truth record, never a post), esc leaves it.
    fn handle_slack_pick(&mut self, key: KeyEvent) -> Outcome {
        let (id, relation, mut cursor) = match &self.mode {
            Mode::SlackPick { id, relation, cursor } => (id.clone(), *relation, *cursor),
            _ => return Outcome::Continue,
        };
        let Some(item) = self.slack_item(&id).cloned() else {
            self.mode = Mode::Normal;
            return Outcome::Continue;
        };
        let choices = if relation { slack::relation_choices(&item) } else { Vec::new() };
        let len = if relation { choices.len() } else { slack::KINDS.len() };
        let mut chosen = None;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => cursor = (cursor + 1).min(len - 1),
            KeyCode::Up | KeyCode::Char('k') => cursor = cursor.saturating_sub(1),
            KeyCode::Enter => chosen = Some(cursor),
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            _ => {}
        }
        if let Mode::SlackPick { cursor: shown, .. } = &mut self.mode {
            *shown = cursor;
        }
        if let Some(at) = chosen {
            self.mode = Mode::Normal;
            if relation {
                let choice = &choices[at];
                match self.machine.slack_relation(&id, choice.relation, choice.target.as_deref()) {
                    Ok(updated) => {
                        if let Some(slot) = self.slack_item_mut(&id) {
                            *slot = updated;
                        }
                        self.notify("relation saved", false);
                    }
                    Err(error) => self.notify(error, true),
                }
            } else {
                let kind = slack::KINDS[at];
                self.patch_slack(&id, serde_json::json!({ "kind": kind }), &format!("kind: {kind}"), |_| {});
            }
        }
        Outcome::Continue
    }

    /// Marks an item done, with the reason a draft was dismissed when one was given.
    fn slack_done(&mut self, id: &str, reason: Option<&str>) {
        let now = iso_of(now_secs());
        self.patch_slack(id, dismiss_patch(reason), "done", move |item| {
            item.split = SlackSplit::Done.wire().to_string();
            item.done_at = Some(now);
        });
    }

    /// The dismiss prompt: n (no reply needed), b (bad draft), s or enter (no reason); esc leaves the item as it is.
    fn handle_slack_dismiss(&mut self, key: KeyEvent) -> Outcome {
        let Mode::SlackDismiss { id } = &self.mode else {
            return Outcome::Continue;
        };
        let id = id.clone();
        let reason = match key.code {
            KeyCode::Char('n') => Some(Some("no_reply_needed")),
            KeyCode::Char('b') => Some(Some("bad_draft")),
            KeyCode::Char('s') | KeyCode::Enter => Some(None),
            KeyCode::Esc | KeyCode::Char('q') => {
                self.mode = Mode::Normal;
                None
            }
            _ => None,
        };
        if let Some(reason) = reason {
            self.mode = Mode::Normal;
            self.slack_done(&id, reason);
        }
        Outcome::Continue
    }

    /// The snooze picker: j/k or 1-4 pick, enter sets `snoozedUntil`, esc leaves it awake.
    fn handle_slack_snooze(&mut self, key: KeyEvent) -> Outcome {
        let Mode::SlackSnooze { id, cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        let id = id.clone();
        let mut chosen = None;
        let mut close = false;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => *cursor = (*cursor + 1).min(slack::SNOOZE_OPTIONS.len() - 1),
            KeyCode::Up | KeyCode::Char('k') => *cursor = cursor.saturating_sub(1),
            KeyCode::Enter => chosen = Some(*cursor),
            KeyCode::Char(d @ '1'..='4') => chosen = Some((d as usize) - ('1' as usize)),
            KeyCode::Esc | KeyCode::Char('q') => close = true,
            _ => {}
        }
        if close {
            self.mode = Mode::Normal;
        }
        if let Some(option) = chosen {
            self.mode = Mode::Normal;
            let until = iso_of(slack::snooze_until(option, now_secs(), local_offset_secs()));
            let toast = format!("snoozed until {}", slack::SNOOZE_OPTIONS[option]);
            let stored = until.clone();
            self.patch_slack(&id, serde_json::json!({ "snoozedUntil": until }), &toast, move |item| {
                item.split = SlackSplit::Snoozed.wire().to_string();
                item.snoozed_until = Some(stored);
            });
        }
        Outcome::Continue
    }

    /// `t`'s confirm: y creates the ticket and opens it (the repo picker follows when none was
    /// guessed), n / esc keeps the message where it is.
    fn handle_slack_task(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('y') | KeyCode::Enter => {
                let Mode::SlackTask { id, title, repo } = std::mem::replace(&mut self.mode, Mode::Normal) else {
                    return Outcome::Continue;
                };
                match self.machine.slack_task(&id, &title, repo.as_deref()) {
                    Ok(task) => {
                        let task_id = task.id.clone();
                        let no_repo = task.repo_path.is_none();
                        self.upsert(task);
                        if let Some(item) = self.slack_item_mut(&id) {
                            item.linked.task_id = Some(task_id.clone());
                        }
                        self.select(&task_id, true);
                        self.open_detail(task_id.clone());
                        if no_repo {
                            self.notify(format!("ticket #{} created; pick its repo", short_id(&task_id)), false);
                            self.open_repo_picker(&task_id);
                        } else {
                            self.notify(format!("ticket #{} created", short_id(&task_id)), false);
                        }
                    }
                    Err(error) => self.notify(error, true),
                }
            }
            KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
    }

    /// The keys `handle_slack_watches` matches.
    #[cfg(test)]
    pub(crate) const HANDLED_WATCHES: &[&str] = &["esc", "W", "q", "?", "j", "k", "n", "space", "e", "d"];

    /// The Watches popup: j/k move, space toggles, d deletes (not a built-in), e cycles the
    /// priority floor, n adds, esc / W closes.
    fn handle_slack_watches(&mut self, key: KeyEvent) -> Outcome {
        let Some(open) = self.slack.as_ref().and_then(|s| s.watches.clone()) else {
            return Outcome::Continue;
        };
        let count = self.slack_snapshot.watches.len();
        let under = self.slack_snapshot.watches.get(open.cursor.min(count.saturating_sub(1))).cloned();
        let mut cursor = open.cursor;
        match key.code {
            KeyCode::Esc | KeyCode::Char('W') | KeyCode::Char('q') => {
                if let Some(state) = self.slack.as_mut() {
                    state.watches = None;
                }
                return Outcome::Continue;
            }
            KeyCode::Char('?') => {
                self.open_help();
                return Outcome::Continue;
            }
            KeyCode::Char('j') | KeyCode::Down => cursor = (cursor + 1).min(count.saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => cursor = cursor.saturating_sub(1),
            KeyCode::Char('n') => {
                // The catalogue was asked for when the view opened; the picker says "loading…" until it lands.
                self.prefetch_slack_catalog();
                self.mode = Mode::SlackWatchAdd { query: String::new(), cursor: 0 };
                return Outcome::Continue;
            }
            KeyCode::Char(' ') => {
                if let Some(watch) = under {
                    let enabled = !watch.enabled;
                    self.patch_slack_watch(&watch.id, serde_json::json!({ "enabled": enabled }), if enabled { "on" } else { "off" });
                }
                return Outcome::Continue;
            }
            KeyCode::Char('e') => {
                if let Some(watch) = under {
                    let floor = match watch.priority.as_deref() {
                        None => Some("P0"),
                        Some("P0") => Some("P1"),
                        Some("P1") => Some("P2"),
                        _ => None,
                    };
                    let toast = floor.map_or("no priority floor".to_string(), |p| format!("at least {p}"));
                    self.patch_slack_watch(&watch.id, serde_json::json!({ "priority": floor }), &toast);
                }
                return Outcome::Continue;
            }
            KeyCode::Char('d') => {
                if let Some(watch) = under {
                    if watch.builtin {
                        self.notify("built-in; switch it off instead", false);
                    } else {
                        match self.machine.delete_slack_watch(&watch.id) {
                            Ok(()) => {
                                self.slack_snapshot.watches.retain(|w| w.id != watch.id);
                                self.clamp_slack_cursor();
                                self.notify(format!("removed {}", watch.label), false);
                            }
                            Err(error) => self.notify(error, true),
                        }
                    }
                }
                return Outcome::Continue;
            }
            _ => {}
        }
        if let Some(state) = self.slack.as_mut()
            && let Some(open) = state.watches.as_mut()
        {
            open.cursor = cursor;
        }
        Outcome::Continue
    }

    /// PATCHes one watch and keeps the local copy in step with the machine's answer.
    fn patch_slack_watch(&mut self, id: &str, patch: serde_json::Value, toast: &str) {
        match self.machine.patch_slack_watch(id, patch) {
            Ok(updated) => {
                if let Some(watch) = self.slack_snapshot.watches.iter_mut().find(|w| w.id == id) {
                    *watch = updated;
                }
                self.notify(toast, false);
            }
            Err(error) => self.notify(error, true),
        }
    }

    /// Type `@handle`, `#channel` or a word; up/down pick a completion; enter saves the watch.
    fn handle_slack_watch_add(&mut self, key: KeyEvent) -> Outcome {
        let Mode::SlackWatchAdd { query, cursor } = &mut self.mode else {
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
            KeyCode::Down => *cursor += 1,
            KeyCode::Up => *cursor = cursor.saturating_sub(1),
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                let (query, cursor) = (query.trim().to_string(), *cursor);
                let (kind, text) = slack::watch_kind_of(&query);
                if text.is_empty() {
                    return Outcome::Continue;
                }
                let matches = self.slack_watch_matches(&query);
                let input = match kind {
                    "keyword" => serde_json::json!({ "kind": "keyword", "value": text, "label": text }),
                    _ => {
                        let Some(pick) = matches.get(cursor.min(matches.len().saturating_sub(1))) else {
                            self.notify(format!("no {kind} matches {query}"), true);
                            return Outcome::Continue;
                        };
                        let sigil = if kind == "usergroup" { '@' } else { '#' };
                        let label = if pick.label.starts_with(sigil) { pick.label.clone() } else { format!("{sigil}{}", pick.label) };
                        serde_json::json!({ "kind": kind, "value": pick.id, "label": label })
                    }
                };
                self.mode = Mode::Normal;
                match self.machine.add_slack_watch(input) {
                    Ok(watch) => {
                        self.notify(format!("watching {}", watch.label), false);
                        self.slack_snapshot.watches.push(watch);
                        if let Some(open) = self.slack.as_mut().and_then(|s| s.watches.as_mut()) {
                            open.cursor = self.slack_snapshot.watches.len() - 1;
                        }
                    }
                    Err(error) => self.notify(error, true),
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// `x` in the Slack view: a menu of the item keys, each line saying why it is off when it is.
    fn handle_slack_actions(&mut self, key: KeyEvent) -> Outcome {
        let Mode::SlackActions { cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        let mut chosen = None;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => *cursor = (*cursor + 1).min(SlackKey::ALL.len() - 1),
            KeyCode::Up | KeyCode::Char('k') => *cursor = cursor.saturating_sub(1),
            KeyCode::Enter => chosen = Some(SlackKey::ALL[*cursor]),
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            KeyCode::Char(c) => chosen = SlackKey::from_char(c),
            _ => {}
        }
        if let Some(key) = chosen {
            self.mode = Mode::Normal;
            if let Some(item) = self.slack_under_cursor().cloned() {
                self.slack_key(key, &item);
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

    /// The keys `handle_normal` matches: its own, the second keys `prefixed` takes, then
    /// everything `ticket_key` takes (`S` opens Slack here, so it is not ship).
    #[cfg(test)]
    pub(crate) const HANDLED_BOARD: &[&str] = &[
        "q", "Q", "h", "l", "j", "k", "n", "x", "/", "=", "!", "@", "zc", "zo", "zz", "gg", "gs", "gr", "ga", "G", "1-8", "tab", "shift+tab", "]", "[", "F", "I", "D", "P", "B", "$", "S", "v", "V", "?", ":",
        "esc", "enter", "R", "a", "A", "e", "r", "N", "X", "w", "Z", "C", "d", "f", "o", "J", "T", "p", "K",
    ];

    fn handle_normal(&mut self, key: KeyEvent) -> Outcome {
        if let Some(prefix) = self.prefix.take() {
            if let KeyCode::Char(c) = key.code {
                self.prefixed(prefix, c);
            }
            return Outcome::Continue;
        }
        match key.code {
            KeyCode::Char('q') if self.pending_counts() != (0, 0) => self.mode = Mode::ConfirmQuit,
            KeyCode::Char('q' | 'Q') => return Outcome::Quit,
            KeyCode::Char('h') | KeyCode::Left => self.switch_column(-1),
            KeyCode::Char('l') | KeyCode::Right => self.switch_column(1),
            KeyCode::Char('j') | KeyCode::Down => self.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_selection(-1),
            KeyCode::Char('n') => self.mode = Mode::Adding(String::new()),
            KeyCode::Char('x') => self.mode = Mode::Actions { cursor: 0 },
            KeyCode::Char('/') => self.mode = Mode::Filter,
            KeyCode::Char('=') => {
                self.density = self.density.next();
                self.notify(format!("cards: {}", self.density.label()), false);
            }
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
                    self.prefix_at = Some(Instant::now());
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
            KeyCode::Char(']') | KeyCode::Tab => self.hop_needs_you(true),
            KeyCode::Char('[') | KeyCode::BackTab => self.hop_needs_you(false),
            KeyCode::Char('F') => {
                self.close_views();
                self.floor = Some(FloorState::default());
                self.refresh_floor();
            }
            KeyCode::Char('I') => {
                self.close_views();
                self.inbox = Some(InboxState::default());
            }
            KeyCode::Char('D') => {
                self.close_views();
                self.digest = Some(DigestState::default());
            }
            KeyCode::Char('P') => self.open_pulls(),
            KeyCode::Char('B') => self.open_backlog(),
            KeyCode::Char('$') => self.open_economy(),
            KeyCode::Char('K') => self.open_tickets(),
            KeyCode::Char('S') => self.open_slack(),
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
            KeyCode::Char('?') => self.open_help(),
            KeyCode::Char(':') => self.mode = Mode::Command { text: String::new(), pick: None },
            // The repo search is the one key you need on a ticket without a repo; with one set,
            // the deliberate paths are the menu and `:repo <name>`.
            KeyCode::Char('R') => match self.selected_task().map(|t| t.repo_path.is_some()) {
                Some(true) => self.notify("use :repo <name> or x", false),
                Some(false) => {
                    if let Some(id) = self.selected_id() {
                        return self.ticket_key('R', &id);
                    }
                }
                None => {}
            },
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
                    return self.board_key(c, &id);
                }
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// A ticket key from the board or its `x` menu. `a` at a gate opens the task on its first page
    /// instead of approving (`ticket_key`): you read what you approve, and approve inside.
    fn board_key(&mut self, c: char, id: &str) -> Outcome {
        self.ticket_key(c, id)
    }

    /// `a`, `X`, `d` or `w` over the marked set. `a` goes straight to the machine for the
    /// tickets whose next step needs no words from you; the destructive three ask once.
    fn bulk_key(&mut self, c: char) -> Outcome {
        let ids: Vec<String> = self.marked.iter().cloned().collect();
        if c == 'a' {
            // What commits something (the plan, a split, shipping, the release) waits for one yes; the rest goes now.
            let (committing, rest): (Vec<String>, Vec<String>) = ids.iter().cloned().partition(|id| self.task(id).is_some_and(|t| self.committing_kind(t).is_some()));
            let (mut done, mut skipped) = (0, 0);
            for id in &rest {
                let Some(task) = self.task(id).cloned() else { continue };
                let ok = match task.state.as_str() {
                    "draft" if task.repo_path.is_some() => self.machine.start(id).is_ok(),
                    "paused_rate_limit" => self.machine.resume(id).is_ok(),
                    "awaiting_answers" | "escalated" | "reviewing_memory" => {
                        skipped += 1;
                        continue;
                    }
                    _ => {
                        skipped += 1;
                        continue;
                    }
                };
                if ok {
                    done += 1;
                }
            }
            let skip = if skipped > 0 { format!("; {skipped} need words from you or are running") } else { String::new() };
            let before = if rest.is_empty() { String::new() } else { format!("advanced {done} of {}{skip}", rest.len()) };
            if committing.is_empty() {
                self.marked.clear();
                self.notify(before, false);
            } else {
                for id in &rest {
                    self.marked.remove(id);
                }
                self.mode = Mode::ConfirmApproveMany { ids: committing, before };
            }
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

    /// What approving `task` would commit, when it is a gate that asks first: `plan`, `split`, `ship` or `release`.
    /// The retro's rules are not approved in bulk, as before: they need reading.
    pub fn committing_kind(&self, task: &Task) -> Option<&'static str> {
        if !task.waiting_on_you || task.state == "reviewing_memory" {
            return None;
        }
        let question = self.approval_question(task)?;
        Some(if question.contains("split") {
            "split"
        } else if question.contains("release") {
            "release"
        } else if question.starts_with("ship") {
            "ship"
        } else {
            "plan"
        })
    }

    /// `approve 3 cards? 2 plans · 1 ship`: the count and the kinds, for the box over the marked cards.
    pub fn approve_many_question(&self, ids: &[String]) -> String {
        let kinds: Vec<&str> = ids.iter().filter_map(|id| self.task(id)).filter_map(|t| self.committing_kind(t)).collect();
        let parts: Vec<String> = ["plan", "split", "ship", "release"]
            .iter()
            .filter_map(|kind| {
                let n = kinds.iter().filter(|k| *k == kind).count();
                (n > 0).then(|| format!("{n} {kind}{}", if n == 1 { "" } else { "s" }))
            })
            .collect();
        format!("approve {} card{}? {}", ids.len(), if ids.len() == 1 { "" } else { "s" }, parts.join(" · "))
    }

    fn handle_confirm_approve_many(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('y') => {
                let Mode::ConfirmApproveMany { ids, before } = std::mem::replace(&mut self.mode, Mode::Normal) else {
                    return Outcome::Continue;
                };
                let total = ids.len();
                let done = ids.iter().filter(|id| self.machine.decide(id, true, None).is_ok()).count();
                self.marked.clear();
                let before = if before.is_empty() { String::new() } else { format!("{before}; ") };
                self.notify(format!("{before}approved {done} of {total}"), done < total);
            }
            KeyCode::Char('n') | KeyCode::Esc => {
                let Mode::ConfirmApproveMany { before, .. } = std::mem::replace(&mut self.mode, Mode::Normal) else {
                    return Outcome::Continue;
                };
                if !before.is_empty() {
                    self.notify(format!("{before}; the rest not approved"), false);
                }
            }
            _ => {}
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

    /// The keys `handle_detail` matches: its own, then everything `ticket_key` takes (`J`
    /// scrolls here, so the Jira link is not among them).
    #[cfg(test)]
    pub(crate) const HANDLED_DETAIL: &[&str] =
        &["esc", "enter", "q", "j", "k", "J", "K", "ctrl+d", "ctrl+u", "l", "h", "tab", "space", "1-9", "+", "?", ":", "o", "O", "i", "a", "A", "S", "e", "E", "R", "r", "N", "X", "w", "Z", "C", "d", "f", "T", "p", "M", "U", "y", "n"];

    fn handle_detail(&mut self, key: KeyEvent, id: &str) -> Outcome {
        let half_page = (self.detail_viewport.get() / 2).max(1) as i16;
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            let down = key.code == KeyCode::Char('d');
            match key.code {
                KeyCode::Char('d' | 'u') if self.detail_refs.focus && self.detail_refs.page(if down { 1 } else { -1 }) => {}
                KeyCode::Char('d') => self.scroll_detail(half_page),
                KeyCode::Char('u') => self.scroll_detail(-half_page),
                _ => {}
            }
            return Outcome::Continue;
        }
        if self.detail_refs.focus {
            // The reference holds the keys: its headers move and fold; everything else is as in the main text.
            let section = self.detail_section;
            match key.code {
                KeyCode::Esc | KeyCode::Tab => self.detail_refs.focus = false,
                KeyCode::Enter | KeyCode::Char(' ') => self.detail_refs.toggle(section),
                KeyCode::Char('j') | KeyCode::Down => {
                    if !self.detail_refs.scroll_into(1) {
                        self.detail_refs.step(1);
                    }
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    if !self.detail_refs.scroll_into(-1) {
                        self.detail_refs.step(-1);
                    }
                }
                _ => return self.handle_detail_main(key, id, half_page),
            }
            self.detail_follow.set(true);
            return Outcome::Continue;
        }
        self.handle_detail_main(key, id, half_page)
    }

    fn handle_detail_main(&mut self, key: KeyEvent, id: &str, half_page: i16) -> Outcome {
        match key.code {
            KeyCode::Enter if self.detail_section == Section::Evidence && self.detail_rows() > 0 => self.open_artifact(id, self.detail_row()),
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => self.mode = Mode::Normal,
            KeyCode::Tab => {
                self.detail_refs.flip_focus();
                self.detail_follow.set(true);
            }
            KeyCode::Char(' ') => {}
            KeyCode::Char('j') | KeyCode::Down => self.move_in_detail(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_in_detail(-1),
            KeyCode::Char('J') => self.scroll_detail(1),
            KeyCode::Char('K') => self.scroll_detail(-1),
            KeyCode::PageDown => self.scroll_detail(half_page),
            KeyCode::PageUp => self.scroll_detail(-half_page),
            KeyCode::Char('l') | KeyCode::Right => self.step_section(true),
            KeyCode::Char('h') | KeyCode::Left | KeyCode::BackTab => self.step_section(false),
            KeyCode::Char(digit @ '1'..='9') => {
                let (order, _) = self.detail_rail();
                if let Some(section) = Section::from_digit(digit, &order) {
                    self.set_section(section);
                }
            }
            KeyCode::Char('+') => self.detail_full = !self.detail_full,
            KeyCode::Char('?') => {
                self.open_help();
            }
            KeyCode::Char('o') => match self.detail_open_target() {
                Some(target) => self.open_target(id, target),
                None if self.detail_section == Section::Evidence => self.notify("no evidence yet", false),
                None if self.detail_section.has_cursor() => self.notify("nothing to open here", false),
                None => return self.ticket_key('o', id),
            },
            KeyCode::Char('O') => match self.detail_pr_url() {
                Some(url) => self.open_target(id, OpenTarget::Url(url)),
                None => self.notify("no PR yet", false),
            },
            KeyCode::Char('E') => self.open_engine_picker(id),
            KeyCode::Char(':') => self.open_card_command(id, ""),
            KeyCode::Char('M') => self.open_card_command(id, "dup "),
            KeyCode::Char('U') => {
                self.command_card = Some(id.to_string());
                self.unmerge_selected();
                self.command_card = None;
            }
            KeyCode::Char(c) => return self.ticket_key(c, id),
            _ => {}
        }
        Outcome::Continue
    }

    /// `:` (and `M`) in the task view: the palette over the open card. The commands that read the
    /// board's selection (`:whole`, `:dismiss`, `:dup`, ...) find this card there, and the task view
    /// is back when the palette closes (`handle_command`).
    fn open_card_command(&mut self, id: &str, text: &str) {
        self.select(id, true);
        self.return_to = Some(id.to_string());
        self.mode = Mode::Command { text: text.to_string(), pick: None };
    }

    /// Leaves the palette: back to the task view it was opened over, else the board.
    fn close_command(&mut self) {
        self.back_from_overlay();
    }

    /// `E`: the picker for the selected stage of the Engines section.
    fn open_engine_picker(&mut self, id: &str) {
        if self.detail_section != Section::Engines {
            let (order, _) = self.detail_rail();
            let how = order.iter().position(|s| *s == Section::Engines).filter(|i| *i < 9).map_or("h/l".to_string(), |i| (i + 1).to_string());
            return self.notify(format!("E picks an engine in the Engines section ({how})"), false);
        }
        let pack = match &self.engine_catalog {
            Some(Ok(catalog)) => catalog.task_packs().get(self.detail_row()).map(|p| p.id.clone()),
            _ => return self.notify("this machine does not offer engines", false),
        };
        if let Some(pack) = pack {
            self.mode = Mode::EnginePicker { id: id.to_string(), pack, cursor: 0 };
        }
    }

    /// The picker: j/k move over the engines this machine can run, enter sets the one picked
    /// (the default row clears the ticket's own), esc or q go back to the popup.
    fn handle_engine_picker(&mut self, key: KeyEvent) -> Outcome {
        let Mode::EnginePicker { id, pack, cursor } = &self.mode else { return Outcome::Continue };
        let (id, pack, at) = (id.clone(), pack.clone(), *cursor);
        let choices = match &self.engine_catalog {
            Some(Ok(catalog)) => catalog.task_packs().into_iter().find(|p| p.id == pack).map(|p| catalog.choices(p)).unwrap_or_default(),
            _ => Vec::new(),
        };
        let open = |i: &usize| choices[*i].off.is_none();
        let step = |down: bool| if down { (at + 1..choices.len()).find(open) } else { (0..at).rev().find(open) }.unwrap_or(at);
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => self.mode = Mode::EnginePicker { id, pack, cursor: step(true) },
            KeyCode::Char('k') | KeyCode::Up => self.mode = Mode::EnginePicker { id, pack, cursor: step(false) },
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Detail(id),
            KeyCode::Enter => {
                let Some(choice) = choices.get(at).filter(|c| c.off.is_none()).cloned() else { return Outcome::Continue };
                self.mode = Mode::Detail(id.clone());
                let done = match &choice.engine {
                    Some(engine) => format!("{pack} runs on {engine} for this ticket"),
                    None => format!("{pack} back on its default engine"),
                };
                self.act(|m| m.set_stage_engine(&id, &pack, choice.engine.as_deref()), &done);
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// The open card's rail: the sections with content (numbered for `1`-`9`) and those that come later.
    fn detail_rail(&self) -> (Vec<Section>, Vec<Section>) {
        let Mode::Detail(id) = &self.mode else { return (Section::ALL.to_vec(), Vec::new()) };
        let Some(task) = self.task(id) else { return (Section::ALL.to_vec(), Vec::new()) };
        let has_diff = task.diff.is_some() || self.diff.as_ref().is_some_and(|(for_id, _)| for_id == id);
        crate::detail::rail(task, self.detail.as_ref(), has_diff, &self.prs.prs)
    }

    /// `l` / `h`: the next or previous section of the rail, those with content first and then the ones that come later.
    fn step_section(&mut self, forward: bool) {
        let (mut order, later) = self.detail_rail();
        order.extend(later);
        let to = if forward { self.detail_section.next(&order) } else { self.detail_section.prev(&order) };
        self.set_section(to);
    }

    /// Switches the popup's section; each starts at the top, Runs and Evidence on their
    /// latest row, the others on their first.
    pub(crate) fn set_section(&mut self, section: Section) {
        if section != self.detail_section {
            self.detail_section = section;
            self.detail_scroll.set(0);
            self.detail_cursor = start_cursor(section);
            self.detail_refs.focus = false;
            self.detail_refs.cursor = 0;
            self.detail_refs.side_offset.set(0);
            self.detail_follow.set(true);
            self.diff_failed = None;
            if section == Section::Engines {
                self.engine_catalog = Some(self.machine.engine_catalog());
            }
        }
    }

    /// `j`/`k` in the popup: the next row where the section has rows, else a line of scroll.
    fn move_in_detail(&mut self, delta: i16) {
        if self.detail_section.has_cursor() {
            let rows = self.detail_rows();
            let next = (self.detail_row() as i64 + i64::from(delta)).clamp(0, rows.saturating_sub(1) as i64);
            self.detail_cursor = next as usize;
            self.detail_follow.set(true);
        } else {
            self.scroll_detail(delta);
        }
    }

    /// The selected row of the open section, inside its rows (`usize::MAX` is the last).
    pub fn detail_row(&self) -> usize {
        self.detail_cursor.min(self.detail_rows().saturating_sub(1))
    }

    /// The open ticket's detail, when it is the one loaded.
    fn open_detail_of(&self) -> Option<&TaskDetail> {
        self.detail.as_ref().filter(|d| matches!(&self.mode, Mode::Detail(id) if *id == d.task.id))
    }

    /// How many rows the open section's cursor can land on.
    pub(crate) fn detail_rows(&self) -> usize {
        let detail = self.open_detail_of();
        match self.detail_section {
            Section::Runs => detail.map_or(0, |d| d.stage_runs.len()),
            Section::Evidence => detail.map_or(0, |d| d.artifacts.len()),
            Section::Engines => self.engine_catalog.as_ref().and_then(|c| c.as_ref().ok()).map_or(0, |c| c.task_packs().len()),
            Section::Diff => self.diff.as_ref().filter(|(id, _)| matches!(&self.mode, Mode::Detail(open) if open == id)).map_or(0, |(_, d)| d.files.len()),
            _ => 0,
        }
    }

    /// What `o` opens in the popup, by section: the selected file inside the worktree (Diff), the evidence folder (Evidence, and
    /// every other section of a card that has artifacts), the PR's URL (PR). `None` elsewhere: `o` then means what it means on
    /// the board, the linked issue.
    pub fn detail_open_target(&self) -> Option<OpenTarget> {
        let Mode::Detail(id) = &self.mode else { return None };
        let task = self.task(id)?;
        match self.detail_section {
            Section::Diff => {
                let (_, diff) = self.diff.as_ref().filter(|(for_id, _)| for_id == id)?;
                let file = diff.files.get(self.detail_row())?;
                let root = task.worktree_path.as_deref()?;
                Some(OpenTarget::Path { path: format!("{}/{}", root.trim_end_matches('/'), file.path), what: crate::model::plain(&file.path, 80) })
            }
            Section::Pr => self.detail_pr_url().map(OpenTarget::Url),
            _ if self.open_detail_of().is_some_and(|d| !d.artifacts.is_empty()) => Some(OpenTarget::EvidenceFolder),
            _ => None,
        }
    }

    /// The open card's PR: the inbox's row for its branch, else what the ship gate reported.
    pub fn detail_pr_url(&self) -> Option<String> {
        let Mode::Detail(id) = &self.mode else { return None };
        let task = self.task(id)?;
        let detail = self.open_detail_of();
        crate::detail::pr_for(task, &self.prs.prs)
            .map(|pr| pr.url.clone())
            .or_else(|| detail.and_then(crate::detail::pr_url))
            .or_else(|| detail.and_then(|d| d.ship.as_ref()).filter(|s| s.pr.number > 0).map(|s| s.pr.url.clone()))
    }

    /// Opens what `o` or `O` named, and says in fixed words what it did.
    fn open_target(&mut self, id: &str, target: OpenTarget) {
        match target {
            OpenTarget::Url(url) => match crate::open::open_url_with(&mut *self.launch, &url) {
                Ok(()) => self.notify("opened the PR", false),
                Err(why) => self.notify(why, true),
            },
            OpenTarget::Path { path, what } => self.open_file(id, &path, &what),
            OpenTarget::EvidenceFolder => self.open_evidence_folder(id),
        }
    }

    /// Opens the folder the evidence lives in: the cursor's run's while the Evidence section is open, else the latest run's.
    fn open_evidence_folder(&mut self, id: &str) {
        let focus = (self.detail_section == Section::Evidence).then(|| self.detail_row());
        let Some(detail) = self.open_detail_of() else { return };
        match crate::detail::evidence_folder(detail, focus) {
            Some(folder) => self.open_file(id, &folder.to_string_lossy(), "the evidence folder"),
            None if detail.artifacts.is_empty() => self.notify("no evidence yet", false),
            None => self.notify("the evidence files share no folder", false),
        }
    }

    /// Opens artifact `index` (a place in `ordered_artifacts`).
    fn open_artifact(&mut self, id: &str, index: usize) {
        let Some(detail) = self.open_detail_of() else { return };
        let Some(artifact) = crate::detail::ordered_artifacts(detail).get(index).map(|a| (a.path.clone(), a.label.clone())) else { return };
        let what = if artifact.1.trim().is_empty() { "the file".to_string() } else { crate::model::plain(&artifact.1, 80) };
        self.open_file(id, &artifact.0, &what);
    }

    /// A left click in the task view: on a file row of the Evidence section it moves the cursor there, and a second click on the same
    /// row within half a second opens it; on the `Folder` line it opens the folder. Anywhere else it does nothing.
    fn click_detail(&mut self, x: u16, y: u16) {
        let Mode::Detail(id) = &self.mode else { return };
        let id = id.clone();
        let hit = self.evidence_hits.borrow().iter().find(|(rect, _)| x >= rect.x && x < rect.right() && y >= rect.y && y < rect.bottom()).map(|(_, hit)| *hit);
        match hit {
            Some(EvidenceHit::Folder) => self.open_evidence_folder(&id),
            Some(EvidenceHit::File(i)) => {
                let again = self.last_click.is_some_and(|(row, at)| row == i && at.elapsed() <= DOUBLE_CLICK);
                self.detail_cursor = i;
                self.detail_follow.set(true);
                if again {
                    self.last_click = None;
                    self.open_artifact(&id, i);
                } else {
                    self.last_click = Some((i, Instant::now()));
                }
            }
            None => self.last_click = None,
        }
    }

    /// Scrolls the open detail popup. `ui` clamps this to the content's actual height on the
    /// next frame, since only it knows that (it depends on the terminal width).
    fn scroll_detail(&self, delta: i16) {
        let next = i32::from(self.detail_scroll.get()) + i32::from(delta);
        self.detail_scroll.set(next.clamp(0, i32::from(u16::MAX)) as u16);
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
            .and_then(|d| d.latest_approval("awaiting_approval"))
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

    /// Typing a `:` command. The commands the text is a prefix of show under the prompt; tab
    /// cycles them, enter runs the highlighted one, or the only one left, else the text as typed.
    fn handle_command(&mut self, key: KeyEvent) -> Outcome {
        let Mode::Command { text, pick } = &mut self.mode else {
            return Outcome::Continue;
        };
        match key.code {
            KeyCode::Char(c) => {
                text.push(c);
                *pick = None;
            }
            KeyCode::Backspace => {
                *pick = None;
                if text.pop().is_none() {
                    self.close_command();
                }
            }
            KeyCode::Tab | KeyCode::BackTab | KeyCode::Down | KeyCode::Up => {
                let n = keys::completions(text).len();
                if n > 0 {
                    let back = matches!(key.code, KeyCode::BackTab | KeyCode::Up);
                    *pick = Some(match (*pick, back) {
                        (None, false) => 0,
                        (None, true) => n - 1,
                        (Some(p), false) => (p + 1) % n,
                        (Some(p), true) => (p + n - 1) % n,
                    });
                }
            }
            KeyCode::Esc => self.close_command(),
            KeyCode::Enter => {
                let matches = keys::completions(text);
                let line = match (*pick, matches.as_slice()) {
                    (Some(p), _) if p < matches.len() => matches[p].0.to_string(),
                    (None, [(only, _)]) => only.to_string(),
                    _ => text.trim().to_string(),
                };
                // A command on the card (the ones that name it) leaves the task view open; the ones
                // that open a view, a prompt or the board's own state take the screen as on the board.
                let open = self.return_to.take();
                let back = open.clone().filter(|_| CARD_COMMANDS.contains(&line.split_whitespace().next().unwrap_or("")));
                self.command_card = open;
                self.mode = Mode::Normal;
                let outcome = self.run_command(&line);
                self.command_card = None;
                if let Some(id) = back {
                    match self.mode {
                        Mode::Normal => self.mode = Mode::Detail(id),
                        Mode::Detail(_) => {}
                        _ => self.return_to = Some(id),
                    }
                }
                return outcome;
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// The names `run_command` knows, aliases left out.
    #[cfg(test)]
    pub(crate) const HANDLED_COMMANDS: &[&str] = &[
        "q", "new", "filter", "repo", "open", "group", "fold", "unfold", "setup", "whole", "dismiss", "finding", "slots", "drain", "resume", "start", "floor", "inbox", "digest", "prs", "backlog", "economy", "tickets", "ticket-edit", "context", "dedup", "dup", "undup", "slack", "jira",
        "help",
    ];

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
            "repo" => match self.card_target() {
                None => self.notify("no ticket selected", true),
                Some(id) if rest.is_empty() => self.open_repo_picker(&id),
                Some(id) => self.set_repo_named(&id, rest),
            },
            "start" => match self.card_target() {
                Some(id) => return self.ticket_key('a', &id),
                None => self.notify("no ticket selected", true),
            },
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
            "whole" => match self.card_target() {
                None => self.notify("no ticket selected", true),
                Some(id) => self.act(|m| m.keep_whole(&id), "kept as one card: recorded, and flagged at every later gate"),
            },
            "dismiss" => match (self.card_target(), parse_dismiss(rest)) {
                (None, _) => self.notify("no ticket selected", true),
                (_, Err(error)) => self.notify(error, true),
                (Some(id), Ok((finding, reason))) => self.act(|m| m.dismiss_finding(&id, &finding, reason.as_deref()), "finding dismissed"),
            },
            "finding" => match (self.card_target(), parse_finding(rest)) {
                (None, _) => self.notify("no ticket selected", true),
                (_, Err(error)) => self.notify(error, true),
                (Some(id), Ok((severity, title))) => self.act(|m| m.add_finding(&id, &severity, &title), "finding added"),
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
                self.close_views();
                self.floor = Some(FloorState::default());
                self.refresh_floor();
            }
            "inbox" => {
                self.close_views();
                self.inbox = Some(InboxState::default());
            }
            "digest" => {
                self.close_views();
                self.digest = Some(DigestState::default());
            }
            "prs" | "pulls" => self.open_pulls(),
            "backlog" => self.open_backlog(),
            "economy" => self.open_economy(),
            "tickets" => self.open_tickets(),
            "ticket-edit" => self.ticket_edit(rest),
            "context" => self.give_context(rest),
            "dedup" => self.answer_dedup(rest),
            "dup" => self.merge_selected(rest),
            "undup" => self.unmerge_selected(),
            "slack" => self.open_slack(),
            "jira" => match self.card_target() {
                Some(id) if rest.is_empty() => return self.ticket_key('J', &id),
                Some(id) => self.link_jira(&id, rest),
                None => self.notify("no ticket selected", true),
            },
            "help" | "?" => self.open_help(),
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

    /// `N`'s prompt: the comment is required; enter rejects the plan (the card is archived as rejected), esc cancels.
    /// The note for a thumbs-down: enter sends it (empty is fine), esc cancels.
    fn handle_evidence_note(&mut self, key: KeyEvent) -> Outcome {
        let Mode::EvidenceNote { id, text } = &mut self.mode else {
            return Outcome::Continue;
        };
        match key.code {
            KeyCode::Char(c) => text.push(c),
            KeyCode::Backspace => {
                text.pop();
            }
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                let (id, note) = (id.clone(), text.trim().to_string());
                self.mode = Mode::Normal;
                self.act(|m| m.evidence_feedback(&id, false, Some(&note)), "noted: the pack was not useful");
            }
            _ => {}
        }
        Outcome::Continue
    }

    fn handle_reject(&mut self, key: KeyEvent) -> Outcome {
        let Mode::Reject { id, text } = &mut self.mode else {
            return Outcome::Continue;
        };
        match key.code {
            KeyCode::Char(c) => text.push(c),
            KeyCode::Backspace => {
                text.pop();
            }
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                let (id, comment) = (id.clone(), text.trim().to_string());
                if comment.is_empty() {
                    self.notify("say why the plan is rejected; the card ends and the comment is kept", true);
                    return Outcome::Continue;
                }
                self.mode = Mode::Normal;
                self.act(|m| m.reject(&id, &comment), "rejected");
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// `T`'s picker: j/k pick the field, h/l (or the arrows) change its value, enter sends what changed, esc cancels.
    fn handle_record_edit(&mut self, key: KeyEvent) -> Outcome {
        let Mode::RecordEdit { id, field, picks } = &mut self.mode else {
            return Outcome::Continue;
        };
        let id = id.clone();
        let mut send = false;
        let mut cancel = false;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => *field = (*field + 1).min(RECORD_FIELDS.len() - 1),
            KeyCode::Up | KeyCode::Char('k') => *field = field.saturating_sub(1),
            KeyCode::Right | KeyCode::Char('l') => picks[*field] = (picks[*field] + 1) % RECORD_FIELDS[*field].2.len(),
            KeyCode::Left | KeyCode::Char('h') => picks[*field] = (picks[*field] + RECORD_FIELDS[*field].2.len() - 1) % RECORD_FIELDS[*field].2.len(),
            KeyCode::Enter => send = true,
            KeyCode::Esc | KeyCode::Char('q') => cancel = true,
            _ => {}
        }
        if cancel {
            self.mode = Mode::Normal;
        } else if send {
            let picks = *picks;
            self.mode = Mode::Normal;
            let changes = self.task(&id).and_then(|t| t.record.as_ref()).map(|r| record_changes(r, &picks)).unwrap_or_default();
            if changes.is_empty() {
                self.notify("nothing changed in the record", false);
            } else {
                let done = format!("record corrected: {}", changes.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", "));
                self.act(|m| m.edit_record(&id, &changes), &done);
            }
        }
        Outcome::Continue
    }

    /// `Z`'s picker: j/k or 1-5 move, enter archives with the highlighted reason, esc cancels.
    fn handle_archive_reason(&mut self, key: KeyEvent) -> Outcome {
        let Mode::ArchiveReason { id, cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        let id = id.clone();
        let mut chosen = None;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => *cursor = (*cursor + 1).min(ARCHIVE_REASONS.len() - 1),
            KeyCode::Up | KeyCode::Char('k') => *cursor = cursor.saturating_sub(1),
            KeyCode::Enter => chosen = Some(*cursor),
            KeyCode::Char(d @ '1'..='9') if (d as usize) - ('0' as usize) <= ARCHIVE_REASONS.len() => chosen = Some((d as usize) - ('1' as usize)),
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            _ => {}
        }
        if let Some(pick) = chosen {
            self.mode = Mode::Normal;
            let reason = ARCHIVE_REASONS[pick].0;
            self.act(|m| m.archive(&id, reason), &format!("archived: {reason}"));
        }
        Outcome::Continue
    }

    /// `E`'s picker: j/k or 1-6 move, enter sends the highlighted reason, esc cancels. Only the six reasons can be sent.
    fn handle_escalation_reason(&mut self, key: KeyEvent) -> Outcome {
        let Mode::EscalationReason { id, cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        let id = id.clone();
        let mut chosen = None;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => *cursor = (*cursor + 1).min(crate::model::ESCALATION_REASONS.len() - 1),
            KeyCode::Up | KeyCode::Char('k') => *cursor = cursor.saturating_sub(1),
            KeyCode::Enter => chosen = Some(*cursor),
            KeyCode::Char(d @ '1'..='9') if (d as usize) - ('0' as usize) <= crate::model::ESCALATION_REASONS.len() => chosen = Some((d as usize) - ('1' as usize)),
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            _ => {}
        }
        if let Some(pick) = chosen {
            self.mode = Mode::Normal;
            let reason = crate::model::ESCALATION_REASONS[pick].0;
            self.act(|m| m.correct_escalation_reason(&id, reason), &format!("reason corrected: {reason}"));
        }
        Outcome::Continue
    }

    fn handle_confirm(&mut self, key: KeyEvent, id: &str) -> Outcome {
        // A delete or an abort wants the letter.
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

    /// The approval box: `y` or enter sends the decision only while the card still waits at the gate the box was opened for.
    fn handle_confirm_approve(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('y') | KeyCode::Enter => {
                let Mode::ConfirmApprove(held) = std::mem::replace(&mut self.mode, Mode::Normal) else {
                    return Outcome::Continue;
                };
                if !self.still_at_gate(&held) {
                    self.notify(MOVED_ON, true);
                } else if held.skip_rules {
                    self.act(|m| m.approve_skipping_rules(&held.id), "approved, rules skipped");
                } else {
                    self.act(|m| m.decide(&held.id, true, None), "approved");
                }
            }
            KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
    }

    /// Whether the card of `held` is still at the gate, and the same ask, that the box was opened for.
    fn still_at_gate(&self, held: &HeldApproval) -> bool {
        let Some(task) = self.task(&held.id) else { return false };
        self.approval_gate(task).is_some_and(|gate| gate.kind == held.gate) && self.open_approval_id(&held.id) == held.approval
    }

    /// Closes an approval box whose card is gone, saying so: no mode may be left that draws nothing.
    fn settle_confirm(&mut self) {
        let gone = matches!(&self.mode, Mode::ConfirmApprove(held) if self.task(&held.id).is_none());
        if gone {
            self.mode = Mode::Normal;
            self.return_to = None;
            self.notify(MOVED_ON, true);
        }
    }

    /// `q` on the board asked while something needs you or runs: y (enter, or q again) quits, n and esc stay.
    fn handle_confirm_quit(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char('y' | 'q' | 'Q') | KeyCode::Enter => return Outcome::Quit,
            KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
            _ => {}
        }
        Outcome::Continue
    }

    /// What `q` would leave behind: the cards waiting on you (as the header counts them) and the cards running.
    pub fn pending_counts(&self) -> (usize, usize) {
        let needs = self.tasks.iter().filter(|t| t.look().needs_person()).count();
        (needs, self.tasks.iter().filter(|t| t.running).count())
    }

    /// The question `q` asks: `quit? 2 cards need you, 1 running`.
    pub fn quit_question(&self) -> String {
        let (needs, running) = self.pending_counts();
        format!("quit? {needs} {} you, {running} running", if needs == 1 { "card needs" } else { "cards need" })
    }

    /// What approving `task` commits, as the box asks it (`approve the plan of #abcdef12?`), when
    /// the card waits at a gate that commits something; None at the gates and states that do not.
    pub fn approval_question(&self, task: &Task) -> Option<String> {
        self.approval_gate(task).filter(|gate| matches!(gate.kind, "plan" | "split" | "ship" | "release" | "memory")).map(|gate| gate.question)
    }

    /// The gate `task` waits at that `a` approves, with the words the box asks: the plan, a split, a reply or an archive
    /// triage proposed, the setup, the cases, shipping, the release, the retro's rules. None while nothing waits on you
    /// and at the states where `a` does something else (answer, start, resume, retry).
    pub fn approval_gate(&self, task: &Task) -> Option<Gate> {
        let short = task.short_id();
        let open = self.detail.as_ref().filter(|d| d.task.id == task.id).and_then(|d| d.open_approval());
        let (kind, question) = match task.state.as_str() {
            "awaiting_approval" => match open.and_then(|a| a.outcome()) {
                None => ("plan", format!("approve the plan of #{short}?")),
                Some("split") => ("split", format!("approve the split of #{short}?")),
                Some("split_failed") => return None,
                Some("conversation") => ("reply", format!("post the reply and close #{short}?")),
                Some("archive") => ("archive", format!("archive #{short}?")),
                Some(_) => ("approval", format!("approve #{short}?")),
            },
            _ if !task.waiting_on_you => return None,
            "awaiting_ship" => if keys::open_ship_approval(self, task) { ("release", format!("approve the release of #{short}?")) } else { ("ship", format!("ship #{short}?")) },
            "reviewing_memory" => ("memory", format!("approve the retro's rules of #{short}?")),
            "awaiting_setup" => ("setup", format!("write the proposed luna.yaml for #{short}?")),
            "awaiting_test_check" => ("tests", format!("approve the test cases of #{short}?")),
            "draft" | "awaiting_answers" | "escalated" | "paused_rate_limit" | "closed" | "archived" => return None,
            _ => ("approval", format!("approve #{short}?")),
        };
        Some(Gate { kind, question })
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
                self.set_repo(&id, repo);
            }
            _ => {}
        }
        Outcome::Continue
    }

    /// Sets `repo` on the ticket, keeping its text.
    fn set_repo(&mut self, id: &str, repo: String) {
        let Some(task) = self.task(id).cloned() else {
            return;
        };
        let text = TicketText { title: task.title, description: task.description, criteria: task.criteria, repo_path: Some(repo) };
        self.act(|m| m.update(id, &text), "repo set");
    }

    /// `:repo <name>`: the one repo under the repos root whose path holds `name` (a path as
    /// given when it is one); says so when none or several match.
    fn set_repo_named(&mut self, id: &str, name: &str) {
        if name.starts_with('/') || name.starts_with('~') || name.starts_with('.') {
            return self.set_repo(id, name.to_string());
        }
        let all = repos_root().map(|root| discover_repos(&root)).unwrap_or_default();
        let hits = Self::matching_repos(&all, name);
        let exact: Vec<&str> = hits.iter().copied().filter(|r| r.trim_end_matches('/').rsplit('/').next() == Some(name)).collect();
        match (exact.as_slice(), hits.as_slice()) {
            ([one], _) | (_, [one]) => self.set_repo(id, one.to_string()),
            (_, []) => self.notify(format!("no repo under the repos root matches {name}; R searches"), true),
            (_, many) => self.notify(format!("{} repos match {name}; R searches, or type more of the path", many.len()), true),
        }
    }

    /// The `x` menu: the registry's rows for the ticket (`keys::menu`), run as if the key were
    /// pressed on it. A dim row still runs: the key itself says why it does nothing.
    fn handle_actions(&mut self, key: KeyEvent) -> Outcome {
        let rows: Vec<char> = keys::menu(self, Scope::Board).iter().filter_map(|(b, _)| keys::menu_char(b)).collect();
        let Mode::Actions { cursor } = &mut self.mode else {
            return Outcome::Continue;
        };
        let mut chosen = None;
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => *cursor = (*cursor + 1).min(rows.len().saturating_sub(1)),
            KeyCode::Up | KeyCode::Char('k') => *cursor = cursor.saturating_sub(1),
            KeyCode::Enter => chosen = rows.get(*cursor).copied(),
            KeyCode::Esc | KeyCode::Char('q') => self.mode = Mode::Normal,
            KeyCode::Char(c) if rows.contains(&c) => chosen = Some(c),
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
                return self.board_key(c, &id);
            }
        }
        Outcome::Continue
    }

    /// The chars the `x` menu runs: the pool keys, then every ticket key `ticket_key` takes.
    #[cfg(test)]
    pub(crate) const HANDLED_ACTIONS: &[&str] = &["P", "D", "+", "-", "S", "a", "A", "r", "e", "R", "f", "o", "J", "X", "w", "Z", "d"];

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

/// What each handler matches, for the registry's parity test: see each `HANDLED_*` next to its handler.
#[cfg(test)]
pub(crate) mod handled {
    pub(crate) use super::App;
    pub(crate) const BOARD: &[&str] = App::HANDLED_BOARD;
    pub(crate) const DETAIL: &[&str] = App::HANDLED_DETAIL;
    pub(crate) const INBOX: &[&str] = App::HANDLED_INBOX;
    pub(crate) const PULLS: &[&str] = App::HANDLED_PULLS;
    pub(crate) const BACKLOG: &[&str] = App::HANDLED_BACKLOG;
    pub(crate) const ECONOMY: &[&str] = App::HANDLED_ECONOMY;
    pub(crate) const TICKETS: &[&str] = App::HANDLED_TICKETS;
    pub(crate) const SLACK: &[&str] = App::HANDLED_SLACK;
    pub(crate) const WATCHES: &[&str] = App::HANDLED_WATCHES;
    pub(crate) const DIGEST: &[&str] = App::HANDLED_DIGEST;
    pub(crate) const FLOOR: &[&str] = App::HANDLED_FLOOR;
    pub(crate) const HELP: &[&str] = App::HANDLED_HELP;
    pub(crate) const ACTIONS: &[&str] = App::HANDLED_ACTIONS;
    pub(crate) const COMMANDS: &[&str] = App::HANDLED_COMMANDS;
}

/// The checkout `:setup <repo>` means: a path as given when it is absolute (or starts with
/// `~`, `.`), otherwise a name under the repos root. It must exist and hold a `.git`.
/// `PLAT-123`: letters (digits and `_` after the first) a dash and a number, as the machine's
/// `JiraLinkInput` accepts it.
pub fn looks_like_jira_key(text: &str) -> bool {
    let Some((project, number)) = text.split_once('-') else {
        return false;
    };
    let mut chars = project.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && !project[1..].is_empty()
        && project[1..].chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

/// `:dismiss <finding id> [reason]`: the id the Verify report shows, and an optional reason that stays out of the stream.
pub(crate) fn parse_dismiss(arg: &str) -> Result<(String, Option<String>), String> {
    let arg = arg.trim();
    let (id, reason) = arg.split_once(char::is_whitespace).map_or((arg, ""), |(i, r)| (i, r.trim()));
    if id.is_empty() {
        return Err("dismiss takes a finding id, e.g. :dismiss f3 not a bug".to_string());
    }
    Ok((id.to_string(), if reason.is_empty() { None } else { Some(reason.chars().take(500).collect()) }))
}

/// `:finding <blocker|should_fix|nit> <title>`.
pub(crate) fn parse_finding(arg: &str) -> Result<(String, String), String> {
    let arg = arg.trim();
    let (severity, title) = arg.split_once(char::is_whitespace).map_or((arg, ""), |(s, t)| (s, t.trim()));
    if !matches!(severity, "blocker" | "should_fix" | "nit") {
        return Err("finding takes blocker, should_fix or nit, then a title, e.g. :finding nit rename x".to_string());
    }
    if title.is_empty() {
        return Err("say what the finding is: :finding nit rename x".to_string());
    }
    Ok((severity.to_string(), title.chars().take(200).collect()))
}

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
        let app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
        app.mode = plan_editor();

        app.handle_key(key(KeyCode::Esc));
        assert!(matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn ctrl_s_returns_to_normal_whether_or_not_the_save_reaches_the_machine() {
        // SAFETY: every test here sets the same value, so a parallel run can't race on it.
        unsafe { std::env::set_var("HARDNESS_MACHINE_URL", "http://127.0.0.1:1") };
        let mut app = App::new(crate::testkit::dead_machine());
        app.mode = plan_editor();

        app.handle_key(KeyEvent::new(KeyCode::Char('s'), ratatui::crossterm::event::KeyModifiers::CONTROL));
        assert!(matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn the_filter_matches_the_repo_name_as_well_as_title_and_id() {
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
    fn the_record_picker_starts_on_the_record_and_sends_only_what_moved() {
        let mut task = ticket("a1", "awaiting_approval", false, false);
        task.waiting_on_you = true;
        task.record = Some(serde_json::from_str(r#"{"kind":"bug","size":"S","typeOfWork":"backend","riskPrelim":"low","urgencyDetail":{"priority":"P2","subScores":{"who":2,"what":2,"impact":2,"time":1,"demand":1}}}"#).unwrap());
        let Ok(Mode::RecordEdit { picks, field: 0, .. }) = record_edit_mode(&task) else { panic!("expected the picker") };
        assert_eq!(picks, [0, 1, 1, 0, 2], "bug, backend, S, low, P2");
        assert!(record_changes(task.record.as_ref().unwrap(), &picks).is_empty());
        let moved = [1, 1, 3, 2, 0];
        assert_eq!(
            record_changes(task.record.as_ref().unwrap(), &moved),
            vec![("kind".to_string(), "feature".to_string()), ("size".to_string(), "L".to_string()), ("riskPrelim".to_string(), "high".to_string()), ("priority".to_string(), "P0".to_string())]
        );
    }

    #[test]
    fn the_record_picker_says_why_it_will_not_open() {
        let mut task = ticket("a1", "awaiting_approval", false, false);
        task.waiting_on_you = true;
        assert!(record_edit_mode(&task).is_err(), "no record yet");
        task.record = Some(TriageRecord::default());
        for state in ["escalated", "reviewing_memory", "awaiting_ship", "implementing"] {
            task.state = state.to_string();
            assert!(record_edit_mode(&task).is_err(), "{state}: only triage's questions and the plan gate");
        }
        task.state = "awaiting_answers".to_string();
        assert!(record_edit_mode(&task).is_ok());
        task.state = "awaiting_approval".to_string();
        assert!(record_edit_mode(&task).is_ok());
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
        let mut app = App::new(crate::testkit::dead_machine());
        type_command(&mut app, &format!("setup {}", root.join("app").display()));
        // Offline machine: the call fails and the toast carries the error, which proves it was made.
        assert!(app.toast.as_ref().is_some_and(|t| t.error), "an offline machine answers with an error toast: {:?}", app.toast.as_ref().map(|t| &t.text));
        type_command(&mut app, "setup");
        assert!(app.toast.as_ref().is_some_and(|t| t.text.contains("setup takes a repo")), "{:?}", app.toast.as_ref().map(|t| &t.text));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn v_marks_a_ticket_capital_v_marks_the_column_and_esc_clears_the_marks() {
        let mut app = App::new(crate::testkit::dead_machine());
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
    fn c_opens_the_escalation_reason_picker_on_an_escalated_ticket_moves_and_esc_cancels_and_any_other_refuses() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "escalated", true, false));
        app.tasks.push(ticket("bbbbbbbb0000", "implementing", false, true));
        app.focus = app.tasks[0].column_index();
        let press = |app: &mut App, code: KeyCode| { app.handle_key(KeyEvent::from(code)); };
        press(&mut app, KeyCode::Char('C'));
        assert!(matches!(&app.mode, Mode::EscalationReason { id, cursor: 0 } if id == "aaaaaaaa0000"));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert!(matches!(app.mode, Mode::EscalationReason { cursor: 2, .. }));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(crate::model::ESCALATION_REASONS.map(|(name, _)| name), ["plan_wrong", "env_broken", "flaky_tests", "too_complex", "undeclared_scope", "other"]);
        app.focus = app.tasks[1].column_index();
        app.select("bbbbbbbb0000", true);
        press(&mut app, KeyCode::Char('C'));
        assert!(matches!(app.mode, Mode::Normal), "a ticket that is not escalated has no reason to correct");
    }

    #[test]
    fn z_opens_the_archive_reason_picker_on_a_live_ticket_moves_and_esc_cancels_and_an_ended_one_refuses() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "awaiting_approval", true, false));
        app.tasks.push(ticket("bbbbbbbb0000", "archived", false, false));
        app.focus = app.tasks[0].column_index();
        let press = |app: &mut App, code: KeyCode| { app.handle_key(KeyEvent::from(code)); };
        press(&mut app, KeyCode::Char('Z'));
        assert!(matches!(&app.mode, Mode::ArchiveReason { id, cursor: 0 } if id == "aaaaaaaa0000"));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert!(matches!(app.mode, Mode::ArchiveReason { cursor: 2, .. }));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(ARCHIVE_REASONS.map(|(name, _)| name), ["duplicate", "sla_expired", "rejected", "not_for_agent", "pr_closed", "no_setup", "no_answer"]);
        app.focus = app.tasks[1].column_index();
        app.select("bbbbbbbb0000", true);
        press(&mut app, KeyCode::Char('Z'));
        assert!(matches!(app.mode, Mode::Normal), "an archived ticket has nothing to archive");
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
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
    fn done_is_sorted_newest_first_and_z_prefix_folds_a_column() {
        let mut app = App::new(crate::testkit::dead_machine());
        let done = COLUMNS.iter().position(|c| *c == "Done").unwrap();
        assert!(!app.folded.contains(&done), "Done is not folded by hand; the board narrows it when the width is short");
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
        press(&mut app, KeyCode::Char('c'));
        assert!(app.folded.contains(&done), "zc folds");
        press(&mut app, KeyCode::Char('z'));
        press(&mut app, KeyCode::Char('o'));
        assert!(!app.folded.contains(&done), "zo unfolds");
        press(&mut app, KeyCode::Char('z'));
        press(&mut app, KeyCode::Char('z'));
        assert!(app.fold, "zz folds the whole board");
    }

    #[test]
    fn g_prefix_groups_a_column_by_stage_repo_or_age() {
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
    fn tab_reaches_a_repository_with_no_task_numbers_and_a_approves_its_base() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.floor = Some(FloorState::default());
        let floor = app.floor.as_mut().unwrap();
        floor.repos = serde_json::from_str(
            r#"[{"repo":"/r/alpha","tasks":{"created":1,"closed":0,"open":1,"waitingOnYou":0,"running":0,"queued":0},
                 "escalationRate":null,"firstPassVerifying":null,"costUsd":0}]"#,
        )
        .unwrap();
        floor.health = serde_json::from_str(
            r#"[{"repo":"/r/alpha","image":{"inUse":"m","base":null,"builtAt":null,"lastFailure":null},
                 "graph":{"on":false,"commit":null,"behind":null,"graphify":null,"builtAt":null,"building":false,"lastFailure":null}},
                {"repo":"/r/fresh","image":{"inUse":"m","base":null,"builtAt":null,"lastFailure":null,"pendingBase":"python:3.13-slim"},
                 "graph":{"on":false,"commit":null,"behind":null,"graphify":null,"builtAt":null,"building":false,"lastFailure":null}}]"#,
        )
        .unwrap();
        assert_eq!(floor.focusable(), 2);
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        let floor = app.floor.as_ref().unwrap();
        assert_eq!(floor.focused(), Some(Some("/r/fresh")));
        assert_eq!(floor.focused_name(), Some("fresh"));
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.floor.as_ref().unwrap().focused(), None, "back to all");
    }

    #[test]
    fn a_started_stage_is_recorded_for_f_and_closing_or_deleting_forgets_it() {
        let mut app = App::new(crate::testkit::dead_machine());
        let started = |id: &str| {
            serde_json::from_str::<StreamMessage>(&format!(
                r##"{{"type":"stage.started","taskId":"{id}","label":"#aaaaaaaa app","cwd":"/w","container":"c1"}}"##
            ))
            .unwrap()
        };
        app.tx.send(Incoming::Message(started("aaaaaaaa0000"))).unwrap();
        app.tx.send(Incoming::Message(started("bbbbbbbb0000"))).unwrap();
        app.pump();
        let stage = app.stages.get("aaaaaaaa0000").expect("recorded");
        assert_eq!((stage.label.as_str(), stage.cwd.as_str(), stage.container.as_str()), ("#aaaaaaaa app", "/w", "c1"));
        app.tx.send(Incoming::Message(StreamMessage::Closed { id: "aaaaaaaa0000".into() })).unwrap();
        app.tx.send(Incoming::Message(StreamMessage::Deleted { id: "bbbbbbbb0000".into() })).unwrap();
        app.pump();
        assert!(app.stages.is_empty());
    }

    #[test]
    fn f_with_nothing_to_watch_shows_a_plain_notice() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "building", true, false));
        app.ticket_key('f', "aaaaaaaa0000");
        let toast = app.toast.as_ref().expect("a toast");
        assert!(!toast.error);
        assert!(!toast.text.contains("opens when an agent runs"), "{}", toast.text);
    }

    #[test]
    fn the_nothing_to_watch_branch_notices_without_error() {
        let mut app = App::new(crate::testkit::dead_machine());
        let task = ticket("aaaaaaaa0000", "building", true, true);
        app.tasks.push(task.clone());
        app.watch_with(&task, false);
        let toast = app.toast.as_ref().expect("a toast");
        assert!(!toast.error);
        assert!(toast.text.contains("nothing is running"), "{}", toast.text);
    }

    #[test]
    fn f_on_a_running_ticket_with_a_recorded_stage_opens_instead_of_noticing() {
        if herdr::available() {
            return;
        }
        let mut app = App::new(crate::testkit::dead_machine());
        let task = ticket("aaaaaaaa0000", "implementing", true, true);
        app.tasks.push(task.clone());
        let stage = herdr::Stage { label: "#aaaaaaaa app · t".into(), cwd: "/wt".into(), container: "c1".into() };
        app.stages.insert(task.id.clone(), stage);
        app.watch_with(&task, false);
        assert!(
            app.toast.as_ref().is_none_or(|t| !t.text.contains("nothing is running")),
            "a running stage opens its tab, it does not say nothing is running"
        );
        assert!(app.stages.contains_key("aaaaaaaa0000"), "the stage stays recorded");
    }

    #[test]
    fn a_stage_of_a_task_that_stopped_running_is_not_opened_by_f() {
        let mut app = App::new(crate::testkit::dead_machine());
        let task = ticket("aaaaaaaa0000", "awaiting_approval", false, true);
        app.tasks.push(task.clone());
        let stage = herdr::Stage { label: "#aaaaaaaa app".into(), cwd: "/wt".into(), container: "c1".into() };
        app.stages.insert(task.id.clone(), stage);
        app.watch_with(&task, false);
        let toast = app.toast.as_ref().expect("a toast");
        assert!(toast.text.contains("nothing is running"), "{}", toast.text);
    }

    #[test]
    fn the_connect_scan_records_a_stage_without_overwriting_a_newer_one() {
        let mut app = App::new(crate::testkit::dead_machine());
        let stage = |c: &str| herdr::Stage { label: "#a".into(), cwd: "/w".into(), container: c.into() };
        app.stages.insert("t1".into(), stage("new"));
        app.scan_tx.send(("t1".into(), stage("old"))).unwrap();
        app.scan_tx.send(("t2".into(), stage("c2"))).unwrap();
        app.pump();
        assert_eq!(app.stages["t1"].container, "new");
        assert_eq!(app.stages["t2"].container, "c2");
    }

    #[test]
    fn reconnecting_drops_stages_recorded_before_the_outage() {
        let mut app = App::new(crate::testkit::dead_machine());
        let stage = herdr::Stage { label: "#a".into(), cwd: "/w".into(), container: "finished".into() };
        app.stages.insert("t1".into(), stage);
        app.tx.send(Incoming::Online).unwrap();
        app.pump();
        assert!(!app.stages.contains_key("t1"), "the scan refills it with what is really running");
    }

    #[test]
    fn f_outside_herdr_with_a_running_stage_notices_and_keeps_the_stage() {
        if herdr::available() {
            return;
        }
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.select("aaaaaaaa0000", true);
        let started = r##"{"type":"stage.started","taskId":"aaaaaaaa0000","label":"#aaaaaaaa app · t","cwd":"/wt","container":"c1"}"##;
        app.tx.send(Incoming::Message(serde_json::from_str(started).unwrap())).unwrap();
        app.pump();
        app.handle_key(KeyEvent::from(KeyCode::Char('f')));
        let toast = app.toast.as_ref().expect("f outside herdr says why nothing opened");
        assert!(!toast.error, "{}", toast.text);
        assert!(toast.text.contains("herdr"), "{}", toast.text);
        assert!(app.stages.contains_key("aaaaaaaa0000"), "the stage stays recorded for a later f inside herdr");
        assert!(app.floor.is_none(), "lowercase f never opens the Floor view");
    }

    #[test]
    fn uppercase_f_opens_and_closes_the_floor_view() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.select("aaaaaaaa0000", true);
        app.handle_key(KeyEvent::from(KeyCode::Char('F')));
        assert!(app.floor.is_some(), "F opens the Floor view");
        assert!(app.toast.as_ref().is_none_or(|t| !t.text.contains("watch")), "F is not the watch key");
        app.handle_key(KeyEvent::from(KeyCode::Char('F')));
        assert!(app.floor.is_none(), "F again closes it");
    }

    #[test]
    fn a_later_stage_replaces_the_recorded_one_so_f_opens_the_newest_container() {
        let mut app = App::new(crate::testkit::dead_machine());
        let task = ticket("aaaaaaaa0000", "implementing", true, true);
        app.tasks.push(task.clone());
        for container in ["c1", "c2"] {
            let started = format!(
                r##"{{"type":"stage.started","taskId":"aaaaaaaa0000","label":"#aaaaaaaa app · t","cwd":"/wt","container":"{container}"}}"##
            );
            app.tx.send(Incoming::Message(serde_json::from_str(&started).unwrap())).unwrap();
        }
        app.pump();
        assert_eq!(app.stages.len(), 1, "one entry per task, not per stage");
        let want = herdr::Stage { label: "#aaaaaaaa app · t".into(), cwd: "/wt".into(), container: "c2".into() };
        assert_eq!(herdr::watch_action(false, app.stages.get(&task.id)), herdr::WatchAction::OpenAndFocus(want));
    }

    #[test]
    fn f_with_an_existing_tab_only_focuses_and_says_nothing() {
        if herdr::available() {
            return;
        }
        let mut app = App::new(crate::testkit::dead_machine());
        let task = ticket("aaaaaaaa0000", "implementing", true, true);
        app.tasks.push(task.clone());
        let stage = herdr::Stage { label: "#aaaaaaaa app · t".into(), cwd: "/wt".into(), container: "c1".into() };
        app.stages.insert(task.id.clone(), stage);
        app.toast = None;
        app.watch_with(&task, true);
        assert!(app.toast.is_none(), "focusing an existing tab is silent: {:?}", app.toast.as_ref().map(|t| &t.text));
        assert!(app.stages.contains_key(&task.id), "the stage stays recorded");
    }

    #[test]
    fn a_budget_alert_becomes_a_notice_and_a_toast_that_turns_red_at_the_ceiling() {
        let mut app = App::new(crate::testkit::dead_machine());
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

    #[test]
    fn a_shipped_task_becomes_a_notice_and_a_toast() {
        let mut app = App::new(crate::testkit::dead_machine());
        let shipped = serde_json::from_str::<StreamMessage>(
            r##"{"type":"task.shipped","shipped":{"id":"aaaaaaaa0000","title":"Export CSV","prUrl":"https://github.com/o/a/pull/7","number":7,"mergedSha":null,"format":null,"howToVerify":null,"media":[],"at":"t"}}"##,
        )
        .unwrap();
        app.tx.send(Incoming::Message(shipped)).unwrap();
        app.pump();
        let notices = app.take_notices();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].title, "Shipped");
        assert_eq!(notices[0].body, "Shipped: Export CSV → PR #7");
        assert!(!app.toast.as_ref().expect("a toast").error);
    }

    #[test]
    fn an_engine_budget_alert_names_the_engine_with_or_without_a_task_or_repo() {
        let mut app = App::new(crate::testkit::dead_machine());
        for line in [
            r#"{"type":"budget.alert","alert":{"scope":"engine","engine":"openai","taskId":null,"repo":null,"pct":80,"spentUsd":16,"limitUsd":20}}"#,
            r#"{"type":"budget.alert","alert":{"scope":"engine","engine":"openai:sol","taskId":"aaaaaaaa0000","repo":"/r/luna-tui","pct":100,"spentUsd":10,"limitUsd":10}}"#,
        ] {
            app.tx.send(Incoming::Message(serde_json::from_str::<StreamMessage>(line).unwrap())).unwrap();
        }
        app.pump();
        let bodies: Vec<String> = app.take_notices().into_iter().map(|n| n.body).collect();
        assert_eq!(bodies, ["engine openai at 80%: $16.00 of $20.00 this month", "engine openai:sol in luna-tui at 100%: $10.00 of $10.00 this month"]);
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
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
        assert!(matches!(app.mode, Mode::Command { .. }), "colon opens the palette");
        for ch in text.chars() {
            app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
        }
        app.handle_key(KeyEvent::from(KeyCode::Enter))
    }

    #[test]
    fn the_colon_palette_runs_board_commands_by_name() {
        let mut app = App::new(crate::testkit::dead_machine());
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
        assert!(matches!(app.mode, Mode::Help { .. }));
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
        let mut app = crate::testkit::plan_gate_app();
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Detail, .. }));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(matches!(&app.mode, Mode::Detail(id) if id == "aaaaaaaa1111"));
        app.mode = Mode::Normal;
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        app.handle_key(KeyEvent::from(KeyCode::Char('q')));
        assert!(matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn help_cursor_moves_with_j_and_k_and_clamps() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.focus = app.tasks[0].column_index();
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        let rows = keys::help_rows_for(&app, Scope::Board, true, None).iter().filter(|r| matches!(r, keys::HelpRow::Key { .. })).count();
        assert!(rows > 3);
        for _ in 0..rows + 5 {
            app.handle_key(KeyEvent::from(KeyCode::Char('j')));
        }
        assert!(matches!(app.mode, Mode::Help { cursor, .. } if cursor == rows - 1), "stops on the last row");
        for _ in 0..rows + 5 {
            app.handle_key(KeyEvent::from(KeyCode::Up));
        }
        assert!(matches!(app.mode, Mode::Help { cursor: 0, .. }));
        app.help_viewport.set(10);
        app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL));
        assert!(matches!(app.mode, Mode::Help { cursor: 5, .. }), "ctrl+d moves half the page");
        app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        assert!(matches!(app.mode, Mode::Help { cursor: 0, .. }));
    }

    #[test]
    fn question_mark_opens_the_sheet_for_the_view_you_are_in() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Board, .. }));
        app.handle_key(KeyEvent::from(KeyCode::Esc));

        app.inbox = Some(InboxState::default());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Inbox, .. }));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(app.inbox.is_some(), "closing the help keeps the view");
        app.inbox = None;

        app.digest = Some(DigestState::default());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Digest, .. }));
        app.mode = Mode::Normal;
        app.digest = None;

        app.floor = Some(FloorState::default());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Floor, .. }));
        app.mode = Mode::Normal;
        app.floor = None;

        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.mode = Mode::Detail("aaaaaaaa0000".to_string());
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Detail, .. }));
    }

    #[test]
    fn a_bright_key_closes_the_sheet_and_runs_a_dim_or_unknown_one_only_says_why() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.focus = app.tasks[0].column_index();
        app.toast = None;
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        app.handle_key(KeyEvent::from(KeyCode::Char('x')));
        assert!(matches!(app.mode, Mode::Actions { .. }), "x is bright: the sheet closes and the menu opens");
        app.mode = Mode::Normal;

        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        app.handle_key(KeyEvent::from(KeyCode::Char('r')));
        assert!(matches!(app.mode, Mode::Help { .. }), "a dim key keeps the sheet");
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("only a setup, plan, tests or escalation go back"));
        app.handle_key(KeyEvent::from(KeyCode::Char('%')));
        assert!(matches!(app.mode, Mode::Help { .. }));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("% is not a key here; esc closes"));

        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help { long: false, .. }), "? again folds to the short form");
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert!(matches!(app.mode, Mode::Help { long: true, .. }));

        app.handle_key(KeyEvent::from(KeyCode::Char('G')));
        assert!(matches!(app.mode, Mode::Normal), "G is bright: the sheet closes and runs it");
    }

    #[test]
    fn enter_runs_the_cursor_row_in_its_own_view_only() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "implementing", true, true));
        app.focus = app.tasks[0].column_index();
        app.toast = None;
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        // The first row is the gate's `a`, dim while a stage runs.
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(matches!(app.mode, Mode::Help { .. }));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("a stage is running; X aborts it"));

        app.handle_key(KeyEvent::from(KeyCode::Char('/')));
        for ch in "merge".chars() {
            app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
        }
        assert!(matches!(&app.mode, Mode::Help { query: Some(q), .. } if q == "merge"));
        let rows = keys::help_rows_for(&app, Scope::Board, false, Some("merge"));
        assert!(rows.iter().any(|r| matches!(r, keys::HelpRow::Key { binding, foreign: true, .. } if binding.scope == Scope::Pulls)));
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("open Pulls first"));
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(matches!(&app.mode, Mode::Help { query: None, .. }), "esc leaves the search first");

        // In the long form (how the sheet opens), down to `enter  open the ticket's workspace`, and run it.
        let rows = keys::help_rows_for(&app, Scope::Board, true, None);
        let at = rows.iter().filter(|r| matches!(r, keys::HelpRow::Key { .. })).position(|r| matches!(r, keys::HelpRow::Key { binding, .. } if binding.keys == "enter")).unwrap();
        for _ in 0..at {
            app.handle_key(KeyEvent::from(KeyCode::Char('j')));
        }
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(matches!(&app.mode, Mode::Detail(id) if id == "aaaaaaaa0000"), "{:?}", app.toast.as_ref().map(|t| t.text.clone()));
    }

    #[test]
    fn a_prefix_key_shows_its_second_keys_after_the_delay() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.handle_key(KeyEvent::from(KeyCode::Char('g')));
        assert!(app.which_key().is_none(), "nothing before the delay");
        app.age_prefix();
        let (prefix, seconds) = app.which_key().expect("the strip");
        assert_eq!(prefix, 'g');
        assert_eq!(seconds.iter().map(|(c, _)| *c).collect::<Vec<_>>(), ['g', 's', 'r', 'a']);
        app.handle_key(KeyEvent::from(KeyCode::Char('s')));
        assert!(app.which_key().is_none(), "the second key ends it");
        app.handle_key(KeyEvent::from(KeyCode::Char('z')));
        app.age_prefix();
        assert_eq!(app.which_key().unwrap().1.iter().map(|(c, _)| *c).collect::<Vec<_>>(), ['c', 'o', 'z']);
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(app.which_key().is_none());
    }

    #[test]
    fn the_colon_prompt_completes_commands() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.handle_key(KeyEvent::from(KeyCode::Char(':')));
        for ch in "fo".chars() {
            app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
        }
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(app.folded.contains(&app.focus), "the only completion runs");
        app.handle_key(KeyEvent::from(KeyCode::Char(':')));
        app.handle_key(KeyEvent::from(KeyCode::Char('f')));
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert!(matches!(&app.mode, Mode::Command { pick: Some(1), .. }));
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(app.folded.contains(&app.focus), "tab tab picks fold");
        type_command(&mut app, "unfo");
        assert!(!app.folded.contains(&app.focus));
        app.toast = None;
        type_command(&mut app, "f");
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("unknown command: f (try :help)"), "several matches and no pick: as typed");
    }

    #[test]
    fn capital_r_searches_only_on_a_ticket_without_a_repo() {
        let mut app = App::new(crate::testkit::dead_machine());
        app.tasks.push(ticket("aaaaaaaa0000", "draft", false, false));
        app.focus = app.tasks[0].column_index();
        app.toast = None;
        app.handle_key(KeyEvent::from(KeyCode::Char('R')));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("use :repo <name> or x"));
        assert!(matches!(app.mode, Mode::Normal));
        app.tasks[0].repo_path = None;
        app.handle_key(KeyEvent::from(KeyCode::Char('R')));
        let opened = matches!(app.mode, Mode::RepoPicker { .. }) || app.toast.as_ref().is_some_and(|t| t.text.starts_with("no repos found"));
        assert!(opened, "without a repo R searches (or says there is nothing to search)");
        app.mode = Mode::Normal;
        app.tasks.clear();
        app.toast = None;
        type_command(&mut app, "repo luna");
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("no ticket selected"));
    }

    #[test]
    fn column_order_is_cached_per_frame_and_still_sees_a_new_ticket() {
        let mut app = App::new(crate::testkit::dead_machine());
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
        let mut app = App::new(crate::testkit::dead_machine());
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
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Pulls, .. }));
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
    fn r_starts_a_poll_in_the_background_and_a_second_r_waits_for_it() {
        let mut app = app_with(vec![pr(1, "mine", true, true)]);
        app.handle_key(KeyEvent::from(KeyCode::Char('P')));
        app.handle_key(KeyEvent::from(KeyCode::Char('R')));
        assert!(app.prs_polling, "the view says it is polling the moment R is pressed");
        app.toast = None;
        app.handle_key(KeyEvent::from(KeyCode::Char('R')));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("already polling GitHub"));
    }

    #[test]
    fn the_polled_snapshot_clears_the_flag_and_a_failed_poll_says_why() {
        let mut app = app_with(vec![pr(1, "mine", true, true)]);
        app.prs_polling = true;
        let fresh = PrSnapshot { prs: Vec::new(), polled_at: Some("2026-10-27T11:00:00Z".to_string()), error: None };
        app.tx.send(Incoming::PrsPolled(Ok(fresh))).unwrap();
        app.pump();
        assert!(!app.prs_polling && app.prs.prs.is_empty());
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("polled GitHub"));
        app.prs_polling = true;
        app.tx.send(Incoming::PrsPolled(Err("timed out".into()))).unwrap();
        app.pump();
        assert!(!app.prs_polling);
        assert!(app.toast.as_ref().is_some_and(|t| t.error && t.text.contains("timed out")));
    }

    #[test]
    fn x_asks_before_closing_your_own_pr_and_says_why_it_will_not_close_a_teammates() {
        let mut app = app_with(vec![pr(1, "mine", true, true), pr(2, "review_requested", false, false)]);
        app.handle_key(KeyEvent::from(KeyCode::Char('P')));
        app.handle_key(KeyEvent::from(KeyCode::Char('6')));
        app.handle_key(KeyEvent::from(KeyCode::Char('X')));
        assert!(matches!(&app.mode, Mode::ConfirmClose { repo, number } if repo == "acme/app" && *number == 1), "{:?}", app.toast.as_ref().map(|t| t.text.clone()));
        app.handle_key(KeyEvent::from(KeyCode::Char('x')));
        assert!(matches!(app.mode, Mode::ConfirmClose { .. }), "only y, n and esc answer the modal");
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert!(matches!(app.mode, Mode::Normal) && app.pulls.is_some(), "esc closes nothing and keeps the view");
        app.handle_key(KeyEvent::from(KeyCode::Char('1')));
        app.handle_key(KeyEvent::from(KeyCode::Char('X')));
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("closing is for your own PRs"));
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
mod slack_tests {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
    };

    use ratatui::crossterm::event::KeyModifiers;

    use super::*;
    use crate::model::SlackOption;
    use crate::slack::fixtures::{item, snapshot, watch_json};

    /// A machine that says yes to everything: `{}` for any call it does not know, the fixture
    /// watches for `/slack/watches`, Jira answers for `/jira/*` and `/tasks/:id/jira`, and an
    /// `/events` stream it keeps open and silent. Its one no: `PATCH /tasks/:id/stages` refuses
    /// test_design (409, it ran) and claude:opus (400), the fixture packs and engines.
    pub(super) fn fake_machine() -> Machine {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            let mut streams = Vec::new();
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut request = String::new();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                    request.push_str(&line);
                }
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                let method = request.split_whitespace().next().unwrap_or("");
                let path = request.split_whitespace().nth(1).unwrap_or("");
                let mut stream = reader.into_inner();
                let sent = String::from_utf8_lossy(&body).to_string();
                let refused = path.ends_with("/stages") && (sent.contains("test_design") || sent.contains("claude:opus"));
                let answer = match path {
                    "/packs" => crate::model::engine_tests::PACKS.to_string(),
                    "/engines" => crate::model::engine_tests::ENGINES.to_string(),
                    p if p.starts_with("/metrics?") => crate::model::engine_tests::metrics_json(p.contains("groupBy=engine")),
                    _ if refused && sent.contains("test_design") => r#"{"error":"stage_started","message":"test_design has run"}"#.to_string(),
                    _ if refused => r#"{"error":"invalid_input","message":"claude:opus is not allowed for triage"}"#.to_string(),
                    p if p.ends_with("/stages") => super::jira_tests::linked_task_json(p.trim_start_matches("/tasks/").trim_end_matches("/stages"), None),
                    "/jira/status" => r#"{"configured":true,"site":"https://acme.atlassian.net","tokenExpiresAt":null,"error":null}"#.to_string(),
                    p if p.starts_with("/jira/search?q=") => {
                        let q = p.trim_start_matches("/jira/search?q=").to_uppercase();
                        if q.starts_with("PL") {
                            r#"[{"key":"PLAT-123","summary":"Login page","status":"In Progress","issueType":"Story","url":"https://acme.atlassian.net/browse/PLAT-123"},
                                {"key":"PLAT-7","summary":"Password reset","status":"To Do","issueType":"Task","url":"https://acme.atlassian.net/browse/PLAT-7"}]"#.to_string()
                        } else {
                            "[]".to_string()
                        }
                    }
                    p if p.ends_with("/jira") && p.starts_with("/tasks/") => {
                        let id = p.trim_start_matches("/tasks/").trim_end_matches("/jira");
                        let key = String::from_utf8_lossy(&body);
                        let key = key.split('"').nth(3).unwrap_or("PLAT-123").to_string();
                        super::jira_tests::linked_task_json(id, if method == "DELETE" { None } else { Some(&key) })
                    }
                    p if p.ends_with("/jira/create") => super::jira_tests::linked_task_json(p.trim_start_matches("/tasks/").trim_end_matches("/jira/create"), Some("PLAT-900")),
                    "/events" => {
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n");
                        streams.push(stream);
                        continue;
                    }
                    "/tasks" => "[]".to_string(),
                    "/slack/watches" => format!("[{},{}]", watch_json("w1", "usergroup", "S04ABCD", "@platform-team", false), watch_json("w2", "broadcast", "here", "@here", true)),
                    "/slack/usergroups" => r#"[{"id":"S04ABCD","label":"@platform-team"},{"id":"S05","label":"@data"}]"#.to_string(),
                    "/slack/channels" => r##"[{"id":"C1","label":"#eng"}]"##.to_string(),
                    p if p.ends_with("/reply") => format!(r#"{{"replied":{}}}"#, String::from_utf8_lossy(&body)),
                    p if p.starts_with("/slack/watches/") => watch_json("w1", "usergroup", "S04ABCD", "@platform-team", false).replace("\"enabled\":true", "\"enabled\":false"),
                    _ => "{}".to_string(),
                };
                // One request per connection: `Connection: close` keeps ureq from reusing it.
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{answer}",
                        match (refused, sent.contains("test_design")) {
                            (false, _) => "200 OK",
                            (true, true) => "409 Conflict",
                            (true, false) => "400 Bad Request",
                        },
                        answer.len()
                    )
                    .as_bytes(),
                );
            }
        });
        Machine::at(&format!("http://{addr}"))
    }

    fn app_with(snapshot: SlackSnapshot) -> App {
        let mut app = App::new(fake_machine());
        app.tasks.clear();
        app.toast = None;
        app.take_notices();
        app.tx.send(Incoming::Message(StreamMessage::Slack { snapshot })).unwrap();
        app.pump();
        app
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    fn toast(app: &App) -> String {
        app.toast.as_ref().map(|t| t.text.clone()).unwrap_or_default()
    }

    fn type_command(app: &mut App, text: &str) {
        press(app, KeyCode::Char(':'));
        for ch in text.chars() {
            press(app, KeyCode::Char(ch));
        }
        press(app, KeyCode::Enter);
    }

    #[test]
    fn the_floor_reads_cost_per_engine_and_each_engine_s_month_from_the_machine() {
        let mut app = app_with(snapshot());
        press(&mut app, KeyCode::Char('F'));
        let floor = app.floor.as_ref().expect("F opens the Floor");
        let rows = floor.by_engine.as_ref().expect("the machine reports engines");
        assert_eq!(rows.iter().map(|r| r.name()).collect::<Vec<_>>(), ["claude:opus", "(none)"]);
        let sonnet = floor.engines.iter().find(|e| e.id == "claude:sonnet").unwrap();
        assert!(sonnet.at_cap(), "{sonnet:?}");

        let mut old = App::new(Machine::at("http://127.0.0.1:9"));
        press(&mut old, KeyCode::Char('F'));
        assert!(old.floor.as_ref().unwrap().by_engine.is_none() && old.floor.as_ref().unwrap().engines.is_empty());
    }

    #[test]
    fn s_opens_the_slack_view_and_its_keys_move_between_splits_and_rows() {
        let mut snapshot = snapshot();
        snapshot.items.push(item("C0123:3", "needs_reply", Some("P1"), "2026-10-28T08:00:00Z"));
        let mut app = app_with(snapshot);
        press(&mut app, KeyCode::Char('S'));
        let state = app.slack.clone().expect("the Slack view opens");
        assert_eq!(state.split, SlackSplit::NeedsReply);
        assert_eq!(app.slack_under_cursor().map(|i| i.id.as_str()), Some("C0123:1730112345.0001"), "the P0 is on top");
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.slack_under_cursor().map(|i| i.id.as_str()), Some("C0123:3"));
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.slack.as_ref().unwrap().cursor, 1, "stops at the last row");
        press(&mut app, KeyCode::Char('l'));
        assert_eq!(app.slack.as_ref().unwrap().split, SlackSplit::WaitingOnThem);
        assert_eq!(app.slack.as_ref().unwrap().cursor, 0);
        press(&mut app, KeyCode::Char('4'));
        assert_eq!(app.slack.as_ref().unwrap().split, SlackSplit::Fyi);
        press(&mut app, KeyCode::Char('h'));
        assert_eq!(app.slack.as_ref().unwrap().split, SlackSplit::Decide);
        press(&mut app, KeyCode::Char('?'));
        assert!(matches!(app.mode, Mode::Help { scope: Scope::Slack, .. }));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal) && app.slack.is_some(), "closing the help keeps the view");
        press(&mut app, KeyCode::Esc);
        assert!(app.slack.is_none());
        type_command(&mut app, "slack");
        assert!(app.slack.is_some(), ":slack opens it too");
        press(&mut app, KeyCode::Char('S'));
        assert!(app.slack.is_none(), "S closes it again");
    }

    #[test]
    fn d_clears_the_row_at_once_and_the_priority_keys_step_one_at_a_time() {
        let mut snapshot = snapshot();
        snapshot.items.push(item("C0123:3", "needs_reply", Some("P1"), "2026-10-28T08:00:00Z"));
        let mut app = app_with(snapshot);
        press(&mut app, KeyCode::Char('S'));
        assert_eq!(slack::items(&app.slack_snapshot.items, SlackSplit::NeedsReply).len(), 2);
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(toast(&app), "done");
        assert_eq!(slack::items(&app.slack_snapshot.items, SlackSplit::NeedsReply).len(), 1, "the row leaves the split before the next poll");
        let cleared = app.slack_item("C0123:1730112345.0001").unwrap();
        assert_eq!(cleared.split_enum(), Some(SlackSplit::Done));
        assert!(cleared.done_at.is_some());
        assert_eq!(app.slack_under_cursor().map(|i| i.id.as_str()), Some("C0123:3"), "the cursor lands on the next row");

        press(&mut app, KeyCode::Char('!'));
        assert_eq!(toast(&app), "P1 → P0");
        let bumped = app.slack_item("C0123:3").unwrap();
        assert_eq!(bumped.priority(), Some("P0"));
        assert!(bumped.triage.as_ref().unwrap().overridden);
        press(&mut app, KeyCode::Char('!'));
        assert_eq!(toast(&app), "already P0", "the blocker speaks before any call");
        press(&mut app, KeyCode::Char('-'));
        assert_eq!(toast(&app), "P0 → P1");
        press(&mut app, KeyCode::Char('N'));
        assert_eq!(toast(&app), "only while waiting on them");
        press(&mut app, KeyCode::Char('6'));
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(toast(&app), "already done");
    }

    #[test]
    fn a_done_tap_names_why_a_draft_was_dismissed_and_asks_only_when_a_draft_waits() {
        assert_eq!(dismiss_patch(None), serde_json::json!({ "done": true }));
        assert_eq!(dismiss_patch(Some("bad_draft")), serde_json::json!({ "done": true, "reason": "bad_draft" }));
        assert_eq!(dismiss_patch(Some("no_reply_needed")), serde_json::json!({ "done": true, "reason": "no_reply_needed" }));
        let mut app = app_with(snapshot());
        app.slack_item_mut("C0123:1730112345.0001").unwrap().draft = Some(crate::model::SlackDraft { id: "d1".into(), hash: "h1".into(), kind: "reply".into(), text: String::new(), expires_at: "2026-11-07T00:00:00Z".into() });
        press(&mut app, KeyCode::Char('S'));
        press(&mut app, KeyCode::Char('d'));
        assert!(matches!(&app.mode, Mode::SlackDismiss { id } if id == "C0123:1730112345.0001"));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(app.slack_item("C0123:1730112345.0001").unwrap().split, "needs_reply", "esc leaves it as it is");
    }

    #[test]
    fn r_opens_the_waiting_drafts_own_text_not_the_classifiers_old_reply() {
        let mut app = app_with(snapshot());
        let id = "C0123:1730112345.0001";
        app.slack_item_mut(id).unwrap().draft = Some(crate::model::SlackDraft { id: "d2".into(), hash: "h2".into(), kind: "questions".into(), text: "Which export?".into(), expires_at: "2026-11-07T00:00:00Z".into() });
        press(&mut app, KeyCode::Char('S'));
        press(&mut app, KeyCode::Char('r'));
        let Mode::SlackReply { area, draft, .. } = &app.mode else { panic!("the reply editor opens: {}", toast(&app)) };
        assert_eq!(draft, &Some(("d2".to_string(), "h2".to_string())));
        assert_eq!(area.lines().join("\n"), "Which export?", "the draft the id and hash stand for, not triage.draft");
    }

    #[test]
    fn a_slack_draft_from_before_its_text_was_sent_still_parses() {
        let old: crate::model::SlackDraft = serde_json::from_str(r#"{"id":"d1","hash":"h1","kind":"reply","expiresAt":"2026-11-07T00:00:00Z"}"#).unwrap();
        assert_eq!(old.text, "");
    }

    #[test]
    fn s_picks_a_snooze_and_r_sends_the_edited_draft() {
        let mut app = app_with(snapshot());
        app.slack_item_mut("C0123:1730112345.0001").unwrap().draft = Some(crate::model::SlackDraft { id: "d1".into(), hash: "h1".into(), kind: "reply".into(), text: String::new(), expires_at: "2026-11-07T00:00:00Z".into() });
        press(&mut app, KeyCode::Char('S'));
        press(&mut app, KeyCode::Char('s'));
        assert!(matches!(&app.mode, Mode::SlackSnooze { id, cursor: 0 } if id == "C0123:1730112345.0001"));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert!(matches!(&app.mode, Mode::SlackSnooze { cursor: 2, .. }));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(app.slack_item("C0123:1730112345.0001").unwrap().split, "needs_reply", "esc leaves it awake");
        press(&mut app, KeyCode::Char('s'));
        press(&mut app, KeyCode::Char('3'));
        assert_eq!(toast(&app), "snoozed until tomorrow 9:00");
        let snoozed = app.slack_item("C0123:1730112345.0001").unwrap();
        assert_eq!(snoozed.split_enum(), Some(SlackSplit::Snoozed));
        assert!(snoozed.snoozed_until.as_deref().is_some_and(|t| t.ends_with("Z")));

        press(&mut app, KeyCode::Char('5'));
        press(&mut app, KeyCode::Char('r'));
        let Mode::SlackReply { id, area, draft, .. } = &app.mode else { panic!("the reply editor opens: {}", toast(&app)) };
        assert_eq!(draft, &Some(("d1".to_string(), "h1".to_string())), "the editor remembers which draft it was opened on");
        assert_eq!(id, "C0123:1730112345.0001");
        assert_eq!(area.lines().join("\n"), "Approve the rollback, I'm on it.", "pre-filled with the draft");
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal) && app.slack.is_some(), "esc backs out without sending");
        press(&mut app, KeyCode::Char('r'));
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert_eq!(toast(&app), "sent");
        let sent = app.slack_item("C0123:1730112345.0001").unwrap();
        assert_eq!(sent.split_enum(), Some(SlackSplit::Done));
        assert!(sent.you_replied);
    }

    #[test]
    fn n_opens_a_nudge_the_machine_addresses_by_id_not_a_typed_at_name() {
        let mut waiting = snapshot();
        waiting.items.push(item("C0123:7", "waiting_on_them", Some("P1"), "2026-10-27T08:00:00Z"));
        let mut app = app_with(waiting);
        press(&mut app, KeyCode::Char('S'));
        press(&mut app, KeyCode::Char('2'));
        press(&mut app, KeyCode::Char('N'));
        let Mode::SlackReply { area, nudge, .. } = &app.mode else { panic!("the reply editor opens: {}", toast(&app)) };
        assert!(*nudge);
        assert_eq!(area.lines().join("\n"), "gentle nudge on this one: any news?", "no @name typed into the text: the machine mentions the author by id");
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert_eq!(toast(&app), "sent");
    }

    #[test]
    fn opening_the_slack_view_prefetches_the_watch_catalogue_off_the_ui_thread() {
        let mut app = app_with(snapshot());
        assert!(app.slack_catalog_loading());
        press(&mut app, KeyCode::Char('S'));
        assert!(app.slack_catalog_pending, "the fetch started when the view opened");
        assert!(app.slack_catalog_loading(), "and has not landed yet");
        // The fake machine's own event stream shares this channel: on a slow runner one of its messages can land first, so wait for the catalogue itself.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let landed = loop {
            let message = app.stream.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).expect("the catalogue arrives on the stream");
            if matches!(message, Incoming::SlackCatalog { .. }) {
                break message;
            }
        };
        app.tx.send(landed).unwrap();
        app.pump();
        assert!(!app.slack_catalog_loading() && !app.slack_catalog_pending);
        assert_eq!(app.slack_watch_matches("@dat").iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), vec!["S05"]);
        assert_eq!(app.slack_watch_matches("#").len(), 1);
    }

    #[test]
    fn quiet_hours_hold_back_every_notice_but_a_p0s() {
        let mut quiet = snapshot();
        quiet.quiet = true;
        let mut app = app_with(quiet.clone());
        let notices = app.take_notices();
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Needs reply"], "the P0 gets through; the overdue P2 waits");
        let mut later = quiet.clone();
        later.items[1].reopened_at = Some("2026-10-28T10:30:00Z".into());
        app.tx.send(Incoming::Message(StreamMessage::Slack { snapshot: later })).unwrap();
        app.pump();
        assert!(app.take_notices().is_empty(), "a P1 reopen is held during quiet hours");
        let mut morning = quiet;
        morning.quiet = false;
        morning.items.push(item("C0123:9", "needs_reply", Some("P1"), "2026-10-28T10:00:00Z"));
        app.tx.send(Incoming::Message(StreamMessage::Slack { snapshot: morning })).unwrap();
        app.pump();
        assert_eq!(app.take_notices().iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Needs reply"], "outside the window a P1 entering Needs reply is news again");
    }

    #[test]
    fn t_asks_first_with_the_title_it_will_use_and_w_runs_the_watches() {
        let mut app = app_with(snapshot());
        press(&mut app, KeyCode::Char('S'));
        press(&mut app, KeyCode::Char('t'));
        let Mode::SlackTask { title, repo, .. } = &app.mode else { panic!("the confirm opens: {}", toast(&app)) };
        assert_eq!(title, "approve rollback");
        assert!(repo.is_none(), "no ticket's repo matches the channel");
        press(&mut app, KeyCode::Char('n'));
        assert!(matches!(app.mode, Mode::Normal) && app.slack.is_some());
        let mut linked = app.slack_snapshot.items[0].clone();
        linked.linked.task_id = Some("t1".into());
        app.slack_snapshot.items[0] = linked;
        press(&mut app, KeyCode::Char('t'));
        assert_eq!(toast(&app), "already a ticket");

        press(&mut app, KeyCode::Char('W'));
        assert!(app.slack.as_ref().unwrap().watches.is_some());
        assert_eq!(app.slack_snapshot.watches.len(), 2, "opens on the machine's list");
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.slack.as_ref().unwrap().watches.as_ref().unwrap().cursor, 1);
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(toast(&app), "built-in; switch it off instead");
        assert_eq!(app.slack_snapshot.watches.len(), 2);
        press(&mut app, KeyCode::Char('k'));
        press(&mut app, KeyCode::Char(' '));
        assert_eq!(toast(&app), "off");
        assert!(!app.slack_snapshot.watches[0].enabled, "the machine's answer replaces the row");
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(toast(&app), "removed @platform-team");
        assert_eq!(app.slack_snapshot.watches.len(), 1);

        app.slack_catalog = Some((
            vec![SlackOption { id: "S04ABCD".into(), label: "@platform-team".into() }, SlackOption { id: "S05".into(), label: "@data".into() }],
            vec![SlackOption { id: "C1".into(), label: "#eng".into() }],
        ));
        press(&mut app, KeyCode::Char('n'));
        assert!(matches!(app.mode, Mode::SlackWatchAdd { .. }));
        for ch in "@plat".chars() {
            press(&mut app, KeyCode::Char(ch));
        }
        assert_eq!(app.slack_watch_matches("@plat").iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), vec!["S04ABCD"]);
        assert_eq!(app.slack_watch_matches("#E").iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), vec!["#eng"]);
        assert!(app.slack_watch_matches("luna").is_empty(), "a keyword has nothing to complete");
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal) && app.slack.as_ref().unwrap().watches.is_some(), "esc returns to the Watches");
        press(&mut app, KeyCode::Esc);
        assert!(app.slack.as_ref().unwrap().watches.is_none() && app.slack.is_some(), "esc closes the popup, not the view");
    }

    #[test]
    fn urgent_and_overdue_items_count_on_the_badge_and_raise_a_notice_once_and_a_reopen_always_does() {
        let mut app = app_with(snapshot());
        assert_eq!(app.needs_you_count(), 2, "the P0 in Needs reply and the overdue P2 in Decide; the FYI does not count");
        let notices = app.take_notices();
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Needs reply", "Overdue"]);
        assert_eq!(notices[0].body, "#payments-oncall @marta: approve rollback");

        let mut next = snapshot();
        next.items[1].reopened_at = Some("2026-10-28T10:30:00Z".into());
        next.items.push(item("C0123:9", "decide", Some("P2"), "2026-10-28T10:00:00Z"));
        app.tx.send(Incoming::Message(StreamMessage::Slack { snapshot: next })).unwrap();
        app.pump();
        let notices = app.take_notices();
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Reopened"], "staying put or overdue is not news; a P2 in Decide is not either");
        assert_eq!(app.needs_you_count(), 2);

        let mut late = snapshot();
        late.items[0].overdue = true;
        late.items[2].split = "done".into();
        app.tx.send(Incoming::Message(StreamMessage::Slack { snapshot: late })).unwrap();
        app.pump();
        let notices = app.take_notices();
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Overdue"], "the P0 going past its SLA is news");
        assert_eq!(app.needs_you_count(), 1, "the overdue P0 counts once; the done item no longer does");
    }
}

#[cfg(test)]
mod workspace_key_tests {
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

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
        let mut app = App::new(crate::testkit::dead_machine());
        let task = task(state);
        app.tasks.push(task.clone());
        app.open_detail(task.id);
        app
    }

    #[test]
    fn enter_opens_on_the_section_the_gate_concerns_and_h_l_digits_switch() {
        let app = open("awaiting_approval");
        assert_eq!(app.detail_section, Section::Review);
        let mut app = open("implementing");
        assert_eq!(app.detail_section, Section::Overview);
        press(&mut app, KeyCode::Char('l'));
        assert_eq!(app.detail_section, Section::Plan);
        press(&mut app, KeyCode::Char('h'));
        press(&mut app, KeyCode::Char('h'));
        assert_eq!(app.detail_section, Section::Engines, "h wraps around");
        press(&mut app, KeyCode::Char('4'));
        assert_eq!(app.detail_section, Section::Runs);
        press(&mut app, KeyCode::Char('l'));
        assert_eq!(app.detail_section, Section::Diff);
        assert!(matches!(app.mode, Mode::Detail(_)), "still open");
    }

    #[test]
    fn j_k_pick_a_run_in_runs_and_scroll_elsewhere_and_plus_toggles_the_size() {
        let mut app = open("implementing");
        app.detail = Some(detail_with_runs(&app.tasks[0], 3));
        app.set_section(Section::Runs);
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.detail_cursor, 2, "the cursor stops at the last run");
        assert_eq!(app.detail_scroll.get(), 0, "picking does not scroll");
        press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.detail_cursor, 1);
        app.set_section(Section::Plan);
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

    fn files() -> TaskDiff {
        serde_json::from_str(r#"{"base":"b","head":"h","files":[{"path":"a.rs","status":"M","added":1,"removed":0},{"path":"b.rs","status":"A","added":2,"removed":0}]}"#).unwrap()
    }

    #[test]
    fn a_diff_that_arrives_after_the_branch_moved_is_dropped() {
        let mut app = open("implementing");
        app.online = true;
        press(&mut app, KeyCode::Char('5'));
        // A fetch in flight, set by hand: `ensure_diff` would start a real fetch against the offline
        // machine, whose failed answer can reach the channel before the update below and clear it.
        app.diff_pending = Some((app.tasks[0].id.clone(), None));
        let generation = app.diff_generation;
        // A stage starts while the fetch is in flight: the branch may move, so the answer is stale.
        let mut moved = task("implementing");
        moved.running = true;
        app.tx.send(Incoming::Message(StreamMessage::Updated { task: moved })).unwrap();
        app.pump();
        assert!(app.diff_pending.is_none(), "the reset forgets the fetch in flight");
        assert_ne!(app.diff_generation, generation);
        app.tx.send(Incoming::Diff { id: "abcdef123456".into(), file: None, diff: Ok(files()), generation }).unwrap();
        app.pump();
        assert!(app.diff.is_none(), "the late answer is ignored");
        app.tx.send(Incoming::Diff { id: "abcdef123456".into(), file: None, diff: Ok(files()), generation: app.diff_generation }).unwrap();
        app.pump();
        assert!(app.diff.is_some(), "a fresh answer lands");
    }

    #[test]
    fn capital_j_k_and_the_page_keys_scroll_a_cursor_section_and_equals_is_not_size() {
        let mut app = open("implementing");
        app.detail = Some(detail_with_runs(&app.tasks[0], 3));
        app.set_section(Section::Runs);
        press(&mut app, KeyCode::Char('j'));
        let cursor = app.detail_row();
        press(&mut app, KeyCode::Char('J'));
        assert_eq!(app.detail_scroll.get(), 1, "J scrolls the pane");
        assert_eq!(app.detail_row(), cursor, "without moving the cursor");
        press(&mut app, KeyCode::Char('K'));
        assert_eq!(app.detail_scroll.get(), 0);
        app.detail_viewport.set(20);
        press(&mut app, KeyCode::PageDown);
        assert_eq!(app.detail_scroll.get(), 10, "a page key scrolls half the pane");
        app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL));
        assert_eq!(app.detail_scroll.get(), 20);
        app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        press(&mut app, KeyCode::PageUp);
        assert_eq!(app.detail_scroll.get(), 0);
        press(&mut app, KeyCode::Char('='));
        assert!(!app.detail_full, "= is the board's density key, not the popup's size");
    }

    #[test]
    fn n_at_the_plan_gate_asks_why_before_rejecting_and_refuses_an_empty_comment() {
        let mut app = open("awaiting_approval");
        press(&mut app, KeyCode::Char('N'));
        assert!(matches!(&app.mode, Mode::Reject { text, .. } if text.is_empty()));
        press(&mut app, KeyCode::Enter);
        assert!(matches!(&app.mode, Mode::Reject { .. }), "an empty comment keeps the prompt open");
        assert!(app.toast.as_ref().is_some_and(|t| t.text.contains("say why")), "{:?}", app.toast.as_ref().map(|t| t.text.clone()));
        for c in "no".chars() {
            press(&mut app, KeyCode::Char(c));
        }
        assert!(matches!(&app.mode, Mode::Reject { text, .. } if text == "no"));
        press(&mut app, KeyCode::Backspace);
        assert!(matches!(&app.mode, Mode::Reject { text, .. } if text == "n"));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Detail(_)) || matches!(app.mode, Mode::Normal), "esc cancels");
    }

    fn with_pack(state: &str) -> App {
        let mut app = open(state);
        app.tasks[0].evidence = Some(serde_json::json!({"summary":"s","format":"text","commitSha":"abc1234","risk":"low","scenarios":[],"media":[]}));
        app
    }

    #[test]
    fn lowercase_n_on_a_card_with_a_pack_asks_for_a_note_and_esc_cancels() {
        let mut app = with_pack("implementing");
        press(&mut app, KeyCode::Char('n'));
        assert!(matches!(&app.mode, Mode::EvidenceNote { text, .. } if text.is_empty()));
        for c in "too long".chars() {
            press(&mut app, KeyCode::Char(c));
        }
        assert!(matches!(&app.mode, Mode::EvidenceNote { text, .. } if text == "too long"));
        press(&mut app, KeyCode::Esc);
        assert!(!matches!(app.mode, Mode::EvidenceNote { .. }));
    }

    #[test]
    fn y_and_n_on_a_card_with_no_pack_say_so_and_send_nothing() {
        for key in ['y', 'n'] {
            let mut app = open("implementing");
            press(&mut app, KeyCode::Char(key));
            assert!(!matches!(app.mode, Mode::EvidenceNote { .. }), "{key}");
            assert!(app.toast.as_ref().is_some_and(|t| t.text.contains("no Evidence Pack")), "{key}: {:?}", app.toast.as_ref().map(|t| t.text.clone()));
        }
    }

    #[test]
    fn n_elsewhere_rejects_nothing() {
        for state in ["awaiting_ship", "awaiting_answers", "implementing"] {
            let mut app = open(state);
            press(&mut app, KeyCode::Char('N'));
            assert!(!matches!(app.mode, Mode::Reject { .. }), "{state}");
        }
    }

    #[test]
    fn r_at_the_ship_gate_opens_the_note_prompt_for_a_feature_task_and_not_for_a_review() {
        let mut app = open("awaiting_ship");
        app.tasks[0].waiting_on_you = true;
        press(&mut app, KeyCode::Char('r'));
        assert!(matches!(&app.mode, Mode::Reason { approve: false, text, .. } if text.is_empty()), "{:?}", app.toast.as_ref().map(|t| t.text.clone()));
        let mut review = open("awaiting_ship");
        review.tasks[0].waiting_on_you = true;
        review.tasks[0].route = "review".to_string();
        press(&mut review, KeyCode::Char('r'));
        assert!(!matches!(review.mode, Mode::Reason { .. }), "a review verdict is not sent back");
    }

    #[test]
    fn runs_and_evidence_open_on_their_latest_row() {
        let mut app = open("escalated");
        assert_eq!(app.detail_section, Section::Stopped, "an escalated card opens on why, not on the run table");
        app.set_section(Section::Runs);
        assert_eq!(app.detail_section, Section::Runs);
        app.detail = Some(detail_with_runs(&app.tasks[0], 3));
        assert_eq!(app.detail_row(), 2, "the latest run, not the oldest");
        press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.detail_row(), 1);
        app.set_section(Section::Diff);
        assert_eq!(app.detail_row(), 0, "the Diff starts on the first file");
        app.set_section(Section::Runs);
        assert_eq!(app.detail_row(), 2, "coming back to Runs lands on the latest run again");
    }

    #[test]
    fn the_diff_rows_belong_to_the_open_ticket_only() {
        let mut app = open("implementing");
        press(&mut app, KeyCode::Char('5'));
        app.diff = Some(("someone-else".into(), files()));
        assert_eq!(app.detail_rows(), 0);
        app.diff = Some(("abcdef123456".into(), files()));
        assert_eq!(app.detail_rows(), 2);
    }

    #[test]
    fn o_targets_the_selected_file_the_evidence_folder_or_the_pr_by_section() {
        let mut app = open("implementing");
        assert_eq!(app.detail_open_target(), None, "Overview with no artifacts falls through to the linked issue");
        press(&mut app, KeyCode::Char('5'));
        app.diff = Some(("abcdef123456".into(), files()));
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.detail_open_target(), Some(OpenTarget::Path { path: "/w/b.rs".into(), what: "b.rs".into() }), "the selected file inside the worktree");
        press(&mut app, KeyCode::Char('6'));
        let mut detail = detail_with_runs(&app.tasks[0], 1);
        detail.artifacts = serde_json::from_str(r#"[{"id":"a1","stageRunId":"r1","kind":"log","path":"/out/files/verify.log","label":"verify","sha256":"x","createdAt":"2026-10-22T10:11:00Z"}]"#).unwrap();
        detail.approvals = serde_json::from_str(r#"[{"id":"s1","kind":"awaiting_ship","requested":{"prUrl":"https://github.com/acme/app/pull/9"},"decision":null,"reason":null,"createdAt":"2026-10-22T10:11:00Z","decidedAt":null}]"#).unwrap();
        app.detail = Some(detail);
        assert_eq!(app.detail_open_target(), Some(OpenTarget::EvidenceFolder), "Evidence: the folder, the file is enter's");
        app.set_section(Section::Pr);
        assert_eq!(app.detail_open_target(), Some(OpenTarget::Url("https://github.com/acme/app/pull/9".into())), "the ship gate's URL when the inbox has no row");
        let mut pr: PullRequest = serde_json::from_str(
            r#"{"repo":"acme/app","number":412,"title":"t","url":"https://github.com/acme/app/pull/412","author":"me","mine":true,"reviewRequested":false,
            "isDraft":false,"headRef":"task/abcdef12","baseRef":"main","fromFork":false,"reviewDecision":null,"mergeable":"MERGEABLE",
            "checks":{"state":"none","passed":0,"total":0,"failed":[]},"unresolvedThreads":0,"split":"mine","localPath":null,"task":null,"updatedAt":"2026-10-27T09:00:00Z"}"#,
        )
        .unwrap();
        pr.head_ref = "task/abcdef12".into();
        app.prs.prs.push(pr);
        assert_eq!(app.detail_open_target(), Some(OpenTarget::Url("https://github.com/acme/app/pull/412".into())), "the inbox's PR first");
    }

    #[test]
    fn saving_the_cases_editor_unchanged_patches_nothing_and_keeps_multi_line_approaches() {
        let mut app = open("awaiting_test_check");
        let mut detail = detail_with_runs(&app.tasks[0], 1);
        detail.approvals = serde_json::from_str(
            r#"[{"id":"t1","kind":"awaiting_test_check","requested":{"cases":[{"title":"rejects a bad password","criterion":"c1","approach":"run the suite\n\n  then read the log  "}]},
            "decision":null,"reason":null,"createdAt":"2026-10-22T10:00:00Z","decidedAt":null}]"#,
        )
        .unwrap();
        app.detail = Some(detail);
        app.open_cases_editor("abcdef123456");
        assert!(matches!(app.mode, Mode::EditCases { .. }));
        app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert!(matches!(app.mode, Mode::Detail(_)));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("nothing changed"), "an untouched editor sends no PATCH");
    }
}

#[cfg(test)]
mod edit_route_tests {
    use ratatui::crossterm::event::{KeyCode, KeyEvent};

    use super::*;

    fn task(state: &str) -> Task {
        serde_json::from_str(&format!(
            r#"{{"id":"abcdef123456","title":"Add CSV export","description":"","criteria":["c1"],
            "repoPath":"/r/app","branch":"task/abcdef12","worktreePath":"/w","state":"{state}","column":"Approved",
            "waitingOnYou":true,"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
        ))
        .unwrap()
    }

    fn detail(state: &str) -> TaskDetail {
        let task = serde_json::to_string(&serde_json::json!({
            "id":"abcdef123456","title":"Add CSV export","description":"","criteria":["c1"],"repoPath":"/r/app","branch":"task/abcdef12",
            "worktreePath":"/w","state":state,"column":"Approved","waitingOnYou":true,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"
        }))
        .unwrap();
        serde_json::from_str(&format!(
            r#"{{"task":{task},"stageRuns":[],"approvals":[
              {{"kind":"awaiting_approval","requested":{{"brief":"b","criteria":["c1"]}},"decision":"approved","decidedAt":"2026-10-22T09:58:00Z"}},
              {{"kind":"awaiting_test_check","requested":{{"cases":[{{"title":"t1","criterion":"c1","approach":"run it"}}]}},"decision":null}}],
              "events":[]}}"#
        ))
        .unwrap()
    }

    fn open(state: &str) -> App {
        let mut app = App::new(crate::testkit::dead_machine());
        let task = task(state);
        app.tasks.push(task.clone());
        app.detail = Some(detail(state));
        app.open_detail(task.id);
        app
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    #[test]
    fn e_at_the_test_check_edits_the_cases_from_tests_and_the_plan_from_plan() {
        let mut app = open("awaiting_test_check");
        assert_eq!(app.detail_section, Section::Tests);
        press(&mut app, KeyCode::Char('e'));
        let Mode::EditCases { area, .. } = &app.mode else { panic!("the cases editor opens: {:?}", std::mem::discriminant(&app.mode)) };
        let text = area.lines().join("\n");
        assert!(text.contains("## c1") && text.contains("- t1") && text.contains("  run it"), "{text}");
        press(&mut app, KeyCode::Esc);
        assert!(matches!(&app.mode, Mode::Detail(id) if id == "abcdef123456"), "esc returns to the popup");

        press(&mut app, KeyCode::Char('2'));
        press(&mut app, KeyCode::Char('e'));
        assert!(matches!(app.mode, Mode::EditPlan { .. }), "the approved plan is still editable before Build");

        app.mode = Mode::Detail("abcdef123456".into());
        press(&mut app, KeyCode::Char('1'));
        press(&mut app, KeyCode::Char('e'));
        assert!(matches!(app.mode, Mode::EditTicket { .. }), "Overview edits the ticket's own text");
    }

    #[test]
    fn once_build_started_e_in_plan_falls_back_to_the_ticket_editor() {
        let mut app = open("implementing");
        press(&mut app, KeyCode::Char('2'));
        press(&mut app, KeyCode::Char('e'));
        assert!(matches!(app.mode, Mode::EditTicket { .. }));
    }
}

#[cfg(test)]
mod jira_tests {
    use ratatui::crossterm::event::KeyModifiers;

    use super::slack_tests::fake_machine;
    use super::*;

    /// A ticket in Intake, linked to `key` when given. The fake machine answers `/tasks/:id/jira`
    /// with this, so a link or unlink round-trips through it.
    pub(super) fn linked_task_json(id: &str, key: Option<&str>) -> String {
        let jira = match key {
            Some(key) => format!(
                r#"{{"key":"{key}","url":"https://acme.atlassian.net/browse/{key}","issueType":"Story","status":"To Do","priority":null,"dueAt":null,"syncedAt":null,"blocked":null}}"#
            ),
            None => "null".to_string(),
        };
        format!(
            r#"{{"id":"{id}","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/luna-tui","branch":null,"worktreePath":null,"state":"draft","column":"Intake",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z","jira":{jira},"sla":null}}"#
        )
    }

    fn app_with(tasks: &[Task]) -> App {
        let mut app = App::new(fake_machine());
        app.tasks = tasks.to_vec();
        app.online = true;
        app.toast = None;
        app.take_notices();
        app.clamp_selection();
        app
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    fn type_text(app: &mut App, text: &str) {
        for ch in text.chars() {
            press(app, KeyCode::Char(ch));
        }
    }

    fn toast(app: &App) -> String {
        app.toast.as_ref().map(|t| t.text.clone()).unwrap_or_default()
    }

    fn economy_json() -> Economy {
        serde_json::from_value(serde_json::json!({
            "envelopes": {}, "guard": [{ "action": "gate", "calls": 3, "at": "2026-11-01T00:00:00Z", "runId": "r", "pack": "build" }],
            "cost": { "exec": 1, "overhead": 1, "overheadShare": 0.5, "overheadUnpriced": 0 },
            "facts": [{ "id": "f1", "state": "active", "text": "CI=1" }, { "id": "f2", "state": "promoted", "text": "kept" }],
            "tools": { "build": { "mask": ["WebSearch"], "proposal": [{ "unit": "NotebookEdit", "unusedRuns": 8, "cards": 5 }] } }
        }))
        .unwrap()
    }

    #[test]
    fn the_economy_does_not_open_without_a_card_that_has_a_repository() {
        let mut app = app_with(&[]);
        press(&mut app, KeyCode::Char('$'));
        assert!(app.economy.is_none());
        assert_eq!(toast(&app), "select a card with a repository");
        let mut card = task("t1", None);
        card.repo_path = None;
        let mut app = app_with(&[card]);
        app.toast = None;
        app.run_command("economy");
        assert!(app.economy.is_none());
        assert_eq!(toast(&app), "select a card with a repository");
    }

    #[test]
    fn the_economy_stays_closed_when_the_machine_cannot_answer() {
        let mut card = task("t1", None);
        card.repo_path = Some("/repo".into());
        let mut app = app_with(&[card]);
        app.machine = Machine::at("http://127.0.0.1:9");
        press(&mut app, KeyCode::Char('$'));
        assert!(app.economy.is_none(), "{}", toast(&app));
        assert!(app.toast.as_ref().is_some_and(|t| t.error));
    }

    #[test]
    fn in_the_economy_the_cursor_stays_in_bounds_and_a_key_off_for_the_row_says_why() {
        let mut app = app_with(&[]);
        app.economy_data = economy_json();
        app.economy = Some(EconomyState { repo: "/repo".into(), cursor: 0 });
        assert_eq!(keys::active_scope(&app), keys::Scope::Economy);
        for _ in 0..20 {
            press(&mut app, KeyCode::Char('j'));
        }
        assert_eq!(app.economy.as_ref().unwrap().cursor, 4, "five rows, the last is the loop guard's");
        press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.economy.as_ref().unwrap().cursor, 3);
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(toast(&app), "only a candidate or active fact can be dropped");
        app.economy.as_mut().unwrap().cursor = 0;
        press(&mut app, KeyCode::Char('a'));
        assert_eq!(toast(&app), "only a proposed mask can be approved");
        press(&mut app, KeyCode::Char('r'));
        assert_eq!(toast(&app), "only a masked or proposed tool can be restored");
        press(&mut app, KeyCode::Esc);
        assert!(app.economy.is_none());
    }

    #[test]
    fn the_economy_keys_are_off_with_a_reason_except_on_their_own_rows() {
        let mut app = app_with(&[]);
        app.economy_data = economy_json();
        app.economy = Some(EconomyState { repo: "/repo".into(), cursor: 0 });
        let avail = |app: &App, key: &str| keys::BINDINGS.iter().find(|b| b.scope == keys::Scope::Economy && b.keys == key).map(|b| (b.when)(app)).unwrap();
        assert_eq!(avail(&app, "d"), keys::Avail::On);
        assert!(matches!(avail(&app, "a"), keys::Avail::Off(_)) && matches!(avail(&app, "r"), keys::Avail::Off(_)));
        app.economy.as_mut().unwrap().cursor = 3;
        assert_eq!(avail(&app, "a"), keys::Avail::On);
        assert_eq!(avail(&app, "r"), keys::Avail::On);
        assert!(matches!(avail(&app, "d"), keys::Avail::Off(_)));
    }

    fn task(id: &str, key: Option<&str>) -> Task {
        serde_json::from_str(&linked_task_json(id, key)).unwrap()
    }

    #[test]
    fn j_searches_from_three_characters_enter_links_the_row_and_j_again_asks_before_unlinking() {
        let mut app = app_with(&[task("abcdef123456", None)]);
        press(&mut app, KeyCode::Char('J'));
        assert!(matches!(&app.mode, Mode::JiraLink { id, query, hits, cursor: 0 } if id == "abcdef123456" && query.is_empty() && hits.is_empty()));
        type_text(&mut app, "PL");
        assert!(matches!(&app.mode, Mode::JiraLink { hits, .. } if hits.is_empty()), "two characters: no search yet");
        type_text(&mut app, "A");
        assert!(matches!(&app.mode, Mode::JiraLink { hits, .. } if hits.is_empty()), "the search waits for the typing to pause");
        app.ensure_jira_search();
        assert!(app.jira_search_due.is_some(), "a quarter second has not passed: nothing asked yet");
        app.settle_jira_search();
        let Mode::JiraLink { hits, .. } = &app.mode else { panic!("still in the prompt") };
        assert_eq!(hits.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(), vec!["PLAT-123", "PLAT-7"]);
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Down);
        assert!(matches!(&app.mode, Mode::JiraLink { cursor: 2, .. }), "the cursor stops on the last hit");
        press(&mut app, KeyCode::Up);
        press(&mut app, KeyCode::Enter);
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(app.tasks[0].jira_key(), Some("PLAT-123"), "the machine's answer replaced the task");
        assert_eq!(toast(&app), "linked PLAT-123");

        press(&mut app, KeyCode::Char('J'));
        assert!(matches!(&app.mode, Mode::ConfirmJiraUnlink(id) if id == "abcdef123456"));
        press(&mut app, KeyCode::Char('n'));
        assert!(matches!(app.mode, Mode::Normal) && app.tasks[0].jira.is_some(), "n keeps the link");
        press(&mut app, KeyCode::Char('J'));
        press(&mut app, KeyCode::Char('y'));
        assert!(app.tasks[0].jira.is_none(), "y drops it");
        assert_eq!(toast(&app), "Jira issue unlinked");
    }

    #[test]
    fn a_search_answer_for_an_older_query_is_dropped_and_a_failed_one_shows_in_the_footer() {
        let mut app = app_with(&[task("abcdef123456", None)]);
        press(&mut app, KeyCode::Char('J'));
        type_text(&mut app, "PLAT");
        let hit = |key: &str| JiraIssueHit { key: key.to_string(), summary: String::new(), status: None, issue_type: None, url: String::new() };
        // The answer to "PLA" lands after "PLAT" was typed: stale, dropped.
        app.tx.send(Incoming::JiraHits { query: "PLA".into(), hits: Ok(vec![hit("PLAT-1")]) }).unwrap();
        app.pump();
        assert!(matches!(&app.mode, Mode::JiraLink { hits, .. } if hits.is_empty()));
        app.tx.send(Incoming::JiraHits { query: "PLAT".into(), hits: Ok(vec![hit("PLAT-1"), hit("PLAT-2")]) }).unwrap();
        app.pump();
        assert!(matches!(&app.mode, Mode::JiraLink { hits, .. } if hits.len() == 2));
        app.tx.send(Incoming::JiraHits { query: "PLAT".into(), hits: Err("boom".into()) }).unwrap();
        app.pump();
        assert!(matches!(&app.mode, Mode::JiraLink { hits, .. } if hits.len() == 2), "a failed search keeps the last hits");
        assert_eq!(toast(&app), "jira search: boom");
        press(&mut app, KeyCode::Esc);
        assert!(app.jira_search_due.is_none());
        app.tx.send(Incoming::JiraHits { query: "PLAT".into(), hits: Ok(vec![hit("PLAT-9")]) }).unwrap();
        app.pump();
        assert!(matches!(app.mode, Mode::Normal), "an answer after the prompt closed changes nothing");
    }

    #[test]
    fn the_create_row_ctrl_n_and_the_colon_command_link_without_a_search() {
        let mut app = app_with(&[task("abcdef123456", None)]);
        press(&mut app, KeyCode::Char('J'));
        type_text(&mut app, "zzz");
        app.settle_jira_search();
        let Mode::JiraLink { hits, .. } = &app.mode else { panic!("in the prompt") };
        assert!(hits.is_empty(), "nothing matched");
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.tasks[0].jira_key(), Some("PLAT-900"), "enter on the create row makes an issue");
        assert_eq!(toast(&app), "Jira issue created and linked");

        let mut app = app_with(&[task("abcdef123456", None)]);
        press(&mut app, KeyCode::Char('J'));
        type_text(&mut app, "plat-7");
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.tasks[0].jira_key(), Some("PLAT-7"), "a typed key links as is, upper-cased, without picking a row");

        let mut app = app_with(&[task("abcdef123456", None)]);
        press(&mut app, KeyCode::Char('J'));
        app.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL));
        assert_eq!(app.tasks[0].jira_key(), Some("PLAT-900"));

        let mut app = app_with(&[task("abcdef123456", None)]);
        press(&mut app, KeyCode::Char(':'));
        type_text(&mut app, "jira PLAT-42");
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.tasks[0].jira_key(), Some("PLAT-42"));
        press(&mut app, KeyCode::Char(':'));
        type_text(&mut app, "jira");
        press(&mut app, KeyCode::Enter);
        assert!(matches!(app.mode, Mode::ConfirmJiraUnlink(_)), "bare :jira is J");
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Char(':'));
        type_text(&mut app, "jira not-a-key");
        press(&mut app, KeyCode::Enter);
        assert!(toast(&app).contains("is not a Jira key"), "{}", toast(&app));
        assert_eq!(app.tasks[0].jira_key(), Some("PLAT-42"), "refused before the machine saw it");
    }

    #[test]
    fn a_jira_key_is_a_project_a_dash_and_a_number() {
        for ok in ["PLAT-123", "A1-1", "MY_TEAM-9"] {
            assert!(looks_like_jira_key(ok), "{ok}");
        }
        for bad in ["plat-123", "PLAT", "PLAT-", "-1", "P-1a", "1P-1", "PLAT 123", ""] {
            assert!(!looks_like_jira_key(bad), "{bad}");
        }
    }

    #[test]
    fn an_overdue_gate_sorts_first_in_its_column_and_under_the_needs_you_filter() {
        let mut early: Task = serde_json::from_str(&linked_task_json("aaaaaaaa0000", None)).unwrap();
        early.state = "awaiting_approval".into();
        early.waiting_on_you = true;
        early.created_at = "2026-10-20T00:00:00Z".into();
        let mut late: Task = serde_json::from_str(&crate::model::tests::jira_task_json()).unwrap();
        late.id = "bbbbbbbb0000".into();
        late.state = "awaiting_approval".into();
        late.waiting_on_you = true;
        let mut running: Task = serde_json::from_str(&linked_task_json("cccccccc0000", None)).unwrap();
        running.state = "implementing".into();
        running.running = true;
        running.created_at = "2026-10-19T00:00:00Z".into();
        let app = app_with(&[running, early, late]);
        let ids = |app: &App| app.indices(0).iter().map(|&i| app.tasks[i].id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&app), vec!["bbbbbbbb0000", "aaaaaaaa0000", "cccccccc0000"], "overdue gate, then the gate, then the stage");
        let mut app = app;
        press(&mut app, KeyCode::Char('!'));
        assert_eq!(ids(&app), vec!["bbbbbbbb0000", "aaaaaaaa0000"], "the needs-you filter keeps the overdue first");
        app.tasks[2].sla = None;
        assert_eq!(ids(&app), vec!["aaaaaaaa0000", "bbbbbbbb0000"], "inside the SLA again, age decides and the cache saw the change");
    }

    #[test]
    fn a_gate_going_overdue_is_news_once_and_a_jira_move_is_news_each_time() {
        let mut app = app_with(&[]);
        let fine: Task = serde_json::from_str(&linked_task_json("abcdef123456", Some("PLAT-123"))).unwrap();
        app.tx.send(Incoming::Message(StreamMessage::Updated { task: fine })).unwrap();
        app.pump();
        assert!(app.take_notices().is_empty(), "a linked ticket inside its SLA is quiet");
        assert_eq!((app.needs_you_count(), app.overdue_count()), (0, 0));

        let late: Task = serde_json::from_str(&crate::model::tests::jira_task_json()).unwrap();
        app.tx.send(Incoming::Message(StreamMessage::Updated { task: late.clone() })).unwrap();
        app.pump();
        let notices = app.take_notices();
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Gate overdue"]);
        assert_eq!(notices[0].body, "#abcdef12 Login page: intake waited past 1h", "the fixture has no repo, so no repo prefix");
        assert_eq!(app.overdue_count(), 1, "the header's bang counts it");
        assert_eq!(app.needs_you_count(), 0, "a draft is not waiting on you: the badge count stays the needs-you count");
        assert_eq!(notify::badge_label(app.needs_you_count(), app.overdue_count()), "Board ‼1");
        app.tx.send(Incoming::Message(StreamMessage::Updated { task: late })).unwrap();
        app.pump();
        assert!(app.take_notices().is_empty(), "still overdue: not twice");

        let moved: crate::model::TaskEvent = serde_json::from_str(r#"{"taskId":"abcdef123456","kind":"jira.moved","payload":{"status":"Done"},"at":"2026-10-28T10:30:00Z"}"#).unwrap();
        app.tx.send(Incoming::Message(StreamMessage::Event { event: moved })).unwrap();
        app.pump();
        let notices = app.take_notices();
        assert_eq!(notices.len(), 1);
        assert_eq!((notices[0].title.as_str(), notices[0].body.as_str()), ("Jira", "PLAT-123 moved to Done while #abcdef12 waits"));
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use crate::model::tests::task_json;

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    fn toast(app: &App) -> String {
        app.toast.as_ref().map(|t| t.text.clone()).unwrap_or_default()
    }

    #[test]
    fn e_in_the_engines_section_picks_skips_what_cannot_run_and_says_why_the_machine_refused() {
        let mut app = App::new(super::slack_tests::fake_machine());
        let mut task: Task = serde_json::from_str(&task_json("")).unwrap();
        task.stages.insert("triage".into(), "claude:opus".into());
        app.tasks.push(task);
        app.open_detail("abcdef123456".into());
        press(&mut app, KeyCode::Char('E'));
        assert!(toast(&app).contains("Engines section"), "{}", toast(&app));
        press(&mut app, KeyCode::Char('9'));
        assert_eq!(app.detail_section, Section::Engines);
        press(&mut app, KeyCode::Char('E'));
        assert!(matches!(&app.mode, Mode::EnginePicker { pack, cursor: 0, .. } if pack == "triage"));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('j'));
        assert!(matches!(app.mode, Mode::EnginePicker { cursor: 1, .. }), "codex:sol has no credential here, so j stops on claude:opus");
        press(&mut app, KeyCode::Enter);
        assert!(matches!(app.mode, Mode::Detail(_)));
        assert_eq!(toast(&app), "claude:opus is not allowed for triage", "a 400 shows the machine's words");
        press(&mut app, KeyCode::Char('E'));
        press(&mut app, KeyCode::Enter);
        assert_eq!(toast(&app), "triage back on its default engine");
        assert!(app.task("abcdef123456").unwrap().stages.is_empty(), "the ticket the machine answered replaces ours");
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('E'));
        press(&mut app, KeyCode::Enter);
        assert_eq!(toast(&app), "test_design already ran on this ticket; its engine stays");
        press(&mut app, KeyCode::Char('E'));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Detail(_)), "esc goes back to the popup");
    }
}

/// `T` on a ticket: the picker over its record, starting from what the record says; why not when there is none or it is not at a gate.
pub fn record_edit_mode(task: &Task) -> Result<Mode, &'static str> {
    let Some(record) = task.record.as_ref() else { return Err("triage has not written a record for this ticket yet") };
    if !matches!(task.state.as_str(), "awaiting_answers" | "awaiting_approval") {
        return Err("the record is corrected at triage's questions or the plan gate");
    }
    let mut picks = [0usize; 5];
    for (i, (key, _, values)) in RECORD_FIELDS.iter().enumerate() {
        picks[i] = record.value_of(key).and_then(|v| values.iter().position(|x| *x == v)).unwrap_or(0);
    }
    Ok(Mode::RecordEdit { id: task.id.clone(), field: 0, picks })
}

/// The fields the picker moved off the record's own value, as `(key, value)` pairs.
pub fn record_changes(record: &TriageRecord, picks: &[usize; 5]) -> Vec<(String, String)> {
    RECORD_FIELDS
        .iter()
        .enumerate()
        .filter_map(|(i, (key, _, values))| {
            let value = values[picks[i]];
            (record.value_of(key) != Some(value)).then(|| (key.to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod task_view_command_tests {
    use super::confirm_tests::{posts, recording_machine};
    use super::*;
    use crate::testkit::{plan_gate_app, running_build_app};

    /// The open Build card with a second card beside it in the same column, and a machine that records what is sent.
    fn two_cards() -> (App, String, String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let mut app = running_build_app();
        let mut other = app.tasks[0].clone();
        other.id = "bbbbbbbb9999".into();
        other.title = "Another build".into();
        let (open, other_id) = (app.tasks[0].id.clone(), other.id.clone());
        app.tasks.push(other);
        let (machine, seen) = recording_machine();
        app.machine = machine;
        (app, open, other_id, seen)
    }

    fn command(app: &mut App, line: &str) {
        press(app, KeyCode::Char(':'));
        type_text(app, line);
        press(app, KeyCode::Enter);
    }

    #[test]
    fn a_command_typed_in_the_task_names_the_open_card_when_a_filter_hides_it() {
        let (mut app, open, _, seen) = two_cards();
        app.filter = "Another".into();
        app.select("bbbbbbbb9999", true);
        app.clamp_selection();
        assert_eq!(app.selected_id().as_deref(), Some("bbbbbbbb9999"), "the board shows only the other card");
        command(&mut app, "whole");
        let sent = posts(&seen);
        assert!(!sent.is_empty() && sent.iter().all(|p| p.starts_with(&format!("/tasks/{open}/"))), "{sent:?}");
        assert!(matches!(&app.mode, Mode::Detail(id) if *id == open));
    }

    #[test]
    fn a_wheel_notch_over_the_palette_does_not_move_the_card_a_command_acts_on() {
        let (mut app, open, _, seen) = two_cards();
        press(&mut app, KeyCode::Char(':'));
        app.scroll(1);
        type_text(&mut app, "whole");
        press(&mut app, KeyCode::Enter);
        let sent = posts(&seen);
        assert!(!sent.is_empty() && sent.iter().all(|p| p.starts_with(&format!("/tasks/{open}/"))), "{sent:?}");
    }

    #[test]
    fn every_card_command_in_the_task_goes_to_the_open_card() {
        let (_, open, other, _) = two_cards();
        for line in ["whole", "dismiss F1", "finding nit rename x", "dup bbbbbbbb9", "undup", "context text hello", "jira PLAT-1"] {
            let (mut app, _, _, seen) = two_cards();
            app.filter = "Another".into();
            app.select("bbbbbbbb9999", true);
            app.clamp_selection();
            if line == "undup" {
                app.tasks[0].merged_into = Some(other.clone());
            }
            command(&mut app, line);
            let sent = posts(&seen);
            assert!(sent.iter().all(|p| !p.contains(&other)), ":{line} reached the other card: {sent:?}");
            assert!(!sent.is_empty(), ":{line} sent nothing (toast {:?})", app.toast.as_ref().map(|t| &t.text));
            assert!(sent.iter().all(|p| p.contains(&open)), ":{line}: {sent:?}");
        }
    }

    #[test]
    fn capital_u_and_m_in_the_task_act_on_the_open_card_too() {
        let (mut app, open, other, seen) = two_cards();
        app.filter = "Another".into();
        app.select("bbbbbbbb9999", true);
        app.clamp_selection();
        app.tasks[0].merged_into = Some(other.clone());
        press(&mut app, KeyCode::Char('U'));
        let sent = posts(&seen);
        assert!(!sent.is_empty() && sent.iter().all(|p| p.contains(&open)), "{sent:?}");
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    fn type_text(app: &mut App, text: &str) {
        for ch in text.chars() {
            press(app, KeyCode::Char(ch));
        }
    }

    #[test]
    fn colon_in_the_task_view_opens_the_palette_over_the_card_and_esc_returns_to_it() {
        let mut app = plan_gate_app();
        let id = app.tasks[0].id.clone();
        press(&mut app, KeyCode::Char(':'));
        assert!(matches!(&app.mode, Mode::Command { text, .. } if text.is_empty()));
        let screen = crate::testkit::render(&mut app, 120, 40);
        assert!(screen.contains(crate::testkit::PLAN_GATE_TITLE), "the task view stays under the prompt:\n{screen}");
        press(&mut app, KeyCode::Esc);
        assert!(matches!(&app.mode, Mode::Detail(open) if *open == id));
    }

    #[test]
    fn every_command_a_section_names_runs_in_the_task_view_and_leaves_it_open() {
        for name in ["whole", "dedup", "context", "dismiss", "finding"] {
            let mut app = running_build_app();
            let id = app.tasks[0].id.clone();
            press(&mut app, KeyCode::Char(':'));
            type_text(&mut app, name);
            press(&mut app, KeyCode::Enter);
            assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), ":{name} left the task view");
            assert!(app.toast.as_ref().is_none_or(|t| !t.text.contains("unknown command")), ":{name} is not a command here: {:?}", app.toast.as_ref().map(|t| &t.text));
            assert_eq!(app.selected_id().as_deref(), Some(id.as_str()), ":{name} acts on the open card");
        }
    }

    #[test]
    fn a_command_that_opens_a_view_leaves_the_task_view_as_on_the_board() {
        let mut app = plan_gate_app();
        press(&mut app, KeyCode::Char(':'));
        type_text(&mut app, "inbox");
        press(&mut app, KeyCode::Enter);
        assert!(app.inbox.is_some() && matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn a_view_opened_from_a_task_that_was_opened_from_another_view_leaves_only_one() {
        let mut app = plan_gate_app();
        app.mode = Mode::Normal;
        app.inbox = Some(crate::inbox::InboxState::default());
        press(&mut app, KeyCode::Enter);
        assert!(matches!(app.mode, Mode::Detail(_)) && app.inbox.is_some(), "the task opened over the Inbox, which waits under it");
        command(&mut app, "digest");
        assert!(app.inbox.is_none() && app.digest.is_some(), "opening the Digest closed the Inbox");
        assert_eq!(app.active_view(), Some(View::Digest));
        assert_eq!(keys::active_scope(&app), keys::Scope::Digest);
        let screen = crate::testkit::render(&mut app, 120, 30);
        assert!(screen.contains("Digest · since"), "the view on screen is the Digest:\n{screen}");
        press(&mut app, KeyCode::Char('A'));
        assert!(!matches!(app.mode, Mode::ConfirmApproveAll(_)), "A reached the hidden Inbox");
    }

    #[test]
    fn opening_any_view_closes_the_others_and_draw_and_keys_agree_on_the_one_left() {
        let opens: [(&str, View); 4] = [("floor", View::Floor), ("inbox", View::Inbox), ("digest", View::Digest), ("tickets", View::Tickets)];
        for (first, _) in opens {
            for (second, view) in opens {
                let mut app = plan_gate_app();
                app.mode = Mode::Normal;
                command(&mut app, first);
                let id = app.tasks[0].id.clone();
                app.open_detail(id);
                command(&mut app, second);
                let open = [app.floor.is_some(), app.inbox.is_some(), app.digest.is_some(), app.tickets.is_some()].iter().filter(|o| **o).count();
                assert_eq!(open, 1, "{first} then {second}");
                assert_eq!(app.active_view(), Some(view), "{first} then {second}");
            }
        }
    }

    #[test]
    fn the_open_page_follows_a_card_whose_state_took_it_out_of_the_rail() {
        let mut app = plan_gate_app();
        assert_eq!(app.detail_section, Section::Review);
        let mut moved = app.tasks[0].clone();
        moved.state = "implementing".into();
        moved.column = "Build".into();
        moved.waiting_on_you = false;
        moved.running = true;
        app.upsert(moved);
        assert_eq!(app.detail_section, Section::Now, "the card's first page now");
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("the card moved to Build"));
        let (shown, later) = app.detail_rail();
        assert!(shown.iter().chain(&later).any(|s| *s == app.detail_section), "the rail has an active row");
    }

    #[test]
    fn a_page_that_still_exists_stays_when_the_card_changes() {
        let mut app = plan_gate_app();
        app.set_section(Section::Overview);
        let mut changed = app.tasks[0].clone();
        changed.title = "A new title".into();
        app.toast = None;
        app.upsert(changed);
        assert_eq!(app.detail_section, Section::Overview);
        assert!(app.toast.is_none());
    }

    #[test]
    fn the_digit_the_rail_shows_is_the_digit_that_works() {
        for mut app in [plan_gate_app(), running_build_app()] {
            let (shown, later) = app.detail_rail();
            let screen = crate::testkit::render(&mut app, 140, 40);
            for (i, section) in shown.iter().enumerate().take(9) {
                assert!(screen.contains(&format!("{} {}", i + 1, section.label())), "{} is numbered {}:\n{screen}", section.label(), i + 1);
                press(&mut app, KeyCode::Char(char::from_digit(i as u32 + 1, 10).unwrap()));
                assert_eq!(app.detail_section, *section, "digit {} goes where the rail says", i + 1);
            }
            for section in later {
                assert!(!(1..=9).any(|d| screen.contains(&format!("{d} {}", section.label()))), "{} sits under later and has no digit", section.label());
            }
        }
    }

    #[test]
    fn the_engines_hint_names_the_digit_the_rail_gives() {
        let mut app = plan_gate_app();
        press(&mut app, KeyCode::Char('E'));
        let (order, _) = app.detail_rail();
        let text = app.toast.as_ref().map(|t| t.text.clone()).unwrap_or_default();
        match order.iter().position(|s| *s == Section::Engines).filter(|i| *i < 9) {
            Some(i) => assert!(text.contains(&format!("Engines section ({})", i + 1)), "{text}"),
            None => assert!(text.contains("Engines section (h/l)"), "{text}"),
        }
    }

    #[test]
    fn the_registry_offers_the_colon_in_the_task_view_and_the_footer_shows_it() {
        let app = plan_gate_app();
        assert!(keys::footer_keys(&app, keys::Scope::Detail, 20).iter().any(|b| b.first() == ":"));
        assert!(keys::detail_footer(&app).iter().any(|(k, l)| k == ":" && l == "command"));
    }
}

#[cfg(test)]
mod task_view_return_tests {
    use super::*;
    use crate::testkit::{ESCALATED_TITLE, PLAN_GATE_TITLE, RUNNING_BUILD_TITLE, SHIP_STAGE_TITLE, escalated_app, plan_gate_app, questions_app, render, running_build_app, ship_stage_app};

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    /// One prompt, editor or picker reachable from the task view: the card, how to open it, what it
    /// opens, the keys that confirm it, and the words its title shows.
    struct Case {
        name: &'static str,
        app: App,
        title: &'static str,
        open: Vec<KeyCode>,
        is_open: fn(&Mode) -> bool,
        confirm: Vec<KeyEvent>,
    }

    fn keys_of(text: &str) -> Vec<KeyEvent> {
        text.chars().map(|c| KeyEvent::from(KeyCode::Char(c))).collect()
    }

    fn cases() -> Vec<Case> {
        let enter = || KeyEvent::from(KeyCode::Enter);
        let save = || KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL);
        let mut with_record = plan_gate_app();
        with_record.tasks[0].record = Some(crate::model::TriageRecord::default());
        let mut cases_gate = plan_gate_app();
        if let Some(detail) = cases_gate.detail.as_mut() {
            for approval in detail.approvals.iter_mut().filter(|a| a.kind.as_deref() == Some("awaiting_test_check")) {
                approval.decision = None;
            }
        }
        vec![
            Case { name: "send back", app: plan_gate_app(), title: PLAN_GATE_TITLE, open: vec![KeyCode::Char('r')], is_open: |m| matches!(m, Mode::Reason { approve: false, .. }), confirm: [keys_of("too wide"), vec![enter()]].concat() },
            Case { name: "reject", app: plan_gate_app(), title: PLAN_GATE_TITLE, open: vec![KeyCode::Char('N')], is_open: |m| matches!(m, Mode::Reject { .. }), confirm: [keys_of("no"), vec![enter()]].concat() },
            Case { name: "escalation guidance", app: escalated_app(), title: ESCALATED_TITLE, open: vec![KeyCode::Char('a')], is_open: |m| matches!(m, Mode::Reason { approve: true, .. }), confirm: vec![enter()] },
            Case { name: "evidence note", app: ship_stage_app(), title: SHIP_STAGE_TITLE, open: vec![KeyCode::Char('n')], is_open: |m| matches!(m, Mode::EvidenceNote { .. }), confirm: vec![enter()] },
            Case { name: "plan editor", app: plan_gate_app(), title: PLAN_GATE_TITLE, open: vec![KeyCode::Char('e')], is_open: |m| matches!(m, Mode::EditPlan { .. }), confirm: vec![save()] },
            Case { name: "cases editor", app: cases_gate, title: PLAN_GATE_TITLE, open: vec![KeyCode::Char('e'), KeyCode::Char('c')], is_open: |m| matches!(m, Mode::EditCases { .. }), confirm: vec![save()] },
            Case { name: "ticket editor", app: running_build_app(), title: RUNNING_BUILD_TITLE, open: vec![KeyCode::Char('e')], is_open: |m| matches!(m, Mode::EditTicket { .. }), confirm: vec![save()] },
            Case { name: "answers editor", app: questions_app(), title: "Fix the invoice rounding", open: vec![KeyCode::Char('a')], is_open: |m| matches!(m, Mode::Answer { .. }), confirm: vec![save()] },
            Case { name: "archive reason", app: plan_gate_app(), title: PLAN_GATE_TITLE, open: vec![KeyCode::Char('Z')], is_open: |m| matches!(m, Mode::ArchiveReason { .. }), confirm: vec![enter()] },
            Case { name: "escalation reason", app: escalated_app(), title: ESCALATED_TITLE, open: vec![KeyCode::Char('C')], is_open: |m| matches!(m, Mode::EscalationReason { .. }), confirm: vec![enter()] },
            Case { name: "record picker", app: with_record, title: PLAN_GATE_TITLE, open: vec![KeyCode::Char('T')], is_open: |m| matches!(m, Mode::RecordEdit { .. }), confirm: vec![enter()] },
            Case { name: "delete", app: plan_gate_app(), title: PLAN_GATE_TITLE, open: vec![KeyCode::Char('d')], is_open: |m| matches!(m, Mode::ConfirmDelete(_)), confirm: keys_of("y") },
            Case { name: "abort", app: running_build_app(), title: RUNNING_BUILD_TITLE, open: vec![KeyCode::Char('X')], is_open: |m| matches!(m, Mode::ConfirmAbort(_)), confirm: keys_of("y") },
            Case { name: "kill the worktree", app: ship_stage_app(), title: SHIP_STAGE_TITLE, open: vec![KeyCode::Char('w')], is_open: |m| matches!(m, Mode::ConfirmWorktree(_)), confirm: keys_of("y") },
        ]
    }

    #[test]
    fn every_prompt_editor_and_picker_keeps_the_card_on_screen_when_it_opens() {
        for mut case in cases() {
            for key in case.open.clone() {
                press(&mut case.app, key);
            }
            assert!((case.is_open)(&case.app.mode), "{}: did not open", case.name);
            let screen = render(&mut case.app, 140, 40);
            assert!(screen.contains(case.title), "{}: the card's title left the screen:\n{screen}", case.name);
        }
    }

    fn plan_gate_with_cases_waiting() -> App {
        let mut app = plan_gate_app();
        if let Some(detail) = app.detail.as_mut() {
            for approval in detail.approvals.iter_mut().filter(|a| a.kind.as_deref() == Some("awaiting_test_check")) {
                approval.decision = None;
            }
        }
        app
    }

    #[test]
    fn e_on_the_review_page_asks_what_to_edit_and_names_the_three_things() {
        let mut app = plan_gate_with_cases_waiting();
        assert_eq!(app.detail_section, Section::Review);
        press(&mut app, KeyCode::Char('e'));
        assert!(matches!(app.mode, Mode::EditChoice(_)), "e asks first");
        let screen = render(&mut app, 140, 40);
        for needle in ["edit", "p  the plan", "c  the cases", "t  the ticket", PLAN_GATE_TITLE] {
            assert!(screen.contains(needle), "{needle} missing in\n{screen}");
        }
    }

    #[test]
    fn the_chooser_reaches_each_editor_by_its_key_and_esc_returns_to_the_task() {
        for (key, is_open) in [('p', (|m: &Mode| matches!(m, Mode::EditPlan { .. })) as fn(&Mode) -> bool), ('c', |m| matches!(m, Mode::EditCases { .. })), ('t', |m| matches!(m, Mode::EditTicket { .. }))] {
            let mut app = plan_gate_with_cases_waiting();
            press(&mut app, KeyCode::Char('e'));
            press(&mut app, KeyCode::Char(key));
            assert!(is_open(&app.mode), "{key} did not open its editor");
        }
        let mut app = plan_gate_with_cases_waiting();
        let id = app.tasks[0].id.clone();
        press(&mut app, KeyCode::Char('e'));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "esc returns to the task");
    }

    #[test]
    fn closing_any_of_them_with_esc_returns_to_the_same_card_section_and_scroll() {
        for mut case in cases() {
            let id = case.app.tasks[0].id.clone();
            let section = case.app.detail_section;
            case.app.detail_scroll.set(2);
            for key in case.open.clone() {
                press(&mut case.app, key);
            }
            assert!((case.is_open)(&case.app.mode), "{}: did not open", case.name);
            press(&mut case.app, KeyCode::Esc);
            assert!(matches!(&case.app.mode, Mode::Detail(open) if *open == id), "{}: esc ended in another mode", case.name);
            assert_eq!(case.app.detail_section, section, "{}: the section moved", case.name);
            assert_eq!(case.app.detail_scroll.get(), 2, "{}: the scroll moved", case.name);
        }
    }

    #[test]
    fn confirming_any_of_them_returns_to_the_same_card_section_and_scroll() {
        for mut case in cases() {
            let id = case.app.tasks[0].id.clone();
            let section = case.app.detail_section;
            case.app.detail_scroll.set(2);
            for key in case.open.clone() {
                press(&mut case.app, key);
            }
            assert!((case.is_open)(&case.app.mode), "{}: did not open", case.name);
            for key in case.confirm.clone() {
                case.app.handle_key(key);
            }
            // Delete and the like are refused by the unreachable machine; the card is still there.
            assert!(matches!(&case.app.mode, Mode::Detail(open) if *open == id), "{}: confirming ended in another mode", case.name);
            assert_eq!(case.app.detail_section, section, "{}: the section moved", case.name);
            assert_eq!(case.app.detail_scroll.get(), 2, "{}: the scroll moved", case.name);
        }
    }

    #[test]
    fn a_card_that_is_gone_after_the_action_returns_to_the_board() {
        let mut app = plan_gate_app();
        press(&mut app, KeyCode::Char('d'));
        app.tasks.clear();
        press(&mut app, KeyCode::Char('y'));
        assert!(matches!(app.mode, Mode::Normal), "nothing to return to");
        assert!(app.return_to.is_none(), "the way back is forgotten");
    }

    #[test]
    fn a_prompt_opened_on_the_board_returns_to_the_board() {
        let mut app = plan_gate_app();
        app.mode = Mode::Normal;
        app.select("aaaaaaaa1111", true);
        press(&mut app, KeyCode::Char('r'));
        assert!(matches!(app.mode, Mode::Reason { .. }));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal), "the board, not a task view");
    }

    #[test]
    fn the_send_back_prompt_is_a_box_over_the_task_not_a_footer_line() {
        let mut app = plan_gate_app();
        press(&mut app, KeyCode::Char('r'));
        let screen = render(&mut app, 140, 40);
        assert!(screen.contains("send back #aaaaaaaa — why?"), "{screen}");
        assert!(!screen.contains("send back because:"), "no footer prompt:\n{screen}");
        assert!(screen.contains(PLAN_GATE_TITLE));
    }
}

#[cfg(test)]
mod view_stack_tests {
    use super::*;
    use crate::model::{PrSnapshot, SlackSnapshot};
    use crate::slack::fixtures::item_json;
    use crate::testkit::{plan_gate_app, task_json};

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    /// Three cards at a gate, so every view has rows to move over; the board is showing.
    fn board_of_three() -> App {
        let mut app = plan_gate_app();
        for (n, id) in ["bbbbbbbb2222", "cccccccc3333"].into_iter().enumerate() {
            let json = task_json(id, &format!("Second card {n}"), "awaiting_approval", "Plan", serde_json::json!({"waitingOnYou": true, "updatedAt": format!("2026-10-22T1{}:00:00.000Z", n + 1)}));
            app.tasks.push(serde_json::from_value(json).unwrap());
        }
        app.mode = Mode::Normal;
        app.last_seen_secs = None;
        app
    }

    fn pr_json(number: u64, task: &str) -> String {
        format!(
            r#"{{"repo":"acme/app","number":{number},"title":"PR {number}","url":"https://github.com/acme/app/pull/{number}","author":"me","mine":true,"reviewRequested":false,"isDraft":false,
            "headRef":"feat/{number}","baseRef":"main","fromFork":false,"reviewDecision":null,"mergeable":"MERGEABLE","checks":{{"state":"none","passed":0,"total":0,"failed":[]}},
            "unresolvedThreads":0,"split":"ready_to_merge","localPath":"/r/app","task":{{"id":"{task}","state":"awaiting_approval","route":"feature"}},"updatedAt":"2026-10-27T0{number}:00:00Z"}}"#
        )
    }

    /// Opens each view with its cursor on the second row.
    fn open_view(app: &mut App, view: &str) {
        match view {
            "inbox" => app.inbox = Some(InboxState { cursor: 1, ..InboxState::default() }),
            "digest" => app.digest = Some(DigestState { cursor: 1 }),
            "pulls" => {
                let prs = ["aaaaaaaa1111", "bbbbbbbb2222", "cccccccc3333"].iter().enumerate().map(|(n, t)| serde_json::from_str(&pr_json(n as u64 + 1, t)).unwrap()).collect();
                app.prs = PrSnapshot { prs, polled_at: None, error: None };
                app.pulls = Some(PullsState { split: crate::pulls::PrSplit::ReadyToMerge, cursor: 1 });
            }
            "slack" => {
                let items = ["aaaaaaaa1111", "bbbbbbbb2222", "cccccccc3333"]
                    .iter()
                    .enumerate()
                    .map(|(n, t)| {
                        let mut item: SlackItem = serde_json::from_str(&item_json(&format!("C0123:{n}"), "needs_reply", Some("P1"), &format!("2026-10-28T09:0{n}:00Z"))).unwrap();
                        item.linked.task_id = Some((*t).to_string());
                        item
                    })
                    .collect();
                app.slack_snapshot = SlackSnapshot { items, ..SlackSnapshot::default() };
                app.slack = Some(SlackState { cursor: 1, ..SlackState::default() });
            }
            other => panic!("no view {other}"),
        }
    }

    fn cursor_of(app: &App, view: &str) -> usize {
        match view {
            "inbox" => app.inbox.as_ref().map(|s| s.cursor),
            "digest" => app.digest.as_ref().map(|s| s.cursor),
            "pulls" => app.pulls.as_ref().map(|s| s.cursor),
            _ => app.slack.as_ref().map(|s| s.cursor),
        }
        .expect("the view is showing")
    }

    fn showing(app: &App, view: &str) -> bool {
        match view {
            "inbox" => app.inbox.is_some(),
            "digest" => app.digest.is_some(),
            "pulls" => app.pulls.is_some(),
            _ => app.slack.is_some(),
        }
    }

    #[test]
    fn esc_in_a_task_opened_from_a_view_returns_to_the_view_with_its_cursor() {
        for view in ["inbox", "digest", "pulls", "slack"] {
            let mut app = board_of_three();
            open_view(&mut app, view);
            let under = app.focus_task().map(|t| t.id.clone());
            press(&mut app, KeyCode::Enter);
            let opened = match &app.mode {
                Mode::Detail(id) => id.clone(),
                other => panic!("{view}: enter did not open a task ({})", if matches!(other, Mode::Normal) { "board" } else { "another mode" }),
            };
            if let Some(under) = under {
                assert_eq!(opened, under, "{view}: opened the row under the cursor");
            }
            assert!(showing(&app, view), "{view}: the view stays open under the task");
            let title = app.task(&opened).map(|t| t.title.clone()).unwrap_or_default();
            assert!(crate::testkit::render(&mut app, 140, 40).contains(&title), "{view}: the task is drawn");
            press(&mut app, KeyCode::Esc);
            assert!(matches!(app.mode, Mode::Normal) && showing(&app, view), "{view}: esc in the task returns to the view");
            assert_eq!(cursor_of(&app, view), 1, "{view}: the cursor is where it was");
            press(&mut app, KeyCode::Esc);
            assert!(!showing(&app, view) && matches!(app.mode, Mode::Normal), "{view}: esc in the view returns to the board");
        }
    }

    #[test]
    fn q_in_a_task_opened_from_a_view_also_returns_to_the_view() {
        let mut app = board_of_three();
        open_view(&mut app, "inbox");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('q'));
        assert!(app.inbox.is_some() && matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn esc_on_the_board_with_nothing_open_does_nothing() {
        let mut app = board_of_three();
        let before = (app.focus, app.selection);
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal));
        assert!(app.inbox.is_none() && app.digest.is_none() && app.pulls.is_none() && app.slack.is_none());
        assert_eq!((app.focus, app.selection), before);
    }

    #[test]
    fn a_task_opened_from_the_board_returns_to_the_board() {
        let mut app = board_of_three();
        app.select("aaaaaaaa1111", true);
        press(&mut app, KeyCode::Enter);
        assert!(matches!(app.mode, Mode::Detail(_)));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn the_view_under_a_task_keeps_its_split() {
        let mut app = board_of_three();
        app.inbox = Some(InboxState { split: crate::inbox::Split::All, cursor: 2 });
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Esc);
        let state = app.inbox.as_ref().expect("the inbox is back");
        assert_eq!((state.split, state.cursor), (crate::inbox::Split::All, 2));
    }
}

#[cfg(test)]
mod confirm_tests {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    use super::*;
    use crate::testkit::{open_card, plan_gate_app, release_question_app, render, running_build_app, ship_stage_app, task_json};

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::from(code));
    }

    /// A machine that answers `{}` to everything and records each POST's path: how a test sees that a
    /// request was (or was not) sent.
    pub(super) fn recording_machine() -> (Machine, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let posts = Arc::new(Mutex::new(Vec::new()));
        let seen = posts.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut request = String::new();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                    request.push_str(&line);
                }
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                let mut parts = request.split_whitespace();
                if let (Some("POST"), Some(path)) = (parts.next(), parts.next()) {
                    seen.lock().unwrap().push(path.to_string());
                }
                let mut stream = reader.into_inner();
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
            }
        });
        (Machine::at(&format!("http://{addr}")), posts)
    }

    pub(super) fn posts(seen: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        seen.lock().unwrap().clone()
    }

    fn at_split_gate() -> App {
        let task = task_json("aaaaaaaa7777", "Split the export work", "awaiting_approval", "Plan", serde_json::json!({"waitingOnYou": true}));
        open_card(task, serde_json::json!({"approvals": [{"id": "p1", "kind": "awaiting_approval", "decision": null, "createdAt": "2026-10-22T09:50:00Z", "requested": {"outcome": "split", "brief": "b"}}]}))
    }

    fn at_memory_review() -> App {
        let task = task_json("aaaaaaaa8888", "Retro for the export", "reviewing_memory", "Ship", serde_json::json!({"waitingOnYou": true}));
        open_card(task, serde_json::json!({}))
    }

    /// Every gate that commits something: the card, its decision path and what the box asks.
    fn gates() -> Vec<(&'static str, App, &'static str)> {
        vec![
            ("plan", plan_gate_app(), "approve the plan of #aaaaaaaa?"),
            ("split", at_split_gate(), "approve the split of #aaaaaaaa?"),
            ("ship", ship_stage_app(), "ship #dddddddd?"),
            ("release", release_question_app(), "approve the release of #ffffffff?"),
            ("memory", at_memory_review(), "approve the retro's rules of #aaaaaaaa?"),
        ]
    }

    #[test]
    fn approving_at_a_gate_asks_once_naming_the_action_and_the_card() {
        for (name, mut app, question) in gates() {
            press(&mut app, KeyCode::Char('a'));
            assert!(matches!(app.mode, Mode::ConfirmApprove(_)), "{name}: a asks first");
            let screen = render(&mut app, 140, 40);
            assert!(screen.contains(question), "{name}: the box asks {question:?}:\n{screen}");
            assert!(screen.contains(" y  yes") && screen.contains(" n  no"), "{name}: the answers show:\n{screen}");
            assert!(screen.contains(&app.tasks[0].title), "{name}: the card stays on screen");
        }
    }

    #[test]
    fn n_and_esc_cancel_back_to_the_task_and_send_nothing() {
        for (name, mut app, _) in gates() {
            let (machine, seen) = recording_machine();
            app.machine = machine;
            let id = app.tasks[0].id.clone();
            for cancel in [KeyCode::Char('n'), KeyCode::Esc] {
                press(&mut app, KeyCode::Char('a'));
                press(&mut app, cancel);
                assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "{name}: back on the task");
            }
            assert!(posts(&seen).is_empty(), "{name}: nothing was sent: {:?}", posts(&seen));
        }
    }

    #[test]
    fn y_and_enter_approve_and_return_to_the_task() {
        for (name, mut app, _) in gates() {
            let (machine, seen) = recording_machine();
            app.machine = machine;
            let id = app.tasks[0].id.clone();
            press(&mut app, KeyCode::Char('a'));
            assert!(posts(&seen).is_empty(), "{name}: asking sends nothing");
            press(&mut app, KeyCode::Char('y'));
            assert_eq!(posts(&seen), vec![format!("/tasks/{id}/decision")], "{name}: y sends the decision");
            assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "{name}: back on the task");
            press(&mut app, KeyCode::Char('a'));
            press(&mut app, KeyCode::Enter);
            assert_eq!(posts(&seen).len(), 2, "{name}: enter confirms too");
        }
    }

    /// The board with marked cards: two plans, a ship, and a draft that commits nothing.
    fn marked_gates() -> App {
        let mut app = plan_gate_app();
        let mut second = app.tasks[0].clone();
        second.id = "aaaaaaaa2222".into();
        second.title = "Second plan\u{1b}[31m with an escape".into();
        let ship = ship_stage_app().tasks[0].clone();
        let draft: Task = serde_json::from_value(task_json("eeeeeeee5555", "A draft", "draft", "Intake", serde_json::json!({}))).unwrap();
        app.tasks.extend([second, ship, draft]);
        app.mode = Mode::Normal;
        app.toast = None;
        app.marked = app.tasks.iter().map(|t| t.id.clone()).collect();
        app
    }

    #[test]
    fn a_over_marked_gates_asks_once_with_the_count_and_the_kinds_and_n_sends_nothing() {
        let mut app = marked_gates();
        let (machine, seen) = recording_machine();
        app.machine = machine;
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(&app.mode, Mode::ConfirmApproveMany { ids, .. } if ids.len() == 3), "the draft is not counted");
        assert_eq!(posts(&seen), vec!["/tasks/eeeeeeee5555/start".to_string()], "only what commits nothing went: the draft started");
        let screen = render(&mut app, 140, 40);
        assert!(screen.contains("approve 3 cards? 2 plans · 1 ship"), "{screen}");
        assert!(screen.contains("#aaaaaaaa  ") && screen.contains("Second plan [31m with an escape") && !screen.contains('\u{1b}'), "{screen}");
        assert!(screen.contains(" y  yes") && screen.contains(" n  no"), "{screen}");
        press(&mut app, KeyCode::Char('x'));
        assert!(matches!(app.mode, Mode::ConfirmApproveMany { .. }), "other keys do not answer");
        press(&mut app, KeyCode::Char('n'));
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(posts(&seen).len(), 1, "n sends no decision");
        let mut app = marked_gates();
        let (machine, seen) = recording_machine();
        app.machine = machine;
        press(&mut app, KeyCode::Char('a'));
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Normal) && posts(&seen).len() == 1, "esc sends nothing either");
    }

    #[test]
    fn y_over_marked_gates_sends_one_decision_per_committing_card() {
        let mut app = marked_gates();
        let (machine, seen) = recording_machine();
        app.machine = machine;
        press(&mut app, KeyCode::Char('a'));
        press(&mut app, KeyCode::Char('y'));
        let sent = posts(&seen);
        let decisions: Vec<&String> = sent.iter().filter(|p| p.ends_with("/decision")).collect();
        assert_eq!(decisions.len(), 3, "{sent:?}");
        assert!(matches!(app.mode, Mode::Normal) && app.marked.is_empty());
    }

    #[test]
    fn a_over_marked_cards_that_commit_nothing_keeps_its_behaviour() {
        let mut app = marked_gates();
        app.tasks.retain(|t| t.state == "draft");
        app.marked = app.tasks.iter().map(|t| t.id.clone()).collect();
        let (machine, seen) = recording_machine();
        app.machine = machine;
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::Normal), "no box when nothing commits");
        assert_eq!(posts(&seen), vec!["/tasks/eeeeeeee5555/start".to_string()]);
        assert!(app.marked.is_empty(), "{:?}", app.marked);
        assert!(app.toast.as_ref().is_some_and(|t| t.text.starts_with("advanced ") && t.text.contains(" of 1")), "{:?}", app.toast.as_ref().map(|t| t.text.clone()));
    }

    #[test]
    fn other_keys_do_not_answer_the_box() {
        let mut app = plan_gate_app();
        press(&mut app, KeyCode::Char('a'));
        press(&mut app, KeyCode::Char('x'));
        assert!(matches!(app.mode, Mode::ConfirmApprove(_)));
    }

    #[test]
    fn answers_that_commit_nothing_keep_their_flow() {
        // Send back is a prompt, not a confirmation.
        let mut app = plan_gate_app();
        press(&mut app, KeyCode::Char('r'));
        assert!(matches!(app.mode, Mode::Reason { approve: false, .. }));
        // A card that is running has nothing to approve: no box, a word in the footer.
        let mut app = running_build_app();
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::Detail(_)));
        assert!(app.toast.as_ref().is_some_and(|t| t.text.contains("running")));
        // Triage's questions open the answers editor.
        let mut app = crate::testkit::questions_app();
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::Answer { .. }));
    }

    #[test]
    fn a_on_the_board_at_a_gate_opens_the_task_and_sends_nothing() {
        for (name, mut app, _) in gates() {
            let (machine, seen) = recording_machine();
            app.machine = machine;
            let id = app.tasks[0].id.clone();
            let first = Section::for_task(&app.tasks[0]);
            app.mode = Mode::Normal;
            app.select(&id, true);
            press(&mut app, KeyCode::Char('a'));
            assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "{name}: the task opens");
            assert_eq!(app.detail_section, first, "{name}: on its first page");
            assert!(posts(&seen).is_empty(), "{name}: nothing was approved unseen");
        }
    }

    fn at_outcome_gate(outcome: &str) -> App {
        let task = task_json("aaaaaaaa6666", "Answer the question", "awaiting_approval", "Plan", serde_json::json!({"waitingOnYou": true}));
        open_card(task, serde_json::json!({"approvals": [{"id": "p9", "kind": "awaiting_approval", "decision": null, "createdAt": "2026-10-22T09:50:00Z", "requested": {"outcome": outcome, "brief": "b", "reply": "hi"}}]}))
    }

    fn at_state(state: &str) -> App {
        open_card(task_json("aaaaaaaa5555", "Set it up", state, "Plan", serde_json::json!({"waitingOnYou": true})), serde_json::json!({}))
    }

    /// Every gate `a` approves, the kinds the box did not cover before included, with the words its box asks.
    fn every_gate() -> Vec<(&'static str, App, &'static str)> {
        let mut all = gates();
        all.extend([
            ("reply", at_outcome_gate("conversation"), "post the reply and close #aaaaaaaa?"),
            ("archive", at_outcome_gate("archive"), "archive #aaaaaaaa?"),
            ("setup", at_state("awaiting_setup"), "write the proposed luna.yaml for #aaaaaaaa?"),
            ("tests", at_state("awaiting_test_check"), "approve the test cases of #aaaaaaaa?"),
        ]);
        all
    }

    #[test]
    fn a_at_every_gate_asks_inside_the_task_and_sends_only_on_y() {
        for (name, mut app, question) in every_gate() {
            let (machine, seen) = recording_machine();
            app.machine = machine;
            let id = app.tasks[0].id.clone();
            press(&mut app, KeyCode::Char('a'));
            let Mode::ConfirmApprove(held) = &app.mode else { panic!("{name}: a asks first") };
            assert_eq!(held.question, question, "{name}");
            assert!(posts(&seen).is_empty(), "{name}: asking sends nothing");
            press(&mut app, KeyCode::Char('y'));
            assert_eq!(posts(&seen), vec![format!("/tasks/{id}/decision")], "{name}");
        }
    }

    #[test]
    fn a_on_the_board_at_a_reply_archive_setup_or_tests_gate_opens_the_task_and_sends_nothing() {
        for (name, mut app, _) in every_gate() {
            let (machine, seen) = recording_machine();
            app.machine = machine;
            let id = app.tasks[0].id.clone();
            app.mode = Mode::Normal;
            app.select(&id, true);
            press(&mut app, KeyCode::Char('a'));
            assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "{name}: the task opens");
            assert!(posts(&seen).is_empty(), "{name}: nothing was approved unseen");
        }
    }

    #[test]
    fn the_x_menu_and_the_inbox_open_the_task_instead_of_approving() {
        for (name, mut app, _) in every_gate() {
            let (machine, seen) = recording_machine();
            app.machine = machine;
            let id = app.tasks[0].id.clone();
            app.mode = Mode::Actions { cursor: 0 };
            app.select(&id, true);
            press(&mut app, KeyCode::Char('a'));
            assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "{name}: the x menu opens the task");
            app.mode = Mode::Normal;
            app.inbox = Some(crate::inbox::InboxState { split: crate::inbox::Split::All, cursor: 0 });
            press(&mut app, KeyCode::Char('a'));
            assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "{name}: Inbox a opens the task, not a box");
            assert!(posts(&seen).is_empty(), "{name}: {:?}", posts(&seen));
            press(&mut app, KeyCode::Char('a'));
            assert!(matches!(&app.mode, Mode::ConfirmApprove(h) if h.id == id), "{name}: the box asks from inside the task");
        }
    }

    #[test]
    fn the_inbox_box_words_come_from_the_card_it_is_for() {
        let mut app = at_split_gate();
        app.mode = Mode::Normal;
        app.inbox = Some(crate::inbox::InboxState::default());
        press(&mut app, KeyCode::Char('a'));
        press(&mut app, KeyCode::Char('a'));
        let screen = render(&mut app, 140, 40);
        assert!(screen.contains("approve the split of #aaaaaaaa?") && !screen.contains("approve the plan"), "{screen}");
        press(&mut app, KeyCode::Esc);
        assert!(matches!(app.mode, Mode::Detail(_)), "esc returns to the task");
        press(&mut app, KeyCode::Esc);
        assert!(app.inbox.is_some() && matches!(app.mode, Mode::Normal), "and the Inbox is under it");
    }

    #[test]
    fn a_card_still_loading_asks_nothing() {
        let mut app = plan_gate_app();
        app.detail = None;
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::Detail(_)), "no box: the gate's kind is not known yet");
        assert!(app.toast.as_ref().is_some_and(|t| t.text.starts_with("still reading")), "{:?}", app.toast.as_ref().map(|t| &t.text));
    }

    #[test]
    fn capital_a_at_the_retro_opens_the_task_from_outside_and_asks_inside() {
        let (machine, seen) = recording_machine();
        let mut app = at_memory_review();
        app.machine = machine;
        let id = app.tasks[0].id.clone();
        app.mode = Mode::Normal;
        app.select(&id, true);
        press(&mut app, KeyCode::Char('A'));
        assert!(matches!(&app.mode, Mode::Detail(open) if *open == id) && posts(&seen).is_empty());
        press(&mut app, KeyCode::Char('A'));
        let Mode::ConfirmApprove(held) = &app.mode else { panic!("A asks inside the task") };
        assert!(held.skip_rules && held.question.contains("skip its rules"), "{held:?}");
        assert!(posts(&seen).is_empty());
        press(&mut app, KeyCode::Char('y'));
        assert_eq!(posts(&seen), vec![format!("/tasks/{id}/decision")]);
    }

    #[test]
    fn y_after_the_card_moved_to_another_gate_sends_nothing_and_says_so() {
        let (machine, seen) = recording_machine();
        let mut app = plan_gate_app();
        app.machine = machine;
        let id = app.tasks[0].id.clone();
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::ConfirmApprove(_)));
        app.tasks[0].state = "awaiting_ship".into();
        press(&mut app, KeyCode::Char('y'));
        assert!(posts(&seen).is_empty(), "{:?}", posts(&seen));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("the card moved on; nothing was approved"));
        assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "the box closed, back on the task");
    }

    #[test]
    fn y_after_the_same_gate_was_asked_again_sends_nothing() {
        let (machine, seen) = recording_machine();
        let mut app = release_question_app();
        app.machine = machine;
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::ConfirmApprove(_)));
        app.detail.as_mut().unwrap().approvals.last_mut().unwrap().id = Some("s2".into());
        press(&mut app, KeyCode::Enter);
        assert!(posts(&seen).is_empty(), "{:?}", posts(&seen));
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("the card moved on; nothing was approved"));
    }

    #[test]
    fn a_card_that_disappears_under_the_box_closes_it_with_the_message() {
        let mut app = plan_gate_app();
        let id = app.tasks[0].id.clone();
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::ConfirmApprove(_)));
        app.forget(&id);
        assert!(matches!(app.mode, Mode::Normal), "no invisible mode");
        assert_eq!(app.toast.as_ref().map(|t| t.text.as_str()), Some("the card moved on; nothing was approved"));
        // The same when the list was replaced under it, which `tick` settles.
        let mut app = plan_gate_app();
        press(&mut app, KeyCode::Char('a'));
        app.tasks.clear();
        app.tick();
        assert!(matches!(app.mode, Mode::Normal));
    }

    #[test]
    fn start_on_the_board_at_a_gate_opens_the_task_and_inside_it_asks_and_returns_to_it() {
        let (machine, seen) = recording_machine();
        let mut app = plan_gate_app();
        app.machine = machine;
        let id = app.tasks[0].id.clone();
        app.mode = Mode::Normal;
        app.select(&id, true);
        for ch in ":start".chars().map(KeyCode::Char).chain([KeyCode::Enter]) {
            press(&mut app, ch);
        }
        assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), ":start on the board opens the task");
        assert!(posts(&seen).is_empty());
        for ch in ":start".chars().map(KeyCode::Char).chain([KeyCode::Enter]) {
            press(&mut app, ch);
        }
        assert!(matches!(app.mode, Mode::ConfirmApprove(_)), ":start inside the task asks");
        press(&mut app, KeyCode::Esc);
        assert!(matches!(&app.mode, Mode::Detail(open) if *open == id), "esc lands on the task, not the board");
        assert!(posts(&seen).is_empty());
    }

    #[test]
    fn start_on_a_draft_inside_the_task_goes_at_once_and_returns_to_the_task() {
        let task = task_json("aaaaaaaa9999", "A draft", "draft", "Intake", serde_json::json!({}));
        let mut app = open_card(task, serde_json::json!({}));
        app.tasks[0].repo_path = Some("/work/app".into());
        let (machine, seen) = recording_machine();
        app.machine = machine;
        for ch in ":start".chars().map(KeyCode::Char).chain([KeyCode::Enter]) {
            press(&mut app, ch);
        }
        assert_eq!(posts(&seen), vec!["/tasks/aaaaaaaa9999/start".to_string()]);
        assert!(matches!(&app.mode, Mode::Detail(open) if open == "aaaaaaaa9999"));
    }

    #[test]
    fn marked_cards_at_a_reply_or_setup_gate_are_not_approved_blind() {
        let mut app = marked_gates();
        let reply = at_outcome_gate("conversation").tasks[0].clone();
        let setup = at_state("awaiting_setup").tasks[0].clone();
        app.tasks.retain(|t| t.state == "draft");
        app.tasks.extend([reply, setup]);
        app.marked = app.tasks.iter().map(|t| t.id.clone()).collect();
        let (machine, seen) = recording_machine();
        app.machine = machine;
        press(&mut app, KeyCode::Char('a'));
        assert!(posts(&seen).iter().all(|p| p.ends_with("/start")), "{:?}", posts(&seen));
    }

    #[test]
    fn inbox_capital_a_approves_together_only_what_asks_a_plain_yes() {
        let mut app = at_outcome_gate("conversation");
        app.mode = Mode::Normal;
        app.inbox = Some(crate::inbox::InboxState::default());
        press(&mut app, KeyCode::Char('A'));
        assert!(matches!(app.mode, Mode::Normal), "a reply is read inside its card, not approved with the rest");
        let mut app = plan_gate_app();
        app.mode = Mode::Normal;
        app.inbox = Some(crate::inbox::InboxState::default());
        press(&mut app, KeyCode::Char('A'));
        assert!(matches!(app.mode, Mode::ConfirmApproveAll(ref ids) if ids.len() == 1));
    }

    #[test]
    fn the_split_and_release_bars_offer_their_answers_and_no_edit() {
        let bar = |app: &App| crate::keys::detail_footer(app).into_iter().map(|(k, l)| format!("{k} {l}")).collect::<Vec<_>>();
        let split = bar(&at_split_gate());
        assert_eq!(split[..3], ["a approve", "r send back", "N reject"], "{split:?}");
        assert!(!split.iter().any(|k| k.starts_with("e ")), "a split has no plan to edit: {split:?}");
        let release = bar(&release_question_app());
        assert_eq!(release[..2], ["a release", "N reject"], "{release:?}");
        assert!(!release.iter().any(|k| k.starts_with("e ")), "{release:?}");
        let plan = bar(&plan_gate_app());
        assert!(plan.contains(&"e edit".to_string()), "the plan gate edits: {plan:?}");
    }

    #[test]
    fn e_at_a_split_or_release_gate_says_why_it_edits_nothing_and_opens_no_editor() {
        for mut app in [at_split_gate(), release_question_app()] {
            press(&mut app, KeyCode::Char('e'));
            assert!(matches!(app.mode, Mode::Detail(_)), "no editor opened");
            let reg = crate::keys::bindings_for(&app, crate::keys::Scope::Detail).into_iter().find(|(b, _)| b.keys == "e").unwrap().1;
            assert!(matches!(reg, crate::keys::Avail::Off(_)), "{reg:?}");
            assert!(app.toast.is_some());
        }
    }

    #[test]
    fn a_on_the_board_keeps_its_meaning_on_other_cards() {
        // A draft starts, as before.
        let task = task_json("aaaaaaaa9999", "A draft", "draft", "Intake", serde_json::json!({}));
        let mut app = open_card(task, serde_json::json!({}));
        let (machine, seen) = recording_machine();
        app.machine = machine;
        app.mode = Mode::Normal;
        app.select("aaaaaaaa9999", true);
        press(&mut app, KeyCode::Char('a'));
        assert_eq!(posts(&seen), vec!["/tasks/aaaaaaaa9999/start".to_string()]);
        // An escalated card asks for guidance.
        let mut app = crate::testkit::escalated_app();
        app.mode = Mode::Normal;
        app.select("cccccccc3333", true);
        press(&mut app, KeyCode::Char('a'));
        assert!(matches!(app.mode, Mode::Reason { approve: true, .. }));
    }

    #[test]
    fn the_board_says_what_a_will_do_for_the_selected_card() {
        let mut app = plan_gate_app();
        app.mode = Mode::Normal;
        app.select("aaaaaaaa1111", true);
        let label = |app: &App, scope: keys::Scope| keys::bindings_for(app, scope).into_iter().find(|(b, _)| b.first() == "a").map(|(b, _)| b.label);
        assert_eq!(label(&app, keys::Scope::Board), Some("open to approve"));
        app.toast = None;
        let screen = render(&mut app, 140, 40);
        assert!(screen.contains("open to approve"), "the board footer says it:\n{screen}");
        app.open_detail("aaaaaaaa1111".to_string());
        assert_eq!(label(&app, keys::Scope::Detail), Some("approve the plan"), "the task view still approves");
    }

    #[test]
    fn q_asks_before_quitting_while_a_card_needs_you_or_runs() {
        let mut app = plan_gate_app();
        app.mode = Mode::Normal;
        assert!(matches!(app.handle_key(KeyEvent::from(KeyCode::Char('q'))), Outcome::Continue));
        assert!(matches!(app.mode, Mode::ConfirmQuit));
        let screen = render(&mut app, 140, 40);
        assert!(screen.contains("quit? 1 card needs you, 0 running"), "{screen}");
        assert!(matches!(app.handle_key(KeyEvent::from(KeyCode::Char('n'))), Outcome::Continue));
        assert!(matches!(app.mode, Mode::Normal), "n stays");
        app.handle_key(KeyEvent::from(KeyCode::Char('q')));
        assert!(matches!(app.handle_key(KeyEvent::from(KeyCode::Esc)), Outcome::Continue));
        assert!(matches!(app.mode, Mode::Normal), "esc stays");
        app.handle_key(KeyEvent::from(KeyCode::Char('q')));
        assert!(matches!(app.handle_key(KeyEvent::from(KeyCode::Char('y'))), Outcome::Quit), "y quits");
    }

    #[test]
    fn q_counts_running_cards_too_and_quits_at_once_when_nothing_is_pending() {
        let mut app = running_build_app();
        app.mode = Mode::Normal;
        app.handle_key(KeyEvent::from(KeyCode::Char('q')));
        let screen = render(&mut app, 140, 40);
        assert!(screen.contains("quit? 0 cards need you, 1 running"), "{screen}");
        let task = task_json("aaaaaaaa0001", "All done", "closed", "Done", serde_json::json!({}));
        let mut quiet = open_card(task, serde_json::json!({}));
        quiet.mode = Mode::Normal;
        assert!(matches!(quiet.handle_key(KeyEvent::from(KeyCode::Char('q'))), Outcome::Quit), "nothing pending: quit at once");
    }

    #[test]
    fn capital_q_quits_without_asking() {
        let mut app = plan_gate_app();
        app.mode = Mode::Normal;
        assert!(matches!(app.handle_key(KeyEvent::from(KeyCode::Char('Q'))), Outcome::Quit));
    }
}

#[cfg(test)]
mod evidence_open_tests {
    use std::{ffi::OsString, fs, rc::Rc};

    use ratatui::crossterm::event::{KeyCode, KeyEvent};

    use super::*;
    use crate::{
        keys::{self, Avail, Scope},
        testkit::{open_card, render, ship_stage_app, task_json},
    };

    type Calls = Rc<RefCell<Vec<(String, Vec<OsString>)>>>;

    /// The ship-stage card with its three artifacts in real files under a fresh folder that is the card's worktree,
    /// and an opener that records its calls. Runs: verifying (r1) wrote `verify.log`, evidence (r2) the other two.
    fn card(name: &str) -> (App, PathBuf, Calls) {
        let root = std::env::temp_dir().join(format!("board-evidence-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mut app = ship_stage_app();
        let paths = [("r2", "runs/r2/files/limit-429.png"), ("r1", "runs/r1/files/verify.log"), ("r2", "runs/r2/files/evidence.md")];
        for (artifact, (_, rel)) in app.detail.as_mut().unwrap().artifacts.iter_mut().zip(paths) {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"x").unwrap();
            artifact.path = path.to_string_lossy().into_owned();
        }
        app.tasks[0].worktree_path = Some(root.to_string_lossy().into_owned());
        let calls: Calls = Rc::default();
        let log = calls.clone();
        app.launch = Box::new(move |program, args| {
            log.borrow_mut().push((program.to_string(), args.to_vec()));
            Ok(())
        });
        (app, root, calls)
    }

    fn press(app: &mut App, c: char) {
        app.handle_key(KeyEvent::from(KeyCode::Char(c)));
    }

    fn toast(app: &App) -> String {
        app.toast.as_ref().map(|t| t.text.clone()).unwrap_or_default()
    }

    fn launched(calls: &Calls) -> Vec<OsString> {
        calls.borrow().iter().filter_map(|(_, args)| args.last().cloned()).collect()
    }

    fn canon(path: &Path) -> OsString {
        fs::canonicalize(path).unwrap().into_os_string()
    }

    #[test]
    fn o_opens_the_evidence_folder_from_any_section_of_a_card_that_has_files() {
        let (mut app, root, calls) = card("o-anywhere");
        assert_eq!(app.detail_section, Section::Result);
        press(&mut app, 'o');
        assert_eq!(launched(&calls), vec![canon(&root.join("runs/r2/files"))], "the latest run's folder: the runs wrote to different ones");
        assert_eq!(toast(&app), "opened the evidence folder");
        assert!(!app.toast.as_ref().unwrap().error);
    }

    #[test]
    fn in_the_evidence_section_o_opens_the_folder_of_the_run_under_the_cursor_and_enter_the_file() {
        let (mut app, root, calls) = card("o-enter");
        app.set_section(Section::Evidence);
        app.detail_cursor = 0;
        assert_eq!(crate::detail::ordered_artifacts(app.detail.as_ref().unwrap())[0].label, "verify", "listed by run: verifying first");
        press(&mut app, 'o');
        assert_eq!(launched(&calls), vec![canon(&root.join("runs/r1/files"))]);
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(launched(&calls)[1], canon(&root.join("runs/r1/files/verify.log")));
        assert_eq!(toast(&app), "opened verify");
        assert!(matches!(app.mode, Mode::Detail(_)), "enter opened the file and did not close the view");
        app.detail_cursor = 2;
        press(&mut app, 'o');
        assert_eq!(launched(&calls)[2], canon(&root.join("runs/r2/files")));
    }

    #[test]
    fn enter_in_the_other_sections_still_closes_the_view() {
        let (mut app, _, calls) = card("enter-closes");
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(matches!(app.mode, Mode::Normal));
        assert!(launched(&calls).is_empty());
    }

    #[test]
    fn i_opens_the_linked_issue_from_any_section_while_o_keeps_the_evidence_folder() {
        let (mut app, root, calls) = card("issue");
        let link = serde_json::json!({"key": "PLAT-1", "url": "https://acme.atlassian.net/browse/PLAT-1"});
        app.tasks[0].jira = Some(serde_json::from_value(link).unwrap());
        for section in [Section::Result, Section::Evidence, Section::Activity] {
            app.set_section(section);
            press(&mut app, 'i');
            assert_eq!(launched(&calls).last(), Some(&OsString::from("https://acme.atlassian.net/browse/PLAT-1")), "{section:?}");
            assert!(crate::keys::bindings_for(&app, crate::keys::Scope::Detail).iter().any(|(b, a)| b.keys == "i" && a.is_on()));
        }
        press(&mut app, 'o');
        assert!(launched(&calls).last().is_some_and(|l| l != &OsString::from("https://acme.atlassian.net/browse/PLAT-1")), "o still opens the evidence, not the issue");
        let _ = root;
        let (mut bare, _, calls) = card("no-issue");
        press(&mut bare, 'i');
        assert!(launched(&calls).is_empty());
        assert_eq!(toast(&bare), "no issue linked");
        let off = crate::keys::bindings_for(&bare, crate::keys::Scope::Detail).into_iter().find(|(b, _)| b.keys == "i").unwrap().1;
        assert!(matches!(off, crate::keys::Avail::Off("no linked issue")));
    }

    #[test]
    fn o_says_in_the_key_sheet_what_it_will_do_when_there_is_nothing_to_open() {
        let mut app = crate::testkit::plan_gate_app();
        let o = |app: &App| crate::keys::bindings_for(app, crate::keys::Scope::Detail).into_iter().find(|(b, _)| b.keys == "o").unwrap().1;
        assert!(matches!(o(&app), crate::keys::Avail::Off("no issue linked")), "a card with no artifacts, PR or issue: {:?}", o(&app));
        let link = serde_json::json!({"key": "PLAT-1", "url": "https://acme.atlassian.net/browse/PLAT-1"});
        app.tasks[0].jira = Some(serde_json::from_value(link).unwrap());
        assert!(o(&app).is_on(), "a linked issue gives it something to open");
        app.set_section(Section::Diff);
        assert!(matches!(o(&app), crate::keys::Avail::Off("nothing to open here")), "{:?}", o(&app));
    }

    #[test]
    fn capital_o_opens_the_pr_and_says_so_when_there_is_none() {
        let (mut app, _, calls) = card("pr");
        press(&mut app, 'O');
        assert_eq!(launched(&calls), vec![OsString::from("https://github.com/acme/app/pull/412")]);
        assert_eq!(toast(&app), "opened the PR");
        let (mut bare, _, calls) = card("no-pr");
        bare.detail.as_mut().unwrap().ship = None;
        press(&mut bare, 'O');
        assert!(launched(&calls).is_empty());
        assert_eq!(toast(&bare), "no PR yet");
    }

    #[test]
    fn a_file_a_run_wrote_is_revealed_not_launched_unless_it_is_plain_to_view() {
        let (mut app, root, calls) = card("reveal");
        let hostile = root.join("runs/r2/files/run.command");
        fs::write(&hostile, b"#!/bin/sh").unwrap();
        app.detail.as_mut().unwrap().artifacts[0].path = hostile.to_string_lossy().into_owned();
        app.detail.as_mut().unwrap().artifacts[0].label = "run.command".into();
        app.set_section(Section::Evidence);
        let row = crate::detail::ordered_artifacts(app.detail.as_ref().unwrap()).iter().position(|a| a.label == "run.command").unwrap();
        app.detail_cursor = row;
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        let real = canon(&hostile);
        let last = calls.borrow().last().cloned().unwrap();
        let expect: Vec<OsString> = if cfg!(target_os = "macos") { vec![OsString::from("-R"), real] } else { vec![canon(hostile.parent().unwrap())] };
        assert_eq!(last.1, expect, "revealed, never opened");
        assert_eq!(toast(&app), "revealed run.command in the folder");
        let plain = crate::detail::ordered_artifacts(app.detail.as_ref().unwrap()).iter().position(|a| a.label != "run.command").unwrap();
        app.detail_cursor = plain;
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(toast(&app).starts_with("opened "), "{}", toast(&app));
    }

    #[test]
    fn the_evidence_folder_inside_a_bundle_is_revealed() {
        let (mut app, root, calls) = card("bundle-folder");
        let bundle = root.join("runs/r2/X.app/files");
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("a.png"), b"x").unwrap();
        for artifact in app.detail.as_mut().unwrap().artifacts.iter_mut() {
            artifact.path = bundle.join("a.png").to_string_lossy().into_owned();
        }
        press(&mut app, 'o');
        assert_eq!(toast(&app), "revealed the evidence folder in the folder");
        let last = calls.borrow().last().cloned().unwrap();
        assert!(if cfg!(target_os = "macos") { last.1.first() == Some(&OsString::from("-R")) } else { true });
    }

    #[test]
    fn a_file_that_resolves_outside_the_card_is_refused_in_fixed_words() {
        let (mut app, root, calls) = card("outside");
        let stray = root.parent().unwrap().join(format!("board-evidence-stray-{}.txt", std::process::id()));
        fs::write(&stray, b"secret").unwrap();
        app.detail.as_mut().unwrap().artifacts[0].path = stray.to_string_lossy().into_owned();
        app.set_section(Section::Evidence);
        app.detail_cursor = 1;
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        let said = toast(&app);
        let _ = fs::remove_file(&stray);
        assert!(launched(&calls).is_empty());
        assert_eq!(said, crate::open::REFUSE_OUTSIDE);
        assert!(app.toast.as_ref().unwrap().error);
    }

    #[test]
    fn a_missing_file_is_refused_and_a_card_without_files_says_so() {
        let (mut app, root, calls) = card("gone");
        fs::remove_dir_all(root.join("runs/r1")).unwrap();
        app.set_section(Section::Evidence);
        app.detail_cursor = 0;
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(toast(&app), crate::open::REFUSE_MISSING);
        let mut bare = open_card(task_json("bbbbbbbb2222", "Bare", "implementing", "Build", serde_json::json!({})), serde_json::json!({}));
        bare.set_section(Section::Evidence);
        press(&mut bare, 'o');
        assert_eq!(toast(&bare), "no evidence yet");
        assert!(launched(&calls).is_empty());
    }

    #[test]
    fn the_registry_gives_each_key_its_reason() {
        let reason = |app: &App, key: &str| keys::bindings_for(app, Scope::Detail).into_iter().find(|(b, _)| b.first() == key).map(|(_, a)| a).unwrap();
        let (mut app, _, _) = card("avail");
        assert_eq!(reason(&app, "O"), Avail::On);
        assert_eq!(reason(&app, "o"), Avail::On);
        assert_eq!(reason(&app, "enter"), Avail::Off("only in the Evidence section"));
        app.set_section(Section::Evidence);
        assert_eq!(reason(&app, "enter"), Avail::On);
        app.detail.as_mut().unwrap().artifacts.clear();
        app.detail.as_mut().unwrap().ship = None;
        assert_eq!(reason(&app, "enter"), Avail::Off("no evidence yet"));
        assert_eq!(reason(&app, "o"), Avail::Off("no evidence yet"));
        assert_eq!(reason(&app, "O"), Avail::Off("no PR yet"));
        let footer = |app: &App| keys::detail_footer(app).into_iter().map(|(k, l)| format!("{k} {l}")).collect::<Vec<_>>();
        let (mut app, _, _) = card("footer");
        assert!(footer(&app).contains(&"o open".to_string()), "{:?}", footer(&app));
        assert!(footer(&app).contains(&"O PR".to_string()), "{:?}", footer(&app));
        app.set_section(Section::Evidence);
        assert!(footer(&app).contains(&"enter open file".to_string()), "{:?}", footer(&app));
    }

    /// The card on the Evidence section, drawn once so the rows have rectangles.
    fn drawn(name: &str) -> (App, PathBuf, Calls) {
        let (mut app, root, calls) = card(name);
        app.set_section(Section::Evidence);
        app.detail_cursor = 0;
        render(&mut app, 140, 40);
        (app, root, calls)
    }

    fn rect_of(app: &App, hit: crate::detail::EvidenceHit) -> Rect {
        app.evidence_hits.borrow().iter().find(|(_, h)| *h == hit).map(|(r, _)| *r).unwrap_or_else(|| panic!("no rectangle for {hit:?}: {:?}", app.evidence_hits.borrow()))
    }

    #[test]
    fn a_click_selects_a_file_row_and_a_second_click_within_half_a_second_opens_it() {
        use crate::detail::EvidenceHit::File;
        let (mut app, root, calls) = drawn("click");
        assert_eq!(app.evidence_hits.borrow().len(), 4, "the folder line and three rows");
        let row = rect_of(&app, File(2));
        app.click(row.x + 3, row.y);
        assert_eq!(app.detail_row(), 2);
        assert!(launched(&calls).is_empty(), "one click only selects");
        app.click(row.x + 3, row.y);
        assert_eq!(launched(&calls), vec![canon(&root.join("runs/r2/files/evidence.md"))]);
        assert_eq!(toast(&app), "opened evidence pack");
    }

    #[test]
    fn a_slow_second_click_or_a_click_on_another_row_only_selects() {
        use crate::detail::EvidenceHit::File;
        let (mut app, _, calls) = drawn("slow");
        let (a, b) = (rect_of(&app, File(1)), rect_of(&app, File(2)));
        app.click(a.x, a.y);
        app.last_click = app.last_click.map(|(i, at)| (i, at - Duration::from_millis(600)));
        app.click(a.x, a.y);
        app.click(b.x, b.y);
        assert_eq!(app.detail_row(), 2);
        assert!(launched(&calls).is_empty());
    }

    #[test]
    fn a_click_on_the_folder_line_opens_the_folder_and_a_click_elsewhere_changes_nothing() {
        use crate::detail::EvidenceHit::Folder;
        let (mut app, root, calls) = drawn("folder-click");
        let line = rect_of(&app, Folder);
        app.click(line.x + 2, line.y);
        assert_eq!(launched(&calls), vec![canon(&root.join("runs/r1/files"))], "the folder of the run under the cursor");
        let (cursor, mode_open) = (app.detail_row(), matches!(app.mode, Mode::Detail(_)));
        app.click(0, 0);
        app.click(line.x, line.y.saturating_sub(2));
        assert_eq!((app.detail_row(), matches!(app.mode, Mode::Detail(_)), launched(&calls).len()), (cursor, mode_open, 1));
    }

    #[test]
    fn rows_are_found_after_the_pane_scrolls() {
        use crate::detail::EvidenceHit::File;
        let (mut app, _, _) = card("scrolled");
        app.set_section(Section::Evidence);
        app.detail_cursor = 2;
        render(&mut app, 100, 22);
        let hits = app.evidence_hits.borrow().clone();
        assert!(hits.iter().any(|(_, h)| *h == File(2)), "the cursor's row is on screen and clickable: {hits:?}");
        assert!(hits.iter().all(|(r, _)| r.y >= 1 && r.height == 1));
    }

    #[test]
    fn the_evidence_section_draws_the_folder_and_the_rows_by_run_wide_and_narrow() {
        for (w, h) in [(180u16, 50u16), (100, 30)] {
            let mut app = ship_stage_app();
            app.set_section(Section::Evidence);
            let screen = render(&mut app, w, h);
            for needle in ["Folder  /out/files", "verifying · run 1", "evidence · run 1", "log", "verify", "/out/files/verify.log", "screenshot", "429 after the limit", "/out/files/limit-429.png", "report", "evidence pack"] {
                assert!(screen.contains(needle), "{w}x{h}: {needle} missing in\n{screen}");
            }
        }
    }

    #[test]
    fn a_hostile_label_or_path_is_neutralised_and_a_long_path_is_cut_in_the_middle() {
        let mut app = ship_stage_app();
        let artifacts = &mut app.detail.as_mut().unwrap().artifacts;
        artifacts[0].label = "shot\u{1b}[2J\r\u{7}\u{202e}x".into();
        artifacts[0].path = "/out/files/\u{1b}]0;pwned\u{7}/a\u{85}b.png".into();
        artifacts[2].path = format!("/out/files/{}/deep/er/report.md", "very-long-folder-name/".repeat(12));
        app.set_section(Section::Evidence);
        let screen = render(&mut app, 100, 30);
        for bad in ['\u{1b}', '\r', '\u{7}', '\u{202e}', '\u{85}'] {
            assert!(!screen.contains(bad), "{bad:?} reached the screen");
        }
        assert!(screen.contains("shot [2J"), "{screen}");
        assert!(screen.contains("report.md") && screen.contains('…'), "the tail of a long path stays: {screen}");
    }
}
