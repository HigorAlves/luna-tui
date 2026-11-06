//! The Tickets view: what the ticket machine holds for each ticket in scope: its validity, its scores, a recommendation, and the drafts
//! waiting for a tap. Everything in a ticket is a stranger's text, so every string goes through `detail::plain` before it reaches the terminal.
use serde::Deserialize;
use serde_json::Value;

use crate::detail::plain;

/// One draft waiting on a ticket. `hash` is what a tap sends back, so a draft that changed since it was read is refused.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct DraftEntry {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub text: String,
    pub hash: String,
    /// A split draft's children, as the machine drafted them (`title`, `goal`, `acceptance_criteria`, `est_loc`, `depends_on`, `order`); empty on any other draft.
    #[serde(default)]
    pub children: Vec<Value>,
}

/// One ticket of `GET /tickets`.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TicketEntry {
    pub key: String,
    pub canonical: Value,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub assessments: Vec<Value>,
    #[serde(default)]
    pub drafts: Vec<DraftEntry>,
    #[serde(default)]
    pub card_id: Option<String>,
    #[serde(default)]
    pub clocks: Value,
    /// The Jira project or GitHub repository a split's child tickets are created in; an older machine sends none.
    #[serde(default)]
    pub split_target: Option<String>,
}

/// The open Tickets view: where the cursor is.
#[derive(Clone, Debug, Default)]
pub struct TicketsState {
    pub cursor: usize,
}

/// A ticket key as one path segment: everything but letters, digits and `-._~` is percent-encoded (a GitHub key has `/` and `#`).
pub fn encode_key(key: &str) -> String {
    key.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).map(plain).unwrap_or_default()
}

impl TicketEntry {
    /// The latest assessment that scored the ticket (a workable one), if any.
    pub fn scored(&self) -> Option<&Value> {
        self.assessments.iter().rev().find(|a| a.get("outcome").and_then(|o| o.as_str()) == Some("workable"))
    }

    /// The drafts a person can still act on.
    pub fn waiting(&self) -> Vec<&DraftEntry> {
        self.drafts.iter().filter(|d| d.status == "waiting" || d.status == "edited").collect()
    }

    /// The clocks that are overdue, by name.
    pub fn overdue(&self) -> Vec<String> {
        self.clocks.get("overdue").and_then(|o| o.as_array()).map(|a| a.iter().filter_map(|n| n.as_str().map(plain)).collect()).unwrap_or_default()
    }

    /// `PAY-12  assessed  P1 M low 0.80  schedule  ✎2 ⏰  Refund fails`: one line.
    pub fn row(&self) -> String {
        let status = self.status.as_deref().map(plain).unwrap_or_else(|| "new".into());
        let score = match self.scored() {
            Some(a) => format!(
                "{} {} {} {:.2}  {}",
                text(a, "priority"),
                text(a, "size"),
                text(a, "blastRadius"),
                a.get("score").and_then(|s| s.as_f64()).unwrap_or(0.0),
                a.get("recommendation").map(|r| text(r, "action").replace('_', " ")).unwrap_or_default()
            ),
            None => "-".to_string(),
        };
        let waits = self.waiting().len();
        let marks = format!("{}{}", if waits > 0 { format!("  ✎{waits}") } else { String::new() }, if self.overdue().is_empty() { "" } else { " ⏰" });
        format!("{:<10} {:<12} {score}{marks}  {}", plain(&self.key), status, text(&self.canonical, "title").replace('\n', " "))
    }

    /// The detail pane: sub-scores with their confidence, the enrichment's links, and each waiting draft.
    pub fn detail_lines(&self) -> Vec<String> {
        let mut out = vec![text(&self.canonical, "title")];
        if let Some(a) = self.scored() {
            if let Some(subs) = a.get("subScores").and_then(|s| s.as_object()) {
                let mut names: Vec<&String> = subs.keys().collect();
                names.sort();
                for name in names {
                    let s = &subs[name];
                    out.push(format!("{}: {:.0} (confidence {:.2})", plain(name), s.get("value").and_then(|v| v.as_f64()).unwrap_or(0.0), s.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0)));
                }
            }
            if let Some(r) = a.get("recommendation") {
                out.push(format!("recommended: {} ({})", text(r, "action").replace('_', " "), text(r, "reason")));
            }
        }
        let links = self.canonical.get("links").cloned().unwrap_or(Value::Null);
        let linked: Vec<String> = ["blocks", "duplicates"].iter().flat_map(|k| links.get(*k).and_then(|l| l.as_array()).cloned().unwrap_or_default()).filter_map(|v| v.as_str().map(plain)).collect();
        if !linked.is_empty() {
            out.push(format!("linked: {}", linked.join(", ")));
        }
        for d in self.waiting() {
            out.push(String::new());
            if d.kind == "split" && !d.children.is_empty() {
                out.extend(self.split_lines(d));
            } else {
                out.push(format!("draft ({}): {}", plain(&d.kind), plain(&d.text)));
            }
        }
        out
    }

    /// Everything the tap on a split draft creates: one fixed line, then each child with its size, what it comes after, its goal and its criteria.
    fn split_lines(&self, draft: &DraftEntry) -> Vec<String> {
        let n = draft.children.len();
        let target = self.split_target.as_deref().map(plain).filter(|t| !t.is_empty()).unwrap_or_else(|| "this ticket's own project".to_string());
        let mut out = vec![format!("Approving creates {n} ticket{} in {target}", if n == 1 { "" } else { "s" })];
        for (i, child) in draft.children.iter().enumerate() {
            let after: Vec<String> = child.get("depends_on").and_then(|d| d.as_array()).map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v.to_string()).collect()).unwrap_or_default();
            let loc = child.get("est_loc").and_then(|v| v.as_u64()).map(|l| format!(", about {l} lines")).unwrap_or_default();
            let after = if after.is_empty() { String::new() } else { format!(", after {}", after.join(", ")) };
            out.push(format!("{}. {}{loc}{after}", i + 1, text(child, "title").replace('\n', " ")));
            out.push(format!("   goal: {}", text(child, "goal").replace('\n', " ")));
            for criterion in child.get("acceptance_criteria").and_then(|c| c.as_array()).into_iter().flatten().filter_map(|c| c.as_str()) {
                out.push(format!("   - {}", plain(criterion).replace('\n', " ")));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: serde_json::Value) -> TicketEntry {
        serde_json::from_value(json).expect("an entry")
    }
    fn scored() -> TicketEntry {
        entry(serde_json::json!({"key":"PAY-12","canonical":{"title":"Refund fails","links":{"blocks":["PAY-30"],"duplicates":[]}},"status":"assessed",
          "assessments":[{"outcome":"workable","priority":"P1","size":"M","blastRadius":"low","score":0.8,"recommendation":{"action":"do_now","reason":"worth it"},"subScores":{"who":{"value":2,"confidence":0.9}}}],
          "drafts":[{"id":"PAY-12:assessment","kind":"assessment","status":"waiting","text":"Assessed: P1.","hash":"abcd"},{"id":"PAY-12:decline","kind":"decline","status":"posted","text":"x","hash":"h"}],
          "clocks":{"overdue":["acknowledge"]}}))
    }

    #[test]
    fn a_row_shows_validity_scores_recommendation_and_what_waits() {
        let row = scored().row();
        for part in ["PAY-12", "assessed", "P1 M low 0.80  do now", "✎1", "⏰", "Refund fails"] {
            assert!(row.contains(part), "{part} in {row}");
        }
    }

    #[test]
    fn a_ticket_not_assessed_yet_has_no_scores() {
        let row = entry(serde_json::json!({"key":"PAY-1","canonical":{"title":"t"}})).row();
        assert!(row.contains("new") && row.contains(" -"), "{row}");
    }

    #[test]
    fn the_detail_lists_sub_scores_with_confidence_links_and_the_waiting_draft_only() {
        let lines = scored().detail_lines().join("\n");
        assert!(lines.contains("who: 2 (confidence 0.90)") && lines.contains("recommended: do now") && lines.contains("linked: PAY-30"));
        assert!(lines.contains("draft (assessment): Assessed: P1.") && !lines.contains("decline"));
    }

    #[test]
    fn a_stranger_s_text_cannot_carry_a_control_character_into_a_row_or_the_detail() {
        let e = entry(serde_json::json!({"key":"A-1\u{1b}[2J","canonical":{"title":"bad\u{1b}[31m\ntitle"},"status":"x\u{1b}","drafts":[{"id":"i","kind":"k","status":"waiting","text":"t\u{1b}[0m","hash":"h"}],"clocks":{"overdue":["a\u{1b}"]}}));
        assert!(!e.row().contains('\u{1b}') && !e.row().contains('\n'));
        assert!(e.detail_lines().iter().all(|l| !l.contains('\u{1b}')));
    }

    #[test]
    fn a_key_is_one_path_segment() {
        assert_eq!(encode_key("PAY-12"), "PAY-12");
        assert_eq!(encode_key("o/a#3"), "o%2Fa%233");
        assert_eq!(encode_key("../x"), "..%2Fx");
    }

    fn split_entry(target: serde_json::Value) -> TicketEntry {
        let mut v = serde_json::json!({"key":"PAY-12","canonical":{"title":"Big"},"status":"split_proposed",
          "drafts":[{"id":"PAY-12:split:1","kind":"split","status":"waiting","text":"1. Part A, about 800 lines.","hash":"h",
            "children":[
              {"title":"Part A","goal":"do A in the refund service","acceptance_criteria":["A works","A is logged"],"est_loc":800,"depends_on":[],"order":1},
              {"title":"Part B\u{1b}[31m","goal":"do B\u{1b}[2J\nafter A","acceptance_criteria":["B works\u{7}"],"est_loc":1200,"depends_on":[1],"order":2}]}]});
        if !target.is_null() {
            v["splitTarget"] = target;
        }
        entry(v)
    }

    #[test]
    fn a_split_draft_lists_every_child_with_goal_criteria_size_and_order_under_one_fixed_line() {
        let lines = split_entry(serde_json::json!("PAY")).detail_lines();
        let text = lines.join("\n");
        assert!(lines.contains(&"Approving creates 2 tickets in PAY".to_string()), "{text}");
        for part in ["1. Part A", "about 800 lines", "goal: do A in the refund service", "- A works", "- A is logged", "2. Part B", "about 1200 lines", "after 1", "- B works"] {
            assert!(text.contains(part), "{part} in {text}");
        }
        let first = lines.iter().position(|l| l.starts_with("1. Part A")).unwrap();
        let second = lines.iter().position(|l| l.starts_with("2. Part B")).unwrap();
        assert!(lines.iter().position(|l| l.starts_with("Approving creates")).unwrap() < first && first < second);
    }

    #[test]
    fn a_split_with_one_child_says_one_ticket_and_an_older_machine_names_no_project() {
        let mut e = split_entry(serde_json::Value::Null);
        e.drafts[0].children.truncate(1);
        assert!(e.detail_lines().contains(&"Approving creates 1 ticket in this ticket's own project".to_string()), "{:?}", e.detail_lines());
    }

    #[test]
    fn a_control_character_in_a_child_s_text_cannot_reach_the_terminal() {
        let lines = split_entry(serde_json::json!("PA\u{1b}Y")).detail_lines();
        assert!(lines.iter().all(|l| !l.chars().any(|ch| ch.is_control())), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("goal: do B") && l.contains("after A")));
    }

    #[test]
    fn a_snapshot_from_before_children_and_the_target_still_parses() {
        let e = entry(serde_json::json!({"key":"PAY-1","canonical":{"title":"t"},"drafts":[{"id":"i","kind":"split","status":"waiting","text":"1. x","hash":"h"}]}));
        assert!(e.drafts[0].children.is_empty() && e.split_target.is_none());
        assert!(e.detail_lines().join("\n").contains("draft (split): 1. x"));
    }
}
