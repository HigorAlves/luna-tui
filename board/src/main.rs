//! Hardness Board: a lazygit-style view of the machine's tickets, inside herdr.
//!
//! Modules: `model` (tickets and markdown), `client` (the machine's API and event stream),
//! `store` (one-time import of the old local board), `herdr` (CLI calls), `app`
//! (behaviour), `ui` (drawing). This file only wires them to the terminal.

mod app;
mod client;
mod herdr;
mod model;
mod store;
mod ui;

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
    loop {
        app.pump();
        app.ensure_detail();
        app.tick();
        terminal.draw(|frame| ui::draw(frame, app))?;

        if event::poll(Duration::from_millis(200))? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => match app.handle_key(key) {
                    Outcome::Continue => {}
                    Outcome::Quit => return Ok(()),
                    Outcome::Edit(id) => app.edit_ticket(terminal, &id),
                    Outcome::Answer(id) => app.answer_questions(terminal, &id),
                },
                Event::Mouse(mouse) => match mouse.kind {
                    MouseEventKind::ScrollDown => app.move_selection(1),
                    MouseEventKind::ScrollUp => app.move_selection(-1),
                    MouseEventKind::Down(MouseButton::Left) => app.click(mouse.column, mouse.row),
                    _ => {}
                },
                _ => {}
            }
        }
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
    result
}
