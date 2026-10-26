//! What changed since the board was last open. The Digest view that groups it comes next;
//! this is the question every card can already answer: is this ticket new to me?
use crate::model::{Task, unix_secs};

/// True when the ticket changed after `since` (unix seconds); with no `since`, nothing is new.
pub fn is_new(task: &Task, since: Option<u64>) -> bool {
    match (since, unix_secs(&task.updated_at)) {
        (Some(seen), Some(updated)) => updated > seen,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_means_updated_after_last_seen_and_nothing_is_new_before_the_first_run() {
        let task: Task = serde_json::from_str(
            r#"{"id":"abcdef123456","title":"t","description":"","criteria":[],
            "repoPath":null,"branch":null,"worktreePath":null,"state":"closed","column":"Done",
            "waitingOnYou":false,"running":false,"queued":false,
            "retries":{"verify":0,"e2e":0,"ci":0,"total":0},"resumeTo":null,"reason":null,
            "createdAt":"2026-10-22T20:00:00.000Z","updatedAt":"2026-10-22T23:00:00.000Z"}"#,
        )
        .unwrap();
        assert!(is_new(&task, unix_secs("2026-10-22T21:00:00Z")));
        assert!(!is_new(&task, unix_secs("2026-10-23T21:00:00Z")));
        assert!(!is_new(&task, None));
    }
}
