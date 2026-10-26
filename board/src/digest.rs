//! The Digest: what happened since you last had the board open, grouped by what changed.
//! After a night of autonomous runs you should not have to open every card to find out.
use crate::model::{Task, unix_secs};

/// What changed, in the order the Digest shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Group {
    /// Delivered: a PR is open and waits at the Ship gate, is shipping, or is in memory review.
    Shipped,
    Escalated,
    NeedsYou,
    Closed,
}

impl Group {
    pub fn label(self) -> &'static str {
        match self {
            Group::Shipped => "Shipped",
            Group::Escalated => "Escalated",
            Group::NeedsYou => "Needs you",
            Group::Closed => "Closed",
        }
    }

    /// Where a ticket's latest change belongs, if it is worth a line.
    pub fn of(task: &Task) -> Option<Group> {
        match task.state.as_str() {
            "closed" => Some(Group::Closed),
            "escalated" => Some(Group::Escalated),
            "awaiting_ship" | "shipping" | "reviewing_memory" => Some(Group::Shipped),
            _ if task.waiting_on_you => Some(Group::NeedsYou),
            _ => None,
        }
    }
}

/// True when the ticket changed after `since` (unix seconds); with no `since`, nothing is new.
pub fn is_new(task: &Task, since: Option<u64>) -> bool {
    match (since, unix_secs(&task.updated_at)) {
        (Some(seen), Some(updated)) => updated > seen,
        _ => false,
    }
}

/// `(group, index into tasks)` for every ticket that changed since `since` and has a group:
/// by group, newest first within one. With no `since` (a first run), everything with a group.
pub fn entries(tasks: &[Task], since: Option<u64>) -> Vec<(Group, usize)> {
    let mut found: Vec<(Group, usize)> = tasks
        .iter()
        .enumerate()
        .filter(|(_, t)| since.is_none() || is_new(t, since))
        .filter_map(|(i, t)| Group::of(t).map(|g| (g, i)))
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| tasks[b.1].updated_at.cmp(&tasks[a.1].updated_at)));
    found
}

/// The open Digest: where the cursor is in the flat list of entries.
#[derive(Clone, Debug, Default)]
pub struct DigestState {
    pub cursor: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, state: &str, waiting: bool, updated: &str) -> Task {
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","title":"t {id}","description":"","criteria":[],
            "repoPath":null,"branch":null,"worktreePath":null,"state":"{state}","column":"Build",
            "waitingOnYou":{waiting},"running":false,"queued":false,
            "retries":{{"verify":0,"e2e":0,"ci":0,"total":0}},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T20:00:00.000Z","updatedAt":"{updated}"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn a_ticket_s_latest_change_lands_in_one_of_four_groups_or_none() {
        assert_eq!(Group::of(&task("a", "closed", false, "2026-10-22T23:00:00Z")), Some(Group::Closed));
        assert_eq!(Group::of(&task("a", "escalated", false, "2026-10-22T23:00:00Z")), Some(Group::Escalated));
        assert_eq!(Group::of(&task("a", "awaiting_ship", true, "2026-10-22T23:00:00Z")), Some(Group::Shipped), "the ship gate means delivered");
        assert_eq!(Group::of(&task("a", "awaiting_approval", true, "2026-10-22T23:00:00Z")), Some(Group::NeedsYou));
        assert_eq!(Group::of(&task("a", "implementing", false, "2026-10-22T23:00:00Z")), None, "still working is not news");
    }

    #[test]
    fn entries_are_what_changed_since_last_seen_by_group_then_newest_first() {
        let tasks = vec![
            task("old-closed", "closed", false, "2026-10-22T20:30:00Z"),
            task("new-closed", "closed", false, "2026-10-22T23:00:00Z"),
            task("newer-gate", "awaiting_approval", true, "2026-10-22T23:30:00Z"),
            task("new-gate", "awaiting_approval", true, "2026-10-22T22:30:00Z"),
            task("shipped", "awaiting_ship", true, "2026-10-22T22:00:00Z"),
            task("working", "implementing", false, "2026-10-22T23:59:00Z"),
        ];
        let seen = unix_secs("2026-10-22T21:00:00Z");
        let names = |e: Vec<(Group, usize)>| e.iter().map(|(g, i)| (g.label(), tasks[*i].id.as_str())).collect::<Vec<_>>();
        assert_eq!(
            names(entries(&tasks, seen)),
            vec![("Shipped", "shipped"), ("Needs you", "newer-gate"), ("Needs you", "new-gate"), ("Closed", "new-closed")]
        );
        assert_eq!(entries(&tasks, None).len(), 5, "a first run shows everything with a group");
        assert!(is_new(&tasks[1], seen));
        assert!(!is_new(&tasks[0], seen));
        assert!(!is_new(&tasks[1], None));
    }
}
