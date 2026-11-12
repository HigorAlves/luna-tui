//! The board's colours and what they mean. Ten palette constants, then roles over them: a screen asks for
//! `needs_you()` or `dim()`, not for PEACH or SURFACE1, so a state reads the same wherever it is drawn.

use std::env;

use ratatui::style::{Color, Modifier, Style};

// Catppuccin Mocha, the theme herdr is configured with.
pub(crate) const BASE: Color = Color::Rgb(0x1e, 0x1e, 0x2e);
pub(crate) const SURFACE0: Color = Color::Rgb(0x31, 0x32, 0x44);
pub(crate) const SURFACE1: Color = Color::Rgb(0x45, 0x47, 0x5a);
pub(crate) const SUBTEXT0: Color = Color::Rgb(0xa6, 0xad, 0xc8);
pub(crate) const BLUE: Color = Color::Rgb(0x89, 0xb4, 0xfa);
pub(crate) const LAVENDER: Color = Color::Rgb(0xb4, 0xbe, 0xfe);
pub(crate) const GREEN: Color = Color::Rgb(0xa6, 0xe3, 0xa1);
pub(crate) const YELLOW: Color = Color::Rgb(0xf9, 0xe2, 0xaf);
pub(crate) const PEACH: Color = Color::Rgb(0xfa, 0xb3, 0x87);
pub(crate) const RED: Color = Color::Rgb(0xf3, 0x8b, 0xa8);

pub(crate) const ACCENT: Color = BLUE;
pub(crate) const MUTED: Color = SURFACE1;
pub(crate) const SELECTED_BG: Color = SURFACE0;

/// Colours are dropped when `NO_COLOR` is set. States still read from their glyph and label.
pub(crate) fn c(color: Color) -> Color {
    if env::var_os("NO_COLOR").is_some() {
        Color::Reset
    } else {
        color
    }
}

fn fg(color: Color) -> Style {
    Style::new().fg(c(color))
}

/// Something waits on the person: a gate, a question, a stale run.
pub(crate) fn needs_you() -> Style {
    fg(PEACH)
}

/// Something is running.
pub(crate) fn working() -> Style {
    fg(YELLOW)
}

/// Something stopped or failed.
pub(crate) fn lost() -> Style {
    fg(RED)
}

/// Something is held until a limit lifts: a rate limit, a window.
pub(crate) fn paused() -> Style {
    fg(LAVENDER)
}

/// Something finished well.
pub(crate) fn done() -> Style {
    fg(GREEN)
}

/// A section title: bold, in the terminal's own colour, so the accent stays for what needs the person.
pub(crate) fn heading() -> Style {
    Style::new().add_modifier(Modifier::BOLD)
}

/// A name for a value: ids, ages, the left column of a facts table, hints.
pub(crate) fn label() -> Style {
    fg(SUBTEXT0)
}

/// Body text in the terminal's own colour.
pub(crate) fn text() -> Style {
    Style::new()
}

/// Disabled keys, separators, anything that should recede.
pub(crate) fn dim() -> Style {
    fg(MUTED)
}

/// Inline code and code blocks.
pub(crate) fn code() -> Style {
    fg(LAVENDER)
}

/// The selected row: a background, or reverse video without colour.
pub(crate) fn selection() -> Style {
    if env::var_os("NO_COLOR").is_some() {
        Style::new().add_modifier(Modifier::REVERSED)
    } else {
        Style::new().bg(SELECTED_BG)
    }
}

/// The focused border and the selection bar.
pub(crate) fn border_focus() -> Style {
    fg(ACCENT)
}

/// A check or signal the gate flags.
pub(crate) fn flag() -> Style {
    fg(PEACH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_map_to_the_colours_the_screens_use_for_that_meaning() {
        // The colours are what this asserts; with NO_COLOR there are none.
        if std::env::var_os("NO_COLOR").is_some() {
            return;
        }
        assert_eq!(needs_you().fg, Some(PEACH));
        assert_eq!(working().fg, Some(YELLOW));
        assert_eq!(lost().fg, Some(RED));
        assert_eq!(paused().fg, Some(LAVENDER));
        assert_eq!(done().fg, Some(GREEN));
        assert_eq!(label().fg, Some(SUBTEXT0));
        assert_eq!(dim().fg, Some(SURFACE1));
        assert_eq!(border_focus().fg, Some(BLUE));
        assert_eq!(flag().fg, Some(PEACH));
        assert_eq!(selection().bg, Some(SURFACE0));
    }

    #[test]
    fn a_heading_is_bold_and_has_no_colour_of_its_own() {
        // The colours are what this asserts; with NO_COLOR there are none.
        if std::env::var_os("NO_COLOR").is_some() {
            return;
        }
        assert_eq!(heading().fg, None);
        assert!(heading().add_modifier.contains(Modifier::BOLD));
        assert_eq!(text(), Style::new());
        assert_ne!(code().fg, label().fg);
    }
}
