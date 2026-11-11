//! Text for the screen: making outside text safe, wrapping it to a readable measure, a light markdown
//! for what models write, and cutting strings to fit. Pure functions, no drawing.

use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};

use crate::theme;

/// The widest a line of prose gets, however wide the terminal is.
pub(crate) const MEASURE: usize = 100;

/// A character that must never reach the terminal: a control character (an escape sequence starts with one)
/// or an invisible format character (zero-width, bidirectional overrides, the byte-order mark).
pub(crate) fn is_unsafe(ch: char) -> bool {
    ch.is_control() || matches!(ch, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
}

/// `text` with every unsafe character made a space (a newline stays when `keep_newline`). The zero-width joiner and non-joiner
/// stay when they sit between two ordinary characters, where emoji sequences and some scripts need them; at an edge or next to
/// another format character they are as unsafe as the rest.
pub(crate) fn sanitize(text: &str, keep_newline: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let joiner = |c: char| matches!(c, '\u{200C}' | '\u{200D}');
    let solid = |c: char| !c.is_control() && !c.is_whitespace() && !is_unsafe(c);
    chars
        .iter()
        .enumerate()
        .map(|(i, &ch)| match ch {
            '\n' if keep_newline => ch,
            _ if joiner(ch) && i > 0 && i + 1 < chars.len() && solid(chars[i - 1]) && solid(chars[i + 1]) => ch,
            _ if is_unsafe(ch) => ' ',
            _ => ch,
        })
        .collect()
}

/// Display cells `text` takes.
pub(crate) fn cells(text: &str) -> usize {
    Span::raw(text).width()
}

fn ch_cells(ch: char) -> usize {
    cells(ch.encode_utf8(&mut [0; 4]))
}

/// Cuts `text` to `max` cells, ending in `…` when it had to cut.
pub(crate) fn ellipsis(text: &str, max: usize) -> String {
    if cells(text) <= max {
        return text.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = ch_cells(ch);
        if used + w + 1 > max {
            break;
        }
        out.push(ch);
        used += w;
    }
    if max > 0 {
        out.push('…');
    }
    out
}

/// Cuts a path to `max` cells keeping its head and its tail: `api/…/routes.ts`.
pub(crate) fn truncate_middle(text: &str, max: usize) -> String {
    if cells(text) <= max {
        return text.to_string();
    }
    if max < 3 {
        return ellipsis(text, max);
    }
    let chars: Vec<char> = text.chars().collect();
    let budget = max - 1;
    let head_budget = budget / 3;
    let tail_budget = budget - head_budget;
    let mut head = String::new();
    let mut used = 0;
    for &ch in &chars {
        if used + ch_cells(ch) > head_budget {
            break;
        }
        head.push(ch);
        used += ch_cells(ch);
    }
    let mut tail: Vec<char> = Vec::new();
    used = 0;
    for &ch in chars.iter().rev() {
        if used + ch_cells(ch) > tail_budget {
            break;
        }
        tail.push(ch);
        used += ch_cells(ch);
    }
    tail.reverse();
    format!("{head}…{}", tail.into_iter().collect::<String>())
}

type Piece = (String, Style);

/// Breaks styled text into lines of at most `avail` cells on word boundaries; a word wider than a line is hard-split.
fn wrap_pieces(segments: &[Piece], avail: usize) -> Vec<Vec<Piece>> {
    let avail = avail.max(1);
    let mut words: Vec<Vec<Piece>> = Vec::new();
    let mut word: Vec<Piece> = Vec::new();
    for (text, style) in segments {
        for ch in text.chars() {
            if ch.is_whitespace() {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            } else if let Some(last) = word.last_mut().filter(|(_, s)| s == style) {
                last.0.push(ch);
            } else {
                word.push((ch.to_string(), *style));
            }
        }
        if !word.is_empty() && text.ends_with(char::is_whitespace) {
            words.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        words.push(word);
    }

    let mut lines: Vec<Vec<Piece>> = Vec::new();
    let mut line: Vec<Piece> = Vec::new();
    let mut used = 0;
    for word in words {
        let width: usize = word.iter().map(|(t, _)| cells(t)).sum();
        if used > 0 && used + 1 + width <= avail {
            line.push((" ".into(), Style::new()));
            line.extend(word);
            used += 1 + width;
            continue;
        }
        if used > 0 {
            lines.push(std::mem::take(&mut line));
            used = 0;
        }
        if width <= avail {
            line = word;
            used = width;
            continue;
        }
        for (text, style) in word {
            for ch in text.chars() {
                let w = ch_cells(ch);
                if used > 0 && used + w > avail {
                    lines.push(std::mem::take(&mut line));
                    used = 0;
                }
                match line.last_mut().filter(|(_, s)| *s == style) {
                    Some(last) => last.0.push(ch),
                    None => line.push((ch.to_string(), style)),
                }
                used += w;
            }
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// Word-wraps `text` to the smaller of `width` and `MEASURE` cells. Every line starts with `indent` spaces, the
/// first one too, so a caller can swap that first prefix for a bullet. Blank input lines stay as empty lines.
pub(crate) fn wrap(text: &str, width: usize, indent: usize) -> Vec<String> {
    let avail = width.min(MEASURE).saturating_sub(indent).max(1);
    let pad = " ".repeat(indent);
    let mut out = Vec::new();
    for paragraph in text.split('\n') {
        if paragraph.trim().is_empty() {
            out.push(String::new());
            continue;
        }
        for line in wrap_pieces(&[(paragraph.to_string(), Style::new())], avail) {
            out.push(format!("{pad}{}", line.into_iter().map(|(t, _)| t).collect::<String>()));
        }
    }
    out
}

/// `**bold**` and `` `code` `` in one line of text; a marker without its twin stays literal.
fn inline(text: &str) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::new();
    let mut plain = String::new();
    let mut rest = text;
    let flush = |plain: &mut String, out: &mut Vec<Piece>| {
        if !plain.is_empty() {
            out.push((std::mem::take(plain), Style::new()));
        }
    };
    while let Some(ch) = rest.chars().next() {
        let marked = if let Some(after) = rest.strip_prefix("**") {
            after.find("**").filter(|&end| end > 0).map(|end| (&after[..end], 4 + end, Style::new().add_modifier(Modifier::BOLD)))
        } else if let Some(after) = rest.strip_prefix('`') {
            after.find('`').filter(|&end| end > 0).map(|end| (&after[..end], 2 + end, theme::code()))
        } else {
            None
        };
        match marked {
            Some((inner, consumed, style)) => {
                flush(&mut plain, &mut out);
                out.push((inner.to_string(), style));
                rest = &rest[consumed..];
            }
            None => {
                plain.push(ch);
                rest = &rest[ch.len_utf8()..];
            }
        }
    }
    flush(&mut plain, &mut out);
    out
}

fn to_line(pieces: Vec<Piece>, lead: String) -> Line<'static> {
    let mut spans = vec![Span::raw(lead)];
    spans.extend(pieces.into_iter().map(|(t, s)| Span::styled(t, s)));
    Line::from(spans)
}

/// Splits a list marker off a line: the marker to draw, the text after it and any extra indent for nesting.
fn list_item(line: &str) -> Option<(String, &str, usize)> {
    let body = line.trim_start();
    let nest = (line.len() - body.len()).min(8);
    if let Some(rest) = body.strip_prefix("- ").or_else(|| body.strip_prefix("* ")) {
        return Some(("• ".into(), rest, nest));
    }
    let digits = body.chars().take_while(char::is_ascii_digit).count();
    if (1..=3).contains(&digits) && let Some(rest) = body[digits..].strip_prefix(". ") {
        return Some((format!("{}. ", &body[..digits]), rest, nest));
    }
    None
}

/// A line of model text with a leading status glyph turned into `·`, so it cannot pass for a flag or a status line of the board's own.
/// Markup in front of the glyph (`**`, `- `, `> `, `#`) is looked through.
fn unmimic(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut leading = true;
    for ch in line.chars() {
        if leading && matches!(ch, '⚑' | '✓' | '✗' | '⏸') {
            out.push('·');
            leading = false;
            continue;
        }
        if !(ch.is_whitespace() || matches!(ch, '*' | '_' | '#' | '-' | '>' | '•')) {
            leading = false;
        }
        out.push(ch);
    }
    out
}

/// Puts the dim gutter `▏` at the left edge of every line of a model-written block, over the first cell of its indent.
fn gutter(lines: Vec<Line<'static>>) -> Vec<Line<'static>> {
    lines
        .into_iter()
        .map(|mut line| {
            let bar = Span::styled("▏", theme::dim());
            match line.spans.first_mut() {
                Some(first) if first.content.starts_with(' ') => {
                    let rest: String = first.content.chars().skip(1).collect();
                    first.content = rest.into();
                    line.spans.insert(0, bar);
                }
                _ => line.spans.insert(0, bar),
            }
            line
        })
        .collect()
}

/// Renders model text lightly: bullets, numbered items, `code`, `**bold**`, `#` headings and ``` blocks. The text is
/// made safe first. Everything else is literal and wrapped to `width` (at most `MEASURE`) with `indent` spaces in front.
pub(crate) fn markdown(text: &str, width: usize, indent: usize) -> Vec<Line<'static>> {
    gutter(markdown_body(text, width, indent))
}

fn markdown_body(text: &str, width: usize, indent: usize) -> Vec<Line<'static>> {
    let safe: String = sanitize(text, true).lines().map(unmimic).collect::<Vec<_>>().join("\n");
    let lines: Vec<&str> = safe.lines().collect();
    let total = width.min(MEASURE);
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") && lines[i + 1..].iter().any(|l| l.trim_start().starts_with("```")) {
            let close = lines[i + 1..].iter().position(|l| l.trim_start().starts_with("```")).map_or(lines.len(), |p| i + 1 + p);
            let room = total.saturating_sub(indent + 2).max(1);
            for code in &lines[i + 1..close] {
                let mut kept = String::new();
                let mut used = 0;
                for ch in code.trim_end().chars() {
                    if used + ch_cells(ch) > room {
                        break;
                    }
                    kept.push(ch);
                    used += ch_cells(ch);
                }
                out.push(Line::from(vec![Span::raw(" ".repeat(indent + 2)), Span::styled(kept, theme::code())]));
            }
            i = close + 1;
            continue;
        }
        i += 1;
        if trimmed.is_empty() {
            out.push(Line::default());
        } else if let Some(title) = ["### ", "## ", "# "].iter().find_map(|m| trimmed.strip_prefix(m)).filter(|t| !t.trim().is_empty()) {
            let avail = total.saturating_sub(indent).max(1);
            for row in wrap_pieces(&[(title.trim().to_string(), Style::new().add_modifier(Modifier::BOLD))], avail) {
                out.push(to_line(row, " ".repeat(indent)));
            }
        } else if let Some((marker, rest, nest)) = list_item(line) {
            let lead = indent + nest;
            let avail = total.saturating_sub(lead + cells(&marker)).max(1);
            for (n, row) in wrap_pieces(&inline(rest), avail).into_iter().enumerate() {
                let prefix = if n == 0 { format!("{}{marker}", " ".repeat(lead)) } else { " ".repeat(lead + cells(&marker)) };
                out.push(to_line(row, prefix));
            }
            if rest.trim().is_empty() {
                out.push(to_line(Vec::new(), format!("{}{marker}", " ".repeat(lead))));
            }
        } else {
            let avail = total.saturating_sub(indent).max(1);
            for row in wrap_pieces(&inline(line.trim_end()), avail) {
                out.push(to_line(row, " ".repeat(indent)));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect()).collect()
    }

    #[test]
    fn wrap_breaks_on_words_with_a_hanging_indent() {
        assert_eq!(wrap("alpha beta gamma delta", 12, 2), ["  alpha beta", "  gamma", "  delta"]);
    }

    #[test]
    fn wrap_caps_the_measure_at_one_hundred_cells() {
        let text = "word ".repeat(60);
        assert!(wrap(&text, 300, 0).iter().all(|l| cells(l) <= MEASURE));
        assert!(wrap(&text, 300, 0).len() > 2);
    }

    #[test]
    fn wrap_hard_splits_a_word_longer_than_the_line_and_never_splits_a_short_one() {
        assert_eq!(wrap("abcdefghij", 4, 0), ["abcd", "efgh", "ij"]);
        assert_eq!(wrap("ab cdefghij", 6, 0), ["ab", "cdefgh", "ij"]);
    }

    #[test]
    fn wrap_keeps_blank_lines_as_paragraph_breaks() {
        assert_eq!(wrap("one\n\ntwo", 20, 1), [" one", "", " two"]);
    }

    #[test]
    fn wrap_measures_display_cells_not_characters() {
        // Each of these takes two cells.
        assert_eq!(wrap("世界 世界 世界", 9, 0), ["世界 世界", "世界"]);
    }

    #[test]
    fn ellipsis_ends_with_a_mark_inside_the_budget() {
        assert_eq!(ellipsis("short", 10), "short");
        assert_eq!(ellipsis("abcdefghij", 6), "abcde…");
        assert_eq!(cells(&ellipsis("世界世界世界", 7)), 7);
    }

    #[test]
    fn truncate_middle_keeps_the_head_and_the_file_name() {
        assert_eq!(truncate_middle("api/routes.ts", 20), "api/routes.ts");
        let cut = truncate_middle("api/reports/handlers/routes.ts", 16);
        assert!(cut.starts_with("api/") && cut.ends_with("routes.ts") && cut.contains('…'), "{cut}");
        assert_eq!(cells(&cut), 16);
    }

    #[test]
    fn markdown_renders_bullets_with_a_hanging_indent() {
        let lines = flat(&markdown("- first item is long enough to wrap\n* second", 20, 2));
        assert_eq!(lines, ["▏ • first item is", "▏   long enough to", "▏   wrap", "▏ • second"]);
    }

    #[test]
    fn markdown_renders_numbered_items() {
        let lines = flat(&markdown("1. open it\n2. close it", 40, 0));
        assert_eq!(lines, ["▏1. open it", "▏2. close it"]);
    }

    #[test]
    fn markdown_styles_code_and_bold_spans_and_leaves_unbalanced_markers_literal() {
        let lines = markdown("run `cargo test` and **stop** but `not this and **nor", 80, 0);
        let spans = &lines[0].spans;
        assert!(spans.iter().any(|s| s.content == "cargo" && s.style == theme::code()));
        assert!(spans.iter().any(|s| s.content == "test" && s.style == theme::code()));
        assert!(spans.iter().any(|s| s.content == "stop" && s.style.add_modifier.contains(Modifier::BOLD)));
        assert!(flat(&lines)[0].ends_with("but `not this and **nor"));
    }

    #[test]
    fn markdown_renders_headings_as_bold_lines() {
        let lines = markdown("## Plan\ntext", 40, 0);
        assert_eq!(flat(&lines), ["▏Plan", "▏text"]);
        assert!(lines[0].spans[2].style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn markdown_renders_a_fenced_block_in_the_code_style_cut_not_wrapped() {
        let lines = markdown("before\n```\nlet long_line = 1;\n```\nafter", 12, 0);
        assert_eq!(flat(&lines), ["▏before", "▏ let long_l", "▏after"]);
        assert_eq!(lines[1].spans[2].style, theme::code());
    }

    #[test]
    fn markdown_leaves_an_unclosed_fence_literal() {
        assert_eq!(flat(&markdown("```\nx", 40, 0)), ["▏```", "▏x"]);
    }

    #[test]
    fn markdown_makes_the_text_safe_first() {
        let text = flat(&markdown("a\u{1b}[31mb\rc\u{7}d\u{202e}e\u{200b}f", 40, 0)).join("\n");
        assert!(!text.contains('\u{1b}') && !text.contains('\r') && !text.contains('\u{7}'));
        assert!(!text.contains('\u{202e}') && !text.contains('\u{200b}'));
    }

    #[test]
    fn every_line_of_model_text_wears_the_dim_gutter_and_a_status_glyph_at_its_start_becomes_a_dot() {
        let lines = markdown("# Criteria\n\n⚑ approved by the owner\n**✓ all passed**\n- ✗ nope\n⏸ held", 60, 2);
        let text = flat(&lines);
        assert!(text.iter().all(|l| l.starts_with('▏')), "{text:?}");
        assert!(lines.iter().all(|l| l.spans[0].content == "▏" && l.spans[0].style == theme::dim()));
        assert_eq!(text[0], "▏ Criteria");
        assert!(text.iter().any(|l| l == "▏ · approved by the owner") && text.iter().any(|l| l == "▏ · all passed"), "{text:?}");
        assert!(text.iter().any(|l| l.contains("• · nope")) && text.iter().any(|l| l == "▏ · held"), "{text:?}");
        assert!(!text.join("\n").contains(['⚑', '✓', '✗', '⏸']));
    }

    #[test]
    fn a_joiner_between_two_characters_stays_and_one_at_an_edge_or_beside_a_format_character_goes() {
        let family = "👨\u{200d}👩\u{200d}👧";
        assert_eq!(sanitize(family, false), family);
        assert_eq!(sanitize("می\u{200c}خواهم", false), "می\u{200c}خواهم");
        assert_eq!(sanitize("a\u{200d} b", false), "a  b");
        assert_eq!(sanitize("\u{200d}a", false), " a");
        assert_eq!(sanitize("a\u{200d}\u{202e}b", false), "a  b");
        assert_eq!(sanitize("a\u{202e}b\u{200b}c\u{2066}d\u{feff}", false), "a b c d ");
        assert_eq!(crate::model::plain("x\u{200d}y\u{202e}z", 20), "x\u{200d}y z");
    }
}
