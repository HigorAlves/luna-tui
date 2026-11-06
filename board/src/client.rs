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
use ureq::{
    Agent, Body,
    config::ConfigBuilder,
    http::{HeaderValue, Response},
    typestate::AgentScope,
};

use crate::backlog::BacklogEntry;
use crate::tickets::{TicketEntry, encode_key};
use crate::model::{
    EngineCatalog, EngineInfo, Health, JiraIssueHit, JiraStatus, Metrics, PlanEdit, PrAction, PrSnapshot, SlackMetrics, SlackOption, SlackSnapshot, SlackWatch, Slots,
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
    /// The machine's API token, sent on every call; see `api_token`.
    token: Option<String>,
}

type Reply = Result<Response<Body>, ureq::Error>;

impl Machine {
    /// `HARDNESS_MACHINE_URL`, or whichever of the dev and Docker machines is up (dev first).
    pub fn from_env() -> Self {
        let candidates = candidates(env::var("HARDNESS_MACHINE_URL").ok());
        let token = api_token();
        let base = pick_up(&candidates, &token);
        Self::with(base, candidates, token)
    }

    fn with(base: String, candidates: Vec<String>, token: Option<String>) -> Self {
        let agent = builder(&token).http_status_as_error(false).timeout_global(Some(REQUEST_TIMEOUT)).build().into();
        let slow = builder(&token).http_status_as_error(false).timeout_global(Some(POLL_TIMEOUT)).build().into();
        Self { base: Arc::new(RwLock::new(base)), candidates, agent, slow, token }
    }

    /// A machine at a known address, for tests that stand up their own.
    #[cfg(test)]
    pub fn at(base: &str) -> Self {
        Self::at_with_token(base, None)
    }

    #[cfg(test)]
    pub fn at_with_token(base: &str, token: Option<String>) -> Self {
        Self::with(base.to_string(), vec![base.to_string()], token)
    }

    pub fn base(&self) -> String {
        self.base.read().map(|b| b.clone()).unwrap_or_default()
    }

    /// Follows `/events` on a background thread; see `spawn_stream`.
    pub fn follow_stream(&self, tx: Sender<Incoming>) {
        spawn_stream(Arc::clone(&self.base), self.candidates.clone(), self.token.clone(), tx);
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base())
    }

    /// Turns a reply into its JSON body, or the machine's error message.
    fn json(reply: Reply) -> Result<Value, String> {
        Self::coded(reply).map_err(|(_, message)| message)
    }

    /// `json`, keeping the machine's error code (`stage_started`) beside its message.
    fn coded(reply: Reply) -> Result<Value, (String, String)> {
        let mut response = reply.map_err(|e| (String::new(), format!("machine unreachable: {e}")))?;
        let status = response.status().as_u16();
        if status == 204 {
            return Ok(Value::Null);
        }
        let body: Value = response
            .body_mut()
            .read_json()
            .map_err(|e| (String::new(), format!("unexpected reply from the machine: {e}")))?;
        if status >= 400 {
            let code = body["error"].as_str().unwrap_or_default().to_string();
            return Err((code, body["message"].as_str().unwrap_or("request failed").to_string()));
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
    /// One repo's numbers (`Some(None)` is the tasks with no repo); `group` adds a row per
    /// `repo` or per `engine`.
    pub fn metrics_for(&self, since: &str, repo: Option<Option<&str>>, group: Option<&str>) -> Result<Metrics, String> {
        let mut query = format!("/metrics?since={since}");
        if let Some(repo) = repo {
            query.push_str(&format!("&repo={}", urlencoding(repo.unwrap_or(""))));
        }
        if let Some(group) = group {
            query.push_str(&format!("&groupBy={group}"));
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

    /// Corrects the Triage Record at a gate: `(key, value)` pairs from `RECORD_FIELDS`, enum values only.
    pub fn edit_record(&self, id: &str, changes: &[(String, String)]) -> Result<Task, String> {
        let body: serde_json::Map<String, Value> = changes.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
        Self::typed(self.agent.patch(self.url(&format!("/tasks/{id}/record"))).send_json(Value::Object(body)))
    }

    /// Replaces test_design's cases while they wait for your check.
    pub fn edit_cases(&self, id: &str, cases: &[TestCase]) -> Result<Task, String> {
        let cases: Vec<Value> = cases
            .iter()
            .map(|c| json!({ "title": c.title, "criterion": c.criterion, "approach": c.approach }))
            .collect();
        Self::typed(self.agent.patch(self.url(&format!("/tasks/{id}/cases"))).send_json(json!({ "cases": cases })))
    }

    /// `GET /packs` and `GET /engines` together: what each stage may run on, and what this
    /// machine has the credentials for. A machine from before engines answers neither.
    pub fn engine_catalog(&self) -> Result<EngineCatalog, String> {
        let packs = Self::typed(self.agent.get(self.url("/packs")).call())?;
        let engines = Self::typed(self.agent.get(self.url("/engines")).call())?;
        Ok(EngineCatalog { packs, engines })
    }

    /// `GET /engines`: each engine's credential, and this month's spend against its cap.
    /// Each repository's image and graph health; a machine from before them answers 404.
    pub fn repo_health(&self) -> Result<Vec<crate::model::RepoHealth>, String> {
        Self::typed(self.agent.get(self.url("/repos")).call())
    }

    /// Approves the exact base the repository's luna.yaml names now; the machine refuses any other reference.
    pub fn approve_base(&self, repo: &str, base: &str) -> Result<(), String> {
        Self::json(self.agent.post(self.url("/repos/base/approve")).send_json(json!({ "repo": repo, "base": base }))).map(|_| ())
    }

    pub fn engines(&self) -> Result<Vec<EngineInfo>, String> {
        Self::typed(self.agent.get(self.url("/engines")).call())
    }

    /// Sets the task's engine for one pack; `None` goes back to luna.yaml's, else the pack's default.
    pub fn set_stage_engine(&self, id: &str, pack: &str, engine: Option<&str>) -> Result<Task, String> {
        let reply = self.agent.patch(self.url(&format!("/tasks/{id}/stages"))).send_json(json!({ "stages": { pack: engine } }));
        let body = Self::coded(reply).map_err(|(code, message)| match code.as_str() {
            "stage_started" => format!("{pack} already ran on this ticket; its engine stays"),
            _ => message,
        })?;
        serde_json::from_value(body).map_err(|e| format!("unexpected reply: {e}"))
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

    /// Approves (or sends back) whatever the task waits on, with an optional reason, as
    /// `LUNA_APPROVER` when it is set: a plan of High risk needs two distinct names.
    pub fn decide(&self, id: &str, approve: bool, reason: Option<&str>) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/decision"), decision_body(approve, reason, approver().as_deref()))
    }

    /// Keeps a split card as one card: the split gate approved with `keepWhole`, recorded with the approver's name. Only a split gate takes it.
    pub fn keep_whole(&self, id: &str) -> Result<Task, String> {
        let mut body = json!({ "decision": "approved", "keepWhole": true });
        if let Some(name) = approver() {
            body["approver"] = json!(name);
        }
        self.post(&format!("/tasks/{id}/decision"), body)
    }

    /// Rejects the plan the task waits on: the card ends archived as rejected and the comment is kept. Only the plan gate takes it.
    pub fn reject(&self, id: &str, comment: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/decision"), reject_body(comment, approver().as_deref()))
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

    /// Posts triage's open questions where the ticket came from (the machine does it once; asking again posts nothing new).
    pub fn post_questions(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/questions/post"), json!({}))
    }

    /// Ends the ticket as archived, with one of `ARCHIVE_REASONS`.
    pub fn archive(&self, id: &str, reason: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/archive"), json!({ "reason": reason }))
    }

    /// Says whether the card's Evidence Pack was useful (`y` / `n`), with a short note for a no. The machine keeps it as ground truth; it labels no decision.
    pub fn evidence_feedback(&self, id: &str, useful: bool, note: Option<&str>) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/evidence/feedback"), evidence_feedback_body(useful, note))
    }

    /// Dismisses a finding the last Verify reported (the card waits at the ship gate, or its PR is watched); the reason is kept as ground truth, out of the stream.
    pub fn dismiss_finding(&self, id: &str, finding: &str, reason: Option<&str>) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/findings/{}/dismiss", path_segment(finding)), dismiss_body(reason))
    }

    /// Adds a finding Verify missed, with a severity (`blocker`, `should_fix`, `nit`) and a title.
    pub fn add_finding(&self, id: &str, severity: &str, title: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/findings"), json!({ "severity": severity, "title": title }))
    }

    /// Corrects the reason an escalation was decided with, to one of `ESCALATION_REASONS`; the card stays where it is.
    pub fn correct_escalation_reason(&self, id: &str, reason: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/escalation-reason"), json!({ "reason": reason }))
    }

    pub fn resume(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/resume"), json!({}))
    }

    /// Removes the task's worktree from disk; the task and its branch stay.
    pub fn remove_worktree(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/worktree/remove"), json!({}))
    }

    /// The ranked backlog.
    pub fn backlog(&self) -> Result<Vec<BacklogEntry>, String> {
        Self::typed(self.agent.get(self.url("/backlog")).call())
    }

    /// The tickets the ticket machine holds, with their drafts.
    pub fn tickets(&self) -> Result<Vec<TicketEntry>, String> {
        Self::typed(self.agent.get(self.url("/tickets")).call())
    }

    /// A tap on a ticket: `approve`, `edit`, `ignore`, `card` or `backlog`; `body` carries the draft id and hash (and the text for an edit).
    pub fn ticket_act(&self, key: &str, action: &str, body: Value) -> Result<(), String> {
        Self::json(self.agent.post(self.url(&format!("/tickets/{}/{action}", encode_key(key)))).send_json(body)).map(|_| ())
    }

    /// `bump`, `promote` or `decline` on a backlog item.
    pub fn backlog_act(&self, id: &str, action: &str) -> Result<(), String> {
        Self::json(self.agent.post(self.url(&format!("/backlog/{id}/{action}"))).send_json(json!({}))).map(|_| ())
    }

    /// A person's answer at Intake's dedup gate: `choice` is `duplicate`, `related` or `neither`, `of` ids the gate listed.
    pub fn answer_dedup(&self, id: &str, choice: &str, of: &[String]) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/dedup"), json!({ "choice": choice, "of": of }))
    }

    /// The task is a duplicate of `into`: it closes, merged into it.
    pub fn merge_into(&self, id: &str, into: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/merge"), json!({ "into": into }))
    }

    /// Undoes a merge: the duplicate comes back as a new card (the answer).
    pub fn unmerge(&self, id: &str) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/unmerge"), json!({}))
    }

    /// What a person gives Intake's context gate: a repository, a project or more text; the card is checked again.
    pub fn give_context(&self, id: &str, given: Value) -> Result<Task, String> {
        self.post(&format!("/tasks/{id}/context"), given)
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

    /// Closes the PR without merging; its branch stays.
    pub fn close_pr(&self, repo: &str, number: u64) -> Result<(), String> {
        Self::json(self.agent.post(self.url(&pr_path(repo, number, "close"))).send_json(json!({}))).map(|_| ())
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
    /// `draft` is the id and hash of the waiting draft you were shown: with them the machine settles that draft, without them it only posts.
    pub fn slack_reply(&self, id: &str, text: &str, nudge: bool, draft: Option<(&str, &str)>) -> Result<(), String> {
        Self::json(self.agent.post(self.url(&slack_item_path(id, "/reply"))).send_json(slack_reply_body(text, nudge, draft))).map(|_| ())
    }

    /// What you say a thread is about: a stored answer (and a truth record), never a post. `target` is an id of the item's stored shortlist.
    pub fn slack_relation(&self, id: &str, relation: &str, target: Option<&str>) -> Result<crate::model::SlackItem, String> {
        let value = Self::json(self.agent.post(self.url(&slack_item_path(id, "/relation"))).send_json(json!({ "relation": relation, "target": target })))?;
        serde_json::from_value(value).map_err(|e| e.to_string())
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
/// The body of a Slack reply: the text, the nudge flag and, for a draft's tap, the draft's id and hash.
fn slack_reply_body(text: &str, nudge: bool, draft: Option<(&str, &str)>) -> Value {
    let mut body = json!({ "text": text, "nudge": nudge });
    if let Some((id, hash)) = draft {
        body["draftId"] = json!(id);
        body["draftHash"] = json!(hash);
    }
    body
}

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

/// `MACHINE_API_TOKEN`, else `~/.config/hardness/machine-api-token`: the token the machine asks
/// for when it has one. Never shown.
fn api_token() -> Option<String> {
    token_from(env::var("MACHINE_API_TOKEN").ok(), env::var("HOME").ok())
}

fn token_from(var: Option<String>, home: Option<String>) -> Option<String> {
    let bare = |value: String| Some(value.split_whitespace().collect::<String>()).filter(|v| !v.is_empty());
    var.and_then(bare).or_else(|| {
        let path = std::path::Path::new(&home?).join(".config").join("hardness").join("machine-api-token");
        std::fs::read_to_string(path).ok().and_then(bare)
    })
}

/// An agent's config, sending `Authorization: Bearer <token>` on every call when there is a token.
fn builder(token: &Option<String>) -> ConfigBuilder<AgentScope> {
    let config = Agent::config_builder();
    let Some(value) = token.as_ref().and_then(|t| HeaderValue::from_str(&format!("Bearer {t}")).ok()) else {
        return config;
    };
    config.middleware(move |mut request: ureq::http::Request<ureq::SendBody>, next: ureq::middleware::MiddlewareNext| {
        request.headers_mut().insert("authorization", value.clone());
        next.handle(request)
    })
}

/// `pick` against the real `/health`; skips probing when there is only one candidate.
fn pick_up(candidates: &[String], token: &Option<String>) -> String {
    if candidates.len() == 1 {
        return candidates[0].clone();
    }
    let probe: Agent = builder(token).timeout_global(Some(PROBE_TIMEOUT)).build().into();
    pick(candidates, |base| probe.get(format!("{base}/health")).call().is_ok()).to_string()
}

/// Follows `/events` on a background thread, reconnecting while the machine is down. Each
/// (re)connect picks the machine again, so switching between `pnpm start` and `pnpm dev`
/// needs no restart. Stops once the receiving side is gone.
fn spawn_stream(shared: Arc<RwLock<String>>, candidates: Vec<String>, token: Option<String>, tx: Sender<Incoming>) {
    thread::spawn(move || {
        // No timeout: the stream stays open for as long as the board runs.
        let agent: Agent = builder(&token).http_status_as_error(false).build().into();
        loop {
            let base = pick_up(&candidates, &token);
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
        "task.updated" | "task.event" | "task.deleted" | "stage.started" | "task.closed" | "budget.alert" | "github.prs" | "slack.items" | "task.shipped" => {
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

/// Who is deciding: `LUNA_APPROVER`, when it names someone.
fn approver() -> Option<String> {
    std::env::var("LUNA_APPROVER").ok().map(|name| name.trim().to_string()).filter(|name| !name.is_empty())
}

/// The body of `POST /tasks/:id/decision`; the approver rides along only when there is one.
fn decision_body(approve: bool, reason: Option<&str>, approver: Option<&str>) -> Value {
    let mut body = json!({ "decision": if approve { "approved" } else { "sent_back" }, "reason": reason });
    if let Some(name) = approver {
        body["approver"] = json!(name);
    }
    body
}

/// The body of an Evidence feedback: the fixed value, and the note only when there is one (trimmed, at most 500 characters, as the machine allows).
/// One path segment, percent-encoded: a finding id is the machine's, but a typed one is not trusted to keep a `/` or a `?` out of the URL.
fn path_segment(text: &str) -> String {
    text.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn dismiss_body(reason: Option<&str>) -> Value {
    match reason {
        Some(r) if !r.trim().is_empty() => json!({ "reason": r.trim() }),
        _ => json!({}),
    }
}

fn evidence_feedback_body(useful: bool, note: Option<&str>) -> Value {
    let mut body = json!({ "useful": useful });
    if let Some(text) = note.map(str::trim).filter(|t| !t.is_empty()) {
        body["note"] = json!(text.chars().take(500).collect::<String>());
    }
    body
}

/// The body of a rejection: `rejected` with its comment (the machine reads it as the reason), and the approver when there is one.
fn reject_body(comment: &str, approver: Option<&str>) -> Value {
    let mut body = json!({ "decision": "rejected", "reason": comment });
    if let Some(name) = approver {
        body["approver"] = json!(name);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_carries_the_draft_id_and_hash_only_when_it_was_opened_on_a_draft() {
        assert_eq!(slack_reply_body("hi", false, Some(("d1", "abc"))), json!({ "text": "hi", "nudge": false, "draftId": "d1", "draftHash": "abc" }));
        assert_eq!(slack_reply_body("hi", true, None), json!({ "text": "hi", "nudge": true }));
    }

    #[test]
    fn a_decision_names_its_approver_when_there_is_one_and_stays_as_it_was_when_not() {
        assert_eq!(decision_body(true, None, None), json!({ "decision": "approved", "reason": null }));
        assert_eq!(decision_body(false, Some("split it"), Some("ana")), json!({ "decision": "sent_back", "reason": "split it", "approver": "ana" }));
    }

    #[test]
    fn the_feedback_body_is_the_fixed_value_and_a_note_only_when_there_is_one() {
        assert_eq!(evidence_feedback_body(true, None), json!({ "useful": true }));
        assert_eq!(evidence_feedback_body(false, Some("too long")), json!({ "useful": false, "note": "too long" }));
        assert_eq!(evidence_feedback_body(false, Some("  ")), json!({ "useful": false }));
        assert_eq!(evidence_feedback_body(false, Some(&"x".repeat(900)))["note"].as_str().unwrap().chars().count(), 500);
    }

    #[test]
    fn a_rejection_is_the_rejected_decision_with_its_comment_and_the_approver_when_there_is_one() {
        assert_eq!(reject_body("not now", None), json!({ "decision": "rejected", "reason": "not now" }));
        assert_eq!(reject_body("not now", Some("ana")), json!({ "decision": "rejected", "reason": "not now", "approver": "ana" }));
    }

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
    fn task_shipped_is_parsed_with_what_shipped() {
        let shipped = parse_stream_event(
            "task.shipped",
            r##"{"type":"task.shipped","shipped":{"id":"t1","title":"Export CSV","prUrl":"https://github.com/o/a/pull/7","number":7,"mergedSha":"9c1f0e2a","format":"video","howToVerify":null,"media":[{"kind":"video","label":"Walkthrough","url":"https://x/w.mp4"}],"at":"2026-11-04T12:00:00.000Z"}}"##,
        );
        assert!(matches!(
            shipped,
            Some(StreamMessage::TaskShipped { ref shipped }) if shipped.number == 7 && shipped.title == "Export CSV" && shipped.how_to_verify.is_none()
        ));
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
mod token_tests {
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::mpsc,
    };

    use super::*;

    #[test]
    fn the_api_token_comes_from_the_environment_else_the_secrets_file_else_none() {
        let home = env::temp_dir().join(format!("board-token-{}", std::process::id()));
        let dir = home.join(".config").join("hardness");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(token_from(None, Some(home.to_string_lossy().to_string())), None);
        std::fs::write(dir.join("machine-api-token"), "from-file\n").unwrap();
        assert_eq!(token_from(None, Some(home.to_string_lossy().to_string())).as_deref(), Some("from-file"));
        assert_eq!(token_from(Some(" from-env ".into()), Some(home.to_string_lossy().to_string())).as_deref(), Some("from-env"));
        assert_eq!(token_from(Some(String::new()), Some(home.to_string_lossy().to_string())).as_deref(), Some("from-file"));
        assert_eq!(token_from(None, None), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn every_call_carries_the_token_when_there_is_one() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut auth = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("authorization:") {
                        auth = Some(value.trim().to_string());
                    }
                }
                let _ = tx.send(auth);
                let _ = reader.into_inner().write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 2\r\n\r\n[]");
            }
        });
        let machine = Machine::at_with_token(&format!("http://{addr}"), Some("s3cret".into()));
        machine.tasks().unwrap();
        assert_eq!(rx.recv().unwrap().as_deref(), Some("bearer s3cret"));
        Machine::at(&format!("http://{addr}")).tasks().unwrap();
        assert_eq!(rx.recv().unwrap(), None);
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

    #[test]
    fn a_finding_id_travels_as_one_encoded_path_segment() {
        assert_eq!(path_segment("f-3_a.b"), "f-3_a.b");
        assert_eq!(path_segment("a/b?c d"), "a%2Fb%3Fc%20d");
        assert_eq!(dismiss_body(None), json!({}));
        assert_eq!(dismiss_body(Some(" no ")), json!({"reason":"no"}));
    }
}
