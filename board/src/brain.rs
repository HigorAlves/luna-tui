//! The company brain on the board: ask a question the machine answers from its graph of past cards,
//! pull requests and decisions (`POST /brain/ask`), and read the reply with the nodes it cites.
//!
//! Smaller than the foreman's popup: the brain only answers, so there is nothing to walk.

use serde::Deserialize;

use crate::text::sanitize;

/// The longest question the machine takes, in characters.
pub const MAX_QUESTION: usize = 2000;

/// One node the reply rests on. `kind` is `card`, `pr`, `verdict` or `component`; `slug` already starts with it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Cite {
    pub slug: String,
    pub kind: String,
    pub text: String,
}

/// What `POST /brain/ask` answers. `known` is false when the brain holds nothing about the question.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Reply {
    pub known: bool,
    pub reply: String,
    pub cites: Vec<Cite>,
    /// Cites the machine refused; the board does not show them.
    #[serde(default)]
    pub dropped: Vec<serde_json::Value>,
}

/// What the popup is doing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    /// The question is being typed.
    Typing,
    /// The call is out.
    Waiting,
    /// The reply shows under the question it answers.
    Answer,
}

#[derive(Clone, Debug)]
pub struct State {
    pub phase: Phase,
    pub input: String,
    /// The question in flight, kept to put back in the box if the call fails.
    sent: String,
    /// The question the reply answers.
    pub question: String,
    pub reply: Option<Reply>,
    /// Why the last call failed, until the person types again.
    pub error: Option<String>,
    /// The number of the question in flight; a reply with another number answers a question this popup no longer holds.
    pub seq: u64,
}

impl State {
    pub fn new() -> Self {
        State {
            phase: Phase::Typing,
            input: String::new(),
            sent: String::new(),
            question: String::new(),
            reply: None,
            error: None,
            seq: 0,
        }
    }

    /// Adds typed or pasted text to the box, up to `MAX_QUESTION` characters; clears an earlier error.
    pub fn type_str(&mut self, text: &str) {
        self.error = None;
        let room = MAX_QUESTION.saturating_sub(self.input.chars().count());
        self.input.extend(text.chars().take(room));
    }

    /// Takes the typed question and waits for the call. `None` for an empty box.
    pub fn ask(&mut self) -> Option<String> {
        let question = self.input.trim().to_string();
        if question.is_empty() {
            return None;
        }
        self.input.clear();
        self.sent = question.clone();
        self.phase = Phase::Waiting;
        Some(question)
    }

    /// The machine answered. A reply that knows nothing holds no cites, whatever it was sent with.
    pub fn answered(&mut self, mut reply: Reply) {
        if !reply.known {
            reply.cites.clear();
        }
        self.question = std::mem::take(&mut self.sent);
        self.reply = Some(reply);
        self.phase = Phase::Answer;
    }

    /// The call failed: the question is back in the box to send again, with the reason beside it.
    pub fn failed(&mut self, message: String) {
        self.input = std::mem::take(&mut self.sent);
        self.error = Some(message);
        self.phase = Phase::Typing;
    }
}

/// A cite as one line: its slug, and its text cut so both fit in `width` cells with two spaces between.
pub fn cite_row(cite: &Cite, width: usize) -> (String, String) {
    let slug = sanitize(&cite.slug, false);
    let room = width.saturating_sub(slug.chars().count() + 2);
    if room == 0 {
        return (slug, String::new());
    }
    (
        slug,
        crate::ui::truncate(&sanitize(&cite.text, false), room),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(known: bool) -> Reply {
        serde_json::from_value(serde_json::json!({
            "known": known,
            "reply": "The egress proxy card was estimated at 300 lines and changed 412.",
            "cites": [{
                "slug": "card:6f1c2a9e",
                "kind": "card",
                "text": "Sandbox egress proxy \u{b7} state closed \u{b7} estimated 300 lines \u{b7} actual 412 lines"
            }],
            "dropped": []
        }))
        .unwrap()
    }

    #[test]
    fn the_reply_reads_the_machines_json() {
        let reply = reply(true);
        assert!(reply.known);
        assert_eq!(reply.cites.len(), 1);
        assert_eq!(reply.cites[0].slug, "card:6f1c2a9e");
        assert_eq!(reply.cites[0].kind, "card");
        let bare: Reply =
            serde_json::from_str(r#"{"known":false,"reply":"Nothing.","cites":[]}"#).unwrap();
        assert!(!bare.known && bare.cites.is_empty());
    }

    #[test]
    fn an_empty_question_is_not_sent_and_a_sent_one_waits() {
        let mut state = State::new();
        state.input = "  ".into();
        assert!(state.ask().is_none());
        assert_eq!(state.phase, Phase::Typing);
        state.input = "  how big was the proxy?  ".into();
        assert_eq!(state.ask().as_deref(), Some("how big was the proxy?"));
        assert_eq!(state.phase, Phase::Waiting);
        assert!(state.input.is_empty());
    }

    #[test]
    fn the_answer_keeps_the_question_it_answers() {
        let mut state = State::new();
        state.input = "how big?".into();
        state.ask().unwrap();
        state.answered(reply(true));
        assert_eq!(state.phase, Phase::Answer);
        assert_eq!(state.question, "how big?");
        assert_eq!(state.reply.as_ref().unwrap().cites.len(), 1);
    }

    #[test]
    fn an_unknown_answer_holds_no_cites() {
        let mut state = State::new();
        state.input = "who?".into();
        state.ask().unwrap();
        state.answered(reply(false));
        assert!(state.reply.as_ref().unwrap().cites.is_empty());
    }

    #[test]
    fn a_failure_puts_the_question_back_and_keeps_the_answer_before_it() {
        let mut state = State::new();
        state.input = "first".into();
        state.ask().unwrap();
        state.answered(reply(true));
        state.phase = Phase::Typing;
        state.input = "second".into();
        state.ask().unwrap();
        state.failed("the brain is off".into());
        assert_eq!(state.phase, Phase::Typing);
        assert_eq!(state.input, "second");
        assert_eq!(state.error.as_deref(), Some("the brain is off"));
        assert_eq!(
            state.question, "first",
            "the shown answer is still the first one's"
        );
    }

    #[test]
    fn typing_stops_at_the_length_the_machine_takes() {
        let mut state = State::new();
        state.type_str(&"a".repeat(MAX_QUESTION - 1));
        state.type_str("bcd");
        assert_eq!(state.input.chars().count(), MAX_QUESTION);
        assert!(state.input.ends_with('b'));
        state.type_str("more");
        assert_eq!(state.input.chars().count(), MAX_QUESTION);
    }

    #[test]
    fn a_cite_row_is_the_slug_then_its_text_cut_to_the_width() {
        let cite = reply(true).cites.remove(0);
        let (slug, text) = cite_row(&cite, 40);
        assert_eq!(slug, "card:6f1c2a9e");
        assert_eq!(slug.chars().count() + 2 + text.chars().count(), 40);
        assert!(text.ends_with('\u{2026}'));
        let (_, whole) = cite_row(&cite, 200);
        assert_eq!(whole, cite.text);
    }

    #[test]
    fn a_cite_row_is_clean_of_text_that_steers_the_terminal() {
        let cite = Cite {
            slug: "pr:o/a#1".into(),
            kind: "pr".into(),
            text: "fix\u{202E}ed\nit".into(),
        };
        let (_, text) = cite_row(&cite, 80);
        assert_eq!(text, "fix ed it");
    }

    #[test]
    fn a_cite_row_in_no_room_still_shows_the_slug() {
        let cite = reply(true).cites.remove(0);
        let (slug, text) = cite_row(&cite, 5);
        assert_eq!(slug, "card:6f1c2a9e");
        assert!(text.is_empty());
    }
}
