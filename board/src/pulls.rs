//! The PR inbox: every open pull request involving you, as the machine polls it, split by
//! what you do about it. The kanban is tickets by stage; this is GitHub by what needs a key.
use crate::model::{PrAction, PullRequest, unix_secs};

/// One split per PR; the machine picks it, the board only shows it. Order is the tab order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PrSplit {
    #[default]
    ReviewRequested,
    ReadyToMerge,
    CiFailed,
    CiRunning,
    ChangesRequested,
    Mine,
}

impl PrSplit {
    pub const ALL: [PrSplit; 6] = [
        PrSplit::ReviewRequested,
        PrSplit::ReadyToMerge,
        PrSplit::CiFailed,
        PrSplit::CiRunning,
        PrSplit::ChangesRequested,
        PrSplit::Mine,
    ];

    /// The machine's name for the split, as `PullRequest::split` carries it.
    pub fn wire(self) -> &'static str {
        match self {
            PrSplit::ReviewRequested => "review_requested",
            PrSplit::ReadyToMerge => "ready_to_merge",
            PrSplit::CiFailed => "ci_failed",
            PrSplit::CiRunning => "ci_running",
            PrSplit::ChangesRequested => "changes_requested",
            PrSplit::Mine => "mine",
        }
    }

    pub fn from_wire(wire: &str) -> Option<PrSplit> {
        PrSplit::ALL.iter().copied().find(|s| s.wire() == wire)
    }

    pub fn label(self) -> &'static str {
        match self {
            PrSplit::ReviewRequested => "Review requested",
            PrSplit::ReadyToMerge => "Ready to merge",
            PrSplit::CiFailed => "CI failed",
            PrSplit::CiRunning => "CI running",
            PrSplit::ChangesRequested => "Changes requested",
            PrSplit::Mine => "Mine",
        }
    }

    /// The splits that count on the badge and raise a notice.
    pub fn needs_me(self) -> bool {
        !matches!(self, PrSplit::CiRunning | PrSplit::Mine)
    }

    pub fn next(self) -> PrSplit {
        let i = PrSplit::ALL.iter().position(|s| *s == self).unwrap_or(0);
        PrSplit::ALL[(i + 1) % PrSplit::ALL.len()]
    }

    pub fn prev(self) -> PrSplit {
        let i = PrSplit::ALL.iter().position(|s| *s == self).unwrap_or(0);
        PrSplit::ALL[(i + PrSplit::ALL.len() - 1) % PrSplit::ALL.len()]
    }
}

/// Indices into `prs` for `split`, oldest first: the one waiting longest is on top.
pub fn items(prs: &[PullRequest], split: PrSplit) -> Vec<usize> {
    let mut found: Vec<usize> = prs.iter().enumerate().filter(|(_, p)| p.split_enum() == Some(split)).map(|(i, _)| i).collect();
    found.sort_by_key(|&i| unix_secs(&prs[i].updated_at).unwrap_or(u64::MAX));
    found
}

/// How many PRs sit in each split, in `PrSplit::ALL` order.
pub fn counts(prs: &[PullRequest]) -> [usize; 6] {
    let mut out = [0; 6];
    for pr in prs {
        if let Some(i) = pr.split_enum().and_then(|s| PrSplit::ALL.iter().position(|x| *x == s)) {
            out[i] += 1;
        }
    }
    out
}

/// What `m`, `c`, `v` and `t` can do to a PR right now, in the order the actions menu lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrKey {
    Merge,
    CiFix,
    Review,
    Address,
}

impl PrKey {
    pub const ALL: [PrKey; 4] = [PrKey::Merge, PrKey::CiFix, PrKey::Review, PrKey::Address];

    pub fn key(self) -> char {
        match self {
            PrKey::Merge => 'm',
            PrKey::CiFix => 'c',
            PrKey::Review => 'v',
            PrKey::Address => 't',
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PrKey::Merge => "merge (squash, delete the branch)",
            PrKey::CiFix => "CI fix: an agent diagnoses the red run and pushes a fix",
            PrKey::Review => "review: an agent posts line comments; a verdict waits for you",
            PrKey::Address => "threads: an agent answers every unresolved review thread",
        }
    }

    /// The machine's action for a dispatching key; `Merge` is a merge, not a task.
    pub fn action(self) -> Option<PrAction> {
        match self {
            PrKey::Merge => None,
            PrKey::CiFix => Some(PrAction::CiFix),
            PrKey::Review => Some(PrAction::Review),
            PrKey::Address => Some(PrAction::Address),
        }
    }
}

/// Why a key is off for this PR, or None when it works. Mirrors the machine's refusals, so a
/// greyed key never has to round-trip to learn it would be a 409.
pub fn blocker(pr: &PullRequest, key: PrKey) -> Option<&'static str> {
    match key {
        PrKey::Merge => (pr.split_enum() != Some(PrSplit::ReadyToMerge)).then_some("not ready to merge"),
        PrKey::CiFix | PrKey::Review | PrKey::Address => {
            if pr.task.is_some() {
                return Some("a task is already running for it");
            }
            if pr.local_path.is_none() {
                return Some("no checkout");
            }
            match key {
                PrKey::Review if pr.mine => Some("review is for other people's PRs"),
                PrKey::CiFix | PrKey::Address if pr.from_fork => Some("the head is in a fork; nothing can push to it"),
                PrKey::Address if !pr.mine => Some("threads are answered on your own PRs"),
                _ => None,
            }
        }
    }
}

/// The keys that work on this PR.
pub fn actions_for(pr: &PullRequest) -> Vec<PrKey> {
    PrKey::ALL.iter().copied().filter(|k| blocker(pr, *k).is_none()).collect()
}

/// The open PR view: which split, and where the cursor is in it.
#[derive(Clone, Debug, Default)]
pub struct PullsState {
    pub split: PrSplit,
    pub cursor: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn pr(number: u64, split: &str, updated: &str) -> PullRequest {
        serde_json::from_str(&format!(
            r#"{{"repo":"o/a","number":{number},"title":"PR {number}","url":"https://github.com/o/a/pull/{number}",
            "author":"me","mine":true,"reviewRequested":false,"isDraft":false,"headRef":"feat/x","baseRef":"main",
            "fromFork":false,"reviewDecision":null,"mergeable":"MERGEABLE",
            "checks":{{"state":"success","passed":1,"total":1,"failed":[]}},"unresolvedThreads":0,
            "split":"{split}","localPath":"/r/a","task":null,"updatedAt":"{updated}"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn items_are_the_split_s_prs_oldest_first_and_counts_follow() {
        let prs = vec![
            pr(1, "ready_to_merge", "2026-10-27T10:00:00Z"),
            pr(2, "ready_to_merge", "2026-10-27T08:00:00Z"),
            pr(3, "ci_failed", "2026-10-27T09:00:00Z"),
            pr(4, "mine", "2026-10-27T09:00:00Z"),
        ];
        let numbers = |ix: Vec<usize>| ix.iter().map(|&i| prs[i].number).collect::<Vec<_>>();
        assert_eq!(numbers(items(&prs, PrSplit::ReadyToMerge)), vec![2, 1]);
        assert_eq!(numbers(items(&prs, PrSplit::CiFailed)), vec![3]);
        assert_eq!(numbers(items(&prs, PrSplit::ReviewRequested)), Vec::<u64>::new());
        assert_eq!(counts(&prs), [0, 2, 1, 0, 0, 1]);
        assert_eq!(PrSplit::ReviewRequested.next(), PrSplit::ReadyToMerge);
        assert_eq!(PrSplit::Mine.next(), PrSplit::ReviewRequested);
        assert_eq!(PrSplit::ReviewRequested.prev(), PrSplit::Mine);
        assert_eq!(PrSplit::from_wire("changes_requested"), Some(PrSplit::ChangesRequested));
        assert!(PrSplit::CiFailed.needs_me() && !PrSplit::CiRunning.needs_me() && !PrSplit::Mine.needs_me());
    }

    #[test]
    fn the_keys_that_work_follow_the_machine_s_own_refusals() {
        let keys = |p: &PullRequest| actions_for(p).iter().map(|k| k.key()).collect::<String>();
        assert_eq!(keys(&pr(1, "ready_to_merge", "t")), "mct", "mine, ready: merge, CI fix, threads; no self-review");
        let theirs = PullRequest { mine: false, author: "them".into(), ..pr(2, "review_requested", "t") };
        assert_eq!(keys(&theirs), "cv", "a teammate's PR: CI fix and review, no threads");
        assert_eq!(keys(&PullRequest { local_path: None, ..theirs.clone() }), "", "no checkout, nothing to dispatch");
        assert_eq!(blocker(&PullRequest { local_path: None, ..theirs.clone() }, PrKey::Review), Some("no checkout"));
        assert_eq!(keys(&PullRequest { from_fork: true, ..theirs.clone() }), "v", "a fork: review only");
        let busy = PullRequest { task: Some(crate::model::PrTask { id: "t1".into(), state: "ci_watch".into(), route: "ci_fix".into() }), ..pr(3, "ci_failed", "t") };
        assert_eq!(keys(&busy), "", "a running task blocks every dispatch");
        assert_eq!(blocker(&pr(4, "mine", "t"), PrKey::Merge), Some("not ready to merge"));
        assert_eq!(PrKey::CiFix.action(), Some(PrAction::CiFix));
        assert_eq!(PrKey::Merge.action(), None);
    }
}
