//! Luna TUI board: a lazygit-style view of the machine's tickets, inside herdr.
//!
//! Modules: `model` (tickets and markdown), `client` (the machine's API and event stream),
//! `store` (one-time import of the old local board), `herdr` (CLI calls), `app`
//! (behaviour), `keys` (the key registry every surface reads), `ui` (drawing). This file only
//! wires them to the terminal, and answers `--keys-md` (the README's key tables) without one.

mod app;
mod client;
mod datadog;
mod detail;
mod digest;
mod discover;
mod herdr;
mod inbox;
mod keys;
mod model;
mod notify;
mod pulls;
mod slack;
mod store;
mod ui;
mod vim;

use std::{io, time::Duration};

use ratatui::{
    DefaultTerminal,
    crossterm::{
        event::{
            self, DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind, MouseButton,
            MouseEventKind,
        },
        execute,
    },
};

use app::{App, Outcome};
use client::Machine;

fn run(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    let quiet = notify::quiet(std::env::var("HARDNESS_BOARD_QUIET").ok().as_deref());
    let mut badge = (usize::MAX, usize::MAX);
    loop {
        app.pump();
        tell(app, quiet, &mut badge);
        app.ensure_detail();
        app.ensure_diff();
        app.ensure_jira_search();
        app.tick();
        terminal.draw(|frame| ui::draw(frame, app))?;

        if event::poll(Duration::from_millis(200))? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => match app.handle_key(key) {
                    Outcome::Continue => {}
                    Outcome::Quit => return Ok(()),
                },
                Event::Mouse(mouse) => match mouse.kind {
                    MouseEventKind::ScrollDown => app.scroll(1),
                    MouseEventKind::ScrollUp => app.scroll(-1),
                    MouseEventKind::Down(MouseButton::Left) => app.click(mouse.column, mouse.row),
                    _ => {}
                },
                _ => {}
            }
        }
    }
}

/// `--keys-md`: prints the registry's markdown key tables; with a file, rewrites the tables
/// between that file's `<!-- keys:start <scope> -->` and `<!-- keys:end -->` markers in place.
fn keys_md(file: Option<&str>) -> io::Result<()> {
    match file {
        None => {
            print!("{}", keys::markdown());
            Ok(())
        }
        Some(path) => {
            let text = std::fs::read_to_string(path)?;
            let spliced = keys::splice_markdown(&text);
            if spliced != text {
                std::fs::write(path, &spliced)?;
                eprintln!("{path}: key tables regenerated");
            } else {
                eprintln!("{path}: key tables already current");
            }
            Ok(())
        }
    }
}

/// Notices go to herdr, or ring the terminal bell without it; the tab badge follows the count.
/// herdr calls are subprocesses, so they stay off the UI thread.
fn tell(app: &mut App, quiet: bool, badge: &mut (usize, usize)) {
    for notice in app.take_notices() {
        if quiet {
            continue;
        }
        if herdr::available() {
            std::thread::spawn(move || herdr::notify(&notice.title, &notice.body));
        } else {
            print!("\x07");
            let _ = io::Write::flush(&mut io::stdout());
        }
    }
    let count = (app.needs_you_count(), app.overdue_count());
    if count != *badge {
        *badge = count;
        let label = notify::badge_label(count.0, count.1);
        std::thread::spawn(move || herdr::badge(&label));
    }
}

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--keys-md") {
        return keys_md(args.get(1).map(String::as_str));
    }
    herdr::name_tab_and_pane();
    let mut app = App::new(Machine::from_env());
    let mut terminal = ratatui::init();
    let _ = execute!(io::stdout(), EnableMouseCapture);
    let result = run(&mut terminal, &mut app);
    let _ = execute!(io::stdout(), DisableMouseCapture);
    ratatui::restore();
    // Next time, the Digest and the cards' new dots are measured from now.
    let _ = store::write_last_seen_at(&store::state_path(), model::now_secs());
    result
}
