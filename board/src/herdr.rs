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

/// The workspace the board was opened from, when it is a git repo: the default repo for
/// new tickets.
pub fn workspace_repo() -> Option<String> {
    let context: Value = serde_json::from_str(&env::var("HERDR_PLUGIN_CONTEXT_JSON").ok()?).ok()?;
    let cwd = context["workspace_cwd"].as_str()?;
    Path::new(cwd).join(".git").exists().then(|| cwd.to_string())
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
