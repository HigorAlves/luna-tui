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
    /// The board's own tab over the every-repo snapshot; the machine never sends it.
    AllRepos,
}

impl PrSplit {
    pub const ALL: [PrSplit; 7] = [
        PrSplit::ReviewRequested,
        PrSplit::ReadyToMerge,
        PrSplit::CiFailed,
        PrSplit::CiRunning,
        PrSplit::ChangesRequested,
        PrSplit::Mine,
        PrSplit::AllRepos,
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
            PrSplit::AllRepos => "all",
        }
    }

    /// The split a PR carries. `all` names the board's tab, so no PR is in it by its own say.
    pub fn from_wire(wire: &str) -> Option<PrSplit> {
        PrSplit::ALL
            .iter()
            .copied()
            .find(|s| *s != PrSplit::AllRepos && s.wire() == wire)
    }

    pub fn label(self) -> &'static str {
        match self {
            PrSplit::ReviewRequested => "Review requested",
            PrSplit::ReadyToMerge => "Ready to merge",
            PrSplit::CiFailed => "CI failed",
            PrSplit::CiRunning => "CI running",
            PrSplit::ChangesRequested => "Changes requested",
            PrSplit::Mine => "Mine",
            PrSplit::AllRepos => "All repos",
        }
    }

    /// The splits that count on the badge and raise a notice.
    pub fn needs_me(self) -> bool {
        !matches!(self, PrSplit::CiRunning | PrSplit::Mine | PrSplit::AllRepos)
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

/// Whether `pr` passes the repo filter; no filter lets everything through.
fn in_repo(pr: &PullRequest, repo: Option<&str>) -> bool {
    repo.is_none_or(|r| pr.repo == r)
}

/// The list a tab reads: the inbox for the six splits, the every-repo snapshot for All repos.
pub fn source<'a>(
    inbox: &'a [PullRequest],
    all: &'a [PullRequest],
    split: PrSplit,
) -> &'a [PullRequest] {
    if split == PrSplit::AllRepos {
        all
    } else {
        inbox
    }
}

/// Indices into `prs` (the tab's `source`) for `split` under the repo filter. A split lists
/// oldest first: the one waiting longest is on top. All repos lists newest first, since it is
/// for browsing what just opened.
pub fn items(prs: &[PullRequest], split: PrSplit, repo: Option<&str>) -> Vec<usize> {
    let mut found: Vec<usize> = prs
        .iter()
        .enumerate()
        .filter(|(_, p)| in_repo(p, repo))
        .filter(|(_, p)| split == PrSplit::AllRepos || p.split_enum() == Some(split))
        .map(|(i, _)| i)
        .collect();
    let at = |i: usize| unix_secs(&prs[i].updated_at);
    if split == PrSplit::AllRepos {
        found.sort_by_key(|&i| std::cmp::Reverse(at(i).unwrap_or(0)));
    } else {
        found.sort_by_key(|&i| at(i).unwrap_or(u64::MAX));
    }
    found
}

/// How many PRs sit in each tab under the repo filter, in `PrSplit::ALL` order: the inbox by
/// split, then everything in the every-repo snapshot.
pub fn counts(inbox: &[PullRequest], all: &[PullRequest], repo: Option<&str>) -> [usize; 7] {
    let mut out = [0; 7];
    for pr in inbox.iter().filter(|p| in_repo(p, repo)) {
        if let Some(i) = pr
            .split_enum()
            .and_then(|s| PrSplit::ALL.iter().position(|x| *x == s))
        {
            out[i] += 1;
        }
    }
    out[PrSplit::ALL.len() - 1] = all.iter().filter(|p| in_repo(p, repo)).count();
    out
}

/// Every repo in either list, sorted, once each: what the `f` picker offers.
pub fn repos(inbox: &[PullRequest], all: &[PullRequest]) -> Vec<String> {
    let mut found: Vec<String> = inbox.iter().chain(all).map(|p| p.repo.clone()).collect();
    found.sort();
    found.dedup();
    found
}

/// What `m`, `c`, `v` and `t` can do to a PR right now, in the order the actions menu lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrKey {
    Merge,
    CiFix,
    Review,
    Address,
    Close,
}

impl PrKey {
    pub const ALL: [PrKey; 5] = [
        PrKey::Merge,
        PrKey::CiFix,
        PrKey::Review,
        PrKey::Address,
        PrKey::Close,
    ];

    pub fn key(self) -> char {
        match self {
            PrKey::Merge => 'm',
            PrKey::CiFix => 'c',
            PrKey::Review => 'v',
            PrKey::Address => 't',
            PrKey::Close => 'X',
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PrKey::Merge => "merge (the repo's method, delete the branch)",
            PrKey::CiFix => "CI fix: an agent diagnoses the red run and pushes a fix",
            PrKey::Review => "review: an agent posts line comments; a verdict waits for you",
            PrKey::Address => "threads: an agent answers every unresolved review thread",
            PrKey::Close => "close the PR without merging (asks first; the branch stays)",
        }
    }

    /// The machine's action for a dispatching key; `Merge` is a merge, not a task.
    pub fn action(self) -> Option<PrAction> {
        match self {
            PrKey::Merge | PrKey::Close => None,
            PrKey::CiFix => Some(PrAction::CiFix),
            PrKey::Review => Some(PrAction::Review),
            PrKey::Address => Some(PrAction::Address),
        }
    }
}

/// Why Merge is off, in GitHub's terms when it said so: its merge state is the authority.
fn merge_blocker(pr: &PullRequest) -> &'static str {
    match pr.merge_state.as_str() {
        "BLOCKED" => "GitHub: blocked, a required review or check is still missing",
        "BEHIND" => "GitHub: the branch is behind its base; update it first",
        "DIRTY" => "GitHub: the branch has conflicts with its base",
        "DRAFT" => "GitHub: still a draft",
        _ if pr.checks.state == "failure" => "a check is red",
        _ if pr.checks.state == "pending" => "checks are still running",
        _ => "not ready to merge",
    }
}

/// Why a key is off for this PR, or None when it works. Mirrors the machine's refusals, so a
/// greyed key never has to round-trip to learn it would be a 409.
pub fn blocker(pr: &PullRequest, key: PrKey) -> Option<&'static str> {
    match key {
        PrKey::Merge => (pr.split_enum() != Some(PrSplit::ReadyToMerge)).then(|| merge_blocker(pr)),
        PrKey::Close if !pr.mine => Some("closing is for your own PRs"),
        PrKey::Close => pr
            .task
            .is_some()
            .then_some("a task is already running for it"),
        PrKey::CiFix | PrKey::Review | PrKey::Address => {
            if pr.task.is_some() {
                return Some("a task is already running for it");
            }
            if pr.local_path.is_none() {
                return Some("no checkout");
            }
            match key {
                PrKey::Review if pr.mine => Some("review is for other people's PRs"),
                PrKey::CiFix | PrKey::Address if pr.from_fork => {
                    Some("the head is in a fork; nothing can push to it")
                }
                PrKey::Address if !pr.mine => Some("threads are answered on your own PRs"),
                _ => None,
            }
        }
    }
}

/// The open PR view: which split, where the cursor is in it, and the repo it is narrowed to.
#[derive(Clone, Debug, Default)]
pub struct PullsState {
    pub split: PrSplit,
    pub cursor: usize,
    /// `owner/name` set by `f`; every tab and its count follow it.
    pub repo: Option<String>,
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
        assert_eq!(
            numbers(items(&prs, PrSplit::ReadyToMerge, None)),
            vec![2, 1]
        );
        assert_eq!(numbers(items(&prs, PrSplit::CiFailed, None)), vec![3]);
        assert_eq!(
            numbers(items(&prs, PrSplit::ReviewRequested, None)),
            Vec::<u64>::new()
        );
        assert_eq!(counts(&prs, &[], None), [0, 2, 1, 0, 0, 1, 0]);
        assert_eq!(PrSplit::ReviewRequested.next(), PrSplit::ReadyToMerge);
        assert_eq!(PrSplit::Mine.next(), PrSplit::AllRepos);
        assert_eq!(PrSplit::AllRepos.next(), PrSplit::ReviewRequested);
        assert_eq!(PrSplit::ReviewRequested.prev(), PrSplit::AllRepos);
        assert_eq!(
            PrSplit::from_wire("changes_requested"),
            Some(PrSplit::ChangesRequested)
        );
        assert!(
            PrSplit::CiFailed.needs_me()
                && !PrSplit::CiRunning.needs_me()
                && !PrSplit::Mine.needs_me()
                && !PrSplit::AllRepos.needs_me()
        );
    }

    fn pr_in(repo: &str, number: u64, split: &str, updated: &str) -> PullRequest {
        PullRequest {
            repo: repo.into(),
            ..pr(number, split, updated)
        }
    }

    #[test]
    fn all_repos_is_a_board_only_tab_over_the_second_snapshot_newest_first() {
        let inbox = vec![pr_in("o/a", 1, "mine", "2026-10-27T08:00:00Z")];
        let all = vec![
            pr_in("o/a", 1, "mine", "2026-10-27T08:00:00Z"),
            pr_in("o/b", 2, "mine", "2026-10-27T10:00:00Z"),
            pr_in("o/c", 3, "review_requested", "2026-10-27T09:00:00Z"),
        ];
        // The machine never sends split "all", so no PR is in the tab by its own say.
        assert_eq!(PrSplit::from_wire("all"), None);
        assert_eq!(PrSplit::AllRepos.wire(), "all");
        assert_eq!(PrSplit::AllRepos.label(), "All repos");
        assert_eq!(PrSplit::ALL.len(), 7);
        let shown = source(&inbox, &all, PrSplit::AllRepos);
        let numbers = |ix: Vec<usize>| ix.iter().map(|&i| shown[i].number).collect::<Vec<_>>();
        assert_eq!(
            numbers(items(shown, PrSplit::AllRepos, None)),
            vec![2, 3, 1],
            "the newest first, whatever the split"
        );
        assert_eq!(
            source(&inbox, &all, PrSplit::Mine).len(),
            1,
            "the six splits read the inbox"
        );
        assert_eq!(counts(&inbox, &all, None), [0, 0, 0, 0, 0, 1, 3]);
    }

    #[test]
    fn the_repo_filter_narrows_every_tab_and_its_count() {
        let inbox = vec![
            pr_in("o/a", 1, "mine", "2026-10-27T08:00:00Z"),
            pr_in("o/b", 2, "mine", "2026-10-27T09:00:00Z"),
        ];
        let all = vec![
            pr_in("o/b", 2, "mine", "2026-10-27T09:00:00Z"),
            pr_in("o/c", 3, "mine", "2026-10-27T10:00:00Z"),
        ];
        assert_eq!(items(&inbox, PrSplit::Mine, Some("o/b")), vec![1]);
        assert_eq!(items(&all, PrSplit::AllRepos, Some("o/c")), vec![1]);
        assert_eq!(
            counts(&inbox, &all, Some("o/b")),
            [0, 0, 0, 0, 0, 1, 1],
            "the counts follow the filter"
        );
        assert_eq!(
            counts(&inbox, &all, Some("o/none")),
            [0; 7],
            "a repo with nothing open"
        );
        assert_eq!(
            repos(&inbox, &all),
            vec!["o/a", "o/b", "o/c"],
            "the repos in both lists, once each, sorted"
        );
    }

    #[test]
    fn the_keys_that_work_follow_the_machine_s_own_refusals() {
        let keys = |p: &PullRequest| {
            PrKey::ALL
                .iter()
                .filter(|k| blocker(p, **k).is_none())
                .map(|k| k.key())
                .collect::<String>()
        };
        assert_eq!(
            keys(&pr(1, "ready_to_merge", "t")),
            "mctX",
            "mine, ready: merge, CI fix, threads, close; no self-review"
        );
        let theirs = PullRequest {
            mine: false,
            author: "them".into(),
            ..pr(2, "review_requested", "t")
        };
        assert_eq!(
            keys(&theirs),
            "cv",
            "a teammate's PR: CI fix and review, no threads"
        );
        assert_eq!(
            keys(&PullRequest {
                local_path: None,
                ..theirs.clone()
            }),
            "",
            "no checkout, nothing to dispatch"
        );
        assert_eq!(
            blocker(
                &PullRequest {
                    local_path: None,
                    ..theirs.clone()
                },
                PrKey::Review
            ),
            Some("no checkout")
        );
        assert_eq!(
            keys(&PullRequest {
                from_fork: true,
                ..theirs.clone()
            }),
            "v",
            "a fork: review only"
        );
        let busy = PullRequest {
            task: Some(crate::model::PrTask {
                id: "t1".into(),
                state: "ci_watch".into(),
                route: "ci_fix".into(),
            }),
            ..pr(3, "ci_failed", "t")
        };
        assert_eq!(keys(&busy), "", "a running task blocks every dispatch");
        assert_eq!(
            blocker(&pr(4, "mine", "t"), PrKey::Merge),
            Some("not ready to merge")
        );
        assert_eq!(PrKey::CiFix.action(), Some(PrAction::CiFix));
        assert_eq!(PrKey::Merge.action(), None);
        assert_eq!(PrKey::Close.action(), None);
    }

    #[test]
    fn merge_says_what_github_says_and_close_is_for_your_own_idle_prs() {
        let with = |state: &str| PullRequest {
            merge_state: state.into(),
            ..pr(5, "mine", "t")
        };
        assert_eq!(
            blocker(&with("BLOCKED"), PrKey::Merge),
            Some("GitHub: blocked, a required review or check is still missing")
        );
        assert_eq!(
            blocker(&with("BEHIND"), PrKey::Merge),
            Some("GitHub: the branch is behind its base; update it first")
        );
        assert_eq!(
            blocker(&with("DIRTY"), PrKey::Merge),
            Some("GitHub: the branch has conflicts with its base")
        );
        let theirs = PullRequest {
            mine: false,
            author: "them".into(),
            ..pr(6, "review_requested", "t")
        };
        assert_eq!(
            blocker(&theirs, PrKey::Close),
            Some("closing is for your own PRs")
        );
        let busy = PullRequest {
            task: Some(crate::model::PrTask {
                id: "t1".into(),
                state: "ci_watch".into(),
                route: "ci_fix".into(),
            }),
            ..pr(7, "ci_failed", "t")
        };
        assert_eq!(
            blocker(&busy, PrKey::Close),
            Some("a task is already running for it")
        );
        assert_eq!(blocker(&pr(8, "mine", "t"), PrKey::Close), None);
    }
}
