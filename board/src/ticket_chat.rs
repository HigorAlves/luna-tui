//! The planning chat on the board: talk a ticket through with a planner that reads the repo, then create it.
//!
//! The machine answers one turn per call (`POST /ticket-chat`) and keeps nothing: this state holds the
//! talk, its notes and its draft, and sends them back with each message. A reply carries a generation
//! so that a reply the person gave up on (`esc` while waiting) is dropped when it lands.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::model::TicketText;

/// How many turns of the talk a message carries.
pub const HISTORY_TURNS: usize = 30;
/// The most choices a reply shows as `1`-`4` keys.
pub const MAX_CHOICES: usize = 4;
/// The engines the pack allows; the first is the default.
pub const ENGINES: [&str; 2] = ["claude:opus", "codex:sol"];

/// One turn of the talk, as the machine reads it: `who` is `person` or `planner`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Turn {
    pub who: &'static str,
    pub text: String,
}

/// A ticket as the planner drafts it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub criteria: Vec<String>,
}

/// What `POST /ticket-chat` answers.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Reply {
    pub reply: String,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub draft: Option<Draft>,
    #[serde(default)]
    pub ready: bool,
}

/// What `POST /ticket-chat` takes.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Request {
    pub repo: String,
    pub engine: String,
    pub message: String,
    pub history: Vec<Turn>,
    pub notes: String,
    pub draft: Option<Draft>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    /// Choosing the engine, before the first message.
    PickEngine,
    Typing,
    /// The planner is answering.
    Waiting,
    /// The planner has a ready draft: the create gate.
    Draft,
    /// The ticket is being created.
    Creating,
    /// The ticket exists; the Jira offer.
    Created {
        id: String,
    },
    /// `esc` with turns: drop the talk?
    ConfirmDiscard,
}

#[derive(Clone, Debug)]
pub struct State {
    pub repo_path: String,
    pub repo_name: String,
    pub engine: String,
    pub turns: Vec<Turn>,
    pub notes: String,
    pub draft: Option<Draft>,
    pub choices: Vec<String>,
    pub ready: bool,
    pub input: String,
    /// Lines scrolled up from the newest turn.
    pub scroll: usize,
    pub generation: u64,
    pub waiting_since: Option<Instant>,
    pub phase: Phase,
    pub error: Option<String>,
}

impl State {
    pub fn new(repo_path: String, engine: Option<&str>) -> Self {
        let repo_name = repo_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&repo_path)
            .to_string();
        let engine = engine
            .filter(|e| ENGINES.contains(e))
            .unwrap_or(ENGINES[0])
            .to_string();
        State {
            repo_path,
            repo_name,
            engine,
            turns: Vec::new(),
            notes: String::new(),
            draft: None,
            choices: Vec::new(),
            ready: false,
            input: String::new(),
            scroll: 0,
            generation: 0,
            waiting_since: None,
            phase: Phase::PickEngine,
            error: None,
        }
    }

    /// The other engine of the two.
    pub fn toggle_engine(&mut self) {
        let at = ENGINES.iter().position(|e| *e == self.engine).unwrap_or(0);
        self.engine = ENGINES[(at + 1) % ENGINES.len()].to_string();
    }

    /// The engine is chosen: the talk starts.
    pub fn start(&mut self) {
        self.phase = Phase::Typing;
    }

    /// Takes `message` as the person's turn and waits for the planner. `None` when it is empty.
    pub fn send(&mut self, message: &str) -> Option<Request> {
        let message = message.trim().to_string();
        if message.is_empty() {
            return None;
        }
        let from = self.turns.len().saturating_sub(HISTORY_TURNS);
        let history = self.turns[from..].to_vec();
        self.turns.push(Turn {
            who: "person",
            text: message.clone(),
        });
        self.input.clear();
        self.choices.clear();
        self.error = None;
        self.scroll = 0;
        self.generation += 1;
        self.waiting_since = Some(Instant::now());
        self.phase = Phase::Waiting;
        Some(Request {
            repo: self.repo_path.clone(),
            engine: self.engine.clone(),
            message,
            history,
            notes: self.notes.clone(),
            draft: self.draft.clone(),
        })
    }

    /// Sends the typed input.
    pub fn send_input(&mut self) -> Option<Request> {
        let input = self.input.clone();
        self.send(&input)
    }

    /// `1`-`4`: sends choice `n` (counted from 1) as the message, only while the input is empty.
    pub fn pick_choice(&mut self, n: usize) -> Option<Request> {
        if !self.input.is_empty() || n == 0 {
            return None;
        }
        let choice = self.choices.get(n - 1)?.clone();
        self.send(&choice)
    }

    /// The planner answered the message sent at `generation`. Returns whether the answer was used:
    /// a stale one (the wait was cancelled) is ignored.
    pub fn answered(&mut self, generation: u64, result: Result<Reply, String>) -> bool {
        if generation != self.generation || self.phase != Phase::Waiting {
            return false;
        }
        self.waiting_since = None;
        match result {
            Ok(reply) => {
                self.turns.push(Turn {
                    who: "planner",
                    text: reply.reply,
                });
                self.notes = reply.notes;
                if reply.draft.is_some() {
                    self.draft = reply.draft;
                }
                self.choices = reply.choices.into_iter().take(MAX_CHOICES).collect();
                self.ready = reply.ready;
                self.phase = if self.ready && self.draft.is_some() {
                    Phase::Draft
                } else {
                    Phase::Typing
                };
            }
            Err(error) => {
                self.take_back_message();
                self.error = Some(error);
                self.phase = Phase::Typing;
            }
        }
        true
    }

    /// `esc` while waiting: the reply is dropped when it lands and the message is back in the box.
    pub fn cancel_wait(&mut self) {
        self.generation += 1;
        self.waiting_since = None;
        self.take_back_message();
        self.phase = Phase::Typing;
    }

    /// The unanswered message goes back into the input, to edit or send again.
    fn take_back_message(&mut self) {
        if self.turns.last().is_some_and(|t| t.who == "person")
            && let Some(turn) = self.turns.pop()
        {
            self.input = turn.text;
        }
    }

    /// The gate's `y`: the ticket text to create, and the phase moves to `Creating`.
    pub fn begin_create(&mut self) -> Option<TicketText> {
        if self.phase != Phase::Draft {
            return None;
        }
        let draft = self.draft.clone()?;
        self.phase = Phase::Creating;
        Some(TicketText {
            title: draft.title,
            description: draft.description,
            criteria: draft.criteria,
            repo_path: Some(self.repo_path.clone()),
        })
    }

    pub fn created(&mut self, id: String) {
        self.phase = Phase::Created { id };
    }

    pub fn create_failed(&mut self, error: String) {
        self.error = Some(error);
        self.phase = Phase::Draft;
    }

    /// `n` at the gate: back to talking, with the draft kept.
    pub fn keep_talking(&mut self) {
        self.ready = false;
        self.phase = Phase::Typing;
    }

    pub fn scroll_by(&mut self, lines: isize) {
        self.scroll = self.scroll.saturating_add_signed(lines);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        let mut s = State::new("/work/app".into(), None);
        s.start();
        s
    }

    fn draft() -> Draft {
        Draft {
            title: "Export reports as CSV".into(),
            description: "Users want a file.".into(),
            criteria: vec!["escapes commas".into(), "adds a BOM".into()],
        }
    }

    fn ready_reply() -> Reply {
        Reply {
            reply: "Here is the ticket.".into(),
            draft: Some(draft()),
            ready: true,
            ..Reply::default()
        }
    }

    #[test]
    fn a_ready_answer_with_a_draft_moves_to_the_draft_gate_and_y_creates_with_the_drafts_text() {
        let mut s = state();
        s.send("add csv export").unwrap();
        assert!(s.answered(s.generation, Ok(ready_reply())));
        assert_eq!(s.phase, Phase::Draft);
        let text = s.begin_create().unwrap();
        assert_eq!(text.title, "Export reports as CSV");
        assert_eq!(text.description, "Users want a file.");
        assert_eq!(text.criteria, vec!["escapes commas", "adds a BOM"]);
        assert_eq!(text.repo_path.as_deref(), Some("/work/app"));
        assert_eq!(s.phase, Phase::Creating);
        s.created("t1".into());
        assert_eq!(s.phase, Phase::Created { id: "t1".into() });
    }

    #[test]
    fn ready_without_a_draft_keeps_talking_and_a_draft_not_ready_is_kept_for_later() {
        let mut s = state();
        s.send("a").unwrap();
        s.answered(
            s.generation,
            Ok(Reply {
                ready: true,
                ..Reply::default()
            }),
        );
        assert_eq!(s.phase, Phase::Typing);
        s.send("b").unwrap();
        s.answered(
            s.generation,
            Ok(Reply {
                draft: Some(draft()),
                ..Reply::default()
            }),
        );
        assert_eq!(s.phase, Phase::Typing);
        assert_eq!(s.draft, Some(draft()));
        assert!(s.begin_create().is_none(), "create only from the gate");
    }

    #[test]
    fn a_stale_generation_is_ignored() {
        let mut s = state();
        s.send("one").unwrap();
        let old = s.generation;
        s.cancel_wait();
        assert_eq!(s.phase, Phase::Typing);
        assert_eq!(s.input, "one", "the cancelled message is back in the box");
        s.send("two").unwrap();
        assert!(!s.answered(old, Ok(ready_reply())));
        assert_eq!(s.phase, Phase::Waiting);
        assert_eq!(s.turns.len(), 1);
        assert!(s.answered(s.generation, Ok(ready_reply())));
    }

    #[test]
    fn a_message_carries_the_last_thirty_turns_and_not_itself() {
        let mut s = state();
        for i in 0..40 {
            s.turns.push(Turn {
                who: if i % 2 == 0 { "person" } else { "planner" },
                text: format!("turn {i}"),
            });
        }
        let request = s.send("and now?").unwrap();
        assert_eq!(request.history.len(), HISTORY_TURNS);
        assert_eq!(request.history[0].text, "turn 10");
        assert_eq!(request.history[29].text, "turn 39");
        assert_eq!(request.message, "and now?");
    }

    #[test]
    fn choices_pick_only_with_an_empty_input() {
        let mut s = state();
        s.send("x").unwrap();
        s.answered(
            s.generation,
            Ok(Reply {
                reply: "Which?".into(),
                choices: ["csv", "xlsx", "json", "xml", "yaml"]
                    .map(String::from)
                    .to_vec(),
                ..Reply::default()
            }),
        );
        assert_eq!(s.choices.len(), MAX_CHOICES);
        s.input = "typing".into();
        assert!(s.pick_choice(1).is_none());
        s.input.clear();
        assert!(s.pick_choice(5).is_none());
        let request = s.pick_choice(2).unwrap();
        assert_eq!(request.message, "xlsx");
        assert_eq!(s.phase, Phase::Waiting);
    }

    #[test]
    fn an_error_returns_to_typing_with_the_message_back_and_the_error_shown() {
        let mut s = state();
        s.send("hello").unwrap();
        s.answered(s.generation, Err("the planner failed".into()));
        assert_eq!(s.phase, Phase::Typing);
        assert_eq!(s.input, "hello");
        assert_eq!(s.error.as_deref(), Some("the planner failed"));
        assert!(s.turns.is_empty());
    }

    #[test]
    fn the_request_carries_notes_draft_engine_and_repo() {
        let mut s = State::new("/work/app/".into(), Some("codex:sol"));
        s.start();
        s.notes = "n".into();
        s.draft = Some(draft());
        let request = s.send("m").unwrap();
        assert_eq!(s.repo_name, "app");
        assert_eq!(request.engine, "codex:sol");
        assert_eq!(request.notes, "n");
        assert_eq!(request.draft, Some(draft()));
        assert!(State::new("/x".into(), Some("gpt-5")).engine == "claude:opus");
    }

    #[test]
    fn the_reply_reads_the_machines_json() {
        let reply: Reply = serde_json::from_value(serde_json::json!({
            "reply": "r", "choices": ["a"], "notes": "n", "ready": true,
            "draft": { "title": "T", "description": "D", "criteria": ["c"] }
        }))
        .unwrap();
        assert!(reply.ready && reply.draft.unwrap().criteria == ["c"]);
        let bare: Reply =
            serde_json::from_value(serde_json::json!({"reply": "r", "draft": null})).unwrap();
        assert!(bare.draft.is_none() && bare.choices.is_empty());
    }
}
