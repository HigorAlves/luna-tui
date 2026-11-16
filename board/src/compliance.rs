//! The Compliance view: the drafts the manager's agents write for you (RFC 0008), each waiting for a tap before anything leaves the
//! machine. A draft is a stranger's text, so every string goes through `plain` (or the markdown renderer) before it reaches the terminal.
use serde::Deserialize;

use crate::detail::plain;

/// Where an approved draft goes. A kind of target this board does not know still has a repo and a path, or nothing.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Target {
    pub kind: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub path: String,
}

/// One step of a draft's history: who did what, when.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Step {
    pub at: String,
    pub did: String,
    pub from: String,
}

/// One draft of `GET /compliance/drafts`. `hash` is what a tap sends back, so a draft that changed since it was read is refused.
/// `kind` and `status` stay strings: a later wave adds kinds, and an old board shows them generically.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComplianceDraft {
    pub id: String,
    pub kind: String,
    pub repo: String,
    pub title: String,
    #[serde(default)]
    pub period: Option<String>,
    #[serde(default)]
    pub summary: String,
    pub text: String,
    /// The machine's own text, kept beside the person's edit.
    #[serde(default)]
    pub original: Option<String>,
    pub status: String,
    pub hash: String,
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(default)]
    pub history: Vec<Step>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

/// The body of `GET /compliance/drafts`.
#[derive(Deserialize, Debug)]
pub struct DraftsResponse {
    pub drafts: Vec<ComplianceDraft>,
}

/// The body of `GET /compliance/repos`: the repositories a questionnaire may be answered from.
#[derive(Deserialize, Debug)]
pub struct ReposResponse {
    pub repos: Vec<String>,
}

/// Why a tap on a draft did not go through: the draft changed under you (`409`: read it again), or the machine's own words.
#[derive(Debug, PartialEq)]
pub enum ActError {
    Stale,
    Failed(String),
}

/// The open Compliance view: where the cursor is and how far the text is scrolled.
#[derive(Clone, Debug, Default)]
pub struct ComplianceState {
    pub cursor: usize,
    pub scroll: u16,
}

/// A draft id as one path segment: it holds `:` and `/` (`change_evidence:acme/api:2026-10`).
pub fn encode_id(id: &str) -> String {
    crate::tickets::encode_key(id)
}

/// `change_evidence` as `Change evidence`; a kind from a later wave reads the same way.
pub fn kind_label(kind: &str) -> String {
    let words = plain(kind).replace('_', " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => words,
    }
}

/// Where a draft sits in its kind: what waits, what is posting, what is posted, what is ignored.
fn rank(status: &str) -> u8 {
    match status {
        "waiting" | "edited" => 0,
        "posted" => 2,
        "ignored" => 3,
        _ => 1,
    }
}

/// The list's order: grouped by kind, and inside a kind what waits for you first (newest period first), then what is posting, then
/// what is posted and, last, what is ignored.
pub fn order(mut drafts: Vec<ComplianceDraft>) -> Vec<ComplianceDraft> {
    drafts.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then(rank(&a.status).cmp(&rank(&b.status)))
            // A period sorts as text (`2026-10`, `2026-Q4`, `2026-W46`); a draft with none comes after one that has.
            .then(b.period.is_some().cmp(&a.period.is_some()))
            .then(b.period.cmp(&a.period))
            .then(a.repo.cmp(&b.repo))
            .then(a.id.cmp(&b.id))
    });
    drafts
}

fn one_line(text: &str) -> String {
    plain(text).replace('\n', " ")
}

impl ComplianceDraft {
    /// A draft the person can still act on.
    pub fn waiting(&self) -> bool {
        self.status == "waiting" || self.status == "edited"
    }

    /// Posted and ignored drafts are history: the list draws them dim.
    pub fn settled(&self) -> bool {
        self.status == "posted" || self.status == "ignored"
    }

    fn marker(&self) -> &'static str {
        match self.status.as_str() {
            "waiting" => "●",
            "edited" => "✎",
            "posting" => "…",
            "posted" => "✓",
            "ignored" => "–",
            _ => "?",
        }
    }

    /// `● change evidence  acme/api  2026-10  3 exceptions`: one line.
    pub fn row(&self) -> String {
        format!(
            "{} {}  {}  {}  {}",
            self.marker(),
            kind_label(&self.kind).to_lowercase(),
            one_line(&self.repo),
            self.period
                .as_deref()
                .map(one_line)
                .unwrap_or_else(|| "-".into()),
            one_line(&self.summary)
        )
    }

    /// The detail pane above the text: title, status, where it goes, why the last tap failed.
    pub fn head_lines(&self) -> Vec<String> {
        let mut out = vec![
            one_line(&self.title),
            format!("status: {}", one_line(&self.status)),
        ];
        for t in &self.targets {
            let place = [one_line(&t.repo), one_line(&t.path)]
                .into_iter()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" › ");
            out.push(
                format!("{} {place}", one_line(&t.kind))
                    .trim_end()
                    .to_string(),
            );
        }
        if let Some(error) = &self.error {
            out.push(format!("⚠ {}", one_line(error)));
        }
        out
    }
}

/// How many drafts wait for a tap.
pub fn waiting_count(drafts: &[ComplianceDraft]) -> usize {
    drafts.iter().filter(|d| d.waiting()).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(json: serde_json::Value) -> ComplianceDraft {
        let mut base = serde_json::json!({
            "id": "change_evidence:acme/api:2026-10", "kind": "change_evidence", "repo": "acme/api",
            "title": "Change management, 2026-10", "period": "2026-10", "summary": "3 exceptions in 41 PRs",
            "text": "# Change management\n\n- PR 12 had no independent approval", "status": "waiting",
            "hash": "0123456789abcdef",
            "targets": [{"kind": "wiki", "repo": "acme/api", "path": "Compliance/Change-Management/2026-10.md"}],
            "history": [], "createdAt": "2026-11-01T06:00:00Z", "updatedAt": "2026-11-01T06:00:00Z"
        });
        for (k, v) in json.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).expect("a draft")
    }

    fn with(id: &str, kind: &str, period: Option<&str>, status: &str) -> ComplianceDraft {
        draft(serde_json::json!({"id": id, "kind": kind, "period": period, "status": status}))
    }

    #[test]
    fn a_drafts_response_parses_with_its_targets_history_error_and_original() {
        let body = serde_json::json!({"drafts": [{
            "id": "change_evidence:acme/api:2026-10", "kind": "change_evidence", "repo": "acme/api",
            "title": "t", "period": null, "summary": "s", "text": "edited", "original": "machine's own",
            "status": "edited", "hash": "0123456789abcdef",
            "targets": [{"kind": "wiki", "repo": "acme/api", "path": "Compliance/x.md"}],
            "history": [{"at": "2026-11-02T08:00:00Z", "did": "edited", "from": "board"}],
            "error": "wiki is disabled", "createdAt": "a", "updatedAt": "b"}]});
        let parsed: DraftsResponse = serde_json::from_value(body).expect("parses");
        let d = &parsed.drafts[0];
        assert_eq!(d.period, None);
        assert_eq!(d.original.as_deref(), Some("machine's own"));
        assert_eq!(d.targets[0].path, "Compliance/x.md");
        assert_eq!(d.history[0].did, "edited");
        assert_eq!(d.error.as_deref(), Some("wiki is disabled"));
        assert_eq!(d.created_at, "a");
    }

    #[test]
    fn a_kind_from_a_later_wave_still_parses_and_reads_generically() {
        let body = serde_json::json!({"drafts": [{
            "id": "status_report:2026-W46", "kind": "status_report", "repo": "acme/api", "title": "t",
            "period": "2026-W46", "summary": "s", "text": "x", "status": "waiting", "hash": "0123456789abcdef",
            "targets": [{"kind": "slack", "channel": "#leads"}], "history": [], "createdAt": "a", "updatedAt": "b"}]});
        let parsed: DraftsResponse =
            serde_json::from_value(body).expect("an unknown kind and target parse");
        let d = &parsed.drafts[0];
        assert_eq!(kind_label(&d.kind), "Status report");
        assert!(d.row().contains("status report"), "{}", d.row());
        assert!(d.head_lines().join("\n").contains("slack"));
    }

    #[test]
    fn an_id_is_one_path_segment() {
        assert_eq!(
            encode_id("change_evidence:acme/api:2026-10"),
            "change_evidence%3Aacme%2Fapi%3A2026-10"
        );
        assert_eq!(encode_id("../x"), "..%2Fx");
    }

    #[test]
    fn what_waits_comes_first_in_its_kind_and_posted_then_ignored_come_last() {
        let ordered = order(vec![
            with("a", "change_evidence", Some("2026-08"), "ignored"),
            with("b", "change_evidence", Some("2026-09"), "posted"),
            with("c", "change_evidence", Some("2026-09"), "waiting"),
            with("d", "change_evidence", Some("2026-10"), "edited"),
            with("e", "change_evidence", Some("2026-10"), "posting"),
        ]);
        let ids: Vec<&str> = ordered.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            ids,
            ["d", "c", "e", "b", "a"],
            "newest waiting first, then posting, posted, ignored"
        );
    }

    #[test]
    fn drafts_are_grouped_by_kind_whatever_order_the_machine_sent() {
        let ordered = order(vec![
            with("a", "status_report", Some("2026-W46"), "waiting"),
            with("b", "change_evidence", Some("2026-10"), "waiting"),
            with("c", "status_report", Some("2026-W45"), "waiting"),
            with("d", "change_evidence", Some("2026-09"), "posted"),
        ]);
        let kinds: Vec<&str> = ordered.iter().map(|d| d.kind.as_str()).collect();
        assert_eq!(
            kinds,
            [
                "change_evidence",
                "change_evidence",
                "status_report",
                "status_report"
            ]
        );
        let ids: Vec<&str> = ordered.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["b", "d", "a", "c"]);
    }

    #[test]
    fn a_draft_with_no_period_sorts_after_one_that_has_a_period() {
        let ordered = order(vec![
            with("a", "change_evidence", None, "waiting"),
            with("b", "change_evidence", Some("2026-10"), "waiting"),
        ]);
        assert_eq!(ordered[0].id, "b");
    }

    #[test]
    fn waiting_and_edited_wait_and_posted_and_ignored_are_settled() {
        for (status, waits, settled) in [
            ("waiting", true, false),
            ("edited", true, false),
            ("posting", false, false),
            ("posted", false, true),
            ("ignored", false, true),
        ] {
            let d = with("a", "change_evidence", None, status);
            assert_eq!((d.waiting(), d.settled()), (waits, settled), "{status}");
        }
        let all = vec![
            with("a", "change_evidence", None, "waiting"),
            with("b", "change_evidence", None, "edited"),
            with("c", "change_evidence", None, "posted"),
        ];
        assert_eq!(waiting_count(&all), 2);
    }

    #[test]
    fn a_row_shows_the_marker_kind_repo_period_and_summary() {
        let row = with("a", "change_evidence", Some("2026-10"), "waiting").row();
        for part in [
            "change evidence",
            "acme/api",
            "2026-10",
            "3 exceptions in 41 PRs",
        ] {
            assert!(row.contains(part), "{part} in {row}");
        }
        let marker = |status| {
            with("a", "change_evidence", None, status)
                .row()
                .chars()
                .next()
                .unwrap()
        };
        assert_ne!(marker("waiting"), marker("posted"));
        assert_ne!(marker("edited"), marker("waiting"));
        assert_ne!(marker("ignored"), marker("posted"));
    }

    #[test]
    fn the_head_names_the_target_and_the_error_when_there_is_one() {
        let d = draft(serde_json::json!({"error": "the wiki is disabled"}));
        let head = d.head_lines().join("\n");
        assert!(
            head.contains("wiki acme/api › Compliance/Change-Management/2026-10.md"),
            "{head}"
        );
        assert!(head.contains("the wiki is disabled"), "{head}");
        assert!(
            !with("a", "change_evidence", None, "waiting")
                .head_lines()
                .join("\n")
                .contains("⚠")
        );
    }

    #[test]
    fn a_stranger_s_text_cannot_carry_a_control_character_into_a_row_or_the_head() {
        let d = draft(serde_json::json!({
            "repo": "a/b\u{1b}[2J", "title": "t\u{1b}[31m\nx", "summary": "s\u{7}\nm", "period": "2026\u{1b}",
            "error": "bad\u{1b}[0m\nnews",
            "targets": [{"kind": "wiki\u{1b}", "repo": "o/r\u{1b}", "path": "p\u{1b}.md"}]
        }));
        assert!(!d.row().chars().any(|c| c.is_control()), "{:?}", d.row());
        assert!(
            d.head_lines()
                .iter()
                .all(|l| !l.chars().any(|c| c.is_control()))
        );
    }

    #[test]
    fn reads_the_repositories_the_machine_offers() {
        let r: ReposResponse =
            serde_json::from_str(r#"{"repos":["acme/api","acme/web"]}"#).unwrap();
        assert_eq!(r.repos, vec!["acme/api", "acme/web"]);
    }
}
