//! Luna TUI board: a lazygit-style view of the machine's tickets, inside herdr.
//!
//! Modules: `model` (tickets and markdown), `client` (the machine's API and event stream),
//! `store` (one-time import of the old local board), `herdr` (CLI calls), `app`
//! (behaviour), `ui` (drawing). This file only wires them to the terminal.

mod app;
mod client;
mod digest;
mod discover;
mod herdr;
mod inbox;
mod model;
mod notify;
mod pulls;
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
    let mut badge = usize::MAX;
    loop {
        app.pump();
        tell(app, quiet, &mut badge);
        app.ensure_detail();
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

/// Notices go to herdr, or ring the terminal bell without it; the tab badge follows the count.
/// herdr calls are subprocesses, so they stay off the UI thread.
fn tell(app: &mut App, quiet: bool, badge: &mut usize) {
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
    let count = app.needs_you_count();
    if count != *badge {
        *badge = count;
        let label = notify::badge_label(count);
        std::thread::spawn(move || herdr::badge(&label));
    }
}

fn main() -> io::Result<()> {
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
