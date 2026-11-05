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
        format!("{:>5.2}  {:<2}  ×{:<2} {}{age}{stale}", self.score, plain(&self.size), self.demand, plain(&self.title).replace('\n', " "))
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
}
