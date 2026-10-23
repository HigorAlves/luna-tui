//! Tickets as the machine describes them (contracts/src/api.ts), how the board shows them,
//! and the markdown they are edited as. No I/O here.

use std::time::{SystemTime, UNIX_EPOCH};

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

impl Task {
    pub fn short_id(&self) -> &str {
        &self.id[..self.id.len().min(8)]
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
}
