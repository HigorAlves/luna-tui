//! Talks to the machine: blocking HTTP calls for commands, and a background thread that
//! follows the `/events` stream and hands each message to the UI over a channel.

use std::{
    env,
    io::{BufRead, BufReader},
    sync::{Arc, RwLock, mpsc::Sender},
    thread,
    time::Duration,
};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use ureq::{Agent, Body, http::Response};

use crate::model::{Metrics, PlanEdit, StreamMessage, Task, TaskDetail, TicketText};

const RECONNECT_EVERY: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// Where `pnpm dev` runs the machine, on the host.
pub const DEV_URL: &str = "http://127.0.0.1:4317";
/// Where `pnpm start` publishes the machine's container.
pub const DOCKER_URL: &str = "http://127.0.0.1:4318";

/// What the stream thread reports.
pub enum Incoming {
    Online,
    Offline(String),
    Message(StreamMessage),
}

pub struct Machine {
    /// The machine in use. The stream thread re-picks it on every reconnect.
    base: Arc<RwLock<String>>,
    candidates: Vec<String>,
    agent: Agent,
}

type Reply = Result<Response<Body>, ureq::Error>;

impl Machine {
    /// `HARDNESS_MACHINE_URL`, or whichever of the dev and Docker machines is up (dev first).
    pub fn from_env() -> Self {
        let candidates = candidates(env::var("HARDNESS_MACHINE_URL").ok());
        let base = pick_up(&candidates);
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .into();
        Self { base: Arc::new(RwLock::new(base)), candidates, agent }
    }

    pub fn base(&self) -> String {
        self.base.read().map(|b| b.clone()).unwrap_or_default()
    }

    /// Follows `/events` on a background thread; see `spawn_stream`.
    pub fn follow_stream(&self, tx: Sender<Incoming>) {
        spawn_stream(Arc::clone(&self.base), self.candidates.clone(), tx);
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base())
    }

    /// Turns a reply into its JSON body, or the machine's error message.
    fn json(reply: Reply) -> Result<Value, String> {
        let mut response = reply.map_err(|e| format!("machine unreachable: {e}"))?;
        let status = response.status().as_u16();
        if status == 204 {
            return Ok(Value::Null);
        }
        let body: Value = response
            .body_mut()
            .read_json()
            .map_err(|e| format!("unexpected reply from the machine: {e}"))?;
        if status >= 400 {
            return Err(body["message"].as_str().unwrap_or("request failed").to_string());
        }
        Ok(body)
    }

    fn typed<T: DeserializeOwned>(reply: Reply) -> Result<T, String> {
        serde_json::from_value(Self::json(reply)?).map_err(|e| format!("unexpected reply: {e}"))
    }

    fn post(&self, path: &str, body: Value) -> Result<Task, String> {
        Self::typed(self.agent.post(self.url(path)).send_json(body))
    }

    pub fn tasks(&self) -> Result<Vec<Task>, String> {
        Self::typed(self.agent.get(self.url("/tasks")).call())
    }

    /// Metrics for a window: `7d` or `30d`.
    pub fn metrics(&self, since: &str) -> Result<Metrics, String> {
        Self::typed(self.agent.get(self.url(&format!("/metrics?since={since}"))).call())
    }

    pub fn detail(&self, id: &str) -> Result<TaskDetail, String> {
        Self::typed(self.agent.get(self.url(&format!("/tasks/{id}"))).call())
    }

    pub fn create(&self, text: &TicketText) -> Result<Task, String> {
        self.post(
            "/tasks",
            json!({
                "title": text.title,
                "description": text.description,
                "criteria": text.criteria,
                "repoPath": text.repo_path,
            }),
        )
    }

    pub fn update(&self, id: &str, text: &TicketText) -> Result<Task, String> {
        let body = json!({
            "title": text.title,
            "description": text.description,
            "criteria": text.criteria,
            "repoPath": text.repo_path,
        });
        Self::typed(self.agent.patch(self.url(&format!("/tasks/{id}"))).send_json(body))
    }

    /// Edits triage's proposed plan while it awaits your approval. Slices aren't sent: they
    /// stay as triage wrote them.
    pub fn edit_plan(&self, id: &str, edit: &PlanEdit) -> Result<Task, String> {
        let body = json!({ "brief": edit.brief, "criteria": edit.criteria, "assumptions": edit.assumptions });
        Self::typed(self.agent.patch(self.url(&format!("/tasks/{id}/plan"))).send_json(body))
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        Self::json(self.agent.delete(self.url(&format!("/tasks/{id}"))).call()).map(|_| ())
    }

    pub fn start(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/start"), json!({}))
    }

    /// Approves (or sends back) whatever the task waits on, with an optional reason.
    pub fn decide(&self, id: &str, approve: bool, reason: Option<&str>) -> Result<Task, String> {
        let decision = if approve { "approved" } else { "sent_back" };
        self.post(
            &format!("/tasks/{id}/decision"),
            json!({ "decision": decision, "reason": reason }),
        )
    }

    /// Approves the memory review without writing its proposed rules to project-context.md.
    pub fn approve_skipping_rules(&self, id: &str) -> Result<Task, String> {
        self.post(
            &format!("/tasks/{id}/decision"),
            json!({ "decision": "approved", "applyRules": false, "reason": "rules skipped" }),
        )
    }

    pub fn answer(&self, id: &str, answers: &[(String, String)]) -> Result<Task, String> {
        let answers: serde_json::Map<String, Value> = answers
            .iter()
            .map(|(q, a)| (q.clone(), Value::String(a.clone())))
            .collect();
        self.post(&format!("/tasks/{id}/answers"), json!({ "answers": answers }))
    }

    pub fn abort(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/abort"), json!({}))
    }

    pub fn resume(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/resume"), json!({}))
    }

    /// Removes the task's worktree from disk; the task and its branch stay.
    pub fn remove_worktree(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/worktree/remove"), json!({}))
    }
}

/// `HARDNESS_MACHINE_URL` alone when set, else the dev machine, then the Docker one.
fn candidates(over: Option<String>) -> Vec<String> {
    match over {
        Some(url) => vec![url.trim_end_matches('/').to_string()],
        None => vec![DEV_URL.to_string(), DOCKER_URL.to_string()],
    }
}

/// The first candidate that answers, or the first one when none does.
fn pick(candidates: &[String], healthy: impl Fn(&str) -> bool) -> &str {
    candidates.iter().find(|c| healthy(c)).unwrap_or(&candidates[0])
}

/// `pick` against the real `/health`; skips probing when there is only one candidate.
fn pick_up(candidates: &[String]) -> String {
    if candidates.len() == 1 {
        return candidates[0].clone();
    }
    let probe: Agent = Agent::config_builder().timeout_global(Some(PROBE_TIMEOUT)).build().into();
    pick(candidates, |base| probe.get(format!("{base}/health")).call().is_ok()).to_string()
}

/// Follows `/events` on a background thread, reconnecting while the machine is down. Each
/// (re)connect picks the machine again, so switching between `pnpm start` and `pnpm dev`
/// needs no restart. Stops once the receiving side is gone.
fn spawn_stream(shared: Arc<RwLock<String>>, candidates: Vec<String>, tx: Sender<Incoming>) {
    thread::spawn(move || {
        // No timeout: the stream stays open for as long as the board runs.
        let agent: Agent = Agent::config_builder().http_status_as_error(false).build().into();
        loop {
            let base = pick_up(&candidates);
            if let Ok(mut current) = shared.write() {
                current.clone_from(&base);
            }
            let report = match agent.get(format!("{base}/events")).call() {
                Ok(response) if response.status().is_success() => {
                    if tx.send(Incoming::Online).is_err() {
                        return;
                    }
                    if !follow(response, &tx) {
                        return;
                    }
                    "the event stream closed".to_string()
                }
                Ok(response) => format!("the machine answered {}", response.status()),
                Err(error) => error.to_string(),
            };
            if tx.send(Incoming::Offline(report)).is_err() {
                return;
            }
            thread::sleep(RECONNECT_EVERY);
        }
    });
}

/// One stream message, or `None` for events the board does not use. `task.metrics` is
/// ignored on purpose: the Floor view fetches its own 7d and 30d windows, and the pushed
/// snapshot does not say which window it covers. Unknown event types are never an error.
fn parse_stream_event(event: &str, data: &str) -> Option<StreamMessage> {
    match event {
        "task.updated" | "task.event" | "task.deleted" | "stage.started" | "task.closed" => {
            serde_json::from_str(data).ok()
        }
        _ => None,
    }
}

/// Reads server-sent events until the stream ends. Returns false when the UI has gone away.
fn follow(response: Response<Body>, tx: &Sender<Incoming>) -> bool {
    let reader = BufReader::new(response.into_body().into_reader());
    let mut event = String::new();
    let mut data = String::new();
    for line in reader.lines() {
        let Ok(line) = line else {
            break;
        };
        if line.is_empty() {
            if let Some(message) = parse_stream_event(&event, &data)
                && tx.send(Incoming::Message(message)).is_err()
            {
                return false;
            }
            event.clear();
            data.clear();
        } else if let Some(value) = line.strip_prefix("event:") {
            event = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push_str(value.trim_start());
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_stream_events_are_ignored_not_errors() {
        assert!(parse_stream_event("task.metrics", r#"{"type":"task.metrics","metrics":{"x":1}}"#).is_none());
        assert!(parse_stream_event("task.future", "not json").is_none());
        let deleted = parse_stream_event("task.deleted", r#"{"type":"task.deleted","id":"a"}"#);
        assert!(matches!(deleted, Some(StreamMessage::Deleted { .. })));
    }

    #[test]
    fn stage_started_and_task_closed_are_parsed_for_the_watch_tabs() {
        let started = parse_stream_event(
            "stage.started",
            r##"{"type":"stage.started","taskId":"t1","label":"#t1 Fix","cwd":"/wt","container":"c1"}"##,
        );
        assert!(matches!(
            started,
            Some(StreamMessage::StageStarted { ref task_id, ref container, .. }) if task_id == "t1" && container == "c1"
        ));
        let closed = parse_stream_event("task.closed", r#"{"type":"task.closed","id":"t1"}"#);
        assert!(matches!(closed, Some(StreamMessage::Closed { ref id }) if id == "t1"));
    }

    #[test]
    fn the_dev_machine_wins_over_the_docker_one() {
        let both = candidates(None);
        assert_eq!(both, vec![DEV_URL.to_string(), DOCKER_URL.to_string()]);
        assert_eq!(pick(&both, |_| true), DEV_URL);
        assert_eq!(pick(&both, |url| url == DOCKER_URL), DOCKER_URL);
    }

    #[test]
    fn with_nothing_up_the_dev_machine_is_assumed_and_an_override_is_the_only_candidate() {
        assert_eq!(pick(&candidates(None), |_| false), DEV_URL);
        assert_eq!(candidates(Some("http://box:9000/".into())), vec!["http://box:9000".to_string()]);
    }
}
