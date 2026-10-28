//! Tickets as the machine describes them (contracts/src/api.ts), how the board shows them,
//! and the markdown they are edited as. No I/O here.

use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

/// Board columns, named after the pipeline stages. Same order as the machine's contracts.
pub const COLUMNS: [&str; 8] =
    ["Intake", "Triage", "Approved", "Build", "Verify", "Evidence", "Ship", "Done"];

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Diff {
    pub added: u64,
    pub removed: u64,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Tests {
    pub passed: u64,
    pub total: u64,
}

/// A running stage nobody has heard from for this long reads as stale: a dead `docker logs -f`
/// tab should not look like progress.
pub const STALE_SECS: u64 = 20 * 60;

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Retries {
    pub verify: u32,
    pub e2e: u32,
    pub ci: u32,
    pub total: u32,
}

/// Where a task came from, when it was created from an outside issue. `kind` stays a plain
/// string so kinds this board does not know still load.
#[derive(Deserialize, Clone, Debug)]
pub struct TaskSource {
    #[allow(dead_code)] // kept for kinds beyond GitHub; the board only labels GitHub today
    pub kind: String,
    pub repo: String,
    pub number: u64,
    pub url: String,
}

fn feature_route() -> String {
    "feature".to_string()
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub criteria: Vec<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub state: String,
    pub column: String,
    /// Which graph the task walks: `feature` (a ticket), `setup` (proposes the repo's luna.yaml,
    /// then closes) or a PR task's route. Absent from machines that predate it.
    #[serde(default = "feature_route")]
    pub route: String,
    pub waiting_on_you: bool,
    pub running: bool,
    /// Ready to run, but waiting for a free concurrency slot.
    pub queued: bool,
    pub retries: Retries,
    pub resume_to: Option<String>,
    pub reason: Option<String>,
    /// What every stage run of this ticket has cost so far; None when unknown.
    #[serde(default)]
    pub spent_usd: Option<f64>,
    /// Wall time its stage runs took; the branch's diff against its base; verifying's results.
    #[serde(default)]
    pub worked_ms: Option<f64>,
    #[serde(default)]
    pub diff: Option<Diff>,
    #[serde(default)]
    pub tests: Option<Tests>,
    pub created_at: String,
    pub updated_at: String,
    /// Absent on tasks made by hand, and from machines that predate it.
    #[serde(default)]
    pub source: Option<TaskSource>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StageRun {
    pub stage: String,
    pub attempt: u32,
    pub status: String,
    /// What the run cost and how many model turns it took; null while it runs or for a stub.
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub turns: Option<u32>,
}

impl StageRun {
    /// `$0.42 · 18 turns`, or None when the run has no usage yet.
    pub fn usage_label(&self) -> Option<String> {
        match (self.cost_usd, self.turns) {
            (None, None) => None,
            (cost, turns) => Some(
                [cost.map(|c| format!("${c:.2}")), turns.map(|t| format!("{t} turns"))]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · "),
            ),
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub requested: Value,
    pub decision: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub task_id: String,
    pub kind: String,
    pub payload: Value,
    pub at: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub task: Task,
    pub stage_runs: Vec<StageRun>,
    pub approvals: Vec<Approval>,
    pub events: Vec<TaskEvent>,
}

impl TaskDetail {
    /// What every run of this ticket cost so far; None when no run reported a cost.
    pub fn spent_usd(&self) -> Option<f64> {
        let costs: Vec<f64> = self.stage_runs.iter().filter_map(|r| r.cost_usd).collect();
        if costs.is_empty() { None } else { Some(costs.iter().sum()) }
    }

    /// The gate the task waits at, with what the stage before it produced.
    pub fn open_approval(&self) -> Option<&Approval> {
        self.approvals.iter().rev().find(|a| a.decision.is_none())
    }
}

/// Messages on the machine's `/events` stream.
#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
pub enum StreamMessage {
    #[serde(rename = "task.updated")]
    Updated { task: Task },
    #[serde(rename = "task.event")]
    Event { event: TaskEvent },
    #[serde(rename = "task.deleted")]
    Deleted { id: String },
    /// A stage container is running: follow it in the task's watch tab.
    #[serde(rename = "stage.started", rename_all = "camelCase")]
    StageStarted { task_id: String, label: String, cwd: String, container: String },
    /// The task is done or deleted: its watch tab can go.
    #[serde(rename = "task.closed")]
    Closed { id: String },
    /// A spend crossed 80, 90 or 100% of a ceiling.
    #[serde(rename = "budget.alert")]
    BudgetAlert { alert: BudgetAlert },
}

/// `budget.alert`: a task's, a repo's month's or the day's spend passing a threshold.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetAlert {
    pub scope: String,
    pub task_id: String,
    pub repo: Option<String>,
    pub pct: u8,
    pub spent_usd: f64,
    pub limit_usd: f64,
}

impl BudgetAlert {
    /// `repo luna-tui at 90%: $18.00 of $20.00 this month`.
    pub fn line(&self) -> String {
        let repo = self.repo.as_deref().and_then(|p| p.trim_end_matches('/').rsplit('/').next()).unwrap_or("?");
        let (what, when) = match self.scope.as_str() {
            "task" => (format!("task #{}", short_id(&self.task_id)), ""),
            "repo" => (format!("repo {repo}"), " this month"),
            _ => ("the day".to_string(), ""),
        };
        format!("{what} at {}%: ${:.2} of ${:.2}{when}", self.pct, self.spent_usd, self.limit_usd)
    }
}

/// Median and 90th percentile; `None` when there is no data.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Stats {
    pub median: Option<f64>,
    pub p90: Option<f64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct StageStats {
    pub median: Option<f64>,
    pub p90: Option<f64>,
    pub runs: u64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskCounts {
    pub created: u64,
    pub closed: u64,
    pub open: u64,
    pub waiting_on_you: u64,
    pub running: u64,
    pub queued: u64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CycleTime {
    pub task: Stats,
    pub per_stage: BTreeMap<String, StageStats>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct FirstPass {
    pub verifying: Option<f64>,
    pub ci_watch: Option<f64>,
    pub implementing: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Reason {
    pub reason: String,
    pub count: u64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Escalations {
    pub rate: Option<f64>,
    pub top_reasons: Vec<Reason>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RetryStats {
    pub per_task: Stats,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub total_usd: f64,
    pub per_task_usd: Stats,
    pub by_stage: BTreeMap<String, f64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Slots {
    pub max: u64,
    pub active: u64,
    /// Taking no new work: running stages finish, the queue waits.
    #[serde(default)]
    pub draining: bool,
}

/// `GET /health`: liveness, and the stage pool since the machine learned to drain.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Health {
    #[allow(dead_code)] // part of the contract; the board reads the pool, not the liveness bit
    pub ok: bool,
    #[serde(default)]
    pub slots: Slots,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct QueueStats {
    pub depth: u64,
    pub slots: Slots,
    pub utilisation: Option<f64>,
}

/// One repo's row of `GET /metrics?groupBy=repo`.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoMetrics {
    /// The checkout's path; `None` for the tasks with no repo.
    pub repo: Option<String>,
    pub tasks: TaskCounts,
    pub escalation_rate: Option<f64>,
    pub first_pass_verifying: Option<f64>,
    pub cost_usd: f64,
}

impl RepoMetrics {
    /// The last path segment, or `(none)` for the tasks with no repo.
    pub fn name(&self) -> &str {
        self.repo
            .as_deref()
            .and_then(|p| p.trim_end_matches('/').rsplit('/').next())
            .filter(|n| !n.is_empty())
            .unwrap_or("(none)")
    }
}

/// `GET /metrics?since=7d|30d`. Unknown keys are ignored so a newer machine still loads.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub since: String,
    /// Set when the numbers are one repo's (`?repo=`).
    #[serde(default)]
    #[allow(dead_code)] // part of the contract; the Floor keeps its own focus
    pub repo: Option<String>,
    /// One row per repo, when asked for with `?groupBy=repo`.
    #[serde(default)]
    pub by_repo: Option<Vec<RepoMetrics>>,
    #[allow(dead_code)] // part of the contract; the view only shows the start of the window
    pub until: String,
    pub tasks: TaskCounts,
    pub cycle_time_ms: CycleTime,
    pub first_pass_rate: FirstPass,
    pub escalations: Escalations,
    pub retries: RetryStats,
    pub cost: Cost,
    pub queue: QueueStats,
}

const NONE: &str = "–";

/// Milliseconds as `450ms`, `1.2s`, `34m`, `1.5h`; `–` when there is no data.
pub fn fmt_ms(ms: Option<f64>) -> String {
    let Some(ms) = ms else {
        return NONE.to_string();
    };
    let (value, unit) = if ms < 1000.0 {
        return format!("{ms:.0}ms");
    } else if ms < 60_000.0 {
        (ms / 1000.0, "s")
    } else if ms < 3_600_000.0 {
        (ms / 60_000.0, "m")
    } else {
        (ms / 3_600_000.0, "h")
    };
    let number = if value < 10.0 {
        format!("{value:.1}").trim_end_matches(".0").to_string()
    } else {
        format!("{value:.0}")
    };
    format!("{number}{unit}")
}

/// A 0..1 share as `83%`; `–` when there is no data.
pub fn fmt_pct(share: Option<f64>) -> String {
    share.map_or(NONE.to_string(), |s| format!("{:.0}%", s * 100.0))
}

/// Dollars as `$1.23`; `–` when there is no data.
pub fn fmt_usd(usd: Option<f64>) -> String {
    usd.map_or(NONE.to_string(), |u| format!("${u:.2}"))
}

/// The spend above which a card gets its dim `$`: the p90 over the loaded tickets that have
/// spent anything, and only once there are three of them to compare.
pub fn spend_p90(tasks: &[Task]) -> Option<f64> {
    let mut spends: Vec<f64> = tasks.iter().filter_map(|t| t.spent_usd).collect();
    if spends.len() < 3 {
        return None;
    }
    spends.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    // Linear interpolation between ranks (R-7), so a handful of tickets still has a p90
    // below its most expensive one.
    let position = 0.9 * (spends.len() - 1) as f64;
    let (lower, upper) = (position.floor() as usize, position.ceil() as usize);
    let fraction = position - lower as f64;
    Some(spends[lower] + (spends[upper] - spends[lower]) * fraction)
}

/// How a task reads on the board. Declared most urgent first, which is the sort order.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Look {
    Escalated,
    NeedsYou,
    Stale,
    Working,
    Queued,
    Paused,
    Draft,
    Done,
}

/// The first 8 characters of a task id: what cards and watch-tab labels show.
pub fn short_id(id: &str) -> &str {
    &id[..id.len().min(8)]
}

/// How many distinct colours a repo bar can take; `repo_colour_slot` picks one per repo name.
pub const REPO_COLOUR_SLOTS: usize = 6;

/// A stable slot for a repo name, so the same repo keeps its colour across restarts and
/// machines: a small hash, nothing more.
pub fn repo_colour_slot(name: &str) -> usize {
    let hash = name.bytes().fold(5381u32, |h, b| h.wrapping_mul(33) ^ u32::from(b));
    (hash as usize) % REPO_COLOUR_SLOTS
}

impl Task {
    /// The repo's basename (`luna-tui` for `/Users/me/Developer/projects/luna-tui`), if any.
    pub fn repo_name(&self) -> Option<&str> {
        self.repo_path.as_deref().and_then(|p| p.trim_end_matches('/').rsplit('/').next()).filter(|n| !n.is_empty())
    }

    pub fn short_id(&self) -> &str {
        short_id(&self.id)
    }

    /// `#42 ` when the task came from an issue, else empty. The card shows it dim.
    pub fn issue_prefix(&self) -> String {
        self.source.as_ref().map_or_else(String::new, |s| format!("#{} ", s.number))
    }

    #[allow(dead_code)] // the card renders the prefix dim, so it builds from `issue_prefix`
    /// The title as a card reads it: issue number first when the task has one.
    /// The card's first line: the issue number when linked, a gear for a setup task, the title.
    pub fn card_label(&self) -> String {
        let setup = if self.route == "setup" { "⚙ " } else { "" };
        format!("{setup}{}{}", self.issue_prefix(), self.title)
    }

    pub fn column_index(&self) -> usize {
        COLUMNS.iter().position(|c| *c == self.column).unwrap_or(0)
    }

    pub fn look(&self) -> Look {
        self.look_at(now_secs())
    }

    /// `look()` with the clock passed in: a running stage silent past `STALE_SECS` is stale.
    pub fn look_at(&self, now: u64) -> Look {
        match self.state.as_str() {
            "escalated" => Look::Escalated,
            "paused_rate_limit" => Look::Paused,
            "draft" => Look::Draft,
            "closed" => Look::Done,
            _ if self.waiting_on_you => Look::NeedsYou,
            _ if self.queued => Look::Queued,
            _ if self.running && unix_secs(&self.updated_at).is_some_and(|t| now.saturating_sub(t) > STALE_SECS) => Look::Stale,
            _ => Look::Working,
        }
    }

    /// The card's second line: `worked 4m · +142 −18 · tests 7/9`, the parts the task has.
    pub fn triad(&self) -> Option<String> {
        let parts: Vec<String> = [
            self.worked_ms.map(|ms| format!("worked {}", fmt_ms(Some(ms)))),
            self.diff.map(|d| format!("+{} −{}", d.added, d.removed)),
            self.tests.map(|t| format!("tests {}/{}", t.passed, t.total)),
        ]
        .into_iter()
        .flatten()
        .collect();
        if parts.is_empty() { None } else { Some(parts.join(" · ")) }
    }

    /// What the task is doing, in words: the gate it waits at or the stage that runs.
    pub fn status_label(&self) -> String {
        let stage = match self.state.as_str() {
            "draft" => "intake".to_string(),
            "setup" => "setting up".to_string(),
            "awaiting_setup" => "approve setup".to_string(),
            "awaiting_answers" => "answer questions".to_string(),
            "awaiting_approval" => "approve plan".to_string(),
            "awaiting_test_check" => "check tests".to_string(),
            "awaiting_ship" => "choose ship".to_string(),
            "shipping" => "opening PR".to_string(),
            "reviewing_memory" => "review memory".to_string(),
            "escalated" => "escalated".to_string(),
            "paused_rate_limit" => "paused: usage limit".to_string(),
            "closed" => "closed".to_string(),
            "ci_watch" => "ci".to_string(),
            "test_design" => "test design".to_string(),
            other => other.to_string(),
        };
        if self.queued { format!("queued: {stage}") } else { stage }
    }
}

/// Triage's proposed plan, the part you can edit before approving. Slices aren't here:
/// they're shown for reference but edited only by triage itself.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct PlanEdit {
    pub brief: String,
    pub criteria: Vec<String>,
    pub assumptions: Vec<String>,
}

/// An open `awaiting_approval` gate's requested plan, read for editing. Fields absent from
/// `requested` (an older run, or one with nothing to say) come back empty.
pub fn plan_edit_of(requested: &Value) -> PlanEdit {
    let strings = |value: &Value| -> Vec<String> {
        value.as_array().map(|items| items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect()).unwrap_or_default()
    };
    PlanEdit {
        brief: requested["brief"].as_str().unwrap_or_default().to_string(),
        criteria: strings(&requested["criteria"]),
        assumptions: strings(&requested["assumptions"]),
    }
}

pub fn plan_markdown(edit: &PlanEdit) -> String {
    let mut out = format!("# Plan

## Brief

{}

## Criteria to build

", edit.brief);
    for item in &edit.criteria {
        out.push_str(&format!("- {item}
"));
    }
    out.push_str("
## Assumptions

");
    for item in &edit.assumptions {
        out.push_str(&format!("- {item}
"));
    }
    out
}

/// Parses `plan_markdown`.
pub fn parse_plan(markdown: &str) -> PlanEdit {
    #[derive(PartialEq)]
    enum Section {
        Other,
        Brief,
        Criteria,
        Assumptions,
    }

    let mut section = Section::Other;
    let mut edit = PlanEdit::default();
    let mut brief = Vec::new();

    for line in markdown.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            section = match heading.trim().to_ascii_lowercase().as_str() {
                "brief" => Section::Brief,
                "criteria to build" => Section::Criteria,
                "assumptions" => Section::Assumptions,
                _ => Section::Other,
            };
            continue;
        }
        if line.starts_with("# ") {
            continue;
        }
        let bullet = |line: &str| {
            let item = line.trim_start().trim_start_matches("- ").trim();
            item.to_string()
        };
        match section {
            Section::Brief => brief.push(line),
            Section::Criteria if !line.trim().is_empty() => edit.criteria.push(bullet(line)),
            Section::Assumptions if !line.trim().is_empty() => edit.assumptions.push(bullet(line)),
            _ => {}
        }
    }

    edit.brief = brief.join("
").trim().to_string();
    edit
}

/// A ticket's editable text, as shown in `$EDITOR`.
#[derive(Debug, Default, PartialEq)]
pub struct TicketText {
    pub title: String,
    pub description: String,
    pub criteria: Vec<String>,
    pub repo_path: Option<String>,
}

/// The repo isn't part of this text: it's set only through the repo picker (`R`), never typed
/// freely, so a stray edit (or a careless `dd`) can't silently point a ticket at the wrong repo
/// or blank it out.
pub fn ticket_markdown(text: &TicketText) -> String {
    let mut out = format!(
        "# {}\n\n## Description\n\n{}\n\n## Acceptance criteria\n\n",
        text.title, text.description
    );
    for item in &text.criteria {
        out.push_str(&format!("- {item}\n"));
    }
    out
}

/// Parses `ticket_markdown`. A missing title keeps `fallback_title`. Never touches
/// `repo_path`: callers must carry that over from the ticket being edited.
pub fn parse_ticket(markdown: &str, fallback_title: &str) -> TicketText {
    #[derive(PartialEq)]
    enum Section {
        Other,
        Description,
        Criteria,
    }

    let mut section = Section::Other;
    let mut text = TicketText::default();
    let mut description = Vec::new();

    for line in markdown.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            section = match heading.trim().to_ascii_lowercase().as_str() {
                "description" => Section::Description,
                "acceptance criteria" => Section::Criteria,
                _ => Section::Other,
            };
        } else if text.title.is_empty()
            && section == Section::Other
            && let Some(title) = line.strip_prefix("# ")
        {
            text.title = title.trim().to_string();
        } else {
            match section {
                Section::Description => description.push(line),
                Section::Criteria => {
                    let item = line.trim_start().trim_start_matches("- ").trim();
                    let item = item.trim_start_matches("[ ] ").trim_start_matches("[x] ").trim();
                    if !item.is_empty() {
                        text.criteria.push(item.to_string());
                    }
                }
                Section::Other => {}
            }
        }
    }

    if text.title.is_empty() {
        text.title = fallback_title.to_string();
    }
    text.description = description.join("\n").trim().to_string();
    text
}

/// Triage's questions, with its recommended answers ready to edit.
pub fn answers_markdown(task: &Task, questions: &[(String, String)]) -> String {
    let mut out = format!(
        "# Answers for #{} {}\n\nEdit the answer under each question, then save and quit.\n",
        task.short_id(),
        task.title
    );
    for (question, recommended) in questions {
        out.push_str(&format!("\n## Q: {question}\n\n{recommended}\n"));
    }
    out
}

/// Parses `answers_markdown` into (question, answer) pairs.
pub fn parse_answers(markdown: &str) -> Vec<(String, String)> {
    let mut answers: Vec<(String, String)> = Vec::new();
    for line in markdown.lines() {
        if let Some(question) = line.strip_prefix("## Q: ") {
            answers.push((question.trim().to_string(), String::new()));
        } else if let Some((_, answer)) = answers.last_mut() {
            answer.push_str(line);
            answer.push('\n');
        }
    }
    for (_, answer) in &mut answers {
        *answer = answer.trim().to_string();
    }
    answers
}

/// Questions triage asked, as (question, recommended answer).
pub fn questions_of(approval: &Approval) -> Vec<(String, String)> {
    approval.requested["questions"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|q| {
                    Some((
                        q["question"].as_str()?.to_string(),
                        q["recommended"].as_str().unwrap_or_default().to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Unix seconds from an ISO-8601 UTC timestamp such as `2026-10-22T23:24:22.089Z`.
pub fn unix_secs(iso: &str) -> Option<u64> {
    let (date, time) = iso.split_once('T')?;
    let mut parts = date.split('-').map(|p| p.parse::<i64>().ok());
    let (year, month, day) = (parts.next()??, parts.next()??, parts.next()??);
    let mut clock = time.trim_end_matches('Z').split(':');
    let hour = clock.next()?.parse::<i64>().ok()?;
    let minute = clock.next()?.parse::<i64>().ok()?;
    let second = clock.next()?.split('.').next()?.parse::<i64>().ok()?;

    // Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let year_of_era = y - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    u64::try_from(days * 86_400 + hour * 3600 + minute * 60 + second).ok()
}

/// How long ago an ISO timestamp was, compact: `45s`, `12m`, `3h`, `2d`.
pub fn age(iso: &str, now: u64) -> String {
    let Some(since) = unix_secs(iso) else {
        return String::new();
    };
    let s = now.saturating_sub(since);
    match s {
        0..=59 => format!("{s}s"),
        60..=3599 => format!("{}m", s / 60),
        3600..=86_399 => format!("{}h", s / 3600),
        _ => format!("{}d", s / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamps_parse_to_unix_seconds() {
        assert_eq!(unix_secs("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(unix_secs("2026-10-22T23:24:22.089Z"), Some(1_792_711_462));
        assert_eq!(unix_secs("2024-02-29T12:00:00Z"), Some(1_709_208_000));
    }

    fn task_json(source: &str) -> String {
        format!(
            r#"{{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":null,"branch":null,"worktreePath":null,"state":"draft","column":"Intake",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"{source}}}"#
        )
    }

    #[test]
    fn there_is_no_backlog_column_and_a_new_ticket_sits_in_intake() {
        assert_eq!(COLUMNS.len(), 8);
        assert_eq!(COLUMNS[0], "Intake");
        let task: Task = serde_json::from_str(&task_json("")).unwrap();
        assert_eq!(task.column_index(), 0);
        assert!(matches!(task.look(), Look::Draft));
        assert_eq!(task.status_label(), "intake");
    }

    #[test]
    fn the_setup_gate_reads_as_approve_setup_and_a_task_without_a_route_is_a_feature() {
        let task: Task = serde_json::from_str(&task_json("")).unwrap();
        assert_eq!(task.route, "feature");
        let mut setup = task.clone();
        setup.state = "awaiting_setup".to_string();
        assert_eq!(setup.status_label(), "approve setup");
        setup.state = "setup".to_string();
        assert_eq!(setup.status_label(), "setting up");
    }

    #[test]
    fn a_stage_run_carries_its_cost_and_turns_and_the_detail_sums_the_spend() {
        let detail: TaskDetail = serde_json::from_str(&format!(
            r#"{{"task":{},"stageRuns":[
              {{"stage":"triage","attempt":1,"status":"passed","costUsd":0.42,"turns":18}},
              {{"stage":"implementing","attempt":1,"status":"running","costUsd":null,"turns":null}},
              {{"stage":"verifying","attempt":1,"status":"passed","costUsd":0.08,"turns":5}}],
              "approvals":[],"events":[]}}"#,
            task_json("")
        ))
        .unwrap();
        assert_eq!(detail.stage_runs[0].cost_usd, Some(0.42));
        assert_eq!(detail.stage_runs[0].turns, Some(18));
        assert_eq!(detail.stage_runs[1].cost_usd, None);
        assert_eq!(detail.spent_usd(), Some(0.5));
        let bare: StageRun = serde_json::from_str(r#"{"stage":"triage","attempt":1,"status":"passed"}"#).unwrap();
        assert_eq!(bare.cost_usd, None);
    }

    #[test]
    fn the_spend_p90_marks_only_the_expensive_tickets_and_needs_a_few_to_compare() {
        let t = |spent: Option<f64>| -> Task {
            let mut task: Task = serde_json::from_str(&task_json("")).unwrap();
            task.spent_usd = spent;
            task
        };
        assert_eq!(spend_p90(&[t(Some(0.1)), t(Some(0.2))]), None);
        let tasks = [t(Some(0.1)), t(Some(0.2)), t(Some(0.3)), t(Some(5.0)), t(None)];
        let p90 = spend_p90(&tasks).unwrap();
        assert!(tasks[3].spent_usd.unwrap() > p90 && tasks[2].spent_usd.unwrap() <= p90, "p90 {p90}");
        assert_eq!(t(None).spent_usd, None);
    }

    #[test]
    fn a_task_names_its_repo_by_basename_and_gets_a_stable_colour_slot() {
        let mut task: Task = serde_json::from_str(&task_json("")).unwrap();
        assert_eq!(task.repo_name(), None);
        task.repo_path = Some("/Users/me/Developer/projects/luna-tui".into());
        assert_eq!(task.repo_name(), Some("luna-tui"));
        task.repo_path = Some("/r/notch/".into());
        assert_eq!(task.repo_name(), Some("notch"));
        assert_eq!(repo_colour_slot("luna-tui"), repo_colour_slot("luna-tui"));
        assert_ne!(repo_colour_slot("luna-tui"), repo_colour_slot("notch"));
        assert!(repo_colour_slot("anything") < REPO_COLOUR_SLOTS);
    }

    #[test]
    fn the_triad_reads_worked_diff_and_tests_and_only_the_parts_the_task_has() {
        let mut task: Task = serde_json::from_str(&task_json("")).unwrap();
        assert_eq!(task.triad(), None);
        task.worked_ms = Some(240_000.0);
        task.diff = Some(Diff { added: 142, removed: 18 });
        task.tests = Some(Tests { passed: 7, total: 9 });
        assert_eq!(task.triad().as_deref(), Some("worked 4m · +142 −18 · tests 7/9"));
        task.diff = None;
        assert_eq!(task.triad().as_deref(), Some("worked 4m · tests 7/9"));
        let full: Task = serde_json::from_str(&task_json(r#","workedMs":1500,"diff":{"added":1,"removed":0},"tests":{"passed":1,"total":1}"#)).unwrap();
        assert_eq!(full.triad().as_deref(), Some("worked 1.5s · +1 −0 · tests 1/1"));
    }

    #[test]
    fn a_running_task_nobody_has_touched_for_twenty_minutes_looks_stale() {
        let mut task: Task = serde_json::from_str(&task_json("")).unwrap();
        task.state = "implementing".into();
        task.running = true;
        let updated = unix_secs(&task.updated_at).unwrap();
        assert!(matches!(task.look_at(updated + 60), Look::Working));
        assert!(matches!(task.look_at(updated + STALE_SECS + 1), Look::Stale));
        task.running = false;
        task.queued = true;
        assert!(matches!(task.look_at(updated + STALE_SECS + 1), Look::Queued), "a queued task is waiting, not stale");
        assert!(Look::Stale < Look::Working, "stale sorts before working: it needs a look");
    }

    #[test]
    fn health_carries_the_pool_and_an_older_machine_s_slots_still_load() {
        let health: Health = serde_json::from_str(r#"{"ok":true,"slots":{"max":4,"active":1,"draining":true}}"#).unwrap();
        assert!(health.ok);
        assert_eq!((health.slots.max, health.slots.active, health.slots.draining), (4, 1, true));
        let old: Slots = serde_json::from_str(r#"{"max":2,"active":0}"#).unwrap();
        assert!(!old.draining);
        let bare: Health = serde_json::from_str(r#"{"ok":true}"#).unwrap();
        assert_eq!(bare.slots.max, 0);
    }

    #[test]
    fn task_with_a_github_source_deserialises() {
        let json = task_json(
            r#","source":{"kind":"github","repo":"acme/app","number":42,"url":"https://github.com/acme/app/issues/42"}"#,
        );
        let task: Task = serde_json::from_str(&json).unwrap();
        let source = task.source.expect("source present");
        assert_eq!(source.number, 42);
        assert_eq!(source.repo, "acme/app");
        assert_eq!(source.url, "https://github.com/acme/app/issues/42");
    }

    #[test]
    fn task_without_a_source_deserialises_as_none() {
        let task: Task = serde_json::from_str(&task_json("")).unwrap();
        assert!(task.source.is_none());
    }

    #[test]
    fn task_with_an_unknown_source_kind_still_deserialises() {
        let json = task_json(r#","source":{"kind":"linear","repo":"ENG","number":7,"url":"https://x/7"}"#);
        let task: Task = serde_json::from_str(&json).unwrap();
        assert_eq!(task.source.unwrap().kind, "linear");
    }

    #[test]
    fn card_label_prefixes_the_issue_number_only_when_linked() {
        let linked: Task = serde_json::from_str(&task_json(
            r#","source":{"kind":"github","repo":"acme/app","number":42,"url":"u"}"#,
        ))
        .unwrap();
        let plain: Task = serde_json::from_str(&task_json("")).unwrap();
        assert_eq!(linked.card_label(), "#42 Login page");
        assert_eq!(plain.card_label(), "Login page");
        let setup: Task = serde_json::from_str(&task_json(r#","route":"setup""#)).unwrap();
        assert_eq!(setup.card_label(), "⚙ Login page", "a setup task reads apart on the board");
    }

    #[test]
    fn plan_edit_of_reads_brief_criteria_and_assumptions_from_requested() {
        let requested: Value = serde_json::json!({
            "brief": "Build the exporter",
            "criteria": ["c1", "c2"],
            "assumptions": ["a1"],
            "slices": [{"title": "s"}],
        });
        assert_eq!(
            plan_edit_of(&requested),
            PlanEdit { brief: "Build the exporter".into(), criteria: vec!["c1".into(), "c2".into()], assumptions: vec!["a1".into()] }
        );
        assert_eq!(plan_edit_of(&Value::Null), PlanEdit::default());
    }

    #[test]
    fn plan_edit_round_trips() {
        let edit = PlanEdit {
            brief: "Build the exporter".into(),
            criteria: vec!["handles a/b & c".into(), "exports UTF-8".into()],
            assumptions: vec!["CSV only for now".into()],
        };
        let markdown = plan_markdown(&edit);
        assert_eq!(parse_plan(&markdown), edit);
    }

    #[test]
    fn plan_edit_with_no_assumptions_round_trips() {
        let edit = PlanEdit { brief: "b".into(), criteria: vec!["c".into()], assumptions: vec![] };
        assert_eq!(parse_plan(&plan_markdown(&edit)), edit);
    }

    #[test]
    fn ticket_text_round_trips() {
        let text = TicketText {
            title: "Format prices".into(),
            description: "Always show cents.".into(),
            criteria: vec!["1050 shows $10.50".into()],
            repo_path: Some("/repo".into()),
        };
        let markdown = ticket_markdown(&text);
        // The repo isn't in the markdown: it's set only through the repo picker, never by
        // editing this text, so it never round-trips through it.
        let expected = TicketText { repo_path: None, ..text };
        assert_eq!(parse_ticket(&markdown, "x"), expected);
    }

    const METRICS_JSON: &str = r#"{
      "since":"2026-10-16T00:00:00.000Z","until":"2026-10-23T00:00:00.000Z",
      "tasks":{"created":9,"closed":6,"open":3,"waitingOnYou":1,"running":1,"queued":0},
      "cycleTimeMs":{"task":{"median":5400000,"p90":null},
        "perStage":{"verifying":{"median":90000,"p90":120000,"runs":7},
                    "implementing":{"median":null,"p90":null,"runs":0}}},
      "firstPassRate":{"verifying":0.83,"ci_watch":null,"implementing":0.5},
      "escalations":{"rate":0.25,"topReasons":[{"reason":"no tests","count":2}]},
      "retries":{"perTask":{"median":1,"p90":3},"byLoop":{"verify":2,"e2e":0,"ci":1}},
      "cost":{"totalUsd":12.5,"perTaskUsd":{"median":1.234,"p90":null},"byStage":{"verifying":2.5}},
      "queue":{"depth":2,"slots":{"max":4,"active":1},"utilisation":null},
      "futureKey":{"anything":true}
    }"#;

    #[test]
    fn metrics_deserialise_with_nulls_and_unknown_keys() {
        let m: Metrics = serde_json::from_str(METRICS_JSON).unwrap();
        assert_eq!(m.tasks.closed, 6);
        assert_eq!(m.cycle_time_ms.task.median, Some(5_400_000.0));
        assert_eq!(m.cycle_time_ms.task.p90, None);
        assert_eq!(m.cycle_time_ms.per_stage["verifying"].runs, 7);
        assert_eq!(m.first_pass_rate.ci_watch, None);
        assert_eq!(m.escalations.top_reasons[0].reason, "no tests");
        assert_eq!(m.cost.by_stage["verifying"], 2.5);
        assert_eq!(m.queue.slots.max, 4);
        assert_eq!(m.queue.utilisation, None);
    }

    #[test]
    fn fmt_ms_picks_a_readable_unit() {
        assert_eq!(fmt_ms(Some(1200.0)), "1.2s");
        assert_eq!(fmt_ms(Some(90_000.0)), "1.5m");
        assert_eq!(fmt_ms(Some(5_400_000.0)), "1.5h");
        assert_eq!(fmt_ms(Some(2_040_000.0)), "34m");
        assert_eq!(fmt_ms(Some(12_000.0)), "12s");
        assert_eq!(fmt_ms(Some(450.0)), "450ms");
        assert_eq!(fmt_ms(None), "–");
    }

    #[test]
    fn fmt_pct_and_fmt_usd() {
        assert_eq!(fmt_pct(Some(0.83)), "83%");
        assert_eq!(fmt_pct(Some(1.0)), "100%");
        assert_eq!(fmt_pct(None), "–");
        assert_eq!(fmt_usd(Some(1.234)), "$1.23");
        assert_eq!(fmt_usd(Some(0.0)), "$0.00");
        assert_eq!(fmt_usd(None), "–");
    }
}
