//! The board's old local tickets. They are imported into the machine once, after which the
//! file is renamed so the import never runs twice.

use std::{env, fs, path::PathBuf};

use serde::Deserialize;

use crate::model::TicketText;

#[derive(Deserialize)]
struct LegacyStore {
    tickets: Vec<LegacyTicket>,
}

#[derive(Deserialize)]
struct LegacyTicket {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    acceptance: Vec<String>,
}

/// `board.json` in the plugin state dir when herdr launched us, else in the current directory.
pub fn legacy_path() -> PathBuf {
    env::var_os("HERDR_PLUGIN_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("board.json")
}

/// The old tickets, if the file is still there.
pub fn read_legacy() -> Option<Vec<TicketText>> {
    let json = fs::read_to_string(legacy_path()).ok()?;
    let store: LegacyStore = serde_json::from_str(&json).ok()?;
    Some(
        store
            .tickets
            .into_iter()
            .map(|t| TicketText {
                title: t.title,
                description: t.description,
                criteria: t.acceptance,
                repo_path: None,
            })
            .collect(),
    )
}

/// Renames the old file to `board.json.imported`.
pub fn mark_imported() -> std::io::Result<()> {
    let path = legacy_path();
    fs::rename(&path, path.with_extension("json.imported"))
}

/// `board-state.json` next to the legacy file: what the board remembers between runs.
#[derive(Deserialize, serde::Serialize, Default)]
struct BoardState {
    /// When the board was last open, unix seconds: the Digest's "since", the cards' new dot.
    #[serde(default)]
    last_seen_secs: Option<u64>,
}

pub fn state_path() -> PathBuf {
    legacy_path().with_file_name("board-state.json")
}

fn read_state(path: &PathBuf) -> BoardState {
    fs::read_to_string(path).ok().and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

/// When the board was last open, if it ever was.
pub fn last_seen_secs_at(path: &PathBuf) -> Option<u64> {
    read_state(path).last_seen_secs
}

/// Remembers now as the last time the board was open.
pub fn write_last_seen_at(path: &PathBuf, secs: u64) -> std::io::Result<()> {
    let mut state = read_state(path);
    state.last_seen_secs = Some(secs);
    fs::write(path, serde_json::to_string_pretty(&state).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_seen_round_trips_through_the_state_file_and_is_none_before_the_first_run() {
        let dir = std::env::temp_dir().join(format!("board-state-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("board-state.json");
        assert_eq!(last_seen_secs_at(&path), None);
        write_last_seen_at(&path, 1_792_711_462).unwrap();
        assert_eq!(last_seen_secs_at(&path), Some(1_792_711_462));
        let _ = fs::remove_dir_all(&dir);
    }
}
