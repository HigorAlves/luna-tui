//! Calls into the herdr CLI. Everything here is a no-op or `None` outside herdr.

use std::{env, ffi::OsString, path::Path, process::Command};

use serde_json::Value;

use crate::model::short_id;

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

/// The label stage containers are tagged with, carrying the task id.
const TASK_LABEL: &str = "dev.hardness.task";

/// The id of the tab whose label starts with `prefix`, from a `tab list` reply.
fn tab_with_prefix(reply: &Value, prefix: &str) -> Option<String> {
    reply["result"]["tabs"]
        .as_array()?
        .iter()
        .find(|t| t["label"].as_str().is_some_and(|l| l.starts_with(prefix)))
        .and_then(|t| t["tab_id"].as_str())
        .map(String::from)
}

/// A pane in `tab`, from a `pane list` reply.
fn pane_in_tab(reply: &Value, tab: &str) -> Option<String> {
    reply["result"]["panes"]
        .as_array()?
        .iter()
        .find(|p| p["tab_id"].as_str() == Some(tab))
        .and_then(|p| p["pane_id"].as_str())
        .map(String::from)
}

/// The task's watch tab, labelled `#<short id> <title>`. Found by label, so it is the same
/// tab across board restarts and when several boards are open.
fn task_tab(short_id: &str) -> Option<String> {
    tab_with_prefix(&json(&["tab", "list"])?, &format!("#{short_id} "))
}

/// Switches to this task's watch tab. False if there is none.
pub fn focus_task_tab(short_id: &str) -> bool {
    match task_tab(short_id) {
        Some(tab) => {
            run(&["tab", "focus", &tab]);
            true
        }
        None => false,
    }
}

/// Shows `container`'s output in the task's watch tab, opening the tab at `cwd` if needed.
pub fn follow(short_id: &str, label: &str, cwd: &str, container: &str) {
    let existing = task_tab(short_id).and_then(|tab| pane_in_tab(&json(&["pane", "list"])?, &tab));
    let pane = existing.or_else(|| {
        let created = json(&["tab", "create", "--cwd", cwd, "--label", label])?;
        created["result"]["root_pane"]["pane_id"].as_str().map(String::from)
    });
    if let Some(pane) = pane {
        run(&["pane", "run", &pane, &format!("docker logs -f {container}")]);
    }
}

/// Closes the task's watch tab, if it has one.
pub fn close_task_tab(short_id: &str) {
    if let Some(tab) = task_tab(short_id) {
        run(&["tab", "close", &tab]);
    }
}

/// `(container, task id)` for each line of `docker ps --format '{{.Names}}\t{{.Label ...}}'`.
fn running_stages(listed: &str) -> Vec<(String, String)> {
    listed
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .filter(|(name, task)| !name.is_empty() && !task.is_empty())
        .map(|(name, task)| (name.to_string(), task.to_string()))
        .collect()
}

/// Opens watch tabs for stages that were already running when the board connected.
/// `tasks` is `(task id, tab label, worktree)` for every task the board knows.
pub fn catch_up(tasks: &[(String, String, String)]) {
    if bin().is_none() {
        return;
    }
    let format = format!("{{{{.Names}}}}\t{{{{.Label \"{TASK_LABEL}\"}}}}");
    let filter = format!("label={TASK_LABEL}");
    let Ok(output) = Command::new("docker").args(["ps", "--filter", &filter, "--format", &format]).output() else {
        return;
    };
    for (container, task_id) in running_stages(&String::from_utf8_lossy(&output.stdout)) {
        let Some((id, label, cwd)) = tasks.iter().find(|(id, ..)| *id == task_id) else {
            continue;
        };
        let short = short_id(id);
        if task_tab(short).is_none() {
            follow(short, label, cwd, &container);
        }
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

/// True when the board runs where the herdr CLI can be called.
pub fn available() -> bool {
    bin().is_some()
}

/// A desktop notification with herdr's "request" sound.
pub fn notify(title: &str, body: &str) {
    run(&["notification", "show", title, "--body", body, "--sound", "request"]);
}

/// Relabels the board's own tab (`Board`, `Board !2`), when running as a herdr plugin.
pub fn badge(label: &str) {
    if let Ok(tab) = env::var("HERDR_TAB_ID") {
        run(&["tab", "rename", &tab, label]);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::{pane_in_tab, repo_root, running_stages, tab_with_prefix};

    #[test]
    fn finds_a_task_tab_by_its_label_prefix_and_the_pane_inside_it() {
        let tabs = json!({"result": {"tabs": [
            {"tab_id": "w:1", "label": "Board"},
            {"tab_id": "w:2", "label": "#abcd1234 Fix it"},
        ]}});
        assert_eq!(tab_with_prefix(&tabs, "#abcd1234 ").as_deref(), Some("w:2"));
        assert_eq!(tab_with_prefix(&tabs, "#ffff0000 "), None);

        let panes = json!({"result": {"panes": [
            {"pane_id": "p:1", "tab_id": "w:1"},
            {"pane_id": "p:2", "tab_id": "w:2"},
        ]}});
        assert_eq!(pane_in_tab(&panes, "w:2").as_deref(), Some("p:2"));
        assert_eq!(pane_in_tab(&panes, "w:9"), None);
    }

    #[test]
    fn reads_running_stage_containers_from_docker_ps() {
        let listed = "hardness-abc-triage\tabc\n\nstray-container\t\n";
        assert_eq!(running_stages(listed), vec![("hardness-abc-triage".to_string(), "abc".to_string())]);
    }

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
