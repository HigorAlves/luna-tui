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

use crate::model::{
    Health, JiraIssueHit, JiraStatus, Metrics, PlanEdit, PrAction, PrSnapshot, SlackMetrics, SlackOption, SlackSnapshot, SlackWatch, Slots,
    StreamMessage, Task, TaskDetail, TaskDiff, TestCase, TicketText,
};

const RECONNECT_EVERY: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A poll asks GitHub or Slack about every item, so it may take far longer than a click.
const POLL_TIMEOUT: Duration = Duration::from_secs(120);
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
    /// A `/tasks/:id` answer, fetched off the UI thread.
    Detail { id: String, detail: Option<TaskDetail> },
    /// A `/tasks/:id/diff` answer: the files, and `file`'s patch when one was asked for.
    /// `generation` is the app's diff generation when the fetch left; an answer from an
    /// older one is stale (the branch moved meanwhile) and is dropped.
    Diff { id: String, file: Option<String>, diff: Result<TaskDiff, String>, generation: u64 },
    /// The watch picker's completions (user groups, channels), fetched off the UI thread when the Slack view opens.
    SlackCatalog { groups: Vec<SlackOption>, channels: Vec<SlackOption> },
    /// A `/jira/search` answer for `query`, fetched off the UI thread; dropped when the prompt has moved on.
    JiraHits { query: String, hits: Result<Vec<JiraIssueHit>, String> },
    /// The answer to `R` in Pulls, polled off the UI thread.
    PrsPolled(Result<PrSnapshot, String>),
    /// The answer to `R` in Slack, polled off the UI thread.
    SlackPolled(Result<SlackSnapshot, String>),
}

#[derive(Clone)]
pub struct Machine {
    /// The machine in use. The stream thread re-picks it on every reconnect.
    base: Arc<RwLock<String>>,
    candidates: Vec<String>,
    agent: Agent,
    /// For the calls that wait on a poll of GitHub or Slack.
    slow: Agent,
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
        let slow = Agent::config_builder().http_status_as_error(false).timeout_global(Some(POLL_TIMEOUT)).build().into();
        Self { base: Arc::new(RwLock::new(base)), candidates, agent, slow }
    }

    /// A machine at a known address, for tests that stand up their own.
    #[cfg(test)]
    pub fn at(base: &str) -> Self {
        let agent = Agent::config_builder().http_status_as_error(false).timeout_global(Some(REQUEST_TIMEOUT)).build().into();
        let slow = Agent::config_builder().http_status_as_error(false).timeout_global(Some(POLL_TIMEOUT)).build().into();
        Self { base: Arc::new(RwLock::new(base.to_string())), candidates: vec![base.to_string()], agent, slow }
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

    /// The stage pool, from `/health`.
    pub fn health(&self) -> Result<Health, String> {
        Self::typed(self.agent.get(self.url("/health")).call())
    }

    /// Take no new work; running stages finish.
    pub fn drain(&self) -> Result<Slots, String> {
        Self::typed(self.agent.post(self.url("/drain")).send_json(json!({})))
    }

    /// Carry on claiming from the queue.
    pub fn resume_claims(&self) -> Result<Slots, String> {
        Self::typed(self.agent.post(self.url("/resume")).send_json(json!({})))
    }

    /// Resize the pool at run time.
    pub fn set_slots(&self, max: u64) -> Result<Slots, String> {
        Self::typed(self.agent.patch(self.url("/slots")).send_json(json!({ "max": max })))
    }

    /// Metrics for a window: `7d` or `30d`.
    /// One repo's numbers (`Some(None)` is the tasks with no repo), or every repo's at once.
    pub fn metrics_for(&self, since: &str, repo: Option<Option<&str>>, group: bool) -> Result<Metrics, String> {
        let mut query = format!("/metrics?since={since}");
        if let Some(repo) = repo {
            query.push_str(&format!("&repo={}", urlencoding(repo.unwrap_or(""))));
        }
        if group {
            query.push_str("&groupBy=repo");
        }
        Self::typed(self.agent.get(self.url(&query)).call())
    }

    pub fn detail(&self, id: &str) -> Result<TaskDetail, String> {
        Self::typed(self.agent.get(self.url(&format!("/tasks/{id}"))).call())
    }

    /// The task branch against its base; with `file`, that file's patch too.
    pub fn diff(&self, id: &str, file: Option<&str>) -> Result<TaskDiff, String> {
        let query = file.map(|f| format!("?file={}", urlencoding(f))).unwrap_or_default();
        Self::typed(self.agent.get(self.url(&format!("/tasks/{id}/diff{query}"))).call())
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

    /// Replaces test_design's cases while they wait for your check.
    pub fn edit_cases(&self, id: &str, cases: &[TestCase]) -> Result<Task, String> {
        let cases: Vec<Value> = cases
            .iter()
            .map(|c| json!({ "title": c.title, "criterion": c.criterion, "approach": c.approach }))
            .collect();
        Self::typed(self.agent.patch(self.url(&format!("/tasks/{id}/cases"))).send_json(json!({ "cases": cases })))
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        Self::json(self.agent.delete(self.url(&format!("/tasks/{id}"))).call()).map(|_| ())
    }

    pub fn start(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/start"), json!({}))
    }

    /// A setup-only task for the checkout at `repo_path`: the setup pack proposes its luna.yaml,
    /// approving writes the file and closes the task.
    pub fn setup_repo(&self, repo_path: &str) -> Result<Task, String> {
        self.post("/repos/setup", json!({ "repoPath": repo_path }))
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

    /// The PR inbox as the machine last polled it.
    pub fn prs(&self) -> Result<PrSnapshot, String> {
        Self::typed(self.agent.get(self.url("/github/prs")).call())
    }

    /// Polls GitHub now and answers the fresh snapshot.
    pub fn refresh_prs(&self) -> Result<PrSnapshot, String> {
        Self::typed(self.slow.post(self.url("/github/prs/refresh")).send_json(json!({})))
    }

    /// Dispatches a PR task; answers the task the machine started.
    pub fn pr_action(&self, repo: &str, number: u64, action: PrAction) -> Result<Task, String> {
        self.post(&pr_path(repo, number, "actions"), json!({ "action": action.wire() }))
    }

    /// Squash-merges a PR the machine shows as ready.
    pub fn merge_pr(&self, repo: &str, number: u64) -> Result<(), String> {
        Self::json(self.agent.post(self.url(&pr_path(repo, number, "merge"))).send_json(json!({}))).map(|_| ())
    }

    /// Asks the machine to clone `owner/name` into `dest`; the next snapshot shows the checkout.
    pub fn clone_repo(&self, repo: &str, dest: &str) -> Result<(), String> {
        Self::json(self.agent.post(self.url("/github/clone")).send_json(json!({ "repo": repo, "dest": dest }))).map(|_| ())
    }

    /// The Slack inbox as the machine last polled it, watches included.
    pub fn slack(&self) -> Result<SlackSnapshot, String> {
        Self::typed(self.agent.get(self.url("/slack/items")).call())
    }

    /// Polls Slack now and answers the fresh snapshot.
    pub fn refresh_slack(&self) -> Result<SlackSnapshot, String> {
        Self::typed(self.slow.post(self.url("/slack/refresh")).send_json(json!({})))
    }

    /// `done`, `snoozedUntil`, `seen` or `priority` on one item; answers the item as the
    /// machine now has it, which the next snapshot repeats.
    pub fn patch_slack_item(&self, id: &str, patch: Value) -> Result<Value, String> {
        Self::json(self.agent.patch(self.url(&slack_item_path(id, ""))).send_json(patch))
    }

    /// Posts `text` as you, in the item's thread (or channel). Nothing is added to it.
    /// Posts `text` in the item's thread as you; `nudge` has the machine prefix a mention of the item's author.
    pub fn slack_reply(&self, id: &str, text: &str, nudge: bool) -> Result<(), String> {
        Self::json(self.agent.post(self.url(&slack_item_path(id, "/reply"))).send_json(json!({ "text": text, "nudge": nudge }))).map(|_| ())
    }

    /// A Backlog ticket from the item; `repo_path` None leaves the repo to set later.
    pub fn slack_task(&self, id: &str, title: &str, repo_path: Option<&str>) -> Result<Task, String> {
        self.post(&slack_item_path(id, "/task"), json!({ "title": title, "repoPath": repo_path }))
    }

    pub fn slack_watches(&self) -> Result<Vec<SlackWatch>, String> {
        Self::typed(self.agent.get(self.url("/slack/watches")).call())
    }

    /// `{kind, value, label?, channels?, priority?}`; answers the watch the machine stored.
    pub fn add_slack_watch(&self, input: Value) -> Result<SlackWatch, String> {
        Self::typed(self.agent.post(self.url("/slack/watches")).send_json(input))
    }

    /// `{label?, channels?, priority?, enabled?}`; answers the watch as it now is.
    pub fn patch_slack_watch(&self, id: &str, patch: Value) -> Result<SlackWatch, String> {
        Self::typed(self.agent.patch(self.url(&format!("/slack/watches/{}", urlencoding(id)))).send_json(patch))
    }

    pub fn delete_slack_watch(&self, id: &str) -> Result<(), String> {
        Self::json(self.agent.delete(self.url(&format!("/slack/watches/{}", urlencoding(id)))).call()).map(|_| ())
    }

    /// How fast you answer, over `7d` or `30d`.
    pub fn slack_metrics(&self, since: &str) -> Result<SlackMetrics, String> {
        Self::typed(self.agent.get(self.url(&format!("/slack/metrics?since={since}"))).call())
    }

    /// The workspace's user groups, for the watch picker's `@` completions.
    pub fn slack_usergroups(&self) -> Result<Vec<SlackOption>, String> {
        Self::typed(self.agent.get(self.url("/slack/usergroups")).call())
    }

    /// The channels you are in, for the watch picker's `#` completions.
    pub fn slack_channels(&self) -> Result<Vec<SlackOption>, String> {
        Self::typed(self.agent.get(self.url("/slack/channels")).call())
    }

    /// Links an existing Jira issue to the ticket; answers the task with its `jira` set.
    pub fn link_jira(&self, id: &str, key: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/jira"), json!({ "key": key }))
    }

    /// Drops the ticket's Jira link; the issue itself is not touched.
    pub fn unlink_jira(&self, id: &str) -> Result<Task, String> {
        Self::typed(self.agent.delete(self.url(&format!("/tasks/{id}/jira"))).call())
    }

    /// Creates a Jira issue from the ticket, in the repo's project or `project`, and links it.
    pub fn create_jira(&self, id: &str, project: Option<&str>) -> Result<Task, String> {
        let body = match project {
            Some(project) => json!({ "project": project }),
            None => json!({}),
        };
        self.post(&format!("/tasks/{id}/jira/create"), body)
    }

    /// Issues matching a key or free text, your open ones first.
    pub fn jira_search(&self, q: &str) -> Result<Vec<JiraIssueHit>, String> {
        Self::typed(self.agent.get(self.url(&format!("/jira/search?q={}", urlencoding(q)))).call())
    }

    /// Whether Jira is configured and reachable.
    pub fn jira_status(&self) -> Result<JiraStatus, String> {
        Self::typed(self.agent.get(self.url("/jira/status")).call())
    }
}

/// `/slack/items/<id><verb>`; the id carries `:` and `.`, so it travels percent-encoded.
fn slack_item_path(id: &str, verb: &str) -> String {
    format!("/slack/items/{}{verb}", urlencoding(id))
}

/// `/github/prs/<owner>/<name>/<number>/<verb>`.
fn pr_path(repo: &str, number: u64, verb: &str) -> String {
    format!("/github/prs/{repo}/{number}/{verb}")
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
        "task.updated" | "task.event" | "task.deleted" | "stage.started" | "task.closed" | "budget.alert" | "github.prs" | "slack.items" => {
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

/// Percent-encodes a query value: paths carry `/` and spaces, nothing a URL may keep bare.
fn urlencoding(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
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

#[cfg(test)]
mod pr_tests {
    use super::*;

    #[test]
    fn the_pr_routes_are_built_from_the_repo_and_number() {
        assert_eq!(pr_path("o/a", 12, "merge"), "/github/prs/o/a/12/merge");
        assert_eq!(pr_path("o/a", 12, "actions"), "/github/prs/o/a/12/actions");
        let event = parse_stream_event("github.prs", r#"{"type":"github.prs","snapshot":{"prs":[],"polledAt":null,"error":"x"}}"#);
        assert!(matches!(event, Some(StreamMessage::Prs { ref snapshot }) if snapshot.error.as_deref() == Some("x")));
    }

    #[test]
    fn the_slack_routes_encode_the_item_id_and_the_stream_event_is_parsed() {
        assert_eq!(slack_item_path("C0123:1730112345.0001", ""), "/slack/items/C0123%3A1730112345.0001");
        assert_eq!(slack_item_path("C0123:1.2", "/reply"), "/slack/items/C0123%3A1.2/reply");
        let data = format!(r#"{{"type":"slack.items","snapshot":{}}}"#, crate::slack::fixtures::snapshot_json());
        let event = parse_stream_event("slack.items", &data);
        assert!(matches!(event, Some(StreamMessage::Slack { ref snapshot }) if snapshot.items.len() == 3 && snapshot.socket == "connected"));
        let bare = parse_stream_event("slack.items", r#"{"type":"slack.items","snapshot":{"items":[],"watches":[],"me":null,"polledAt":null,"error":null,"socket":"off"}}"#);
        assert!(matches!(bare, Some(StreamMessage::Slack { ref snapshot }) if snapshot.items.is_empty()));
    }
}
