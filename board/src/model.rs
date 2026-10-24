//! Tickets as the machine describes them (contracts/src/api.ts), how the board shows them,
//! and the markdown they are edited as. No I/O here.

use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

/// Board columns, named after the pipeline stages. Same order as the machine's contracts.
pub const COLUMNS: [&str; 9] =
    ["Backlog", "Intake", "Triage", "Approved", "Build", "Verify", "Evidence", "Ship", "Done"];

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
    pub waiting_on_you: bool,
    pub running: bool,
    /// Ready to run, but waiting for a free concurrency slot.
    pub queued: bool,
    pub retries: Retries,
    pub resume_to: Option<String>,
    pub reason: Option<String>,
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
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct QueueStats {
    pub depth: u64,
    pub slots: Slots,
    pub utilisation: Option<f64>,
}

/// `GET /metrics?since=7d|30d`. Unknown keys are ignored so a newer machine still loads.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub since: String,
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

/// How a task reads on the board. Declared most urgent first, which is the sort order.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Look {
    Escalated,
    NeedsYou,
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

impl Task {
    pub fn short_id(&self) -> &str {
        short_id(&self.id)
    }

    /// `#42 ` when the task came from an issue, else empty. The card shows it dim.
    pub fn issue_prefix(&self) -> String {
        self.source.as_ref().map_or_else(String::new, |s| format!("#{} ", s.number))
    }

    #[allow(dead_code)] // the card renders the prefix dim, so it builds from `issue_prefix`
    /// The title as a card reads it: issue number first when the task has one.
    pub fn card_label(&self) -> String {
        format!("{}{}", self.issue_prefix(), self.title)
    }

    pub fn column_index(&self) -> usize {
        COLUMNS.iter().position(|c| *c == self.column).unwrap_or(0)
    }

    pub fn look(&self) -> Look {
        match self.state.as_str() {
            "escalated" => Look::Escalated,
            "paused_rate_limit" => Look::Paused,
            "backlog" | "draft" => Look::Draft,
            "closed" => Look::Done,
            _ if self.waiting_on_you => Look::NeedsYou,
            _ if self.queued => Look::Queued,
            _ => Look::Working,
        }
    }

    /// What the task is doing, in words: the gate it waits at or the stage that runs.
    pub fn status_label(&self) -> String {
        let stage = match self.state.as_str() {
            "backlog" => "backlog".to_string(),
            "draft" => "intake".to_string(),
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
