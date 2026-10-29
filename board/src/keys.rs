//! The key registry: one table every surface reads. The `?` sheet, the footer, the `x` menus,
//! the `:` completion, the which-key strip and the README's key tables (`--keys-md`) all derive
//! from `BINDINGS`. The handlers in `app` still run the keys; this only describes them, and the
//! parity tests keep the two in step: every char a handler matches has a binding in its scope,
//! and every binding's key is one its handler matches.
//!
//! One binding per meaning, not per key: `a` has one entry per gate, with `when` predicates
//! that never hold at once, so the sheet shows the one that applies and the footer says
//! `a approve the plan` instead of `a advance`.

use crate::app::{App, Mode};
use crate::model::Task;
use crate::pulls::{self, PrKey};
use crate::slack::{self, SlackKey};
use crate::vim;

/// Whether a key works right now: bright, dim with the reason, or left out of the sheet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Avail {
    On,
    Off(&'static str),
    Hidden,
}

impl Avail {
    pub fn is_on(self) -> bool {
        self == Avail::On
    }
}

/// Where a key is read. The views are the full-screen ones (`Floor`, `Inbox`, `Digest`,
/// `Pulls`, `Slack`), the popups over them (`Detail` over the board, `Watches` over Slack),
/// the vim editors and the sheet itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Scope {
    Board,
    Detail,
    Pulls,
    Slack,
    Watches,
    Inbox,
    Digest,
    Floor,
    Editor,
    Help,
}

impl Scope {
    pub const ALL: [Scope; 10] = [
        Scope::Board,
        Scope::Detail,
        Scope::Pulls,
        Scope::Slack,
        Scope::Watches,
        Scope::Inbox,
        Scope::Digest,
        Scope::Floor,
        Scope::Editor,
        Scope::Help,
    ];

    /// How the sheet and the README name the scope.
    pub fn name(self) -> &'static str {
        match self {
            Scope::Board => "Board",
            Scope::Detail => "Ticket",
            Scope::Pulls => "Pulls",
            Scope::Slack => "Slack",
            Scope::Watches => "Watches",
            Scope::Inbox => "Inbox",
            Scope::Digest => "Digest",
            Scope::Floor => "Floor",
            Scope::Editor => "Editor",
            Scope::Help => "Keys",
        }
    }

    /// The README's marker word: `<!-- keys:start board -->`.
    pub fn slug(self) -> &'static str {
        match self {
            Scope::Board => "board",
            Scope::Detail => "detail",
            Scope::Pulls => "pulls",
            Scope::Slack => "slack",
            Scope::Watches => "watches",
            Scope::Inbox => "inbox",
            Scope::Digest => "digest",
            Scope::Floor => "floor",
            Scope::Editor => "editor",
            Scope::Help => "help",
        }
    }

    /// The layer a popup sits on: its keys fold to one line at the bottom of the sheet.
    pub fn under(self) -> Option<Scope> {
        match self {
            Scope::Detail => Some(Scope::Board),
            Scope::Watches => Some(Scope::Slack),
            _ => None,
        }
    }
}

/// The headings of the sheet, declared in the order it shows them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Group {
    Gate,
    Ticket,
    Move,
    Filter,
    Views,
    Marks,
    App,
    Commands,
}

impl Group {
    pub const ORDER: [Group; 8] = [Group::Gate, Group::Ticket, Group::Move, Group::Filter, Group::Views, Group::Marks, Group::App, Group::Commands];

    /// The heading: the item group is named after what the view holds.
    pub fn heading(self, scope: Scope) -> &'static str {
        match self {
            Group::Gate => "Gate",
            Group::Ticket => match scope {
                Scope::Pulls => "Pull request",
                Scope::Slack => "Message",
                Scope::Watches => "Watch",
                _ => "Ticket",
            },
            Group::Move => "Move",
            Group::Filter => "Filter & order",
            Group::Views => "Views",
            Group::Marks => "Marks & bulk",
            Group::App => "App",
            Group::Commands => "Commands (type after :)",
        }
    }

    /// Dense groups whose labels are obvious fold to one line of keys unless the sheet is long.
    pub fn strip(self) -> bool {
        matches!(self, Group::Move | Group::Filter | Group::Views | Group::App)
    }
}

/// One key (or key pair, or two-key sequence) and what it does in one scope.
#[derive(Clone, Copy)]
pub struct Binding {
    /// `"a"`, `"h / l"`, `"gg"`, `"ctrl+d / ctrl+u"`, `"x P"` (a key reached through the `x` menu).
    pub keys: &'static str,
    /// At most 40 characters: the sheet, the footer and the `x` menu all show it whole.
    pub label: &'static str,
    pub group: Group,
    pub scope: Scope,
    pub when: fn(&App) -> Avail,
    /// What the footer shows first.
    pub weight: u8,
    /// The `:` form, when there is one.
    pub command: Option<&'static str>,
}

impl std::fmt::Debug for Binding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?} {:?}: {}", self.scope, self.keys, self.label)
    }
}

impl Binding {
    pub fn avail(&self, app: &App) -> Avail {
        (self.when)(app)
    }

    /// The alternatives in `keys`: `"h / l"` is two, `"ctrl+d / ctrl+u"` two, `"x P"` one.
    pub fn alternatives(&self) -> impl Iterator<Item = &'static str> {
        self.keys.split(" / ")
    }

    /// Every key named: `"u ^r"` is two tokens, `"x P"` two (the menu and the key in it).
    pub fn tokens(&self) -> impl Iterator<Item = &'static str> {
        self.alternatives().flat_map(|a| a.split(' ')).filter(|t| !t.is_empty())
    }

    /// The first alternative: what the footer, the uniqueness test and dispatch go by.
    pub fn first(&self) -> &'static str {
        self.alternatives().next().unwrap_or("")
    }

    /// A key reached only through the `x` menu, as `"x P"`; `Some('P')` for it.
    pub fn menu_key(&self) -> Option<char> {
        let rest = self.keys.strip_prefix("x ")?;
        let mut chars = rest.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) => Some(c),
            _ => None,
        }
    }

    /// The key the `x` menu lists: `P` for `"x P"`, else the keys as written.
    pub fn menu_keys(&self) -> String {
        self.menu_key().map_or_else(|| self.keys.to_string(), |c| c.to_string())
    }

    /// `"j/k"` for the footer, where every column counts.
    pub fn short_keys(&self) -> String {
        self.keys.replace(" / ", "/")
    }

    /// Whether a typed `c` is one of this binding's keys: the key itself, the first key of a
    /// two-key sequence (`gg`, `zc`), or a digit inside a range (`1-8`).
    pub fn matches_char(&self, c: char) -> bool {
        self.tokens().any(|t| {
            let chars: Vec<char> = t.chars().collect();
            match chars[..] {
                [k] => k == c,
                [lo, '-', hi] => lo <= c && c <= hi,
                [p, _] if matches!(p, 'g' | 'z') => p == c,
                _ => false,
            }
        })
    }
}

// ---------- predicates ----------

fn on(_: &App) -> Avail {
    Avail::On
}

/// The ticket a key would act on: the open popup's, the Inbox row's, else the board's selection.
fn task_of(app: &App) -> Option<&Task> {
    app.focus_task()
}

fn with_task(app: &App, f: fn(&Task) -> Avail) -> Avail {
    match task_of(app) {
        Some(task) => f(task),
        None => Avail::Off("no ticket selected"),
    }
}

/// `On` while the ticket is in one of `states`; `Hidden` otherwise, so the sibling meanings of
/// the same key never show together.
fn gate_is(app: &App, states: &[&str]) -> Avail {
    match task_of(app) {
        Some(task) if states.contains(&task.state.as_str()) => Avail::On,
        _ => Avail::Hidden,
    }
}

/// The states one of the `a` entries names.
const GATE_STATES: &[&str] = &[
    "draft",
    "awaiting_setup",
    "awaiting_answers",
    "awaiting_approval",
    "awaiting_test_check",
    "awaiting_ship",
    "escalated",
    "paused_rate_limit",
    "reviewing_memory",
];

/// `a` when no gate entry applies: says why there is nothing to advance.
fn advance_fallback(app: &App) -> Avail {
    match task_of(app) {
        None => Avail::Off("no ticket selected"),
        Some(task) if GATE_STATES.contains(&task.state.as_str()) => Avail::Hidden,
        Some(task) if task.state == "closed" => Avail::Off("closed"),
        Some(task) if task.waiting_on_you => Avail::On,
        Some(_) => Avail::Off("a stage is running; X aborts it"),
    }
}

fn pr_key(app: &App, key: PrKey) -> Avail {
    match app.pr_under_cursor() {
        None => Avail::Off("no PR selected"),
        Some(pr) => match pulls::blocker(&pr, key) {
            Some(why) => Avail::Off(why),
            None => Avail::On,
        },
    }
}

fn slack_key(app: &App, key: SlackKey) -> Avail {
    match app.slack_under_cursor() {
        None => Avail::Off("no message selected"),
        Some(item) => match slack::blocker(item, key) {
            Some(why) => Avail::Off(why),
            None => Avail::On,
        },
    }
}

fn editor_mode(app: &App) -> Option<vim::Mode> {
    app.editor_vim().map(vim::Vim::mode)
}

fn in_normal(app: &App) -> Avail {
    match editor_mode(app) {
        Some(vim::Mode::Insert) => Avail::Hidden,
        _ => Avail::On,
    }
}

fn in_insert(app: &App) -> Avail {
    match editor_mode(app) {
        Some(vim::Mode::Insert) => Avail::On,
        _ => Avail::Hidden,
    }
}

// ---------- the table ----------

const fn b(keys: &'static str, label: &'static str, group: Group, scope: Scope, when: fn(&App) -> Avail, weight: u8) -> Binding {
    Binding { keys, label, group, scope, when, weight, command: None }
}

const fn cmd(binding: Binding, command: &'static str) -> Binding {
    Binding { command: Some(command), ..binding }
}

/// The keys `ticket_key` runs the same way from the board, the popup and the Inbox. Their scope
/// is set when the table is built.
const SHARED: &[Binding] = &[
    cmd(b("a", "start", Group::Gate, Scope::Board, |app| gate_is(app, &["draft"]), 90), "start"),
    b("a", "approve the setup", Group::Gate, Scope::Board, |app| gate_is(app, &["awaiting_setup"]), 90),
    b("a", "answer triage's questions", Group::Gate, Scope::Board, |app| gate_is(app, &["awaiting_answers"]), 90),
    b("a", "approve the plan", Group::Gate, Scope::Board, |app| gate_is(app, &["awaiting_approval"]), 90),
    b("a", "approve the tests", Group::Gate, Scope::Board, |app| gate_is(app, &["awaiting_test_check"]), 90),
    b("a", "ship: approve and open the PR", Group::Gate, Scope::Board, |app| gate_is(app, &["awaiting_ship"]), 90),
    b("a", "retry the escalation, with guidance", Group::Gate, Scope::Board, |app| gate_is(app, &["escalated"]), 90),
    b("a", "resume after the usage limit", Group::Gate, Scope::Board, |app| gate_is(app, &["paused_rate_limit"]), 90),
    b("a", "approve the memory review", Group::Gate, Scope::Board, |app| gate_is(app, &["reviewing_memory"]), 90),
    b("a", "advance", Group::Gate, Scope::Board, advance_fallback, 90),
    b(
        "A",
        "memory review: approve, skip the rules",
        Group::Gate,
        Scope::Board,
        |app| with_task(app, |t| if t.state == "reviewing_memory" { Avail::On } else { Avail::Off("no memory review waiting") }),
        40,
    ),
    b(
        "r",
        "send back with a reason",
        Group::Gate,
        Scope::Board,
        |app| {
            with_task(app, |t| {
                if matches!(t.state.as_str(), "awaiting_setup" | "awaiting_approval" | "awaiting_test_check") {
                    Avail::On
                } else {
                    Avail::Off("only a setup, plan or tests go back")
                }
            })
        },
        85,
    ),
    b(
        "X",
        "abort the running stage (asks first)",
        Group::Ticket,
        Scope::Board,
        |app| with_task(app, |t| if t.running || t.state == "paused_rate_limit" { Avail::On } else { Avail::Off("nothing is running") }),
        45,
    ),
    b(
        "w",
        "kill its worktree (asks first)",
        Group::Ticket,
        Scope::Board,
        |app| {
            with_task(app, |t| match (t.worktree_path.is_some(), t.running) {
                (false, _) => Avail::Off("no worktree yet"),
                (true, true) => Avail::Off("a stage runs on it; X aborts first"),
                (true, false) => Avail::On,
            })
        },
        40,
    ),
    b("d", "delete (asks first)", Group::Ticket, Scope::Board, |app| with_task(app, |_| Avail::On), 42),
    b("f", "open or focus the agent's watch tab", Group::Ticket, Scope::Board, |app| with_task(app, |_| Avail::On), 41),
    cmd(
        b(
            "J",
            "link a Jira issue (search or create)",
            Group::Ticket,
            Scope::Board,
            |app| match task_of(app) {
                Some(t) if t.jira_key().is_none() => Avail::On,
                Some(_) => Avail::Hidden,
                None => Avail::Off("no ticket selected"),
            },
            50,
        ),
        "jira",
    ),
    cmd(
        b(
            "J",
            "unlink the Jira issue (asks first)",
            Group::Ticket,
            Scope::Board,
            |app| match task_of(app) {
                Some(t) if t.jira_key().is_some() => Avail::On,
                _ => Avail::Hidden,
            },
            50,
        ),
        "jira",
    ),
    cmd(
        b(
            "R",
            "set the repo (search)",
            Group::Ticket,
            Scope::Board,
            |app| with_task(app, |t| if t.repo_path.is_none() { Avail::On } else { Avail::Off("has a repo; x or :repo <name> replaces it") }),
            78,
        ),
        "repo",
    ),
];

/// `S` ships only inside the popup, the Inbox and the `x` menu: on the board it opens Slack.
const SHIP: Binding = b(
    "S",
    "ship: approve and open the PR",
    Group::Gate,
    Scope::Detail,
    |app| with_task(app, |t| if t.state == "awaiting_ship" { Avail::On } else { Avail::Off("not at the ship gate") }),
    90,
);

const BOARD: &[Binding] = &[
    // Keys reached through the `x` menu only.
    b("x P", "resume every ticket paused on the limit", Group::App, Scope::Board, on, 5),
    cmd(b("x D", "drain / carry on taking new work", Group::App, Scope::Board, on, 5), "drain"),
    cmd(b("x +", "one more slot", Group::App, Scope::Board, on, 5), "slots"),
    cmd(b("x -", "one slot fewer", Group::App, Scope::Board, on, 5), "slots"),
    Binding { scope: Scope::Board, keys: "x S", ..SHIP },
    // The ticket keys whose meaning is the board's own.
    b("e", "edit the plan and the ticket", Group::Ticket, Scope::Board, |app| gate_is(app, &["awaiting_approval"]), 80),
    b(
        "e",
        "edit title, description and criteria",
        Group::Ticket,
        Scope::Board,
        |app| match task_of(app) {
            Some(t) if t.state != "awaiting_approval" => Avail::On,
            Some(_) => Avail::Hidden,
            None => Avail::Off("no ticket selected"),
        },
        80,
    ),
    b(
        "o",
        "open the linked issue in the browser",
        Group::Ticket,
        Scope::Board,
        |app| {
            with_task(app, |t| {
                if t.source.as_ref().and_then(|s| s.link()).is_some() || t.jira.is_some() {
                    Avail::On
                } else {
                    Avail::Off("no issue linked")
                }
            })
        },
        50,
    ),
    // Move.
    b("h / l", "previous / next column", Group::Move, Scope::Board, on, 20),
    b("j / k", "previous / next ticket", Group::Move, Scope::Board, on, 20),
    b("gg", "first ticket in the column", Group::Move, Scope::Board, on, 10),
    b("G", "last ticket in the column", Group::Move, Scope::Board, on, 10),
    b("1-8", "jump to that column", Group::Move, Scope::Board, on, 10),
    b("] / [", "next / previous ticket that needs you", Group::Move, Scope::Board, on, 15),
    cmd(b("enter", "open the ticket's workspace", Group::Move, Scope::Board, |app| with_task(app, |_| Avail::On), 75), "open"),
    // Filter & order.
    cmd(b("/", "filter by title, #id or repo", Group::Filter, Scope::Board, on, 65), "filter"),
    b("!", "only the tickets that need you", Group::Filter, Scope::Board, on, 30),
    b("@", "only this repo's tickets", Group::Filter, Scope::Board, |app| if app.home_repo.is_some() { Avail::On } else { Avail::Off("not inside a repo") }, 30),
    cmd(b("zc", "fold the focused column", Group::Filter, Scope::Board, on, 10), "fold"),
    cmd(b("zo", "unfold the focused column", Group::Filter, Scope::Board, on, 10), "unfold"),
    b("zz", "fold every column but the focused one", Group::Filter, Scope::Board, on, 10),
    cmd(b("gs", "order columns by stage", Group::Filter, Scope::Board, on, 10), "group"),
    cmd(b("gr", "order columns by repo", Group::Filter, Scope::Board, on, 10), "group"),
    cmd(b("ga", "order columns by age", Group::Filter, Scope::Board, on, 10), "group"),
    b("=", "card density: 3 lines, 4, 1", Group::Filter, Scope::Board, on, 35),
    // Views.
    cmd(b("F", "Floor: 7d and 30d metrics", Group::Views, Scope::Board, on, 20), "floor"),
    cmd(b("I", "Inbox: what needs you, by why", Group::Views, Scope::Board, on, 20), "inbox"),
    cmd(b("D", "Digest: what changed since last time", Group::Views, Scope::Board, on, 20), "digest"),
    cmd(b("P", "Pulls: every open PR involving you", Group::Views, Scope::Board, on, 20), "prs"),
    cmd(b("S", "Slack: mentions, DMs and watches", Group::Views, Scope::Board, on, 20), "slack"),
    // Marks & bulk.
    b("v", "mark the ticket; a X d w act on marks", Group::Marks, Scope::Board, |app| with_task(app, |_| Avail::On), 25),
    b("V", "mark the whole column", Group::Marks, Scope::Board, on, 24),
    // App.
    cmd(b("n", "new ticket, then edit it in place", Group::App, Scope::Board, on, 55), "new"),
    b("x", "actions menu for the ticket", Group::App, Scope::Board, |app| with_task(app, |_| Avail::On), 70),
    b(":", "command palette", Group::App, Scope::Board, on, 30),
    b("esc", "clear the filter and the marks", Group::App, Scope::Board, on, 20),
    cmd(b("?", "keys", Group::App, Scope::Board, on, 100), "help"),
    cmd(b("q", "quit", Group::App, Scope::Board, on, 60), "q"),
    // Commands: what `:` understands.
    cmd(b(":q", "quit", Group::Commands, Scope::Board, on, 0), "q"),
    cmd(b(":new <title>", "new ticket, then edit it in place", Group::Commands, Scope::Board, on, 0), "new"),
    cmd(b(":filter <text>", "filter: title, #id or repo (bare clears)", Group::Commands, Scope::Board, on, 0), "filter"),
    cmd(b(":repo <name>", "set the ticket's repo (bare: search)", Group::Commands, Scope::Board, on, 0), "repo"),
    cmd(b(":open <#id>", "open a ticket by id prefix", Group::Commands, Scope::Board, on, 0), "open"),
    cmd(b(":group stage|repo|age", "order columns", Group::Commands, Scope::Board, on, 0), "group"),
    cmd(b(":fold", "fold the focused column", Group::Commands, Scope::Board, on, 0), "fold"),
    cmd(b(":unfold", "unfold the focused column", Group::Commands, Scope::Board, on, 0), "unfold"),
    cmd(b(":setup <repo>", "propose the repo's luna.yaml", Group::Commands, Scope::Board, on, 0), "setup"),
    cmd(b(":slots <n>", "resize the pool", Group::Commands, Scope::Board, on, 0), "slots"),
    cmd(b(":drain", "take no new work", Group::Commands, Scope::Board, on, 0), "drain"),
    cmd(b(":resume", "carry on taking new work", Group::Commands, Scope::Board, on, 0), "resume"),
    cmd(b(":start", "start the selected ticket (a)", Group::Commands, Scope::Board, on, 0), "start"),
    cmd(b(":floor", "open the Floor", Group::Commands, Scope::Board, on, 0), "floor"),
    cmd(b(":inbox", "open the Inbox", Group::Commands, Scope::Board, on, 0), "inbox"),
    cmd(b(":digest", "open the Digest", Group::Commands, Scope::Board, on, 0), "digest"),
    cmd(b(":prs", "open Pulls", Group::Commands, Scope::Board, on, 0), "prs"),
    cmd(b(":slack", "open Slack", Group::Commands, Scope::Board, on, 0), "slack"),
    cmd(b(":jira <KEY>", "link that Jira issue (bare: the search)", Group::Commands, Scope::Board, on, 0), "jira"),
    cmd(b(":help", "this sheet", Group::Commands, Scope::Board, on, 0), "help"),
];

const DETAIL: &[Binding] = &[
    SHIP,
    b("e", "edit: the plan, the cases or the ticket", Group::Ticket, Scope::Detail, |app| with_task(app, |_| Avail::On), 80),
    b("o", "open: the file, the PR or the issue", Group::Ticket, Scope::Detail, |app| with_task(app, |_| Avail::On), 50),
    b("h / l", "previous / next section", Group::Move, Scope::Detail, on, 30),
    b("1-8", "jump to that section", Group::Move, Scope::Detail, on, 10),
    b("j / k", "scroll, or pick a run / file", Group::Move, Scope::Detail, on, 28),
    b("J / K", "scroll a line where j / k pick", Group::Move, Scope::Detail, on, 10),
    b("ctrl+d / ctrl+u", "half a page", Group::Move, Scope::Detail, on, 10),
    b("+", "popup: most of the screen, or all", Group::Move, Scope::Detail, on, 26),
    b("esc / q / enter", "close", Group::Move, Scope::Detail, on, 27),
    cmd(b("?", "keys", Group::App, Scope::Detail, on, 100), "help"),
];

const INBOX: &[Binding] = &[
    SHIP,
    b("e", "edit the ticket in place", Group::Ticket, Scope::Inbox, |app| with_task(app, |_| Avail::On), 80),
    b(
        "o",
        "open the linked issue in the browser",
        Group::Ticket,
        Scope::Inbox,
        |app| {
            with_task(app, |t| {
                if t.source.as_ref().and_then(|s| s.link()).is_some() || t.jira.is_some() {
                    Avail::On
                } else {
                    Avail::Off("no issue linked")
                }
            })
        },
        50,
    ),
    b("A", "approve every ticket in Approve", Group::Marks, Scope::Inbox, on, 60),
    b("j / k", "previous / next ticket", Group::Move, Scope::Inbox, on, 30),
    b("h / l", "previous / next split", Group::Move, Scope::Inbox, on, 29),
    b("1-5", "jump to that split", Group::Move, Scope::Inbox, on, 10),
    b("enter", "open the ticket", Group::Move, Scope::Inbox, |app| with_task(app, |_| Avail::On), 75),
    b("esc / I / q", "close", Group::Move, Scope::Inbox, on, 20),
    cmd(b("?", "keys", Group::App, Scope::Inbox, on, 100), "help"),
];

const PULLS: &[Binding] = &[
    b("m", "merge, delete the branch", Group::Ticket, Scope::Pulls, |app| pr_key(app, PrKey::Merge), 90),
    b("c", "CI fix: an agent repairs the red run", Group::Ticket, Scope::Pulls, |app| pr_key(app, PrKey::CiFix), 85),
    b("v", "review: an agent posts line comments", Group::Ticket, Scope::Pulls, |app| pr_key(app, PrKey::Review), 84),
    b("t", "threads: an agent answers every one", Group::Ticket, Scope::Pulls, |app| pr_key(app, PrKey::Address), 83),
    b("j / k", "previous / next PR", Group::Move, Scope::Pulls, on, 30),
    b("h / l", "previous / next split", Group::Move, Scope::Pulls, on, 29),
    b("1-6", "jump to that split", Group::Move, Scope::Pulls, on, 10),
    b("enter", "jump to its task, else open the PR", Group::Move, Scope::Pulls, |app| if app.pr_under_cursor().is_some() { Avail::On } else { Avail::Off("no PR selected") }, 75),
    b("o", "open the PR in the browser", Group::Move, Scope::Pulls, |app| if app.pr_under_cursor().is_some() { Avail::On } else { Avail::Off("no PR selected") }, 70),
    b("esc / P / q", "close", Group::Move, Scope::Pulls, on, 20),
    b("R", "poll GitHub now", Group::App, Scope::Pulls, on, 60),
    b("x", "the same actions as a menu", Group::App, Scope::Pulls, |app| if app.pr_under_cursor().is_some() { Avail::On } else { Avail::Off("no PR selected") }, 65),
    cmd(b("?", "keys", Group::App, Scope::Pulls, on, 100), "help"),
];

const SLACK: &[Binding] = &[
    b("r", "reply: edit the draft, ctrl+s posts", Group::Ticket, Scope::Slack, |app| slack_key(app, SlackKey::Reply), 90),
    b("t", "ticket: a Backlog task from the thread", Group::Ticket, Scope::Slack, |app| slack_key(app, SlackKey::Task), 85),
    b("d", "done: clear it here", Group::Ticket, Scope::Slack, |app| slack_key(app, SlackKey::Done), 80),
    b("s", "snooze: 1h, 3h, tomorrow or Monday", Group::Ticket, Scope::Slack, |app| slack_key(app, SlackKey::Snooze), 75),
    b("o", "open the message in Slack", Group::Ticket, Scope::Slack, |app| slack_key(app, SlackKey::Open), 60),
    b("N", "nudge: a one-line reminder", Group::Ticket, Scope::Slack, |app| slack_key(app, SlackKey::Nudge), 70),
    b("!", "priority up one step", Group::Ticket, Scope::Slack, |app| slack_key(app, SlackKey::Bump), 40),
    b("-", "priority down one step", Group::Ticket, Scope::Slack, |app| slack_key(app, SlackKey::Lower), 39),
    b("j / k", "previous / next message", Group::Move, Scope::Slack, on, 30),
    b("h / l", "previous / next split", Group::Move, Scope::Slack, on, 29),
    b("1-6", "jump to that split", Group::Move, Scope::Slack, on, 10),
    b("enter", "jump to its ticket, else open in Slack", Group::Move, Scope::Slack, |app| if app.slack_under_cursor().is_some() { Avail::On } else { Avail::Off("no message selected") }, 72),
    b("esc / S / q", "close", Group::Move, Scope::Slack, on, 20),
    b("W", "Watches: handles, keywords, channels", Group::App, Scope::Slack, on, 55),
    b("R", "poll Slack now", Group::App, Scope::Slack, on, 50),
    b("x", "the same actions as a menu", Group::App, Scope::Slack, |app| if app.slack_under_cursor().is_some() { Avail::On } else { Avail::Off("no message selected") }, 65),
    cmd(b("?", "keys", Group::App, Scope::Slack, on, 100), "help"),
];

const WATCHES: &[Binding] = &[
    b("n", "add: @handle, #channel or a word", Group::Ticket, Scope::Watches, on, 90),
    b(
        "d",
        "delete the watch",
        Group::Ticket,
        Scope::Watches,
        |app| match app.watch_under_cursor() {
            None => Avail::Off("no watch selected"),
            Some(w) if w.builtin => Avail::Off("built-in; switch it off instead"),
            Some(_) => Avail::On,
        },
        80,
    ),
    b("space", "switch it on / off", Group::Ticket, Scope::Watches, |app| if app.watch_under_cursor().is_some() { Avail::On } else { Avail::Off("no watch selected") }, 85),
    b("e", "cycle its priority floor", Group::Ticket, Scope::Watches, |app| if app.watch_under_cursor().is_some() { Avail::On } else { Avail::Off("no watch selected") }, 70),
    b("j / k", "previous / next watch", Group::Move, Scope::Watches, on, 30),
    b("esc / W / q", "close", Group::Move, Scope::Watches, on, 20),
    cmd(b("?", "keys", Group::App, Scope::Watches, on, 100), "help"),
];

const DIGEST: &[Binding] = &[
    b("j / k", "previous / next entry", Group::Move, Scope::Digest, on, 30),
    b("enter", "jump to the ticket", Group::Move, Scope::Digest, on, 75),
    b("o", "open its PR or issue in the browser", Group::Ticket, Scope::Digest, on, 60),
    b("esc / D / q", "close", Group::Move, Scope::Digest, on, 20),
    cmd(b("?", "keys", Group::App, Scope::Digest, on, 100), "help"),
];

const FLOOR: &[Binding] = &[
    b("tab / shift+tab", "focus the next / previous repo", Group::Move, Scope::Floor, on, 70),
    b("R", "refresh the numbers", Group::App, Scope::Floor, on, 60),
    b("esc / F / q", "close", Group::Move, Scope::Floor, on, 20),
    cmd(b("?", "keys", Group::App, Scope::Floor, on, 100), "help"),
];

const EDITOR: &[Binding] = &[
    b("i a o", "insert", Group::App, Scope::Editor, in_normal, 90),
    b("dd x", "delete", Group::App, Scope::Editor, in_normal, 80),
    b("u ^r", "undo", Group::App, Scope::Editor, in_normal, 70),
    b("esc", "normal", Group::App, Scope::Editor, in_insert, 90),
    b("ctrl+s", "save", Group::App, Scope::Editor, on, 60),
    b("esc q", "cancel", Group::App, Scope::Editor, in_normal, 50),
];

const HELP: &[Binding] = &[
    b("j / k", "previous / next row", Group::Move, Scope::Help, on, 30),
    b("ctrl+d / ctrl+u", "half a page", Group::Move, Scope::Help, on, 20),
    b("/", "search every view's keys", Group::App, Scope::Help, on, 80),
    b("?", "long form: every group as rows", Group::App, Scope::Help, on, 70),
    b("enter", "run the row's key", Group::App, Scope::Help, on, 90),
    b("esc / q", "close", Group::App, Scope::Help, on, 60),
];

const TOTAL: usize = BOARD.len() + SHARED.len() + count_except(SHARED, "J") + count_except(SHARED, "A") + DETAIL.len() + INBOX.len() + PULLS.len() + SLACK.len() + WATCHES.len() + DIGEST.len() + FLOOR.len() + EDITOR.len() + HELP.len();

/// Copies `rows` into `out` under `scope`, skipping the key `except` (the view handles it
/// itself: `A` approves the Inbox split, `J` scrolls the popup).
const fn copy_into(rows: &[Binding], scope: Scope, except: &str, out: &mut [Binding; TOTAL], at: &mut usize) {
    let mut j = 0;
    while j < rows.len() {
        let mut row = rows[j];
        if !str_eq(row.keys, except) {
            row.scope = scope;
            out[*at] = row;
            *at += 1;
        }
        j += 1;
    }
}

const fn str_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn count_except(rows: &[Binding], except: &str) -> usize {
    let mut n = 0;
    let mut j = 0;
    while j < rows.len() {
        if !str_eq(rows[j].keys, except) {
            n += 1;
        }
        j += 1;
    }
    n
}

const fn build() -> [Binding; TOTAL] {
    let mut out = [b("", "", Group::App, Scope::Board, on, 0); TOTAL];
    let mut at = 0;
    copy_into(SHARED, Scope::Board, "", &mut out, &mut at);
    copy_into(BOARD, Scope::Board, "", &mut out, &mut at);
    // `J` scrolls the popup, so the Jira link is the board's and the Inbox's key, not the popup's.
    copy_into(SHARED, Scope::Detail, "J", &mut out, &mut at);
    copy_into(DETAIL, Scope::Detail, "", &mut out, &mut at);
    // `A` approves the whole split in the Inbox.
    copy_into(SHARED, Scope::Inbox, "A", &mut out, &mut at);
    copy_into(INBOX, Scope::Inbox, "", &mut out, &mut at);
    copy_into(PULLS, Scope::Pulls, "", &mut out, &mut at);
    copy_into(SLACK, Scope::Slack, "", &mut out, &mut at);
    copy_into(WATCHES, Scope::Watches, "", &mut out, &mut at);
    copy_into(DIGEST, Scope::Digest, "", &mut out, &mut at);
    copy_into(FLOOR, Scope::Floor, "", &mut out, &mut at);
    copy_into(EDITOR, Scope::Editor, "", &mut out, &mut at);
    copy_into(HELP, Scope::Help, "", &mut out, &mut at);
    out
}

/// Every key of every scope. Order within a scope is declaration order.
pub const BINDINGS: &[Binding] = &build();

// ---------- queries ----------

/// The scope the next key goes to: the sheet, an editor, the Watches popup, the ticket popup,
/// a full-screen view, else the board. Prompts (filter, reason, confirms) read as their view.
pub fn active_scope(app: &App) -> Scope {
    match &app.mode {
        Mode::Help { scope, .. } => return *scope,
        Mode::EditTicket { .. } | Mode::EditPlan { .. } | Mode::EditCases { .. } | Mode::Answer { .. } | Mode::SlackReply { .. } => return Scope::Editor,
        Mode::Detail(_) => return Scope::Detail,
        _ => {}
    }
    if app.slack.as_ref().is_some_and(|s| s.watches.is_some()) {
        return Scope::Watches;
    }
    if app.floor.is_some() {
        Scope::Floor
    } else if app.inbox.is_some() {
        Scope::Inbox
    } else if app.digest.is_some() {
        Scope::Digest
    } else if app.pulls.is_some() {
        Scope::Pulls
    } else if app.slack.is_some() {
        Scope::Slack
    } else {
        Scope::Board
    }
}

/// The bindings of `scope` that apply right now, `Hidden` ones left out, in table order.
pub fn bindings_for(app: &App, scope: Scope) -> Vec<(&'static Binding, Avail)> {
    BINDINGS
        .iter()
        .filter(|b| b.scope == scope)
        .filter_map(|b| match b.avail(app) {
            Avail::Hidden => None,
            avail => Some((b, avail)),
        })
        .collect()
}

/// The `n` heaviest `On` bindings of `scope`, for the footer. Menu-only chords and the `:`
/// commands are not keys you press, so they stay out.
pub fn footer_keys(app: &App, scope: Scope, n: usize) -> Vec<&'static Binding> {
    let mut found: Vec<&Binding> = bindings_for(app, scope)
        .into_iter()
        .filter(|(b, avail)| avail.is_on() && b.menu_key().is_none() && b.group != Group::Commands)
        .map(|(b, _)| b)
        .collect();
    found.sort_by_key(|b| std::cmp::Reverse(b.weight));
    found.truncate(n);
    found
}

/// Bindings of every scope whose keys, label or command contain `query`, case-insensitively.
pub fn search(query: &str) -> Vec<(Scope, &'static Binding)> {
    let needle = query.trim().to_lowercase();
    BINDINGS
        .iter()
        .filter(|b| {
            needle.is_empty()
                || b.keys.to_lowercase().contains(&needle)
                || b.label.to_lowercase().contains(&needle)
                || b.command.is_some_and(|c| c.contains(&needle))
        })
        .map(|b| (b.scope, b))
        .collect()
}

/// The rows of a scope's `x` menu: the keys that act on the item under the cursor, with the
/// menu-only chords first on the board. `Off` rows come with their reason; `Hidden` are left out.
pub fn menu(app: &App, scope: Scope) -> Vec<(&'static Binding, Avail)> {
    let rows = bindings_for(app, scope);
    let mut out: Vec<(&Binding, Avail)> = rows.iter().filter(|(b, _)| b.menu_key().is_some()).copied().collect();
    out.extend(rows.iter().filter(|(b, _)| b.menu_key().is_none() && matches!(b.group, Group::Gate | Group::Ticket)).copied());
    out
}

/// The char a menu row answers to: `P` for `"x P"`, else the row's one-char key.
pub fn menu_char(binding: &Binding) -> Option<char> {
    binding.menu_key().or_else(|| {
        let mut chars = binding.first().chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) => Some(c),
            _ => None,
        }
    })
}

/// The `:` commands, in table order: (name, label).
pub fn commands() -> Vec<(&'static str, &'static Binding)> {
    BINDINGS.iter().filter(|b| b.scope == Scope::Board && b.group == Group::Commands).filter_map(|b| b.command.map(|c| (c, b))).collect()
}

/// The commands `typed` could become: every name it is a prefix of (all of them when empty).
/// Once a space is typed the name is settled, so nothing completes.
pub fn completions(typed: &str) -> Vec<(&'static str, &'static Binding)> {
    if typed.contains(char::is_whitespace) {
        return Vec::new();
    }
    commands().into_iter().filter(|(name, _)| name.starts_with(typed)).collect()
}

/// The which-key strip after a prefix key: the second keys and what each does, `esc` last.
pub fn which_key(prefix: char) -> Vec<(char, &'static str)> {
    BINDINGS
        .iter()
        .filter(|b| b.scope == Scope::Board)
        .flat_map(|b| b.tokens().map(move |t| (t, b.label)))
        .filter_map(|(t, label)| {
            let mut chars = t.chars();
            match (chars.next(), chars.next(), chars.next()) {
                (Some(p), Some(second), None) if p == prefix => Some((second, label)),
                _ => None,
            }
        })
        .collect()
}

/// The editors' key line for the title bar, following the vim mode.
pub fn editor_line(app: &App) -> String {
    let mode = match editor_mode(app) {
        Some(vim::Mode::Insert) => "insert",
        _ => "normal",
    };
    let mut parts = vec![mode.to_string()];
    parts.extend(bindings_for(app, Scope::Editor).into_iter().filter(|(_, a)| a.is_on()).map(|(b, _)| format!("{} {}", b.keys, b.label)));
    parts.join(" · ")
}

/// One line of keys for a group that folds: `h l  j k  gg G  1-8  ] [  enter`.
pub fn strip(rows: &[(&Binding, Avail)]) -> String {
    rows.iter().filter(|(_, a)| a.is_on()).map(|(b, _)| b.keys.replace(" / ", " ")).collect::<Vec<_>>().join("  ")
}

// ---------- the sheet ----------

/// A dense group (more `On` rows than this) folds to a strip of keys unless the sheet is long.
const STRIP_FROM: usize = 3;

/// One line of the `?` sheet, before layout.
#[derive(Clone, Debug)]
pub enum HelpRow {
    Heading(&'static str),
    /// A key: `foreign` when it belongs to another view than the sheet's (a search hit).
    Key { binding: &'static Binding, avail: Avail, foreign: bool },
    /// A dense group folded to its keys: `h l  j k  gg G  1-8  ] [  enter`.
    Strip(String),
}

/// The sheet's sections, one per group that has a row, in `Group::ORDER`: the heading, then
/// the rows, or one strip of keys for a dense group unless `long`. With `query`, one section of
/// every view's matching keys, each row saying which view it belongs to when not this one.
pub fn help_sections(app: &App, scope: Scope, long: bool, query: Option<&str>) -> Vec<Vec<HelpRow>> {
    if let Some(query) = query {
        let rows: Vec<HelpRow> = search(query)
            .into_iter()
            .filter(|(s, _)| *s != Scope::Help)
            .filter_map(|(s, b)| match b.avail(app) {
                Avail::Hidden => None,
                avail => Some(HelpRow::Key { binding: b, avail, foreign: s != scope }),
            })
            .collect();
        let heading = if rows.is_empty() { "no key matches" } else { "every view's keys" };
        let mut section = vec![HelpRow::Heading(heading)];
        section.extend(rows);
        return vec![section];
    }
    let rows = bindings_for(app, scope);
    Group::ORDER
        .iter()
        .filter_map(|group| {
            let in_group: Vec<(&Binding, Avail)> = rows.iter().filter(|(b, _)| b.group == *group).copied().collect();
            if in_group.is_empty() {
                return None;
            }
            let mut section = vec![HelpRow::Heading(group.heading(scope))];
            // A dense group folds to its keys; a small one (a view with three keys) reads better as rows.
            if group.strip() && !long && in_group.iter().filter(|(_, a)| a.is_on()).count() > STRIP_FROM {
                section.push(HelpRow::Strip(strip(&in_group)));
            } else {
                section.extend(in_group.into_iter().map(|(binding, avail)| HelpRow::Key { binding, avail, foreign: false }));
            }
            Some(section)
        })
        .collect()
}

/// The sections flattened, in reading order: what the cursor counts rows in.
pub fn help_rows_for(app: &App, scope: Scope, long: bool, query: Option<&str>) -> Vec<HelpRow> {
    help_sections(app, scope, long, query).into_iter().flatten().collect()
}

/// The sheet's title: the ticket and its state when one is in focus, else the view's name.
pub fn help_title(app: &App, scope: Scope) -> String {
    match (scope, app.focus_task()) {
        (Scope::Board | Scope::Detail | Scope::Inbox, Some(task)) => format!(" Keys · ticket #{} {} · {} ", task.short_id(), task.title, task.status_label()),
        _ => format!(" Keys · {} ", scope.name()),
    }
}

/// The folded line for the layer under a popup: `▸ board keys: h l  j k …`.
pub fn help_under_line(app: &App, scope: Scope) -> Option<String> {
    let under = scope.under()?;
    let rows: Vec<(&Binding, Avail)> = bindings_for(app, under).into_iter().filter(|(b, _)| b.menu_key().is_none() && b.group != Group::Commands).collect();
    Some(format!("▸ {} keys: {}", under.name().to_lowercase(), strip(&rows)))
}

/// The key presses a token stands for, to run a row as if typed: `"gg"` is two, `"x P"` two,
/// `"enter"` one, `"ctrl+d"` one with the modifier.
pub fn key_events(token: &str) -> Vec<ratatui::crossterm::event::KeyEvent> {
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    let named = |code: KeyCode| vec![KeyEvent::from(code)];
    match token {
        "enter" => named(KeyCode::Enter),
        "esc" => named(KeyCode::Esc),
        "tab" => named(KeyCode::Tab),
        "shift+tab" => named(KeyCode::BackTab),
        "space" => named(KeyCode::Char(' ')),
        t if t.starts_with("ctrl+") => t.chars().last().map(|c| vec![KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)]).unwrap_or_default(),
        t if t.starts_with('^') && t.len() == 2 => t.chars().last().map(|c| vec![KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)]).unwrap_or_default(),
        t if t.contains('-') && t.len() == 3 => t.chars().next().map(|c| named(KeyCode::Char(c))).unwrap_or_default(),
        t => t.chars().filter(|c| *c != ' ').map(|c| KeyEvent::from(KeyCode::Char(c))).collect(),
    }
}

// ---------- markdown ----------

/// The README's key tables, one per scope, each inside `<!-- keys:start <slug> -->` and
/// `<!-- keys:end -->` so `--keys-md <file>` can replace them in place.
pub fn markdown() -> String {
    let mut out = String::new();
    for scope in Scope::ALL {
        out.push_str(&markdown_block(scope));
        out.push('\n');
    }
    out
}

pub fn markdown_block(scope: Scope) -> String {
    let mut out = format!("<!-- keys:start {} -->\n", scope.slug());
    let code = |text: &str| format!("`{}`", text.replace('|', "\\|"));
    for group in Group::ORDER {
        let rows: Vec<&Binding> = BINDINGS.iter().filter(|b| b.scope == scope && b.group == group).collect();
        if rows.is_empty() {
            continue;
        }
        out.push_str(&format!("**{}**\n\n| Key | Does |\n|---|---|\n", group.heading(scope)));
        // One row per key: the meanings of a key with several (`a` per gate) share it.
        let mut i = 0;
        while i < rows.len() {
            let b = rows[i];
            let mut labels = vec![b.label];
            while i + 1 < rows.len() && rows[i + 1].keys == b.keys {
                i += 1;
                if !labels.contains(&rows[i].label) {
                    labels.push(rows[i].label);
                }
            }
            let keys = if b.menu_key().is_some() { format!("`x` then {}", code(&b.menu_keys())) } else { code(b.keys) };
            out.push_str(&format!("| {keys} | {} |\n", labels.join("; ").replace('|', "\\|")));
            i += 1;
        }
        out.push('\n');
    }
    out.push_str("<!-- keys:end -->\n");
    out
}

/// `text` with every `<!-- keys:start <slug> -->` … `<!-- keys:end -->` block replaced by the
/// registry's; blocks for scopes the text does not carry are left out, text around them kept.
pub fn splice_markdown(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<!-- keys:start ") {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(head_end) = after.find("-->") else { break };
        let slug = after["<!-- keys:start ".len()..head_end].trim();
        let Some(end) = after.find("<!-- keys:end -->") else { break };
        let tail = end + "<!-- keys:end -->".len();
        match Scope::ALL.iter().find(|s| s.slug() == slug) {
            Some(scope) => out.push_str(markdown_block(*scope).trim_end_matches('\n')),
            None => out.push_str(&after[..tail]),
        }
        rest = &after[tail..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::handled;
    use crate::client::Machine;
    use crate::model::Task;

    fn task(id: &str, state: &str, repo: bool, running: bool, worktree: bool) -> Task {
        let repo = if repo { "\"/r/app\"" } else { "null" };
        let worktree = if worktree { "\"/w/app\"" } else { "null" };
        let waiting = state.starts_with("awaiting") || matches!(state, "escalated" | "reviewing_memory");
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","title":"Login page","description":"","criteria":[],
            "repoPath":{repo},"branch":null,"worktreePath":{worktree},"state":"{state}","column":"Build",
            "waitingOnYou":{waiting},"running":{running},"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
        ))
        .unwrap()
    }

    fn app_with(tasks: Vec<Task>) -> App {
        let mut app = App::new(Machine::from_env());
        app.tasks = tasks;
        app.focus = app.tasks.first().map(|t| t.column_index()).unwrap_or(0);
        app
    }

    /// The states the uniqueness and footer tests walk: a draft without a repo, each gate, a
    /// running stage, an escalation.
    fn fixtures() -> Vec<App> {
        vec![
            app_with(vec![task("t1", "draft", false, false, false)]),
            app_with(vec![task("t1", "draft", true, false, false)]),
            app_with(vec![task("t1", "awaiting_approval", true, false, true)]),
            app_with(vec![task("t1", "awaiting_test_check", true, false, true)]),
            app_with(vec![task("t1", "awaiting_ship", true, false, true)]),
            app_with(vec![task("t1", "implementing", true, true, true)]),
            app_with(vec![task("t1", "escalated", true, false, true)]),
            app_with(vec![task("t1", "paused_rate_limit", true, false, true)]),
            app_with(vec![task("t1", "reviewing_memory", true, false, true)]),
            app_with(vec![task("t1", "closed", true, false, false)]),
            app_with(Vec::new()),
        ]
    }

    #[test]
    fn labels_fit_in_forty_columns_and_every_scope_has_its_question_mark() {
        for b in BINDINGS {
            assert!(b.label.chars().count() <= 40, "{:?} {:?}: {}", b.scope, b.keys, b.label);
            assert!(!b.keys.is_empty() && !b.label.is_empty());
        }
        for scope in Scope::ALL {
            if matches!(scope, Scope::Editor | Scope::Help) {
                continue;
            }
            assert!(BINDINGS.iter().any(|b| b.scope == scope && b.keys == "?"), "{scope:?} has ?");
        }
    }

    #[test]
    fn no_two_on_bindings_share_a_key_in_one_scope_whatever_the_state() {
        for app in fixtures() {
            for scope in Scope::ALL {
                let rows = bindings_for(&app, scope);
                let mut seen: Vec<&str> = Vec::new();
                for (b, avail) in rows {
                    if !avail.is_on() || b.group == Group::Commands {
                        continue;
                    }
                    assert!(!seen.contains(&b.first()), "{scope:?}: {} twice for {:?}", b.first(), app.focus_task().map(|t| t.state.clone()));
                    seen.push(b.first());
                }
            }
        }
    }

    #[test]
    fn the_a_entries_are_mutually_exclusive_and_one_always_shows() {
        for app in fixtures() {
            let shown: Vec<&Binding> = bindings_for(&app, Scope::Board).into_iter().filter(|(b, _)| b.keys == "a").map(|(b, _)| b).collect();
            assert_eq!(shown.len(), 1, "{:?}: {:?}", app.focus_task().map(|t| t.state.clone()), shown.iter().map(|b| b.label).collect::<Vec<_>>());
        }
        let approval = app_with(vec![task("t1", "awaiting_approval", true, false, true)]);
        let a = bindings_for(&approval, Scope::Board).into_iter().find(|(b, _)| b.keys == "a").unwrap();
        assert_eq!((a.0.label, a.1), ("approve the plan", Avail::On));
        let running = app_with(vec![task("t1", "implementing", true, true, true)]);
        let a = bindings_for(&running, Scope::Board).into_iter().find(|(b, _)| b.keys == "a").unwrap();
        assert_eq!(a.1, Avail::Off("a stage is running; X aborts it"));
    }

    #[test]
    fn off_reasons_mirror_the_handlers_refusals() {
        let running = app_with(vec![task("t1", "implementing", true, true, true)]);
        let find = |app: &App, key: &str| bindings_for(app, Scope::Board).into_iter().find(|(b, _)| b.keys == key).map(|(_, a)| a).unwrap();
        assert_eq!(find(&running, "r"), Avail::Off("only a setup, plan or tests go back"));
        assert_eq!(find(&running, "w"), Avail::Off("a stage runs on it; X aborts first"));
        assert_eq!(find(&running, "X"), Avail::On);
        assert_eq!(find(&running, "A"), Avail::Off("no memory review waiting"));
        assert_eq!(find(&running, "R"), Avail::Off("has a repo; x or :repo <name> replaces it"));
        let draft = app_with(vec![task("t1", "draft", false, false, false)]);
        assert_eq!(find(&draft, "R"), Avail::On);
        assert_eq!(find(&draft, "w"), Avail::Off("no worktree yet"));
        assert_eq!(find(&draft, "X"), Avail::Off("nothing is running"));
        assert_eq!(find(&draft, "o"), Avail::Off("no issue linked"));
        let none = app_with(Vec::new());
        assert_eq!(find(&none, "a"), Avail::Off("no ticket selected"));
        assert_eq!(find(&none, "enter"), Avail::Off("no ticket selected"));
    }

    #[test]
    fn the_footer_changes_with_the_ticket() {
        let names = |app: &App| footer_keys(app, Scope::Board, 7).into_iter().map(|b| format!("{} {}", b.keys, b.label)).collect::<Vec<_>>();
        let approval = names(&app_with(vec![task("t1", "awaiting_approval", true, false, true)]));
        assert_eq!(approval[0], "? keys");
        assert_eq!(approval[1], "a approve the plan");
        assert!(approval.contains(&"r send back with a reason".to_string()) && approval.contains(&"e edit the plan and the ticket".to_string()), "{approval:?}");
        let draft = names(&app_with(vec![task("t1", "draft", false, false, false)]));
        assert_eq!(draft[1], "a start");
        assert!(draft.contains(&"R set the repo (search)".to_string()), "a draft without a repo weights R up: {draft:?}");
        assert!(!draft.iter().any(|k| k.starts_with("r ")), "nothing to send back on a draft: {draft:?}");
        let ship = names(&app_with(vec![task("t1", "awaiting_ship", true, false, true)]));
        assert_eq!(ship[1], "a ship: approve and open the PR");
        assert!(footer_keys(&approval_app(), Scope::Board, 7).iter().all(|b| b.menu_key().is_none()), "no menu chords in the footer");
    }

    fn approval_app() -> App {
        app_with(vec![task("t1", "awaiting_approval", true, false, true)])
    }

    #[test]
    fn search_finds_keys_across_scopes_and_says_where() {
        let hits = search("merge");
        assert!(hits.iter().any(|(s, b)| *s == Scope::Pulls && b.keys == "m"), "{:?}", hits.iter().map(|(s, b)| (s, b.keys)).collect::<Vec<_>>());
        let hits = search("NUDGE");
        assert!(hits.iter().all(|(s, _)| *s == Scope::Slack));
        assert!(search("").len() == BINDINGS.len());
        assert!(search("fold").iter().any(|(_, b)| b.command == Some("fold")));
    }

    #[test]
    fn menus_hold_the_item_keys_with_the_board_chords_first() {
        let app = approval_app();
        let board: Vec<String> = menu(&app, Scope::Board).iter().map(|(b, _)| b.menu_keys()).collect();
        assert_eq!(&board[..5], &["P", "D", "+", "-", "S"], "{board:?}");
        assert!(board.contains(&"a".to_string()) && board.contains(&"R".to_string()) && board.contains(&"d".to_string()), "{board:?}");
        assert!(!board.contains(&"n".to_string()) && !board.contains(&"h / l".to_string()), "{board:?}");
        for (b, avail) in menu(&app, Scope::Board) {
            if b.keys == "x S" {
                assert_eq!(avail, Avail::Off("not at the ship gate"));
            }
        }
        // The PR and Slack menus run `PrKey::ALL` / `SlackKey::ALL` by cursor, so the rows must be those, in that order.
        let pulls: Vec<String> = menu(&app, Scope::Pulls).iter().map(|(b, _)| b.keys.to_string()).collect();
        assert_eq!(pulls, PrKey::ALL.iter().map(|k| k.key().to_string()).collect::<Vec<_>>());
        let slack: Vec<String> = menu(&app, Scope::Slack).iter().map(|(b, _)| b.keys.to_string()).collect();
        assert_eq!(slack, SlackKey::ALL.iter().map(|k| k.key().to_string()).collect::<Vec<_>>());
        assert_eq!(slack[5], "N", "the nudge moved to N");
    }

    #[test]
    fn completions_narrow_by_prefix_and_stop_at_the_first_space() {
        let names = |typed: &str| completions(typed).into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        assert_eq!(names("f"), ["filter", "fold", "floor"]);
        assert_eq!(names("fo"), ["fold"]);
        assert!(names("filter x").is_empty());
        assert_eq!(names("").len(), commands().len());
    }

    #[test]
    fn which_key_lists_the_second_keys_of_a_prefix() {
        let g: Vec<char> = which_key('g').iter().map(|(c, _)| *c).collect();
        assert_eq!(g, ['g', 's', 'r', 'a']);
        let z: Vec<char> = which_key('z').iter().map(|(c, _)| *c).collect();
        assert_eq!(z, ['c', 'o', 'z']);
        assert!(which_key('q').is_empty());
    }

    #[test]
    fn the_editor_line_follows_the_vim_mode() {
        let mut app = app_with(vec![task("t1", "draft", true, false, false)]);
        app.mode = Mode::EditTicket { id: "t1".into(), area: tui_textarea::TextArea::default(), vim: vim::Vim::new() };
        assert_eq!(editor_line(&app), "normal · i a o insert · dd x delete · u ^r undo · ctrl+s save · esc q cancel");
        app.handle_key(ratatui::crossterm::event::KeyEvent::from(ratatui::crossterm::event::KeyCode::Char('i')));
        assert_eq!(editor_line(&app), "insert · esc normal · ctrl+s save");
    }

    #[test]
    fn active_scope_prefers_the_sheet_then_editors_then_popups_then_views() {
        let mut app = app_with(vec![task("t1", "draft", true, false, false)]);
        assert_eq!(active_scope(&app), Scope::Board);
        app.pulls = Some(Default::default());
        assert_eq!(active_scope(&app), Scope::Pulls);
        app.slack = Some(crate::slack::SlackState { watches: Some(Default::default()), ..Default::default() });
        assert_eq!(active_scope(&app), Scope::Watches, "the popup over Slack beats every view");
        app.mode = Mode::Detail("t1".into());
        assert_eq!(active_scope(&app), Scope::Detail);
        app.mode = Mode::EditTicket { id: "t1".into(), area: tui_textarea::TextArea::default(), vim: vim::Vim::new() };
        assert_eq!(active_scope(&app), Scope::Editor);
        app.mode = Mode::Help { scope: Scope::Digest, long: false, query: None, cursor: 0 };
        assert_eq!(active_scope(&app), Scope::Digest);
    }

    /// The tokens of every binding of `scope` the parity test compares with the handler.
    fn tokens(scope: Scope) -> Vec<&'static str> {
        BINDINGS.iter().filter(|b| b.scope == scope && b.group != Group::Commands && b.menu_key().is_none()).flat_map(|b| b.tokens()).collect()
    }

    fn parity(scope: Scope, handled: &[&str]) {
        let have = tokens(scope);
        for key in handled {
            assert!(have.contains(key), "{scope:?}: the handler matches {key:?} but the registry has no binding for it");
        }
        for key in &have {
            assert!(handled.contains(key), "{scope:?}: the registry lists {key:?} but the handler does not match it");
        }
    }

    #[test]
    fn every_handled_char_has_a_binding_and_every_binding_is_handled() {
        parity(Scope::Board, handled::BOARD);
        parity(Scope::Detail, handled::DETAIL);
        parity(Scope::Inbox, handled::INBOX);
        parity(Scope::Pulls, handled::PULLS);
        parity(Scope::Slack, handled::SLACK);
        parity(Scope::Watches, handled::WATCHES);
        parity(Scope::Digest, handled::DIGEST);
        parity(Scope::Floor, handled::FLOOR);
        parity(Scope::Help, handled::HELP);
        // The board's menu chords are handled by the menu, not the board.
        let chords: Vec<char> = BINDINGS.iter().filter(|b| b.scope == Scope::Board).filter_map(Binding::menu_key).collect();
        for c in &chords {
            assert!(handled::ACTIONS.contains(&c.to_string().as_str()), "x {c} is in the registry but not the menu");
        }
        let menu_keys: Vec<String> = menu(&approval_app(), Scope::Board).iter().filter_map(|(b, _)| menu_char(b)).map(|c| c.to_string()).collect();
        for key in handled::ACTIONS {
            assert!(menu_keys.contains(&key.to_string()), "the menu handles {key} but no row offers it");
        }
        // The editor's keys are vim's: every token names one of its normal-mode keys or a named key.
        for token in tokens(Scope::Editor) {
            assert!(crate::vim::HANDLED.contains(&token), "editor token {token:?} is not a vim key");
        }
        // Every `:` command the registry lists is one `run_command` knows, and the reverse.
        let names: Vec<&str> = commands().into_iter().map(|(n, _)| n).collect();
        for name in handled::COMMANDS {
            assert!(names.contains(name), "run_command knows {name} but the registry does not list it");
        }
        for name in &names {
            assert!(handled::COMMANDS.contains(name), "the registry lists :{name} but run_command does not know it");
        }
    }

    #[test]
    fn markdown_has_one_block_per_scope_and_splices_in_place() {
        let md = markdown();
        for scope in Scope::ALL {
            assert!(md.contains(&format!("<!-- keys:start {} -->", scope.slug())));
        }
        assert!(md.contains("| `a` | start; approve the setup; answer triage's questions; approve the plan;") && md.contains("| `x` then `P` |"), "{md}");
        assert!(md.contains("**Commands (type after :)**") && md.contains("| `:group stage\\|repo\\|age` |"), "{md}");
        let readme = "intro\n<!-- keys:start pulls -->\nold\n<!-- keys:end -->\nmiddle\n<!-- keys:start nope -->\nkept\n<!-- keys:end -->\nend\n";
        let spliced = splice_markdown(readme);
        assert!(spliced.starts_with("intro\n<!-- keys:start pulls -->\n**Pull request**\n\n| Key | Does |"), "{spliced}");
        assert!(spliced.contains("| `m` | merge, delete the branch |") && !spliced.contains("old"));
        assert!(spliced.contains("<!-- keys:start nope -->\nkept\n<!-- keys:end -->\nend\n"), "{spliced}");
        assert_eq!(splice_markdown(&spliced), spliced, "idempotent");
    }

    #[test]
    fn the_readme_blocks_are_what_the_registry_prints() {
        let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/README.md")).unwrap();
        assert_eq!(splice_markdown(&readme), readme, "run `pnpm board:keys` to regenerate the README's key tables");
        for scope in [Scope::Board, Scope::Detail, Scope::Pulls, Scope::Slack, Scope::Watches, Scope::Inbox, Scope::Digest, Scope::Floor] {
            assert!(readme.contains(&format!("<!-- keys:start {} -->", scope.slug())), "the README documents {scope:?}");
                }
    }
}
