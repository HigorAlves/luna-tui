//! The shared backlog view: candidates that are not tickets yet, ranked by the machine (cost of delay over
//! cost of doing). The machine sends them ranked; the board only shows them, so every text is a stranger's
//! and goes through `detail::plain` before it reaches the terminal.
use serde::Deserialize;

use crate::detail::plain;

/// One item of `GET /backlog`, ranked.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BacklogEntry {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub repo: Option<String>,
    pub size: String,
    pub demand: u64,
    pub score: f64,
    pub stale: bool,
    pub added_at: String,
    #[serde(default)]
    pub sources: Vec<serde_json::Value>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// False while a dependency is not there yet; an older machine says nothing, which reads as schedulable.
    #[serde(default = "yes")]
    pub schedulable: bool,
    #[serde(default)]
    pub blocked_by: Vec<Blocker>,
}

fn yes() -> bool {
    true
}

/// What an item waits for: another backlog item, or a card, with its state in the machine's words.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Blocker {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub state: String,
}

impl Blocker {
    fn text(&self) -> String {
        format!("{} ({})", plain(&self.id).replace('\n', " "), plain(&self.state).replace('\n', " "))
    }
}

/// The machine's `409 not_schedulable`: its message and, after a colon, each thing the item waits for. Every text goes through `plain`.
pub fn refusal_text(body: &serde_json::Value) -> String {
    let message = plain(body["message"].as_str().unwrap_or("request failed")).replace('\n', " ");
    let blockers: Vec<String> = body["blockedBy"].as_array().map(|a| a.iter().filter_map(|b| serde_json::from_value::<Blocker>(b.clone()).ok()).map(|b| b.text()).collect()).unwrap_or_default();
    if blockers.is_empty() { message } else { format!("{message}: {}", blockers.join("; ")) }
}

/// The open Backlog view: where the cursor is.
#[derive(Clone, Debug, Default)]
pub struct BacklogState {
    pub cursor: usize,
}

impl BacklogEntry {
    /// `1.04  M  ×2  Fix the webhook  ⚠ stale`: score, size, demand, title and the stale mark, one line.
    pub fn row(&self, now: u64) -> String {
        let age = crate::model::unix_secs(&self.added_at).map_or_else(String::new, |at| format!("  {}", crate::model::age_secs(now.saturating_sub(at))));
        let stale = if self.stale { "  ⚠ stale" } else { "" };
        let blocked = if self.schedulable { String::new() } else { format!("  ⛔ blocked by {}", self.blocked_by.len()) };
        format!("{:>5.2}  {:<2}  ×{:<2} {}{age}{stale}{blocked}", self.score, plain(&self.size), self.demand, plain(&self.title).replace('\n', " "))
    }

    /// One line per thing the item waits for, for the detail pane; empty when it can be scheduled.
    pub fn blocked_lines(&self) -> Vec<String> {
        if self.schedulable {
            return Vec::new();
        }
        self.blocked_by.iter().map(|b| format!("waits for {} {}", plain(&b.kind), b.text())).collect()
    }

    /// Where it came from, one line per source, as far as the board can name it.
    pub fn source_lines(&self) -> Vec<String> {
        self.sources
            .iter()
            .map(|s| {
                let text = |key: &str| s.get(key).and_then(|v| v.as_str()).map(plain);
                match text("kind").or_else(|| text("type")).as_deref() {
                    Some("github") => format!("GitHub {}#{}", text("repo").unwrap_or_default(), s.get("number").and_then(|n| n.as_u64()).unwrap_or(0)),
                    Some("jira") => format!("Jira {}", text("key").unwrap_or_default()),
                    Some("slack") => "Slack thread".to_string(),
                    Some(other) => other.to_string(),
                    None => "unknown source".to_string(),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: serde_json::Value) -> BacklogEntry {
        serde_json::from_value(json).expect("an entry")
    }

    #[test]
    fn a_row_shows_score_size_demand_title_and_the_stale_mark() {
        let e = entry(serde_json::json!({"id":"1","title":"Fix the webhook","size":"M","demand":2,"score":1.0416,"stale":true,"addedAt":"2026-11-05T00:00:00Z"}));
        let row = e.row(crate::model::unix_secs("2026-11-06T00:00:00Z").unwrap());
        assert!(row.starts_with(" 1.04  M "), "{row}");
        assert!(row.contains("×2") && row.contains("Fix the webhook") && row.contains("⚠ stale"), "{row}");
    }

    #[test]
    fn a_stranger_s_text_cannot_carry_a_control_character_into_a_row_or_a_source() {
        let e = entry(serde_json::json!({"id":"1","title":"bad\u{1b}[31mred\ntitle","size":"S","demand":1,"score":2.0,"stale":false,"addedAt":"x","sources":[{"kind":"github","repo":"o/a\u{1b}[2J","number":3},{"type":"slack"},{"nothing":1}]}));
        assert!(!e.row(0).contains('\u{1b}') && !e.row(0).contains('\n'));
        let lines = e.source_lines();
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|l| !l.contains('\u{1b}')), "{lines:?}");
        assert_eq!(lines[1], "Slack thread");
    }

    #[test]
    fn an_item_that_cannot_be_scheduled_is_marked_with_what_blocks_it() {
        let e = entry(serde_json::json!({"id":"1","title":"Wait","size":"S","demand":1,"score":1.0,"stale":false,"addedAt":"x","schedulable":false,
          "blockedBy":[{"id":"abc\u{1b}[2J","kind":"card","state":"in review"},{"id":"item-2","kind":"item","state":"in the backlog"}]}));
        assert!(e.row(0).contains("⛔ blocked by 2"), "{}", e.row(0));
        let lines = e.blocked_lines();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("in review") && lines[1].contains("item-2 (in the backlog)"), "{lines:?}");
        assert!(lines.iter().all(|l| !l.contains('\u{1b}')), "{lines:?}");
    }

    #[test]
    fn a_snapshot_from_before_the_fields_still_parses_and_is_schedulable() {
        let e = entry(serde_json::json!({"id":"1","title":"Old","size":"S","demand":1,"score":1.0,"stale":false,"addedAt":"x"}));
        assert!(e.schedulable && e.blocked_by.is_empty());
        assert!(!e.row(0).contains("blocked") && e.blocked_lines().is_empty());
    }

    #[test]
    fn the_machine_s_refusal_names_what_the_item_waits_for() {
        let body = serde_json::json!({"error":"not_schedulable","message":"this item waits for 1 dependency that is not there yet","blockedBy":[{"id":"c1\u{1b}[0m","kind":"card","state":"in review"}]});
        let text = refusal_text(&body);
        assert_eq!(text, "this item waits for 1 dependency that is not there yet: c1 [0m (in review)");
        assert_eq!(refusal_text(&serde_json::json!({"message":"nope"})), "nope");
    }
}
