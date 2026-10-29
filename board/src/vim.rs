//! Minimal vim-style modal editing over a `TextArea`: normal-mode navigation and a handful of
//! commands, insert mode for typing. Gives the inline ticket editor the same muscle memory
//! `$EDITOR` (the user's real vim) gave before editing moved in-place.
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use tui_textarea::{CursorMove, TextArea};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Normal,
    Insert,
}

/// What the caller should do after a key is handled.
pub enum Outcome {
    Continue,
    Save,
    /// Esc in normal mode: close the editor without saving, like the old `$EDITOR` flow.
    Cancel,
}

/// Every key `normal` matches, plus the named ones both modes take, for the registry's parity
/// test: the Editor scope may only name keys from this list.
#[cfg(test)]
pub const HANDLED: &[&str] = &[
    "q", "h", "l", "k", "j", "0", "$", "w", "b", "e", "G", "x", "D", "u", "p", "i", "a", "A", "I", "o", "O", "gg", "dd", "^r", "ctrl+s", "esc",
];

/// Normal/insert mode state for one `TextArea`. Starts in normal mode, like opening a file
/// in vim.
pub struct Vim {
    mode: Mode,
    /// The first key of a two-key command (`dd`, `gg`), waiting for its second key.
    pending: Option<char>,
}

impl Vim {
    pub fn new() -> Self {
        Self { mode: Mode::Normal, pending: None }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn handle(&mut self, area: &mut TextArea, key: KeyEvent) -> Outcome {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('s') {
            return Outcome::Save;
        }
        match self.mode {
            Mode::Insert => self.insert(area, key),
            Mode::Normal => self.normal(area, key),
        }
    }

    fn insert(&mut self, area: &mut TextArea, key: KeyEvent) -> Outcome {
        if key.code == KeyCode::Esc {
            self.mode = Mode::Normal;
        } else {
            area.input(key);
        }
        Outcome::Continue
    }

    fn normal(&mut self, area: &mut TextArea, key: KeyEvent) -> Outcome {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('r') {
            area.redo();
            return Outcome::Continue;
        }
        let KeyCode::Char(c) = key.code else {
            if key.code == KeyCode::Esc {
                return Outcome::Cancel;
            }
            return Outcome::Continue;
        };

        if let Some(pending) = self.pending.take() {
            match (pending, c) {
                ('g', 'g') => area.move_cursor(CursorMove::Top),
                ('d', 'd') => {
                    area.move_cursor(CursorMove::Head);
                    area.delete_line_by_end();
                    area.delete_next_char();
                }
                _ => {}
            }
            return Outcome::Continue;
        }

        match c {
            // Matches every other popup in the board, where `q` closes it like `esc`.
            'q' => return Outcome::Cancel,
            'h' => area.move_cursor(CursorMove::Back),
            'l' => area.move_cursor(CursorMove::Forward),
            'k' => area.move_cursor(CursorMove::Up),
            'j' => area.move_cursor(CursorMove::Down),
            '0' => area.move_cursor(CursorMove::Head),
            '$' => area.move_cursor(CursorMove::End),
            'w' => area.move_cursor(CursorMove::WordForward),
            'b' => area.move_cursor(CursorMove::WordBack),
            'e' => area.move_cursor(CursorMove::WordEnd),
            'G' => area.move_cursor(CursorMove::Bottom),
            'x' => {
                area.delete_next_char();
            }
            'D' => {
                area.delete_line_by_end();
            }
            'u' => {
                area.undo();
            }
            'p' => {
                area.paste();
            }
            'i' => self.mode = Mode::Insert,
            'a' => {
                area.move_cursor(CursorMove::Forward);
                self.mode = Mode::Insert;
            }
            'A' => {
                area.move_cursor(CursorMove::End);
                self.mode = Mode::Insert;
            }
            'I' => {
                area.move_cursor(CursorMove::Head);
                self.mode = Mode::Insert;
            }
            'o' => {
                area.move_cursor(CursorMove::End);
                area.insert_newline();
                self.mode = Mode::Insert;
            }
            'O' => {
                area.move_cursor(CursorMove::Head);
                area.insert_newline();
                area.move_cursor(CursorMove::Up);
                self.mode = Mode::Insert;
            }
            'g' | 'd' => self.pending = Some(c),
            _ => {}
        }
        Outcome::Continue
    }
}
