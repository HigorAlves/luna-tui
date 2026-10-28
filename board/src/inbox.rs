//! The Inbox: what needs you, flat, split by why, oldest first. The kanban is by stage; this
//! is by what you have to do. `a`/`r`/`e` act in place, `A` approves a whole split.
use crate::model::{Look, Task};

/// Why a ticket is in the Inbox. Order is the tab order on screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Split {
    /// A gate waiting for a yes: plan, tests, ship.
    #[default]
    Approve,
    /// Something to read and answer: questions, the memory review.
    Review,
    /// Escalated: a stage gave up and says why.
    Failed,
    /// Stale or paused: nothing is moving and nobody said why, or the usage window is shut.
    Stale,
    All,
}

impl Split {
    pub const ALL: [Split; 5] = [Split::Approve, Split::Review, Split::Failed, Split::Stale, Split::All];

    pub fn label(self) -> &'static str {
        match self {
            Split::Approve => "Approve",
            Split::Review => "Review",
            Split::Failed => "Failed",
            Split::Stale => "Stale",
            Split::All => "All",
        }
    }

    pub fn next(self) -> Split {
        let i = Split::ALL.iter().position(|s| *s == self).unwrap_or(0);
        Split::ALL[(i + 1) % Split::ALL.len()]
    }

    pub fn prev(self) -> Split {
        let i = Split::ALL.iter().position(|s| *s == self).unwrap_or(0);
        Split::ALL[(i + Split::ALL.len() - 1) % Split::ALL.len()]
    }

    /// Which split a ticket belongs to, if it needs you at all.
    pub fn of(task: &Task, now: u64) -> Option<Split> {
        match task.state.as_str() {
            "awaiting_setup" | "awaiting_approval" | "awaiting_test_check" | "awaiting_ship" => Some(Split::Approve),
            "awaiting_answers" | "reviewing_memory" => Some(Split::Review),
            "escalated" => Some(Split::Failed),
            "paused_rate_limit" => Some(Split::Stale),
            _ if matches!(task.look_at(now), Look::Stale) => Some(Split::Stale),
            _ => None,
        }
    }
}

/// Indices into `tasks` for `split`, oldest first: the one waiting longest is on top.
pub fn items(tasks: &[Task], split: Split, now: u64) -> Vec<usize> {
    let mut found: Vec<usize> = tasks
        .iter()
        .enumerate()
        .filter(|(_, t)| Split::of(t, now).is_some_and(|s| split == Split::All || s == split))
        .map(|(i, _)| i)
        .collect();
    found.sort_by(|&a, &b| tasks[a].updated_at.cmp(&tasks[b].updated_at));
    found
}

/// The open Inbox: which split, and where the cursor is in it.
#[derive(Clone, Debug, Default)]
pub struct InboxState {
    pub split: Split,
    pub cursor: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, state: &str, waiting: bool, running: bool, updated: &str) -> Task {
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","title":"t {id}","description":"","criteria":[],
            "repoPath":null,"branch":null,"worktreePath":null,"state":"{state}","column":"Build",
            "waitingOnYou":{waiting},"running":{running},"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T23:24:22.089Z","updatedAt":"{updated}"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn each_ticket_lands_in_the_split_that_says_what_you_do_about_it() {
        let now = 1_792_711_462 + 3600;
        let t = |state, waiting, running| task("a", state, waiting, running, "2026-10-22T23:24:22.089Z");
        assert_eq!(Split::of(&t("awaiting_approval", true, false), now), Some(Split::Approve));
        assert_eq!(Split::of(&t("awaiting_ship", true, false), now), Some(Split::Approve));
        assert_eq!(Split::of(&t("awaiting_answers", true, false), now), Some(Split::Review));
        assert_eq!(Split::of(&t("escalated", false, false), now), Some(Split::Failed));
        assert_eq!(Split::of(&t("paused_rate_limit", false, false), now), Some(Split::Stale));
        assert_eq!(Split::of(&t("implementing", false, true), now), Some(Split::Stale), "an hour of silence");
        assert_eq!(Split::of(&t("implementing", false, true), 1_792_711_462 + 60), None, "still working");
        assert_eq!(Split::of(&t("draft", false, false), now), None);
    }

    #[test]
    fn items_are_the_split_s_tickets_oldest_first_and_all_is_everything() {
        let now = 1_792_711_462 + 60;
        let tasks = vec![
            task("new", "awaiting_approval", true, false, "2026-10-22T23:24:22.089Z"),
            task("old", "awaiting_approval", true, false, "2026-10-22T20:00:00.000Z"),
            task("esc", "escalated", false, false, "2026-10-22T21:00:00.000Z"),
            task("run", "implementing", false, true, "2026-10-22T23:24:22.089Z"),
        ];
        let names = |ix: Vec<usize>| ix.iter().map(|&i| tasks[i].id.as_str()).collect::<Vec<_>>();
        assert_eq!(names(items(&tasks, Split::Approve, now)), vec!["old", "new"]);
        assert_eq!(names(items(&tasks, Split::Failed, now)), vec!["esc"]);
        assert_eq!(names(items(&tasks, Split::Review, now)), Vec::<&str>::new(), "caught up");
        assert_eq!(names(items(&tasks, Split::All, now)), vec!["old", "esc", "new"]);
        assert_eq!(Split::Approve.next(), Split::Review);
        assert_eq!(Split::All.next(), Split::Approve);
        assert_eq!(Split::Approve.prev(), Split::All);
    }
}
