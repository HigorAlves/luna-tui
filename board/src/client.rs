//! Talks to the machine: blocking HTTP calls for commands, and a background thread that
//! follows the `/events` stream and hands each message to the UI over a channel.

use std::{
    env,
    io::{BufRead, BufReader},
    sync::mpsc::Sender,
    thread,
    time::Duration,
};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use ureq::{Agent, Body, http::Response};

use crate::model::{Metrics, StreamMessage, Task, TaskDetail, TicketText};

const RECONNECT_EVERY: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// What the stream thread reports.
pub enum Incoming {
    Online,
    Offline(String),
    Message(StreamMessage),
}

pub struct Machine {
    base: String,
    agent: Agent,
}

type Reply = Result<Response<Body>, ureq::Error>;

impl Machine {
    /// `HARDNESS_MACHINE_URL`, or the dev default.
    pub fn from_env() -> Self {
        let base = env::var("HARDNESS_MACHINE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:4317".to_string())
            .trim_end_matches('/')
            .to_string();
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .into();
        Self { base, agent }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
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

/// Follows `/events` on a background thread, reconnecting while the machine is down.
/// Stops once the receiving side is gone.
pub fn spawn_stream(base: String, tx: Sender<Incoming>) {
    thread::spawn(move || {
        // No timeout: the stream stays open for as long as the board runs.
        let agent: Agent = Agent::config_builder().http_status_as_error(false).build().into();
        loop {
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
        "task.updated" | "task.event" | "task.deleted" => serde_json::from_str(data).ok(),
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
}
