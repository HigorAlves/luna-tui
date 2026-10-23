//! Finds repos on disk, so a ticket's repo can be picked instead of typed. Looks under one
//! root (`HARDNESS_REPOS_DIR`, or `~/Developer`), which may itself hold repos directly or
//! group them under project folders (`~/Developer/some-project/backend`, `.../frontend`).

use std::{env, fs, path::Path, path::PathBuf};

const MAX_DEPTH: usize = 4;
const MAX_RESULTS: usize = 500;
// "worktrees" is skipped because it's the machine's own default WORKTREES_DIR: it would
// otherwise fill the list with every task's checkout, not real repos to point a new one at.
const SKIP: [&str; 4] = ["node_modules", "target", "vendor", "worktrees"];

/// `HARDNESS_REPOS_DIR`, or `$HOME/Developer`.
pub fn repos_root() -> Option<PathBuf> {
    if let Ok(dir) = env::var("HARDNESS_REPOS_DIR") {
        return Some(PathBuf::from(dir));
    }
    env::var_os("HOME").map(|home| PathBuf::from(home).join("Developer"))
}

/// Every repo under `root`, as absolute paths, sorted. Stops at the first `.git` on any
/// branch, so a repo's own history or submodules are never descended into.
pub fn discover_repos(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    walk(root, 0, &mut found);
    found.sort();
    found
}

fn walk(dir: &Path, depth: usize, found: &mut Vec<String>) {
    if found.len() >= MAX_RESULTS {
        return;
    }
    if dir.join(".git").exists() {
        found.push(dir.to_string_lossy().into_owned());
        return;
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || SKIP.contains(&name.as_ref()) {
            continue;
        }
        walk(&entry.path(), depth + 1, found);
        if found.len() >= MAX_RESULTS {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::discover_repos;

    #[test]
    fn finds_a_repo_directly_under_root_and_one_grouped_under_a_project() {
        let root = std::env::temp_dir().join(format!("hardness-discover-test-{}", std::process::id()));
        fs::create_dir_all(root.join("solo-repo/.git")).unwrap();
        fs::create_dir_all(root.join("a-project/backend/.git")).unwrap();
        fs::create_dir_all(root.join("a-project/frontend/.git")).unwrap();
        fs::create_dir_all(root.join("a-project/backend/node_modules/left-pad/.git")).unwrap();

        let mut found = discover_repos(&root);
        found.sort();
        assert_eq!(
            found,
            vec![
                root.join("a-project/backend").to_string_lossy().into_owned(),
                root.join("a-project/frontend").to_string_lossy().into_owned(),
                root.join("solo-repo").to_string_lossy().into_owned(),
            ]
        );

        fs::remove_dir_all(&root).unwrap();
    }
}
