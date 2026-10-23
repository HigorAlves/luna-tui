//! Calls into the herdr CLI. Everything here is a no-op or `None` outside herdr.

use std::{env, ffi::OsString, path::Path, process::Command};

use serde_json::Value;

fn bin() -> Option<OsString> {
    env::var_os("HERDR_BIN_PATH")
}

fn json(args: &[&str]) -> Option<Value> {
    let output = Command::new(bin()?).args(args).output().ok()?;
    serde_json::from_slice(&output.stdout).ok()
}

fn run(args: &[&str]) {
    if let Some(bin) = bin() {
        let _ = Command::new(bin).args(args).output();
    }
}

/// Switches to the tab the machine opened to watch this task's agent. False if there is none.
pub fn focus_task_tab(short_id: &str) -> bool {
    let Some(reply) = json(&["tab", "list"]) else {
        return false;
    };
    let prefix = format!("#{short_id} ");
    let tab = reply["result"]["tabs"].as_array().and_then(|tabs| {
        tabs.iter()
            .find(|t| t["label"].as_str().is_some_and(|l| l.starts_with(&prefix)))
            .and_then(|t| t["tab_id"].as_str())
    });
    match tab {
        Some(tab) => {
            run(&["tab", "focus", tab]);
            true
        }
        None => false,
    }
}

/// The repo a new ticket defaults to: herdr's workspace when the board runs as its plugin,
/// otherwise the board's own working directory. Either way, walks up to the repo root so it
/// still finds `.git` from a subdirectory.
pub fn workspace_repo() -> Option<String> {
    let from_herdr = (|| {
        let context: Value = serde_json::from_str(&env::var("HERDR_PLUGIN_CONTEXT_JSON").ok()?).ok()?;
        Some(context["workspace_cwd"].as_str()?.to_string())
    })();
    let start = from_herdr.or_else(|| env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()))?;
    repo_root(Path::new(&start)).map(|p| p.to_string_lossy().into_owned())
}

/// `dir` or the nearest ancestor that has a `.git` entry.
fn repo_root(dir: &Path) -> Option<&Path> {
    if dir.join(".git").exists() {
        Some(dir)
    } else {
        repo_root(dir.parent()?)
    }
}

/// When running inside herdr, names the current tab and pane "Board".
pub fn name_tab_and_pane() {
    if bin().is_none() {
        return;
    }
    if let Ok(tab) = env::var("HERDR_TAB_ID") {
        run(&["tab", "rename", &tab, "Board"]);
    }
    if let Ok(pane) = env::var("HERDR_PANE_ID") {
        run(&["pane", "rename", &pane, "Board"]);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::repo_root;

    #[test]
    fn repo_root_walks_up_to_the_nearest_git_dir() {
        let root = std::env::temp_dir().join(format!("hardness-repo-root-test-{}", std::process::id()));
        let nested = root.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();

        assert_eq!(repo_root(&nested), Some(root.as_path()));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn repo_root_is_none_outside_any_repo() {
        // /tmp itself is never a git repo, and neither is anything above it.
        assert_eq!(repo_root(std::env::temp_dir().as_path()), None);
    }
}
