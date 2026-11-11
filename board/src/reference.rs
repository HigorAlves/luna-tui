//! Reference groups of the task view: what a person looks up but does not decide on (risk and its scores,
//! the triage record, the checks, the code map, the assumptions, the card's facts). A section hands them
//! over beside its main text; a wide terminal draws them in a side pane, a narrow one folds them under
//! the main text. A group longer than `FOLD_ABOVE` lines starts folded.

use std::{cell::RefCell, collections::HashSet};

use ratatui::text::{Line, Span};

use crate::{detail::Section, text::cells, theme};

/// A group with more lines than this starts folded to its header.
pub const FOLD_ABOVE: usize = 4;
/// The popup's inner width from which the side pane is drawn.
pub const SIDE_FROM: u16 = 140;
/// The side pane's width, and the column of rule between it and the main text.
pub const SIDE_WIDTH: u16 = 34;

/// One block of reference: a title, a summary for its folded header (`5 files`) and its lines.
#[derive(Clone, Debug)]
pub struct RefGroup {
    pub id: &'static str,
    pub title: String,
    pub summary: String,
    pub lines: Vec<Line<'static>>,
}

impl RefGroup {
    pub fn new(id: &'static str, title: &str, summary: impl Into<String>, lines: Vec<Line<'static>>) -> RefGroup {
        RefGroup { id, title: title.to_string(), summary: summary.into(), lines }
    }

    fn is_short(&self) -> bool {
        self.lines.len() <= FOLD_ABOVE
    }
}

/// What a section shows: the text the person reads first and the reference beside it.
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub main: Vec<Line<'static>>,
    pub groups: Vec<RefGroup>,
}

impl Page {
    pub fn of(main: Vec<Line<'static>>) -> Page {
        Page { main, groups: Vec::new() }
    }
}

/// Which groups the person opened or closed, and where the focus is. Lives on the app for the open card;
/// `ids` is written by each draw so the keys know what they act on.
#[derive(Default)]
pub struct RefState {
    /// Groups the person flipped from how they start (folded, or open when short in the side pane).
    pub toggled: HashSet<(Section, &'static str)>,
    /// The reference has the keys (`tab`), as against the main text.
    pub focus: bool,
    pub cursor: usize,
    pub ids: RefCell<Vec<&'static str>>,
}

impl RefState {
    pub fn reset(&mut self) {
        self.toggled.clear();
        self.focus = false;
        self.cursor = 0;
        self.ids.borrow_mut().clear();
    }

    /// Whether the open section has reference groups (as of the last frame).
    pub fn has_groups(&self) -> bool {
        !self.ids.borrow().is_empty()
    }

    /// The focused group's index, inside the groups the last frame drew.
    fn at(&self) -> Option<usize> {
        let n = self.ids.borrow().len();
        (n > 0).then(|| self.cursor.min(n - 1))
    }

    /// `tab`: the reference takes the keys, or gives them back. Nothing to take when there are no groups.
    pub fn flip_focus(&mut self) {
        if self.has_groups() {
            self.focus = !self.focus;
        } else {
            self.focus = false;
        }
    }

    /// `j`/`k` while the reference has the keys.
    pub fn step(&mut self, delta: i64) {
        if let Some(at) = self.at() {
            let last = self.ids.borrow().len() as i64 - 1;
            self.cursor = (at as i64 + delta).clamp(0, last) as usize;
        }
    }

    /// `enter` or `space` on the focused group's header.
    pub fn toggle(&mut self, section: Section) {
        if let Some(at) = self.at() {
            let id = self.ids.borrow()[at];
            if !self.toggled.remove(&(section, id)) {
                self.toggled.insert((section, id));
            }
        }
    }

    /// Whether `group` shows its lines. In the side pane a short group is always open; elsewhere a group
    /// starts folded and the person opens it.
    pub fn is_open(&self, section: Section, group: &RefGroup, side: bool) -> bool {
        (side && group.is_short()) || self.toggled.contains(&(section, group.id))
    }
}

/// The groups as lines, and the row of each group's header inside them. `width` pads a focused header.
pub fn layout(groups: &[RefGroup], section: Section, state: &RefState, side: bool, width: usize) -> (Vec<Line<'static>>, Vec<usize>) {
    let mut lines = Vec::new();
    let mut headers = Vec::new();
    let focused = state.focus.then(|| state.cursor.min(groups.len().saturating_sub(1)));
    for (i, group) in groups.iter().enumerate() {
        if i > 0 && side {
            lines.push(Line::default());
        }
        headers.push(lines.len());
        let open = state.is_open(section, group, side);
        let fixed = side && group.is_short();
        let marker = if fixed { " " } else if open { "▾" } else { "▸" };
        let mut spans = vec![Span::styled(format!("{marker} {}", group.title), theme::label().bold())];
        if !open && !group.summary.is_empty() {
            spans.push(Span::styled(format!("  {}", group.summary), theme::dim()));
        }
        let mut header = Line::from(spans);
        if focused == Some(i) {
            let used = header.spans.iter().map(|s| cells(&s.content)).sum::<usize>();
            header.spans.push(Span::raw(" ".repeat(width.saturating_sub(used))));
            header = header.style(theme::selection());
        }
        lines.push(header);
        if open {
            for line in &group.lines {
                let mut indented = vec![Span::raw("  ")];
                indented.extend(line.spans.iter().cloned());
                lines.push(Line::from(indented).style(line.style));
            }
        }
    }
    (lines, headers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect()).collect()
    }

    fn group(id: &'static str, title: &str, n: usize) -> RefGroup {
        RefGroup::new(id, title, format!("{n} lines"), (0..n).map(|i| Line::from(format!("{id} {i}"))).collect())
    }

    #[test]
    fn a_long_group_starts_folded_to_one_line_and_a_short_one_is_open_in_the_side_pane() {
        let groups = [group("map", "Code map", 5), group("risk", "Risk", 2)];
        let state = RefState::default();
        let (side, _) = layout(&groups, Section::Plan, &state, true, 30);
        let side = text(&side);
        assert_eq!(side[0], "▸ Code map  5 lines");
        assert!(side.contains(&"  Risk".to_string()) && side.contains(&"  risk 1".to_string()), "{side:?}");
        assert!(!side.iter().any(|l| l.contains("map 0")), "{side:?}");
        let (under, _) = layout(&groups, Section::Plan, &state, false, 30);
        assert_eq!(text(&under), ["▸ Code map  5 lines", "▸ Risk  2 lines"], "narrow: every group is folded to its header");
    }

    #[test]
    fn toggling_the_focused_group_opens_and_closes_it() {
        let groups = [group("map", "Code map", 5), group("risk", "Risk", 2)];
        let mut state = RefState::default();
        *state.ids.borrow_mut() = vec!["map", "risk"];
        state.flip_focus();
        assert!(state.focus);
        state.toggle(Section::Plan);
        let (lines, headers) = layout(&groups, Section::Plan, &state, true, 30);
        let lines = text(&lines);
        assert_eq!(lines[0].trim_end(), "▾ Code map");
        assert_eq!(lines[1], "  map 0");
        assert_eq!(headers, [0, 7]);
        state.toggle(Section::Plan);
        assert_eq!(text(&layout(&groups, Section::Plan, &state, true, 30).0)[0].trim_end(), "▸ Code map  5 lines");
    }

    #[test]
    fn j_and_k_move_between_headers_and_stop_at_the_ends() {
        let mut state = RefState::default();
        *state.ids.borrow_mut() = vec!["a", "b", "c"];
        state.focus = true;
        state.step(1);
        state.step(1);
        state.step(1);
        assert_eq!(state.cursor, 2);
        state.step(-5);
        assert_eq!(state.cursor, 0);
    }

    #[test]
    fn the_focused_header_is_drawn_with_the_selection_style_and_tab_with_no_groups_gives_nothing() {
        let groups = [group("map", "Code map", 5)];
        let mut state = RefState::default();
        state.flip_focus();
        assert!(!state.focus, "no groups drawn: nothing to focus");
        *state.ids.borrow_mut() = vec!["map"];
        state.flip_focus();
        let (lines, _) = layout(&groups, Section::Plan, &state, true, 30);
        assert_eq!(lines[0].style, theme::selection());
        assert_eq!(cells(&text(&lines)[0]), 30, "the highlight spans the pane");
    }

    #[test]
    fn a_reset_forgets_folds_focus_and_ids() {
        let mut state = RefState::default();
        *state.ids.borrow_mut() = vec!["map"];
        state.focus = true;
        state.toggle(Section::Plan);
        state.reset();
        assert!(state.toggled.is_empty() && !state.focus && !state.has_groups());
    }
}
