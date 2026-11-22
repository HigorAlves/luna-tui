//! Design reports on the board (RFC 0013): the machine's `POST /design/spec` and `POST /design/audit` answers, shown as a popup,
//! and the card a person can make from one. The machine keeps nothing of a report: it lives here until the popup is closed (or until
//! `:report` reopens one that landed while something else was open).

use serde::Deserialize;

use crate::model::TicketText;

/// What a design route answers, tagged by `kind`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DesignReport {
    Spec {
        /// The link the board asked with: the machine's answer carries the reference it found, not the text, so the board adds it
        /// (`with_link`) and a card made from the report names the same Figma file again.
        #[serde(default)]
        link: String,
        spec: Spec,
    },
    Audit {
        target: String,
        level: String,
        mode: String,
        findings: Vec<Finding>,
        #[serde(default)]
        notes: Vec<String>,
    },
}

/// The design spec, as far as the popup reads it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    #[serde(default)]
    pub frames: Vec<Frame>,
    #[serde(default)]
    pub tokens: Tokens,
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub a11y_notes: Vec<Note>,
    #[serde(default)]
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Frame {
    pub id: String,
    pub name: String,
    pub viewport: Option<Viewport>,
    #[serde(default)]
    pub states: Vec<State>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct State {
    pub state: String,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    pub suggestion: Option<Suggestion>,
}

/// A pattern for a state the file lacks: a suggestion, never the design.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Suggestion {
    pub note: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Tokens {
    #[serde(default)]
    pub color: Vec<Token>,
    #[serde(default, rename = "type")]
    pub typography: Vec<Token>,
    #[serde(default)]
    pub spacing: Vec<Token>,
    #[serde(default)]
    pub radius: Vec<Token>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Token {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Component {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Note {
    pub frame: String,
    pub note: String,
}

/// An audit finding, as the machine's review `Finding`: the title names the criterion, the selector and the page, the body the state and the evidence.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Finding {
    pub severity: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub suggested_fix: Option<String>,
}

/// What `:spec` or `:audit` asked, kept while the repo picker is open.
#[derive(Clone, Debug, PartialEq)]
pub enum Ask {
    Spec(String),
    Audit(String),
}

impl DesignReport {
    /// Records the link the board asked with on a spec answer; an audit has none.
    pub fn with_link(&mut self, asked: &str) {
        if let DesignReport::Spec { link, .. } = self {
            *link = asked.to_string();
        }
    }
}

/// The audit's severities, most severe first, and how the popup names each.
const LEVELS: [(&str, &str); 3] = [
    ("blocker", "blocker"),
    ("should_fix", "should fix"),
    ("nit", "nit"),
];

/// The popup's rows: the audit's findings by level, or the spec's frames, tokens, components, notes and what is missing.
pub fn report_lines(report: &DesignReport) -> Vec<String> {
    let mut out = Vec::new();
    match report {
        DesignReport::Audit {
            target,
            level,
            mode,
            findings,
            notes,
        } => {
            out.push(format!(
                "Accessibility audit of {target} (WCAG 2.2 {level}, {mode})"
            ));
            if findings.is_empty() {
                out.push(String::new());
                out.push("No finding.".to_string());
            }
            for (severity, name) in LEVELS {
                let of: Vec<&Finding> =
                    findings.iter().filter(|f| f.severity == severity).collect();
                if of.is_empty() {
                    continue;
                }
                out.push(String::new());
                out.push(format!("{name} ({})", of.len()));
                for finding in of {
                    out.push(format!("  {}", finding.title));
                    if !finding.body.is_empty() {
                        out.push(format!("    {}", finding.body));
                    }
                    if let Some(fix) = finding.suggested_fix.as_deref().filter(|f| !f.is_empty()) {
                        out.push(format!("    fix: {fix}"));
                    }
                }
            }
            for note in notes {
                out.push(String::new());
                out.push(format!("note: {note}"));
            }
        }
        DesignReport::Spec { spec, .. } => {
            out.push(format!("Design spec: {} frame(s)", spec.frames.len()));
            for frame in &spec.frames {
                out.push(String::new());
                let size = frame
                    .viewport
                    .as_ref()
                    .map(|v| format!(" {}x{}", v.width, v.height))
                    .unwrap_or_default();
                out.push(format!("{} ({}){size}", frame.name, frame.id));
                for state in &frame.states {
                    out.push(match (&state.node_id, &state.suggestion) {
                        (Some(_), _) => format!("  {}: designed", state.state),
                        (None, Some(s)) => format!(
                            "  {}: not in the file; a suggestion: {}",
                            state.state, s.note
                        ),
                        (None, None) => format!("  {}: not in the file", state.state),
                    });
                }
            }
            for (name, tokens) in [
                ("color", &spec.tokens.color),
                ("type", &spec.tokens.typography),
                ("spacing", &spec.tokens.spacing),
                ("radius", &spec.tokens.radius),
            ] {
                if tokens.is_empty() {
                    continue;
                }
                out.push(String::new());
                out.push(format!("{name} tokens ({})", tokens.len()));
                for token in tokens {
                    out.push(format!("  {}: {}", token.name, token.value));
                }
            }
            if !spec.components.is_empty() {
                out.push(String::new());
                out.push(format!("components ({})", spec.components.len()));
                for component in &spec.components {
                    out.push(format!("  {}", component.name));
                }
            }
            if !spec.a11y_notes.is_empty() {
                out.push(String::new());
                out.push("accessibility notes".to_string());
                for note in &spec.a11y_notes {
                    out.push(format!("  {}: {}", note.frame, note.note));
                }
            }
            if !spec.missing.is_empty() {
                out.push(String::new());
                out.push("missing".to_string());
                for line in &spec.missing {
                    out.push(format!("  {line}"));
                }
            }
        }
    }
    out
}

/// The ticket `c` makes from a report: a title, a description that carries the Figma link (so the machine finds the design again) or the
/// findings as a list, and the repo it was asked on.
pub fn card_text(report: &DesignReport, repo: Option<&str>) -> TicketText {
    let (title, description) = match report {
        DesignReport::Audit {
            target,
            level,
            mode,
            findings,
            ..
        } => {
            let mut description = format!(
                "Fix what the accessibility audit of {target} found (WCAG 2.2 {level}, {mode}).\n\nFindings:\n"
            );
            for finding in findings {
                description.push_str(&format!("- [{}] {}\n", finding.severity, finding.title));
                if !finding.body.is_empty() {
                    description.push_str(&format!("  {}\n", finding.body));
                }
                if let Some(fix) = finding.suggested_fix.as_deref().filter(|f| !f.is_empty()) {
                    description.push_str(&format!("  Fix: {fix}\n"));
                }
            }
            (format!("Fix accessibility of {target}"), description)
        }
        DesignReport::Spec { link, spec, .. } => {
            let title = match spec.frames.first() {
                Some(frame) => format!("Build {} from the design", frame.name),
                None => "Build from the design".to_string(),
            };
            let mut description = format!("Build this from the design: {link}\n");
            if !spec.frames.is_empty() {
                description.push_str("\nFrames:\n");
                for frame in &spec.frames {
                    description.push_str(&format!("- {} ({})\n", frame.name, frame.id));
                }
            }
            (title, description)
        }
    };
    TicketText {
        title,
        description,
        criteria: Vec::new(),
        repo_path: repo.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audit() -> DesignReport {
        serde_json::from_value(serde_json::json!({
            "kind": "audit", "target": "staging", "level": "AA", "mode": "gate", "pages": [], "notes": [],
            "findings": [
                { "path": "/checkout", "line": 0, "severity": "blocker", "title": "WCAG 2.1.2 (A): div.modal on /checkout", "body": "trap (state modal, judged)", "confidence": 0.9, "category": "accessibility" },
                { "path": "/checkout", "line": 0, "severity": "should_fix", "title": "WCAG 1.4.3 (AA): p.note on /checkout", "body": "low (state default, axe color-contrast)", "confidence": 1.0, "category": "accessibility" }
            ]
        })).unwrap()
    }

    fn spec() -> DesignReport {
        serde_json::from_value(serde_json::json!({
            "kind": "spec", "link": "https://www.figma.com/design/AbCdEf0123456789/Shop?node-id=12-34",
            "ref": { "refs": [{ "fileKey": "AbCdEf0123456789", "nodeIds": ["12:34"], "page": null, "from": "link" }] },
            "spec": {
                "frames": [{ "id": "12:34", "name": "Checkout", "viewport": { "width": 390, "height": 844 }, "states": [
                    { "state": "default", "nodeId": "12:35", "suggestion": null },
                    { "state": "error", "nodeId": null, "suggestion": { "source": "mobbin", "ref": "m1", "note": "inline message" } }
                ] }],
                "tokens": { "color": [{ "name": "brand", "value": "#112233", "variable": null, "nodeId": null }], "type": [], "spacing": [], "radius": [] },
                "components": [{ "name": "Button", "nodeId": "1:2", "codeConnect": null }],
                "a11yNotes": [{ "frame": "12:34", "note": "focus order follows the form" }],
                "missing": ["the loading state"], "confidence": 0.8
            }
        })).unwrap()
    }

    #[test]
    fn groups_audit_findings_by_level_most_severe_first() {
        let lines = report_lines(&audit());
        let blocker = lines.iter().position(|l| l.contains("blocker")).unwrap();
        let should = lines.iter().position(|l| l.contains("should fix")).unwrap();
        assert!(blocker < should);
        assert!(
            lines
                .iter()
                .any(|l| l.contains("WCAG 2.1.2 (A): div.modal on /checkout"))
        );
        assert!(
            lines
                .iter()
                .any(|l| l.contains("trap (state modal, judged)"))
        );
    }

    #[test]
    fn a_suggested_fix_shows_in_the_report_and_in_the_card() {
        let report: DesignReport = serde_json::from_value(serde_json::json!({
            "kind": "audit", "target": "staging", "level": "AA", "mode": "gate", "notes": [],
            "findings": [{ "severity": "blocker", "title": "t", "body": "b", "suggested_fix": "give the modal an Escape handler" }]
        })).unwrap();
        assert!(report_lines(&report).join("\n").contains("give the modal an Escape handler"));
        assert!(card_text(&report, None).description.contains("give the modal an Escape handler"));
    }

    #[test]
    fn lists_the_spec_frames_with_states_tokens_components_notes_and_what_is_missing() {
        let text = report_lines(&spec()).join("\n");
        for part in [
            "Checkout",
            "390x844",
            "default",
            "error",
            "inline message",
            "brand",
            "#112233",
            "Button",
            "focus order follows the form",
            "the loading state",
        ] {
            assert!(text.contains(part), "{part} is missing from:\n{text}");
        }
    }

    #[test]
    fn a_card_from_an_audit_carries_the_findings_and_the_repo() {
        let text = card_text(&audit(), Some("/r/shop"));
        assert_eq!(text.title, "Fix accessibility of staging");
        assert!(
            text.description
                .contains("- [blocker] WCAG 2.1.2 (A): div.modal on /checkout")
        );
        assert_eq!(text.repo_path.as_deref(), Some("/r/shop"));
    }

    #[test]
    fn a_card_from_a_spec_carries_the_figma_link_so_the_machine_finds_the_design() {
        let text = card_text(&spec(), None);
        assert_eq!(text.title, "Build Checkout from the design");
        assert!(
            text.description
                .contains("https://www.figma.com/design/AbCdEf0123456789/Shop?node-id=12-34")
        );
        assert_eq!(text.repo_path, None);
    }

    #[test]
    fn the_board_keeps_the_link_it_asked_with_on_the_spec_it_got() {
        let mut answered: DesignReport = serde_json::from_value(serde_json::json!({
            "kind": "spec", "ref": { "refs": [] },
            "spec": { "frames": [], "tokens": { "color": [], "type": [], "spacing": [], "radius": [] }, "components": [], "a11yNotes": [], "missing": [], "confidence": 0.5 }
        })).unwrap();
        answered.with_link("https://www.figma.com/design/AbCdEf0123456789/x");
        assert!(
            card_text(&answered, None)
                .description
                .contains("https://www.figma.com/design/AbCdEf0123456789/x")
        );
    }
}
