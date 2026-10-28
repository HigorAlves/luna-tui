//! What the board tells you when you are elsewhere: a herdr notification on the transitions
//! that need you, a live count on the Board tab, a terminal BEL when herdr is not there.
//! `HARDNESS_BOARD_QUIET=1` silences all of it.
use crate::model::{Look, PullRequest, SlackItem, Task};
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
/// (`reopened_at` newly set), else `Needs reply` / `Decide` for a P0 or P1 entering one of
/// those splits from anywhere else (or from nowhere). Lower priorities, staying put, and the
/// other splits are not news; quiet hours are the machine's business.
pub fn slack_notice(old_split: Option<SlackSplit>, old_reopened_at: Option<&str>, item: &SlackItem) -> Option<Notice> {
    let body = format!("{} @{}: {}", item.channel_label(), item.author.name, item.summary());
    if item.reopened_at.is_some() && item.reopened_at.as_deref() != old_reopened_at {
        return Some(Notice { title: "Reopened".to_string(), body });
    }
    let new = item.split_enum()?;
    if !new.needs_me() || old_split == Some(new) || !item.urgent() {
        return None;
    }
    Some(Notice { title: new.label().to_string(), body })
}

/// The notice for losing the machine.
pub fn offline_notice(reason: &str) -> Notice {
    Notice { title: "Machine offline".to_string(), body: reason.to_string() }
}

/// The Board tab's label: `Board`, or `Board !2` while two tickets need you.
pub fn badge_label(needs_you: usize) -> String {
    if needs_you == 0 { "Board".to_string() } else { format!("Board !{needs_you}") }
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
    fn the_badge_counts_and_the_kill_switch_reads_like_an_env_flag() {
        assert_eq!(badge_label(0), "Board");
        assert_eq!(badge_label(2), "Board !2");
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
    use crate::slack::fixtures::item;

    #[test]
    fn a_p0_or_p1_entering_needs_reply_or_decide_is_news_and_a_reopen_always_is() {
        let p0 = item("a", "needs_reply", Some("P0"), "2026-10-28T09:00:00Z");
        let notice = slack_notice(None, None, &p0).expect("first sight counts");
        assert_eq!(notice.title, "Needs reply");
        assert_eq!(notice.body, "#payments-oncall @marta: approve rollback");
        assert_eq!(slack_notice(Some(SlackSplit::NeedsReply), None, &p0), None, "already there");
        assert_eq!(slack_notice(Some(SlackSplit::Fyi), None, &item("b", "decide", Some("P1"), "t")).map(|n| n.title), Some("Decide".into()));
        assert_eq!(slack_notice(None, None, &item("c", "needs_reply", Some("P2"), "t")), None, "a P2 is not news");
        assert_eq!(slack_notice(None, None, &item("d", "needs_reply", None, "t")), None, "untriaged is not news");
        assert_eq!(slack_notice(None, None, &item("e", "fyi", Some("P0"), "t")), None, "FYI never is");
        assert_eq!(slack_notice(Some(SlackSplit::NeedsReply), None, &item("f", "done", Some("P0"), "t")), None, "leaving is not news");

        let mut back = item("g", "fyi", Some("P3"), "t");
        back.reopened_at = Some("2026-10-28T10:00:00Z".into());
        assert_eq!(slack_notice(Some(SlackSplit::Done), None, &back).map(|n| n.title), Some("Reopened".into()), "whatever the priority");
        assert_eq!(slack_notice(Some(SlackSplit::Fyi), Some("2026-10-28T10:00:00Z"), &back), None, "an old reopen is not news twice");
        assert_eq!(slack_notice(Some(SlackSplit::Fyi), Some("2026-10-27T10:00:00Z"), &back).map(|n| n.title), Some("Reopened".into()), "a fresh one is");
    }
}
