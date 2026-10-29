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

/// The command to run in the watch tab's pane, if the task has one. A task with no tab gets
/// nothing: a stage starting never opens a tab, only `f` does.
fn follow_command(existing_pane: Option<&str>, container: &str) -> Option<(String, String)> {
    existing_pane.map(|pane| (pane.to_string(), format!("docker logs -f {container}")))
}

/// The latest stage container a task is running: what `f` opens a watch tab for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stage {
    pub label: String,
    pub cwd: String,
    pub container: String,
}

/// What `f` does on a ticket.
#[derive(Debug, PartialEq, Eq)]
pub enum WatchAction {
    FocusExisting,
    OpenAndFocus(Stage),
    NothingToWatch,
}

/// Picks what `f` does from whether the task has a watch tab and what stage it last ran.
pub fn watch_action(has_tab: bool, stage: Option<&Stage>) -> WatchAction {
    match (has_tab, stage) {
        (true, _) => WatchAction::FocusExisting,
        (false, Some(stage)) => WatchAction::OpenAndFocus(stage.clone()),
        (false, None) => WatchAction::NothingToWatch,
    }
}

/// True when the task already has a watch tab.
pub fn has_task_tab(short_id: &str) -> bool {
    task_tab(short_id).is_some()
}

/// Points the task's existing watch tab at `container`. Opens nothing if there is no tab.
pub fn follow(short_id: &str, container: &str) {
    let existing = task_tab(short_id).and_then(|tab| pane_in_tab(&json(&["pane", "list"])?, &tab));
    if let Some((pane, command)) = follow_command(existing.as_deref(), container) {
        run(&["pane", "run", &pane, &command]);
    }
}

/// Opens the task's watch tab at `stage.cwd` tailing its container, then switches to it.
/// A tab that already exists is only focused. No-op outside herdr.
pub fn open_and_focus(short_id: &str, stage: &Stage) {
    if bin().is_none() {
        return;
    }
    if focus_task_tab(short_id) {
        return;
    }
    let Some(created) = json(&["tab", "create", "--cwd", &stage.cwd, "--label", &stage.label]) else {
        return;
    };
    if let Some(pane) = created["result"]["root_pane"]["pane_id"].as_str() {
        run(&["pane", "run", pane, &format!("docker logs -f {}", stage.container)]);
    }
    if let Some(tab) = created["result"]["tab"]["tab_id"].as_str().or_else(|| created["result"]["tab_id"].as_str()) {
        run(&["tab", "focus", tab]);
    } else {
        focus_task_tab(short_id);
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

/// `(container, task id)` for the stages running when the board connected. Opens no tabs.
pub fn running_containers() -> Vec<(String, String)> {
    let format = format!("{{{{.Names}}}}\t{{{{.Label \"{TASK_LABEL}\"}}}}");
    let filter = format!("label={TASK_LABEL}");
    let Ok(output) = Command::new("docker").args(["ps", "--filter", &filter, "--format", &format]).output() else {
        return Vec::new();
    };
    running_stages(&String::from_utf8_lossy(&output.stdout))
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

    use super::{follow_command, open_and_focus, pane_in_tab, repo_root, running_stages, tab_with_prefix, watch_action, Stage, WatchAction};

    fn stage() -> Stage {
        Stage { label: "#abcd1234 app · Fix".into(), cwd: "/w".into(), container: "c1".into() }
    }

    #[test]
    fn a_stage_starting_only_repoints_an_existing_pane() {
        assert_eq!(follow_command(None, "c2"), None, "no tab, no command: nothing is created");
        assert_eq!(follow_command(Some("p:2"), "c2"), Some(("p:2".to_string(), "docker logs -f c2".to_string())));
    }

    #[test]
    fn f_focuses_an_existing_tab_opens_for_a_running_stage_or_says_nothing_to_watch() {
        assert_eq!(watch_action(true, Some(&stage())), WatchAction::FocusExisting);
        assert_eq!(watch_action(true, None), WatchAction::FocusExisting);
        assert_eq!(watch_action(false, Some(&stage())), WatchAction::OpenAndFocus(stage()));
        assert_eq!(watch_action(false, None), WatchAction::NothingToWatch);
    }

    #[test]
    fn opening_outside_herdr_is_a_no_op() {
        // The tests never run inside herdr; nothing sets HERDR_BIN_PATH.
        if super::bin().is_some() {
            return;
        }
        open_and_focus("abcd1234", &stage());
    }

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
    fn a_tab_opened_with_f_is_found_again_so_a_second_f_only_focuses_it() {
        let WatchAction::OpenAndFocus(opened) = watch_action(false, Some(&stage())) else {
            panic!("a running stage with no tab opens one");
        };
        let tabs = json!({"result": {"tabs": [
            {"tab_id": "w:1", "label": "Board"},
            {"tab_id": "w:3", "label": opened.label},
        ]}});
        let found = tab_with_prefix(&tabs, "#abcd1234 ");
        assert_eq!(found.as_deref(), Some("w:3"), "the opened tab carries the task's #short prefix");
        assert_eq!(watch_action(found.is_some(), Some(&stage())), WatchAction::FocusExisting);
        let panes = json!({"result": {"panes": [{"pane_id": "p:3", "tab_id": "w:3"}]}});
        let pane = pane_in_tab(&panes, "w:3");
        assert_eq!(
            follow_command(pane.as_deref(), "c2"),
            Some(("p:3".to_string(), "docker logs -f c2".to_string())),
            "a later stage re-points that same tab's pane"
        );
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
