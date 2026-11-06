//! Memory in the board (RFC 0007): the memory view's rows, the ask pane's answer and the Floor's memory line.
//! The machine owns memory; the board shows what it holds and sends a person's decisions (forget, adopt, ask).
//! Every item's text was written by a past run or came from a stranger, so every string goes through
//! `detail::plain` before it reaches the terminal. No I/O here.
use serde::Deserialize;

use crate::detail::plain;

#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
pub struct MemorySource {
    #[serde(default)]
    pub kind: String,
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
pub struct MemoryAnchors {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
pub struct MemoryProvenance {
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub card: Option<String>,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub pack: Option<String>,
}

/// One item of `GET /memory/items`: the machine's record of a thing it sent to Cognee.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub source: MemorySource,
    #[serde(default)]
    pub anchors: MemoryAnchors,
    #[serde(default)]
    pub provenance: MemoryProvenance,
    pub trust: String,
    pub status: String,
    pub text: String,
    #[serde(default)]
    pub created_at: String,
}

fn short(id: &str) -> String {
    plain(id).chars().take(8).collect()
}

impl MemoryItem {
    /// Where it came from, as one short phrase: `machine, card 1a2b3c4d`.
    pub fn provenance_line(&self) -> String {
        let p = &self.provenance;
        let mut parts = vec![if p.by.is_empty() { "unknown".to_string() } else { plain(&p.by) }];
        if let Some(card) = p.card.as_deref().filter(|c| !c.is_empty()) {
            parts.push(format!("card {}", short(card)));
        }
        if let Some(pack) = p.pack.as_deref().filter(|c| !c.is_empty()) {
            parts.push(format!("pack {}", plain(pack)));
        }
        parts.join(", ")
    }

    /// The source: its kind and, when it has one, its reference (`slack C1`, `github`).
    pub fn source_line(&self) -> String {
        match self.source.reference.as_deref().filter(|r| !r.is_empty()) {
            Some(r) => format!("{} {}", plain(&self.source.kind), plain(r)),
            None => plain(&self.source.kind),
        }
    }

    /// `active  fact    outcome     github  machine, card 1a2b3c4d  the uploader retries`: one line.
    pub fn row(&self) -> String {
        format!(
            "{:<8} {:<7} {:<10} {:<10} {}  {}",
            plain(&self.status),
            plain(&self.trust),
            plain(&self.kind),
            self.source_line().chars().take(10).collect::<String>(),
            self.provenance_line(),
            plain(&self.text).replace('\n', " ")
        )
    }

    /// The detail pane: what it is, where it came from, what it is anchored to, then its text.
    pub fn detail_lines(&self) -> Vec<String> {
        let mut out = vec![
            format!("{} · {} · {}", plain(&self.kind), plain(&self.trust), plain(&self.status)),
            format!("id {}", plain(&self.id)),
            format!("repo {}", self.repo.as_deref().map(plain).unwrap_or_else(|| "(company)".to_string())),
            format!("source {}", self.source_line()),
            format!("provenance {}", self.provenance_line()),
        ];
        if let Some(run) = self.provenance.run.as_deref().filter(|r| !r.is_empty()) {
            out.push(format!("run {}", plain(run)));
        }
        if !self.anchors.files.is_empty() || self.anchors.commit.is_some() {
            let commit = self.anchors.commit.as_deref().map(|c| plain(c).chars().take(7).collect::<String>()).unwrap_or_else(|| "none".to_string());
            out.push(format!("anchored at {commit}: {}", self.anchors.files.iter().take(8).map(|f| plain(f)).collect::<Vec<_>>().join(", ")));
        }
        if !self.created_at.is_empty() {
            out.push(format!("created {}", plain(&self.created_at)));
        }
        out.push(String::new());
        out.extend(plain(&self.text).lines().map(str::to_string));
        out
    }

    /// An `outside` item is waiting for a person to adopt it.
    pub fn is_outside(&self) -> bool {
        self.trust == "outside"
    }

    pub fn is_retired(&self) -> bool {
        self.status == "retired"
    }
}

/// The open memory view: where the cursor is, which repository it lists (a checkout path the machine turns into its
/// slug; `None` is every repository) and whether only the `outside` items show.
#[derive(Clone, Debug, Default)]
pub struct MemoryState {
    pub cursor: usize,
    pub repo: Option<String>,
    pub outside_only: bool,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Citation {
    pub kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
}

/// What `POST /memory/ask` answers.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct MemoryAnswer {
    #[serde(default)]
    pub via: String,
    pub answer: String,
    #[serde(default)]
    pub citations: Vec<Citation>,
    #[serde(default)]
    pub grounded: bool,
    #[serde(default)]
    pub note: Option<String>,
}

impl MemoryAnswer {
    /// The answer, then what it rests on: one line per citation, or a plain word when it cites nothing.
    pub fn lines(&self) -> Vec<String> {
        let mut out: Vec<String> = plain(&self.answer).lines().map(str::to_string).collect();
        out.push(String::new());
        if self.citations.is_empty() {
            out.push("no sources".to_string());
        } else {
            out.push("Sources".to_string());
            out.extend(self.citations.iter().map(|c| format!("  {} {}", plain(&c.kind), plain(&c.reference))));
        }
        if !self.grounded {
            out.push("(the memory does not settle this)".to_string());
        }
        if let Some(note) = self.note.as_deref().filter(|n| !n.is_empty()) {
            out.push(format!("({})", plain(note)));
        }
        out
    }
}

/// Where the ask pane is: typing the question, waiting for the machine, or showing what came back.
#[derive(Clone, Debug)]
pub enum AskPhase {
    Typing,
    Waiting,
    Answered(MemoryAnswer),
    Failed(String),
}

/// The ask pane: one question about a repository's past work, and its answer.
#[derive(Clone, Debug)]
pub struct AskPane {
    /// The checkout path the question is about; `None` asks every repository.
    pub repo: Option<String>,
    pub text: String,
    pub phase: AskPhase,
    pub scroll: u16,
}

impl AskPane {
    pub fn new(repo: Option<String>, text: String) -> Self {
        Self { repo, text, phase: AskPhase::Typing, scroll: 0 }
    }
}

/// `GET /memory/status`, read defensively: every field may be absent, and a machine without memory answers `enabled: false`.
#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub tokens_today: Option<u64>,
    #[serde(default)]
    pub cost_usd_today: Option<f64>,
    #[serde(default)]
    pub cognified_today: Option<u64>,
    /// Items waiting to reach Cognee (`GET /metrics`' `memory.pending`).
    #[serde(default)]
    pub pending: Option<u64>,
}

fn tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

impl MemoryStatus {
    /// The Floor's line: mode and today's usage, `None` when memory is off (nothing to show).
    pub fn floor_line(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let mut parts = vec![format!("Memory · {}", self.mode.as_deref().map(plain).unwrap_or_else(|| "on".to_string()))];
        if let Some(t) = self.tokens_today {
            parts.push(format!("{} tokens", tokens(t)));
        }
        if let Some(c) = self.cost_usd_today {
            parts.push(format!("${c:.2}"));
        }
        if let Some(n) = self.cognified_today {
            parts.push(format!("{n} cognified today"));
        }
        if let Some(n) = self.pending.filter(|n| *n > 0) {
            parts.push(format!("{n} pending"));
        }
        Some(format!(" {}", parts.join(" · ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(json: serde_json::Value) -> MemoryItem {
        serde_json::from_value(json).expect("an item")
    }

    fn outcome() -> MemoryItem {
        item(serde_json::json!({
            "id": "mem_0001", "kind": "outcome", "repo": "api-1a2b3c4d", "source": {"kind": "slack", "ref": "C1"},
            "anchors": {"files": ["src/up.ts"], "commit": "abcdef0123"}, "provenance": {"by": "machine", "card": "1a2b3c4d5e6f", "run": "r1", "pack": null},
            "trust": "fact", "status": "active", "text": "the uploader retries three times", "createdAt": "2026-11-06T22:00:00.000Z"
        }))
    }

    #[test]
    fn a_row_shows_kind_trust_status_source_and_provenance() {
        let row = outcome().row();
        for part in ["active", "fact", "outcome", "slack C1", "machine, card 1a2b3c4d", "the uploader retries three times"] {
            assert!(row.contains(part), "{part} in {row}");
        }
        assert!(!row.contains("5e6f"), "the card id is shortened: {row}");
    }

    #[test]
    fn the_detail_lists_the_anchors_the_run_and_the_text() {
        let lines = outcome().detail_lines().join("\n");
        for part in ["outcome · fact · active", "id mem_0001", "repo api-1a2b3c4d", "source slack C1", "run r1", "anchored at abcdef0: src/up.ts", "created 2026-11-06", "the uploader retries three times"] {
            assert!(lines.contains(part), "{part} in {lines}");
        }
    }

    #[test]
    fn a_company_document_has_no_repo_and_a_sparse_item_still_parses() {
        let doc = item(serde_json::json!({"id": "d1", "kind": "doc", "trust": "fact", "status": "active", "text": "handbook"}));
        assert!(doc.detail_lines().contains(&"repo (company)".to_string()));
        assert!(doc.row().contains("unknown"), "{}", doc.row());
    }

    #[test]
    fn a_stranger_s_text_cannot_carry_a_control_character_into_a_row_or_the_detail() {
        let bad = item(serde_json::json!({"id": "x\u{1b}[2J", "kind": "finding", "trust": "outside", "status": "active", "text": "bad\u{1b}[31m\ntext\u{7}",
            "source": {"kind": "doc\u{1b}", "ref": "p\u{1b}"}, "provenance": {"by": "pe\u{1b}rson", "card": "c\u{1b}", "run": null, "pack": "p\u{7}"}, "anchors": {"files": ["f\u{1b}"], "commit": "c\u{1b}"}}));
        assert!(!bad.row().chars().any(|c| c.is_control()), "{:?}", bad.row());
        assert!(bad.detail_lines().iter().all(|l| !l.chars().any(|c| c.is_control())), "{:?}", bad.detail_lines());
        assert!(bad.is_outside() && !bad.is_retired());
    }

    #[test]
    fn an_answer_lists_its_sources_and_says_when_it_settles_nothing() {
        let answer: MemoryAnswer = serde_json::from_value(serde_json::json!({
            "via": "pack", "answer": "Three attempts.\nThen it fails.", "citations": [{"kind": "item", "ref": "mem_0001"}], "grounded": true, "note": null
        }))
        .unwrap();
        assert_eq!(answer.lines(), vec!["Three attempts.", "Then it fails.", "", "Sources", "  item mem_0001"]);
        let none = MemoryAnswer { via: "pack".into(), answer: "Memory holds nothing about that.".into(), citations: vec![], grounded: false, note: Some("nothing matched".into()) };
        let text = none.lines().join("\n");
        assert!(text.contains("no sources") && text.contains("does not settle this") && text.contains("(nothing matched)"), "{text}");
    }

    #[test]
    fn the_floor_line_shows_mode_and_usage_and_nothing_when_off_or_absent() {
        let on: MemoryStatus = serde_json::from_value(serde_json::json!({"enabled": true, "mode": "openai", "tokensToday": 12_345, "costUsdToday": 0.042, "cognifiedToday": 5})).unwrap();
        assert_eq!(on.floor_line().as_deref(), Some(" Memory · openai · 12.3k tokens · $0.04 · 5 cognified today"));
        let bare: MemoryStatus = serde_json::from_value(serde_json::json!({"enabled": true, "mode": "local", "tokensToday": null, "costUsdToday": null, "cognifiedToday": 0})).unwrap();
        assert_eq!(bare.floor_line().as_deref(), Some(" Memory · local · 0 cognified today"));
        let off: MemoryStatus = serde_json::from_value(serde_json::json!({"enabled": false, "mode": null})).unwrap();
        assert_eq!(off.floor_line(), None);
        assert_eq!(serde_json::from_value::<MemoryStatus>(serde_json::json!({})).unwrap().floor_line(), None, "a machine that does not know the field");
        assert_eq!(tokens(2_500_000), "2.5M");
    }
}
