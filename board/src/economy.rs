//! The Economy view: what the machine learned about one repository's token spend (facts, the tool mask a pack
//! never uses, the loop guard's events, the cost split and the per-pack envelopes). The machine sends all of it;
//! the board only shows it, so every text is a stranger's and goes through `detail::plain` before it is drawn.
use std::collections::BTreeMap;

use serde::Deserialize;

use crate::detail::plain;

/// The status line when `GET /economy` answers 404.
pub const OFF: &str = "the economy is off on this machine";

/// How many loop-guard events the list keeps: the newest.
const GUARD_ROWS: usize = 20;

/// `GET /economy?repo=`: everything the view shows. `facts` and `tools` are absent on a machine that predates them.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Economy {
    #[serde(default)]
    pub envelopes: BTreeMap<String, Envelope>,
    #[serde(default)]
    pub guard: Vec<GuardEvent>,
    #[serde(default)]
    pub cost: Cost,
    #[serde(default)]
    pub facts: Vec<Fact>,
    #[serde(default)]
    pub tools: BTreeMap<String, PackTools>,
}

/// A pack's token envelope: `None` while the machine is still learning it.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Envelope {
    #[serde(default)]
    pub samples: u64,
    #[serde(default)]
    pub envelope: Option<f64>,
}

/// One loop-guard event: what it did to which run.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuardEvent {
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub calls: u64,
    #[serde(default)]
    pub cause: Option<String>,
    #[serde(default)]
    pub failure: Option<String>,
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub pack: String,
}

/// Effective tokens: what the stages ran on and what the machine's own overhead cost.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    #[serde(default)]
    pub exec: f64,
    #[serde(default)]
    pub overhead: f64,
    #[serde(default)]
    pub overhead_share: f64,
    #[serde(default)]
    pub overhead_unpriced: u64,
}

/// A fact about the repository: free (read from it) or proposed, with how the runs bore it out.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Fact {
    pub id: String,
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub confirmations: u64,
    #[serde(default)]
    pub contradictions: u64,
    #[serde(default)]
    pub exercised: u64,
    #[serde(default)]
    pub fired: u64,
}

/// A pack's tool mask: the units applied, and the ones proposed.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PackTools {
    #[serde(default)]
    pub mask: Vec<String>,
    #[serde(default)]
    pub proposal: Vec<Proposal>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub unused_runs: u64,
    #[serde(default)]
    pub cards: u64,
}

/// The open Economy view: the repository it shows and where the cursor is.
#[derive(Clone, Debug, Default)]
pub struct EconomyState {
    pub repo: String,
    pub cursor: usize,
}

/// What a row stands for; the keys read it.
#[derive(Clone, Debug, PartialEq)]
pub enum RowKind {
    Fact(usize),
    Masked { pack: String, unit: String },
    Proposed { pack: String, unit: String, unused_runs: u64, cards: u64 },
    Guard(usize),
}

/// One selectable line of the list, under a section heading.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub section: &'static str,
    pub kind: RowKind,
    pub text: String,
}

/// One line, no control character: a stranger's text for a row.
fn flat(text: &str) -> String {
    plain(text).replace('\n', " ")
}

fn state_rank(state: &str) -> usize {
    ["active", "candidate", "promoted", "retired", "dropped"].iter().position(|s| *s == state).unwrap_or(5)
}

impl Economy {
    /// Facts (active first), then each pack's tools, then the newest loop-guard events.
    pub fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::new();
        let mut facts: Vec<usize> = (0..self.facts.len()).collect();
        facts.sort_by_key(|i| state_rank(&self.facts[*i].state));
        for i in facts {
            let f = &self.facts[i];
            rows.push(Row { section: "Facts", kind: RowKind::Fact(i), text: format!("{:<9} {:<8} {}", flat(&f.state), flat(&f.source), flat(&f.text)) });
        }
        for (pack, tools) in &self.tools {
            for unit in &tools.mask {
                rows.push(Row { section: "Tools", kind: RowKind::Masked { pack: pack.clone(), unit: unit.clone() }, text: format!("masked   {}: {}", flat(pack), flat(unit)) });
            }
            for p in &tools.proposal {
                let text = format!("proposed {}: {}  unused in {} runs over {} cards", flat(pack), flat(&p.unit), p.unused_runs, p.cards);
                rows.push(Row { section: "Tools", kind: RowKind::Proposed { pack: pack.clone(), unit: p.unit.clone(), unused_runs: p.unused_runs, cards: p.cards }, text });
            }
        }
        let mut events: Vec<usize> = (0..self.guard.len()).collect();
        events.sort_by(|a, b| self.guard[*b].at.cmp(&self.guard[*a].at));
        for i in events.into_iter().take(GUARD_ROWS) {
            let g = &self.guard[i];
            let cause = g.cause.as_deref().map(|c| format!("  {}", flat(c))).unwrap_or_default();
            rows.push(Row { section: "Loop guard", kind: RowKind::Guard(i), text: format!("{:<8} {}  {} calls{cause}", flat(&g.action), flat(&g.pack), g.calls) });
        }
        rows
    }

    /// The row under the cursor, kept inside the list.
    pub fn row_at(&self, cursor: usize) -> Option<Row> {
        let rows = self.rows();
        let at = cursor.min(rows.len().saturating_sub(1));
        rows.into_iter().nth(at)
    }

    /// The detail pane's lines for a row.
    pub fn detail_lines(&self, row: &Row) -> Vec<String> {
        match &row.kind {
            RowKind::Fact(i) => {
                let f = &self.facts[*i];
                vec![
                    flat(&f.text),
                    format!("{} · {} · {}", flat(&f.state), flat(&f.source), flat(&f.family)),
                    format!("confirmed {} · contradicted {}", f.confirmations, f.contradictions),
                    format!("exercised {} · fired {}", f.exercised, f.fired),
                    format!("id {}", flat(&f.id)),
                ]
            }
            RowKind::Masked { pack, unit } => vec![format!("{}: {} is masked", flat(pack), flat(unit)), "r restores it".to_string()],
            RowKind::Proposed { pack, unit, unused_runs, cards } => {
                vec![format!("{}: {} is proposed for the mask", flat(pack), flat(unit)), format!("unused in {unused_runs} runs over {cards} cards"), "a approves the pack's proposal, r drops this unit".to_string()]
            }
            RowKind::Guard(i) => {
                let g = &self.guard[*i];
                let mut lines = vec![format!("{} on {} after {} calls", flat(&g.action), flat(&g.pack), g.calls), flat(&g.at), format!("run {}", flat(&g.run_id))];
                lines.extend(g.cause.iter().map(|c| format!("cause {}", flat(c))));
                lines.extend(g.failure.iter().map(|f| format!("failure {}", flat(f))));
                lines
            }
        }
    }

    /// The Cost block and the envelopes, below the detail pane.
    pub fn cost_lines(&self) -> Vec<String> {
        let c = &self.cost;
        let mut lines = vec![format!("effective tokens: exec {:.0} · overhead {:.0}", c.exec, c.overhead), format!("overhead share {:.1}%", c.overhead_share * 100.0)];
        if c.overhead_unpriced > 0 {
            lines.push(format!("{} overhead runs had no token count", c.overhead_unpriced));
        }
        for (pack, e) in &self.envelopes {
            let value = e.envelope.map_or_else(|| format!("learning ({} samples)", e.samples), |v| format!("{v:.0}"));
            lines.push(format!("{}: {value}", flat(pack)));
        }
        lines
    }
}

impl Row {
    /// `d`: only a candidate or active fact can be dropped.
    pub fn can_drop(&self, economy: &Economy) -> bool {
        matches!(self.kind, RowKind::Fact(i) if economy.facts.get(i).is_some_and(|f| f.state == "candidate" || f.state == "active"))
    }

    /// `a`: only a proposal row has a mask to approve.
    pub fn can_approve(&self) -> bool {
        matches!(self.kind, RowKind::Proposed { .. })
    }

    /// `r`: a unit that is masked or proposed.
    pub fn can_restore(&self) -> bool {
        matches!(self.kind, RowKind::Masked { .. } | RowKind::Proposed { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn economy(json: serde_json::Value) -> Economy {
        serde_json::from_value(json).expect("an economy")
    }

    fn full() -> Economy {
        economy(serde_json::json!({
            "envelopes": { "build": { "samples": 12, "envelope": 48000.0 }, "plan": { "samples": 2, "envelope": null } },
            "guard": [
                { "action": "gate", "calls": 9, "cause": "same call twice", "at": "2026-11-01T10:00:00Z", "runId": "r1", "pack": "build" },
                { "action": "stop", "calls": 30, "failure": "budget", "at": "2026-11-02T10:00:00Z", "runId": "r2", "pack": "plan" }
            ],
            "cost": { "exec": 90000.0, "overhead": 10000.0, "overheadShare": 0.1, "overheadUnpriced": 3 },
            "facts": [
                { "id": "f1", "family": "test", "source": "free", "state": "dropped", "text": "old", "confirmations": 0, "contradictions": 2, "exercised": 4, "fired": 0 },
                { "id": "f2", "family": "test", "source": "proposed", "state": "candidate", "text": "pnpm test runs vitest", "confirmations": 1, "contradictions": 0, "exercised": 1, "fired": 1 },
                { "id": "f3", "family": "var", "source": "free", "state": "active", "text": "CI=1", "confirmations": 5, "contradictions": 0, "exercised": 5, "fired": 5 },
                { "id": "f4", "family": "var", "source": "proposed", "state": "promoted", "text": "kept", "confirmations": 9, "contradictions": 0, "exercised": 9, "fired": 9 }
            ],
            "tools": { "build": { "mask": ["WebSearch"], "proposal": [ { "unit": "NotebookEdit", "unusedRuns": 8, "cards": 5 } ] } }
        }))
    }

    #[test]
    fn a_full_status_deserialises_with_camel_case_fields() {
        let e = full();
        assert_eq!(e.facts.len(), 4);
        assert_eq!(e.cost.overhead_unpriced, 3);
        assert_eq!(e.guard[1].run_id, "r2");
        assert_eq!(e.tools["build"].proposal[0].unused_runs, 8);
        assert_eq!(e.envelopes["plan"].envelope, None);
    }

    #[test]
    fn a_minimal_status_without_facts_or_tools_still_parses() {
        let e = economy(serde_json::json!({ "envelopes": {}, "guard": [], "cost": { "exec": 0, "overhead": 0, "overheadShare": 0, "overheadUnpriced": 0 } }));
        assert!(e.facts.is_empty() && e.tools.is_empty() && e.rows().is_empty());
        assert!(e.row_at(3).is_none());
    }

    #[test]
    fn rows_run_facts_by_state_then_tools_then_the_loop_guard_newest_first() {
        let rows = full().rows();
        let sections: Vec<&str> = rows.iter().map(|r| r.section).collect();
        assert_eq!(sections, ["Facts", "Facts", "Facts", "Facts", "Tools", "Tools", "Loop guard", "Loop guard"]);
        let facts: Vec<&RowKind> = rows.iter().take(4).map(|r| &r.kind).collect();
        assert_eq!(facts, [&RowKind::Fact(2), &RowKind::Fact(1), &RowKind::Fact(3), &RowKind::Fact(0)], "active, candidate, promoted, dropped");
        assert!(rows[4].text.starts_with("masked") && rows[5].text.contains("proposed") && rows[5].text.contains("unused in 8 runs over 5 cards"), "{rows:?}");
        assert_eq!(rows[6].kind, RowKind::Guard(1), "the newest event first");
    }

    #[test]
    fn the_loop_guard_keeps_only_the_newest_twenty_events() {
        let guard: Vec<serde_json::Value> = (0..25).map(|i| serde_json::json!({ "action": "gate", "calls": i, "at": format!("2026-11-{:02}T00:00:00Z", i + 1), "runId": "r", "pack": "p" })).collect();
        let rows = economy(serde_json::json!({ "guard": guard })).rows();
        assert_eq!(rows.len(), 20);
        assert_eq!(rows[0].kind, RowKind::Guard(24));
    }

    #[test]
    fn d_a_and_r_are_on_only_for_the_rows_they_act_on() {
        let e = full();
        let rows = e.rows();
        let avail = |i: usize| (rows[i].can_drop(&e), rows[i].can_approve(), rows[i].can_restore());
        assert_eq!(avail(0), (true, false, false), "an active fact");
        assert_eq!(avail(1), (true, false, false), "a candidate fact");
        assert_eq!(avail(2), (false, false, false), "a promoted fact");
        assert_eq!(avail(3), (false, false, false), "a dropped fact");
        assert_eq!(avail(4), (false, false, true), "a masked unit");
        assert_eq!(avail(5), (false, true, true), "a proposed unit");
        assert_eq!(avail(6), (false, false, false), "a loop-guard event");
    }

    #[test]
    fn the_cursor_stays_inside_the_list() {
        let e = full();
        assert_eq!(e.row_at(999).unwrap().kind, RowKind::Guard(0), "past the end is the last row");
        assert_eq!(e.row_at(0).unwrap().kind, RowKind::Fact(2));
    }

    #[test]
    fn the_cost_block_shows_tokens_share_unpriced_runs_and_each_envelope() {
        let lines = full().cost_lines();
        assert_eq!(lines[0], "effective tokens: exec 90000 · overhead 10000");
        assert_eq!(lines[1], "overhead share 10.0%");
        assert_eq!(lines[2], "3 overhead runs had no token count");
        assert_eq!(&lines[3..], ["build: 48000", "plan: learning (2 samples)"]);
        let none = economy(serde_json::json!({})).cost_lines();
        assert!(none.iter().all(|l| !l.contains("no token count")), "{none:?}");
    }

    #[test]
    fn a_stranger_s_text_cannot_carry_a_control_character_into_a_row_or_the_detail() {
        let evil = "bad\u{1b}[31mred\nline";
        let e = economy(serde_json::json!({
            "guard": [ { "action": "gate\u{1b}[2J", "calls": 1, "cause": evil, "failure": evil, "at": "x", "runId": evil, "pack": evil } ],
            "cost": { "exec": 1, "overhead": 1, "overheadShare": 0.5, "overheadUnpriced": 0 },
            "envelopes": { evil: { "samples": 1, "envelope": null } },
            "facts": [ { "id": evil, "family": evil, "source": evil, "state": "active", "text": evil } ],
            "tools": { evil: { "mask": [evil], "proposal": [ { "unit": evil, "unusedRuns": 1, "cards": 1 } ] } }
        }));
        let rows = e.rows();
        assert_eq!(rows.len(), 4);
        let mut lines: Vec<String> = rows.iter().map(|r| r.text.clone()).collect();
        for row in &rows {
            lines.extend(e.detail_lines(row));
        }
        lines.extend(e.cost_lines());
        assert!(lines.iter().all(|l| !l.contains('\u{1b}') && !l.contains('\n')), "{lines:?}");
    }
}
