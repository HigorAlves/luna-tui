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
