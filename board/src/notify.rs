//! What the board tells you when you are elsewhere: a herdr notification on the transitions
//! that need you, a live count on the Board tab, a terminal BEL when herdr is not there.
//! `HARDNESS_BOARD_QUIET=1` silences all of it.
use crate::model::{DatadogItem, Look, PullRequest, SlackItem, Task, TaskEvent, TaskSla};
use crate::pulls::PrSplit;
use crate::slack::SlackSplit;

/// One thing worth telling you about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// The notice a task's change of look is worth, if any: into needs-you, escalated or paused
/// from anything else. Staying in that look, or leaving it, is not news.
pub fn notice_for(old: Option<Look>, task: &Task) -> Option<Notice> {
    let new = task.look();
    let (title, wants) = match new {
        Look::NeedsYou => ("Needs you", true),
        Look::Escalated => ("Escalated", true),
        Look::Paused => ("Paused on a usage limit", true),
        _ => ("", false),
    };
    if !wants || old == Some(new) {
        return None;
    }
    let what = task.reason.clone().unwrap_or_else(|| task.status_label());
    let repo = task.repo_name().map(|r| format!("{r} · ")).unwrap_or_default();
    Some(Notice { title: title.to_string(), body: format!("{repo}#{} {}: {what}", task.short_id(), task.title) })
}

/// The notices a ticket's SLA clocks are worth: `Gate overdue` when the gate clock flips past
/// its target, `Stage over SLA` when the stage clock does. Staying overdue, or coming back
/// inside, is not news; a ticket first seen overdue counts.
pub fn sla_notices(old: Option<&TaskSla>, task: &Task) -> Vec<Notice> {
    let Some(sla) = &task.sla else {
        return Vec::new();
    };
    let repo = task.repo_name().map(|r| format!("{r} · ")).unwrap_or_default();
    let mut notices = Vec::new();
    if sla.gate_overdue() && !old.is_some_and(TaskSla::gate_overdue) {
        let waited = sla.gate.as_ref().map(|g| crate::model::age_secs(g.target_secs)).unwrap_or_default();
        notices.push(Notice {
            title: "Gate overdue".to_string(),
            body: format!("{repo}#{} {}: {} waited past {waited}", task.short_id(), task.title, task.status_label()),
        });
    }
    if sla.stage_overdue() && !old.is_some_and(TaskSla::stage_overdue) {
        let stage = sla.stage.as_ref().and_then(|s| s.stage.clone()).unwrap_or_else(|| task.status_label());
        notices.push(Notice { title: "Stage over SLA".to_string(), body: format!("{repo}#{} {}: {stage} is past its target", task.short_id(), task.title) });
    }
    notices
}

/// The notice a `jira.moved` event is worth: someone moved the linked issue in Jira while the
/// ticket runs. Other task events are not news here.
pub fn jira_moved_notice(task: &Task, event: &TaskEvent) -> Option<Notice> {
    if event.kind != "jira.moved" {
        return None;
    }
    let key = event.payload["key"].as_str().or(task.jira_key()).unwrap_or("the issue");
    let status = event.payload["status"].as_str().unwrap_or("?");
    let doing = if task.running { "runs" } else { "waits" };
    Some(Notice { title: "Jira".to_string(), body: format!("{key} moved to {status} while #{} {doing}", task.short_id()) })
}

/// The notice a PR's change of split is worth: into Review requested, Ready to merge, CI failed
/// or Changes requested from anywhere else (or from nowhere). Staying put, or leaving, is not news.
pub fn pr_notice(old: Option<PrSplit>, pr: &PullRequest) -> Option<Notice> {
    let new = pr.split_enum()?;
    if !new.needs_me() || old == Some(new) {
        return None;
    }
    Some(Notice { title: new.label().to_string(), body: format!("{} {}", pr.key(), pr.title) })
}

/// The notice a Slack item is worth: `Reopened` when its thread moved after you cleared it
/// (`reopened_at` newly set), `Overdue` when it just went past its reply SLA (`overdue`
/// flipped on, whatever the priority), else `Needs reply` / `Decide` for a P0 or P1 entering
/// one of those splits from anywhere else (or from nowhere). Lower priorities, staying put,
/// and the other splits are not news; quiet hours are the machine's business.
pub fn slack_notice(old_split: Option<SlackSplit>, old_reopened_at: Option<&str>, old_overdue: bool, item: &SlackItem) -> Option<Notice> {
    let body = format!("{} @{}: {}", item.channel_label(), item.author.name, item.summary());
    if item.reopened_at.is_some() && item.reopened_at.as_deref() != old_reopened_at {
        return Some(Notice { title: "Reopened".to_string(), body });
    }
    if item.overdue && !old_overdue {
        return Some(Notice { title: "Overdue".to_string(), body });
    }
    let new = item.split_enum()?;
    if !new.needs_me() || old_split == Some(new) || !item.urgent() {
        return None;
    }
    Some(Notice { title: new.label().to_string(), body })
}

/// Inside the rules file's quiet hours (the snapshot's `quiet`) every notice but a P0's is held back.
pub fn muted_by_quiet_hours(quiet: bool, item: &SlackItem) -> bool {
    quiet && item.priority() != Some("P0")
}

/// The Datadog P0s already told, so each is news once: a P0 by its id, one that came back after
/// done by its id and when it came back. Lowering it and raising it again is not news twice.
#[derive(Debug, Default)]
pub struct DatadogNoticed(std::collections::HashSet<String>);

impl DatadogNoticed {
    /// The notices `items` are worth: `Datadog P0` for a P0 in an open split not told yet,
    /// `Datadog P0 reopened` for one that came back after you cleared it. A P0 is triage's, or the
    /// rule's floor while untriaged; lower priorities and anything snoozed or done are not news.
    /// There are no quiet hours to honour: only P0s are told, and a P0 gets through Slack's quiet
    /// hours too.
    pub fn notices(&mut self, items: &[DatadogItem]) -> Vec<Notice> {
        let mut out = Vec::new();
        for item in items {
            if item.effective_priority() != Some("P0") || !item.split_enum().is_some_and(crate::datadog::DatadogSplit::open) {
                continue;
            }
            let key = match &item.reopened_at {
                Some(at) => format!("{}@{at}", item.id),
                None => item.id.clone(),
            };
            if !self.0.insert(key) {
                continue;
            }
            let title = if item.reopened_at.is_some() { "Datadog P0 reopened" } else { "Datadog P0" };
            let place = match &item.service {
                Some(service) => format!("{} · {service}", item.source),
                None => item.source.clone(),
            };
            out.push(Notice { title: title.to_string(), body: format!("{place}: {}", item.summary()) });
        }
        out
    }
}

/// The notice for losing the machine.
pub fn offline_notice(reason: &str) -> Notice {
    Notice { title: "Machine offline".to_string(), body: reason.to_string() }
}

/// The Board tab's label: `Board`, `Board !2` while two tickets need you, `Board !2 ‼1` when
/// one of them (or any ticket) is past an SLA clock.
pub fn badge_label(needs_you: usize, overdue: usize) -> String {
    let mut label = "Board".to_string();
    if needs_you > 0 {
        label.push_str(&format!(" !{needs_you}"));
    }
    if overdue > 0 {
        label.push_str(&format!(" ‼{overdue}"));
    }
    label
}

/// `HARDNESS_BOARD_QUIET=1` (or anything but empty/0) turns every notice off.
pub fn quiet(value: Option<&str>) -> bool {
    matches!(value, Some(v) if !v.is_empty() && v != "0")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(state: &str, waiting: bool, reason: Option<&str>) -> Task {
        let reason = reason.map_or("null".to_string(), |r| format!("\"{r}\""));
        serde_json::from_str(&format!(
            r#"{{"id":"abcdef123456","title":"Login page","description":"","criteria":[],
            "repoPath":"/r/luna-tui","branch":null,"worktreePath":null,"state":"{state}","column":"Build",
            "waitingOnYou":{waiting},"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":{reason},
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"2026-10-22T23:24:22.089Z"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn a_transition_into_needs_you_escalated_or_paused_is_news_and_staying_there_is_not() {
        let gate = task("awaiting_approval", true, None);
        let notice = notice_for(Some(Look::Working), &gate).expect("into needs-you");
        assert_eq!(notice.title, "Needs you");
        assert_eq!(notice.body, "luna-tui · #abcdef12 Login page: approve plan");
        assert_eq!(notice_for(Some(Look::NeedsYou), &gate), None, "already there");
        assert_eq!(notice_for(None, &gate).map(|n| n.title), Some("Needs you".into()), "first sight counts");

        let escalated = task("escalated", false, Some("deliver failed"));
        assert_eq!(notice_for(Some(Look::Working), &escalated).map(|n| n.body), Some("luna-tui · #abcdef12 Login page: deliver failed".into()));
        let paused = task("paused_rate_limit", false, None);
        assert_eq!(notice_for(Some(Look::Working), &paused).map(|n| n.title), Some("Paused on a usage limit".into()));
        assert_eq!(notice_for(Some(Look::NeedsYou), &task("implementing", false, None)), None, "leaving a gate is not news");
    }

    #[test]
    fn a_gate_or_stage_going_past_its_sla_is_news_once_and_a_jira_move_always_is() {
        let late: Task = serde_json::from_str(&crate::model::tests::jira_task_json()).unwrap();
        let notices = sla_notices(None, &late);
        assert_eq!(notices.len(), 1, "first sight overdue counts; the warning stage is not over yet: {notices:?}");
        assert_eq!(notices[0].title, "Gate overdue");
        assert_eq!(notices[0].body, "#abcdef12 Login page: intake waited past 1h");
        assert!(sla_notices(late.sla.as_ref(), &late).is_empty(), "already overdue last time: not twice");
        let mut fine = late.clone();
        fine.sla.as_mut().unwrap().gate.as_mut().unwrap().overdue = false;
        assert!(sla_notices(late.sla.as_ref(), &fine).is_empty(), "coming back inside is not news");
        let mut stage = fine.clone();
        stage.sla.as_mut().unwrap().stage.as_mut().unwrap().overdue = true;
        let notices = sla_notices(fine.sla.as_ref(), &stage);
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Stage over SLA"]);
        assert_eq!(notices[0].body, "#abcdef12 Login page: implementing is past its target");
        let mut none = fine.clone();
        none.sla = None;
        assert!(sla_notices(fine.sla.as_ref(), &none).is_empty(), "a machine without clocks says nothing");

        let moved: TaskEvent = serde_json::from_str(r#"{"taskId":"abcdef123456","kind":"jira.moved","payload":{"status":"Done"},"at":"2026-10-28T10:30:00Z"}"#).unwrap();
        let notice = jira_moved_notice(&late, &moved).expect("a move is news");
        assert_eq!(notice.title, "Jira");
        assert_eq!(notice.body, "PLAT-123 moved to Done while #abcdef12 waits");
        let other: TaskEvent = serde_json::from_str(r#"{"taskId":"abcdef123456","kind":"jira.transitioned","payload":{"from":"a","to":"b"},"at":"t"}"#).unwrap();
        assert_eq!(jira_moved_notice(&late, &other), None, "the machine's own transitions are not news");
    }

    #[test]
    fn the_badge_counts_and_the_kill_switch_reads_like_an_env_flag() {
        assert_eq!(badge_label(0, 0), "Board");
        assert_eq!(badge_label(2, 0), "Board !2");
        assert_eq!(badge_label(2, 1), "Board !2 ‼1");
        assert_eq!(badge_label(0, 1), "Board ‼1");
        assert!(quiet(Some("1")));
        assert!(!quiet(Some("0")));
        assert!(!quiet(Some("")));
        assert!(!quiet(None));
        assert_eq!(offline_notice("connection refused").title, "Machine offline");
    }
}

#[cfg(test)]
mod pr_tests {
    use super::*;
    use crate::pulls::PrSplit;

    fn pr(split: &str) -> PullRequest {
        serde_json::from_str(&format!(
            r#"{{"repo":"acme/app","number":12,"title":"Export CSV","url":"u","author":"them","mine":false,"reviewRequested":true,
            "isDraft":false,"headRef":"h","baseRef":"main","fromFork":false,"reviewDecision":null,"mergeable":"MERGEABLE",
            "checks":{{"state":"none","passed":0,"total":0,"failed":[]}},"unresolvedThreads":0,"split":"{split}",
            "localPath":null,"task":null,"updatedAt":"2026-10-27T09:00:00Z"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn a_pr_moving_into_a_split_that_needs_you_is_news_and_staying_there_is_not() {
        let asked = pr("review_requested");
        let notice = pr_notice(None, &asked).expect("first sight counts");
        assert_eq!(notice.title, "Review requested");
        assert_eq!(notice.body, "acme/app#12 Export CSV");
        assert_eq!(pr_notice(Some(PrSplit::ReviewRequested), &asked), None, "already there");
        assert_eq!(pr_notice(Some(PrSplit::Mine), &pr("ready_to_merge")).map(|n| n.title), Some("Ready to merge".into()));
        assert_eq!(pr_notice(Some(PrSplit::CiRunning), &pr("ci_failed")).map(|n| n.title), Some("CI failed".into()));
        assert_eq!(pr_notice(Some(PrSplit::Mine), &pr("changes_requested")).map(|n| n.title), Some("Changes requested".into()));
        assert_eq!(pr_notice(Some(PrSplit::ReviewRequested), &pr("ci_running")), None, "leaving a needs-you split is not news");
        assert_eq!(pr_notice(None, &pr("mine")), None);
    }
}

#[cfg(test)]
mod slack_tests {
    use super::*;
    use crate::slack::fixtures::{item, overdue_item};

    #[test]
    fn a_p0_or_p1_entering_needs_reply_or_decide_is_news_and_a_reopen_always_is() {
        let p0 = item("a", "needs_reply", Some("P0"), "2026-10-28T09:00:00Z");
        let notice = slack_notice(None, None, false, &p0).expect("first sight counts");
        assert_eq!(notice.title, "Needs reply");
        assert_eq!(notice.body, "#payments-oncall @marta: approve rollback");
        assert_eq!(slack_notice(Some(SlackSplit::NeedsReply), None, false, &p0), None, "already there");
        assert_eq!(slack_notice(Some(SlackSplit::Fyi), None, false, &item("b", "decide", Some("P1"), "t")).map(|n| n.title), Some("Decide".into()));
        assert_eq!(slack_notice(None, None, false, &item("c", "needs_reply", Some("P2"), "t")), None, "a P2 is not news");
        assert_eq!(slack_notice(None, None, false, &item("d", "needs_reply", None, "t")), None, "untriaged is not news");
        assert_eq!(slack_notice(None, None, false, &item("e", "fyi", Some("P0"), "t")), None, "FYI never is");
        assert_eq!(slack_notice(Some(SlackSplit::NeedsReply), None, false, &item("f", "done", Some("P0"), "t")), None, "leaving is not news");

        let mut back = item("g", "fyi", Some("P3"), "t");
        back.reopened_at = Some("2026-10-28T10:00:00Z".into());
        assert_eq!(slack_notice(Some(SlackSplit::Done), None, false, &back).map(|n| n.title), Some("Reopened".into()), "whatever the priority");
        assert_eq!(slack_notice(Some(SlackSplit::Fyi), Some("2026-10-28T10:00:00Z"), false, &back), None, "an old reopen is not news twice");
        assert_eq!(slack_notice(Some(SlackSplit::Fyi), Some("2026-10-27T10:00:00Z"), false, &back).map(|n| n.title), Some("Reopened".into()), "a fresh one is");
    }

    #[test]
    fn quiet_hours_hold_back_everything_but_a_p0() {
        let p0 = item("a", "needs_reply", Some("P0"), "t");
        let p1 = item("b", "needs_reply", Some("P1"), "t");
        let untriaged = item("c", "needs_reply", None, "t");
        assert!(!muted_by_quiet_hours(true, &p0), "a P0 gets through");
        assert!(muted_by_quiet_hours(true, &p1));
        assert!(muted_by_quiet_hours(true, &untriaged), "a reopen of an untriaged item waits too");
        assert!(!muted_by_quiet_hours(false, &p1), "outside the window nothing is held");
    }

    #[test]
    fn going_past_the_reply_sla_is_news_once_whatever_the_priority() {
        let late = overdue_item("a", "needs_reply", Some("P2"), "2026-10-28T08:00:00Z", "2026-10-28T09:00:00Z");
        let notice = slack_notice(Some(SlackSplit::NeedsReply), None, false, &late).expect("the flip is news");
        assert_eq!(notice.title, "Overdue");
        assert_eq!(notice.body, "#payments-oncall @marta: approve rollback");
        assert_eq!(slack_notice(Some(SlackSplit::NeedsReply), None, true, &late), None, "already overdue last time: not twice");
        assert_eq!(slack_notice(None, None, false, &late).map(|n| n.title), Some("Overdue".into()), "first sight overdue counts, and outranks Needs reply");
        let mut back = late.clone();
        back.reopened_at = Some("2026-10-28T10:00:00Z".into());
        assert_eq!(slack_notice(Some(SlackSplit::NeedsReply), None, false, &back).map(|n| n.title), Some("Reopened".into()), "a reopen outranks it");
        let mut fine = late;
        fine.overdue = false;
        assert_eq!(slack_notice(Some(SlackSplit::NeedsReply), None, true, &fine), None, "coming back inside the SLA is not news");
    }
}

#[cfg(test)]
mod datadog_tests {
    use super::*;
    use crate::datadog::fixtures::item;

    #[test]
    fn a_p0_is_news_once_per_item_and_again_only_when_it_comes_back() {
        let mut told = DatadogNoticed::default();
        let p0 = item("inc:412", "incident", "act_now", Some("P0"), "2026-10-28T09:55:00Z");
        let notices = told.notices(std::slice::from_ref(&p0));
        assert_eq!(notices.len(), 1, "first sight counts");
        assert_eq!(notices[0].title, "Datadog P0");
        assert_eq!(notices[0].body, "incident · checkout-api: checkout 5xx since the 14:02 deploy");
        assert!(told.notices(std::slice::from_ref(&p0)).is_empty(), "the same P0 seen twice is news once");
        let mut lowered = p0.clone();
        lowered.triage.as_mut().unwrap().priority = "P1".into();
        assert!(told.notices(&[lowered]).is_empty());
        assert!(told.notices(std::slice::from_ref(&p0)).is_empty(), "back to P0 is not news twice");

        let mut back = p0.clone();
        back.reopened_at = Some("2026-10-28T10:00:00Z".into());
        let notices = told.notices(std::slice::from_ref(&back));
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Datadog P0 reopened"], "coming back after done is");
        assert!(told.notices(&[back]).is_empty(), "once");

        let quiet = [
            item("a", "incident", "investigate", Some("P1"), "t"),
            item("b", "incident", "investigate", None, "t"),
            item("c", "incident", "done", Some("P0"), "t"),
            item("d", "incident", "snoozed", Some("P0"), "t"),
        ];
        assert!(told.notices(&quiet).is_empty(), "a P1, an untriaged item and a P0 put away are not news");
    }

    #[test]
    fn an_untriaged_item_at_a_p0_floor_is_news_with_agents_off() {
        let mut told = DatadogNoticed::default();
        let mut sev1 = item("inc:900", "incident", "act_now", None, "2026-10-28T09:55:00Z");
        sev1.floor = Some("P0".into());
        let notices = told.notices(std::slice::from_ref(&sev1));
        assert_eq!(notices.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), vec!["Datadog P0"], "the rule's P0 counts without triage");
        assert!(told.notices(&[sev1]).is_empty(), "once");
    }
}
