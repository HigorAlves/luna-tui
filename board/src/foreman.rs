//! The foreman on the board: ask a question about the open cards, then walk the actions it suggests.
//!
//! The machine only suggests (`POST /foreman`). Each action runs here, one at a time, when the
//! person presses `y` on its row: there is no key that runs them all. `call_of` maps an action
//! to the client call it makes, and `run` makes it.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::{client::Machine, model::Task};

/// How many turns of the talk a follow-up question carries.
pub const HISTORY_TURNS: usize = 10;

/// The reason an archive carries: the foreman names none, and this one is the plain "decided against".
const ARCHIVE_REASON: &str = "rejected";

/// One suggestion, as `POST /foreman` sends it. Fields that a kind does not use are absent.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub kind: String,
    pub task_id: String,
    pub why: String,
    pub reason: Option<String>,
    pub pack: Option<String>,
    pub engine: Option<String>,
    pub answers: Option<BTreeMap<String, String>>,
    /// The id of the card's open approval when the machine took its snapshot; null when none was open.
    #[serde(default)]
    pub approval_id: Option<String>,
}

impl Action {
    /// Whether the action's effect depends on the gate the card waits at.
    pub fn is_gate_bound(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "approve" | "send_back" | "retry" | "answer" | "post_questions"
        )
    }

    /// Whether the card has moved to another gate since the question: `current` is its open approval now.
    pub fn is_stale(&self, current: Option<&str>) -> bool {
        self.is_gate_bound() && self.approval_id.as_deref() != current
    }
}

/// What `POST /foreman` answers. `dropped` are suggestions the machine refused; only their count shows.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Reply {
    pub reply: String,
    pub actions: Vec<Action>,
    #[serde(default)]
    pub dropped: Vec<serde_json::Value>,
}

/// One turn of the talk, as the history of a follow-up.
#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    pub who: &'static str,
    pub text: String,
}

/// The existing client call an action makes.
#[derive(Clone, Debug, PartialEq)]
pub enum Call {
    Start(String),
    /// `decide`: approve, send back (with its reason) or retry an escalation (approve, with its guidance).
    Decide {
        id: String,
        approve: bool,
        reason: Option<String>,
    },
    Resume(String),
    Abort(String),
    Archive(String, &'static str),
    SetEngine {
        id: String,
        pack: String,
        engine: String,
    },
    Answer(String, Vec<(String, String)>),
    PostQuestions(String),
}

/// The call for an action, or why there is none (a kind this board does not know, or a field it lacks).
pub fn call_of(action: &Action) -> Result<Call, String> {
    let id = action.task_id.clone();
    let need = |value: &Option<String>, name: &str| {
        value
            .clone()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| format!("the {} action has no {name}", action.kind))
    };
    Ok(match action.kind.as_str() {
        "start" => Call::Start(id),
        "approve" => Call::Decide {
            id,
            approve: true,
            reason: None,
        },
        "send_back" => Call::Decide {
            id,
            approve: false,
            reason: Some(need(&action.reason, "reason")?),
        },
        "retry" => Call::Decide {
            id,
            approve: true,
            reason: Some(need(&action.reason, "reason")?),
        },
        "resume" => Call::Resume(id),
        "abort" => Call::Abort(id),
        "archive" => Call::Archive(id, ARCHIVE_REASON),
        "set_engine" => Call::SetEngine {
            id,
            pack: need(&action.pack, "pack")?,
            engine: need(&action.engine, "engine")?,
        },
        "answer" => Call::Answer(
            id,
            action
                .answers
                .clone()
                .filter(|a| !a.is_empty())
                .ok_or("the answer action has no answers")?
                .into_iter()
                .collect(),
        ),
        "post_questions" => Call::PostQuestions(id),
        other => return Err(format!("this board does not know the {other} action")),
    })
}

/// Makes the call. The machine's refusal comes back as the error, for the row to show.
pub fn run(machine: &Machine, call: &Call) -> Result<Task, String> {
    match call {
        Call::Start(id) => machine.start(id),
        Call::Decide {
            id,
            approve,
            reason,
        } => machine.decide(id, *approve, reason.as_deref()),
        Call::Resume(id) => machine.resume(id),
        Call::Abort(id) => machine.abort(id),
        Call::Archive(id, reason) => machine.archive(id, reason),
        Call::SetEngine { id, pack, engine } => machine.set_stage_engine(id, pack, Some(engine)),
        Call::Answer(id, answers) => machine.answer(id, answers),
        Call::PostQuestions(id) => machine.post_questions(id),
    }
}

/// Where a row of the walk stands.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Pending,
    Done,
    Skipped,
    /// The card moved to another gate since the question; no call was made, ask again.
    Stale,
    Failed(String),
}

#[derive(Clone, Debug)]
pub struct Row {
    pub action: Action,
    pub status: Status,
}

/// What the popup is doing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    /// The question is being typed.
    Typing,
    /// The machine is answering.
    Waiting,
    /// The actions are listed, to walk.
    Walk,
}

#[derive(Clone, Debug)]
pub struct State {
    pub phase: Phase,
    pub input: String,
    pub turns: Vec<Turn>,
    pub reply: String,
    pub rows: Vec<Row>,
    pub dropped: usize,
    pub cursor: usize,
}

impl State {
    pub fn new() -> Self {
        State {
            phase: Phase::Typing,
            input: String::new(),
            turns: Vec::new(),
            reply: String::new(),
            rows: Vec::new(),
            dropped: 0,
            cursor: 0,
        }
    }

    /// The last turns of the talk, for a follow-up (the question being asked is not among them yet).
    pub fn history(&self) -> Vec<Turn> {
        let from = self.turns.len().saturating_sub(HISTORY_TURNS);
        self.turns[from..].to_vec()
    }

    /// Takes the typed question: it becomes a turn, and the popup waits. Returns the question and the history it goes with.
    pub fn ask(&mut self) -> Option<(String, Vec<Turn>)> {
        let question = self.input.trim().to_string();
        if question.is_empty() {
            return None;
        }
        let history = self.history();
        self.turns.push(Turn {
            who: "person",
            text: question.clone(),
        });
        self.input.clear();
        self.phase = Phase::Waiting;
        Some((question, history))
    }

    /// The machine answered: the reply is a turn and the actions are the rows to walk.
    pub fn answered(&mut self, reply: Reply) {
        self.turns.push(Turn {
            who: "foreman",
            text: reply.reply.clone(),
        });
        self.reply = reply.reply;
        self.rows = reply
            .actions
            .into_iter()
            .map(|action| Row {
                action,
                status: Status::Pending,
            })
            .collect();
        self.dropped = reply.dropped.len();
        self.cursor = 0;
        self.phase = Phase::Walk;
    }

    /// The machine could not answer: the question is back in the box to send again.
    pub fn failed(&mut self) {
        if let Some(turn) = self.turns.pop().filter(|t| t.who == "person") {
            self.input = turn.text;
        }
        self.phase = Phase::Typing;
    }

    pub fn move_by(&mut self, step: isize) {
        let last = self.rows.len().saturating_sub(1);
        self.cursor = self.cursor.saturating_add_signed(step).min(last);
    }

    /// Moves to the next row that still waits, after the one at the cursor; stays when there is none.
    pub fn next_pending(&mut self) {
        if let Some(at) =
            (self.cursor + 1..self.rows.len()).find(|&i| self.rows[i].status == Status::Pending)
        {
            self.cursor = at;
        }
    }

    /// Marks the row at the cursor skipped and moves on.
    pub fn skip(&mut self) {
        if let Some(row) = self
            .rows
            .get_mut(self.cursor)
            .filter(|r| matches!(r.status, Status::Pending | Status::Failed(_)))
        {
            row.status = Status::Skipped;
        }
        self.next_pending();
    }

    /// The action at the cursor when `y` may run it: it waits, or it failed before (a second `y` tries again).
    pub fn runnable(&self) -> Option<Action> {
        self.rows
            .get(self.cursor)
            .filter(|r| matches!(r.status, Status::Pending | Status::Failed(_)))
            .map(|r| r.action.clone())
    }

    /// The row at the cursor was made at a gate the card has left: no call, and the walk moves on.
    pub fn mark_stale(&mut self) {
        if let Some(row) = self.rows.get_mut(self.cursor) {
            row.status = Status::Stale;
        }
        self.next_pending();
    }

    pub fn settle(&mut self, result: &Result<Task, String>) {
        if let Some(row) = self.rows.get_mut(self.cursor) {
            row.status = match result {
                Ok(_) => Status::Done,
                Err(message) => Status::Failed(message.clone()),
            };
        }
        if result.is_ok() {
            self.next_pending();
        }
    }
}

/// The words a row shows for its action: `approve #ab12cd34 Title: why`.
pub fn row_text(action: &Action, task: Option<&Task>) -> String {
    let what = match action.kind.as_str() {
        "set_engine" => format!(
            "set {} to {}",
            action.pack.as_deref().unwrap_or("?"),
            action.engine.as_deref().unwrap_or("?")
        ),
        "send_back" => "send back".to_string(),
        "post_questions" => "post the questions".to_string(),
        other => other.to_string(),
    };
    // The title and the why are other people's and a model's words: clean them as `payload_lines` does.
    let clean = |text: &str| crate::text::sanitize(text, false);
    let card = match task {
        Some(t) => format!("#{} {}", t.short_id(), clean(&t.title)),
        None => format!(
            "#{}",
            clean(&action.task_id.chars().take(8).collect::<String>())
        ),
    };
    format!("{what}  {card}  {}", clean(&action.why))
}

/// What the person reads under the selected row before `y`: the full payload, sanitised, because model text can steer it.
/// `gate` is the kind of the gate an `approve` would pass.
pub fn payload_lines(action: &Action, gate: Option<&str>) -> Vec<String> {
    let clean = |text: &str| crate::text::sanitize(text, false);
    let mut out = Vec::new();
    if let Some(reason) = action.reason.as_deref() {
        out.push(format!("reason: {}", clean(reason)));
    }
    if let Some(answers) = &action.answers {
        for (question, answer) in answers {
            out.push(format!("{} -> {}", clean(question), clean(answer)));
        }
    }
    if action.kind == "approve" {
        out.push(format!("gate: {}", clean(gate.unwrap_or("unknown"))));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(kind: &str) -> Action {
        Action {
            kind: kind.to_string(),
            task_id: "t1".to_string(),
            why: "because".to_string(),
            reason: None,
            pack: None,
            engine: None,
            answers: None,
            approval_id: None,
        }
    }

    #[test]
    fn a_gate_bound_action_is_stale_when_the_open_approval_is_not_the_one_it_was_made_at() {
        let at = |id: Option<&str>, kind: &str| Action {
            approval_id: id.map(str::to_string),
            ..action(kind)
        };
        assert!(at(Some("a1"), "approve").is_stale(Some("a2")));
        assert!(at(Some("a1"), "answer").is_stale(None));
        assert!(at(None, "retry").is_stale(Some("a2")));
        assert!(!at(Some("a1"), "approve").is_stale(Some("a1")));
        assert!(!at(None, "send_back").is_stale(None));
        assert!(
            !at(Some("a1"), "abort").is_stale(Some("a2")),
            "abort needs no gate"
        );
    }

    #[test]
    fn every_kind_maps_to_the_client_call_the_keys_make() {
        let with_reason = |kind: &str| Action {
            reason: Some("tighten the scope".to_string()),
            ..action(kind)
        };
        assert_eq!(call_of(&action("start")), Ok(Call::Start("t1".into())));
        assert_eq!(
            call_of(&action("approve")),
            Ok(Call::Decide {
                id: "t1".into(),
                approve: true,
                reason: None
            })
        );
        assert_eq!(
            call_of(&with_reason("send_back")),
            Ok(Call::Decide {
                id: "t1".into(),
                approve: false,
                reason: Some("tighten the scope".into())
            })
        );
        assert_eq!(
            call_of(&with_reason("retry")),
            Ok(Call::Decide {
                id: "t1".into(),
                approve: true,
                reason: Some("tighten the scope".into())
            })
        );
        assert_eq!(call_of(&action("resume")), Ok(Call::Resume("t1".into())));
        assert_eq!(call_of(&action("abort")), Ok(Call::Abort("t1".into())));
        assert_eq!(
            call_of(&action("archive")),
            Ok(Call::Archive("t1".into(), "rejected"))
        );
        assert_eq!(
            call_of(&action("post_questions")),
            Ok(Call::PostQuestions("t1".into()))
        );
        assert_eq!(
            call_of(&Action {
                pack: Some("plan".into()),
                engine: Some("codex:luna".into()),
                ..action("set_engine")
            }),
            Ok(Call::SetEngine {
                id: "t1".into(),
                pack: "plan".into(),
                engine: "codex:luna".into()
            })
        );
        assert_eq!(
            call_of(&Action {
                answers: Some(BTreeMap::from([(
                    "Which format?".to_string(),
                    "csv".to_string()
                )])),
                ..action("answer")
            }),
            Ok(Call::Answer(
                "t1".into(),
                vec![("Which format?".into(), "csv".into())]
            ))
        );
    }

    #[test]
    fn an_action_that_lacks_what_its_call_needs_has_no_call() {
        for kind in ["send_back", "retry", "set_engine", "answer"] {
            assert!(call_of(&action(kind)).is_err(), "{kind}");
        }
        assert!(call_of(&action("merge")).unwrap_err().contains("merge"));
    }

    #[test]
    fn the_reply_reads_the_machines_json() {
        let reply: Reply = serde_json::from_value(serde_json::json!({
            "reply": "Start it.",
            "actions": [{ "kind": "start", "taskId": "t1", "why": "a draft" }],
            "dropped": [{ "action": {}, "problem": "x" }]
        }))
        .unwrap();
        assert_eq!(reply.actions[0].task_id, "t1");
        assert_eq!(reply.dropped.len(), 1);
    }

    fn walked() -> State {
        let mut state = State::new();
        state.input = "what needs me?".into();
        state.ask().unwrap();
        state.answered(Reply {
            reply: "Two things.".into(),
            actions: vec![action("start"), action("abort"), action("resume")],
            dropped: vec![],
        });
        state
    }

    #[test]
    fn y_runs_the_row_at_the_cursor_and_moves_on_and_s_skips_it() {
        let mut state = walked();
        assert_eq!(state.runnable().unwrap().kind, "start");
        state.settle(&Err("refused".into()));
        assert_eq!(state.rows[0].status, Status::Failed("refused".into()));
        assert_eq!(state.cursor, 0, "a failure stays on its row");
        assert!(state.runnable().is_some(), "and may be tried again");
        state.skip();
        assert_eq!(state.rows[0].status, Status::Skipped);
        assert_eq!(state.cursor, 1);
        assert_eq!(state.rows[1].status, Status::Pending);
        assert!(
            state.rows.iter().all(|r| r.status != Status::Done),
            "nothing ran without a y"
        );
    }

    #[test]
    fn a_done_row_is_not_run_again() {
        let mut state = walked();
        state.rows[0].status = Status::Done;
        assert!(state.runnable().is_none());
        state.move_by(1);
        assert_eq!(state.runnable().unwrap().kind, "abort");
    }

    #[test]
    fn a_follow_up_carries_the_last_ten_turns_and_not_the_new_question() {
        let mut state = State::new();
        for i in 0..14 {
            state.turns.push(Turn {
                who: if i % 2 == 0 { "person" } else { "foreman" },
                text: format!("turn {i}"),
            });
        }
        state.input = "and now?".into();
        let (question, history) = state.ask().unwrap();
        assert_eq!(question, "and now?");
        assert_eq!(history.len(), HISTORY_TURNS);
        assert_eq!(history[0].text, "turn 4");
        assert_eq!(history[9].text, "turn 13");
        assert_eq!(state.phase, Phase::Waiting);
    }

    #[test]
    fn an_empty_question_is_not_sent_and_a_failure_puts_it_back_in_the_box() {
        let mut state = State::new();
        state.input = "  ".into();
        assert!(state.ask().is_none());
        state.input = "what next?".into();
        state.ask().unwrap();
        state.failed();
        assert_eq!(state.input, "what next?");
        assert_eq!(state.phase, Phase::Typing);
        assert!(state.turns.is_empty());
    }
}
