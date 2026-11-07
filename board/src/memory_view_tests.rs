//! The memory view, the ask pane and the Floor's memory line, driven through `handle_key` against a fake machine
//! that records every request it gets.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use ratatui::{
    Terminal,
    backend::TestBackend,
    crossterm::event::{KeyCode, KeyEvent},
};

use crate::app::{App, FloorState, Mode};
use crate::client::Machine;
use crate::memory::AskPhase;
use crate::ui;

type Seen = Arc<Mutex<Vec<String>>>;

const ITEMS: &str = r#"[
  {"id":"mem_1","kind":"outcome","repo":"api","source":{"kind":"github","ref":null},"anchors":{"files":["src/up.ts"],"commit":"abcdef0"},"provenance":{"by":"machine","card":"1a2b3c4d5e","run":null,"pack":null},"trust":"fact","status":"active","text":"the uploader retries three times","createdAt":"2026-11-06T22:00:00.000Z"},
  {"id":"mem_2","kind":"finding","repo":"api","source":{"kind":"doc","ref":"notes.md"},"anchors":{"files":[],"commit":null},"provenance":{"by":"person","card":null,"run":null,"pack":null},"trust":"outside","status":"active","text":"an upload nobody adopted","createdAt":"2026-11-06T22:00:00.000Z"}
]"#;
const OUTSIDE: &str = r#"[{"id":"mem_2","kind":"finding","repo":"api","source":{"kind":"doc","ref":"notes.md"},"anchors":{"files":[],"commit":null},"provenance":{"by":"person","card":null,"run":null,"pack":null},"trust":"outside","status":"active","text":"an upload nobody adopted","createdAt":"2026-11-06T22:00:00.000Z"}]"#;
const ANSWER: &str = r#"{"via":"pack","answer":"Three attempts.","citations":[{"kind":"item","ref":"mem_1"}],"grounded":true,"note":null}"#;

/// A machine that answers memory routes and records `METHOD path body` for each request. `status` is `GET /memory/status`'s answer.
fn fake(status: &'static str) -> (Machine, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream);
            let mut head = String::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                head.push_str(&line);
            }
            let mut body = vec![0; length];
            let _ = reader.read_exact(&mut body);
            let method = head.split_whitespace().next().unwrap_or("").to_string();
            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
            if path.starts_with("/memory") {
                log.lock().unwrap().push(format!("{method} {path} {}", String::from_utf8_lossy(&body)));
            }
            let answer = match (method.as_str(), path.as_str()) {
                ("GET", p) if p.starts_with("/memory/items?") && p.contains("trust=outside") => OUTSIDE.to_string(),
                ("GET", p) if p.starts_with("/memory/items?") => ITEMS.to_string(),
                ("GET", "/memory/status") => status.to_string(),
                ("POST", "/memory/ask") => ANSWER.to_string(),
                ("POST", p) if p.starts_with("/memory/items/") => r#"{"id":"mem_1"}"#.to_string(),
                ("GET", "/tasks") => "[]".to_string(),
                _ => "{}".to_string(),
            };
            let mut stream = reader.into_inner();
            let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len());
        }
    });
    (Machine::at(&format!("http://{addr}")), seen)
}

fn app(status: &'static str) -> (App, Seen) {
    let (machine, seen) = fake(status);
    let mut app = App::new(machine);
    app.tasks.clear();
    app.toast = None;
    app.home_repo = Some("/r/api".to_string());
    (app, seen)
}

fn press(app: &mut App, code: KeyCode) {
    app.handle_key(KeyEvent::from(code));
}

/// `:` then the text then enter.
fn command(app: &mut App, text: &str) {
    press(app, KeyCode::Char(':'));
    for ch in text.chars() {
        press(app, KeyCode::Char(ch));
    }
    press(app, KeyCode::Enter);
}

fn requests(seen: &Seen) -> Vec<String> {
    seen.lock().unwrap().clone()
}

fn screen(app: &App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|f| ui::draw(f, app)).unwrap();
    let buffer = terminal.backend().buffer().clone();
    buffer.content().chunks(width as usize).map(|row| row.iter().map(|c| c.symbol()).collect::<String>()).collect::<Vec<_>>().join("\n")
}

fn wait_for(app: &mut App, done: impl Fn(&App) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done(app) && Instant::now() < deadline {
        app.pump();
        thread::sleep(Duration::from_millis(10));
    }
    assert!(done(app), "the answer never arrived");
}

#[test]
fn m_opens_the_view_for_the_boards_repo_and_lists_what_is_not_retired() {
    let (mut app, seen) = app("{}");
    press(&mut app, KeyCode::Char('M'));
    assert!(app.memory.is_some());
    assert_eq!(app.memory_items.len(), 2);
    let get = requests(&seen).into_iter().find(|r| r.starts_with("GET /memory/items?")).unwrap();
    assert!(get.contains("status=pending,active,stale") && get.contains("repo=%2Fr%2Fapi"), "{get}");
    let text = screen(&app, 140, 30);
    for part in ["Memory · api · 2", "active", "fact", "outcome", "github", "machine, card 1a2b3c4d", "the uploader retries three times"] {
        assert!(text.contains(part), "{part} in\n{text}");
    }
    press(&mut app, KeyCode::Char('j'));
    assert!(screen(&app, 140, 30).contains("an upload nobody adopted"));
    press(&mut app, KeyCode::Esc);
    assert!(app.memory.is_none());
}

#[test]
fn f_asks_before_forgetting_and_only_a_yes_sends_it() {
    let (mut app, seen) = app("{}");
    press(&mut app, KeyCode::Char('M'));
    press(&mut app, KeyCode::Char('f'));
    assert!(matches!(&app.mode, Mode::ConfirmForget(id) if id == "mem_1"));
    assert!(screen(&app, 140, 30).contains("Forget this memory?"));
    press(&mut app, KeyCode::Char('n'));
    assert!(matches!(app.mode, Mode::Normal));
    assert!(!requests(&seen).iter().any(|r| r.contains("/forget")), "a no sends nothing");
    press(&mut app, KeyCode::Char('f'));
    press(&mut app, KeyCode::Char('y'));
    assert!(matches!(app.mode, Mode::Normal));
    let log = requests(&seen);
    assert!(log.iter().any(|r| r.starts_with("POST /memory/items/mem_1/forget")), "{log:?}");
    assert_eq!(log.iter().filter(|r| r.starts_with("GET /memory/items?")).count(), 2, "the list is fetched again");
}

#[test]
fn a_adopts_only_an_outside_item_and_o_keeps_only_those() {
    let (mut app, seen) = app("{}");
    press(&mut app, KeyCode::Char('M'));
    press(&mut app, KeyCode::Char('a'));
    assert!(app.toast.as_ref().is_some_and(|t| t.error && t.text.contains("only an outside item")));
    assert!(!requests(&seen).iter().any(|r| r.contains("/adopt")));
    press(&mut app, KeyCode::Char('j'));
    press(&mut app, KeyCode::Char('a'));
    assert!(requests(&seen).iter().any(|r| r.starts_with("POST /memory/items/mem_2/adopt")));
    press(&mut app, KeyCode::Char('o'));
    assert!(app.memory.as_ref().unwrap().outside_only);
    assert_eq!(app.memory_items.len(), 1);
    assert!(requests(&seen).iter().any(|r| r.starts_with("GET /memory/items?") && r.contains("trust=outside")));
    assert!(screen(&app, 140, 30).contains("outside only"));
}

#[test]
fn q_opens_the_ask_pane_and_enter_sends_the_question_for_the_repo_and_shows_the_answer_with_its_sources() {
    let (mut app, seen) = app("{}");
    press(&mut app, KeyCode::Char('Q'));
    assert!(matches!(&app.mode, Mode::Ask(p) if matches!(p.phase, AskPhase::Typing) && p.repo.as_deref() == Some("/r/api")));
    for ch in "retries?".chars() {
        press(&mut app, KeyCode::Char(ch));
    }
    press(&mut app, KeyCode::Backspace);
    press(&mut app, KeyCode::Char('?'));
    press(&mut app, KeyCode::Enter);
    assert!(matches!(&app.mode, Mode::Ask(p) if matches!(p.phase, AskPhase::Waiting)));
    wait_for(&mut app, |a| matches!(&a.mode, Mode::Ask(p) if matches!(p.phase, AskPhase::Answered(_))));
    let post = requests(&seen).into_iter().find(|r| r.starts_with("POST /memory/ask")).unwrap();
    let sent: serde_json::Value = serde_json::from_str(post.trim_start_matches("POST /memory/ask ")).unwrap();
    assert_eq!(sent, serde_json::json!({"question": "retries?", "repo": "/r/api"}));
    let text = screen(&app, 120, 30);
    for part in ["Ask memory · api", "? retries?", "Three attempts.", "Sources", "item mem_1"] {
        assert!(text.contains(part), "{part} in\n{text}");
    }
    press(&mut app, KeyCode::Char('Q'));
    assert!(matches!(&app.mode, Mode::Ask(p) if matches!(p.phase, AskPhase::Typing)), "Q asks again");
    press(&mut app, KeyCode::Esc);
    assert!(matches!(app.mode, Mode::Normal));
}

#[test]
fn the_ask_command_sends_at_once_and_a_machine_error_shows_in_the_pane() {
    let (mut app, seen) = app("{}");
    command(&mut app, "ask what changed?");
    wait_for(&mut app, |a| matches!(&a.mode, Mode::Ask(p) if matches!(p.phase, AskPhase::Answered(_))));
    assert!(requests(&seen).iter().any(|r| r.starts_with("POST /memory/ask") && r.contains("what changed?")));
    // A machine nobody answers for.
    let mut down = App::new(Machine::at("http://127.0.0.1:1"));
    down.tasks.clear();
    command(&mut down, "ask anyone?");
    wait_for(&mut down, |a| matches!(&a.mode, Mode::Ask(p) if matches!(p.phase, AskPhase::Failed(_))));
    assert!(screen(&down, 120, 30).contains("machine unreachable"));
}

#[test]
fn the_floor_shows_memory_s_mode_and_usage_only_when_the_machine_reports_it() {
    let (on, _) = fake(r#"{"enabled":true,"mode":"openai","tokensToday":12345,"costUsdToday":0.042,"cognifiedToday":5}"#);
    let status = on.memory_status().expect("a status");
    let floor = FloorState { memory: Some(status), ..FloorState::default() };
    let mut app = App::new(Machine::at("http://127.0.0.1:1"));
    app.floor = Some(floor);
    assert!(screen(&app, 120, 30).contains("Memory · openai · 12.3k tokens · $0.04 · 5 cognified today"));
    app.floor = Some(FloorState::default());
    assert!(!screen(&app, 120, 30).contains("Memory ·"), "absent: nothing is drawn");
    let (off, _) = fake(r#"{"enabled":false,"mode":null,"tokensToday":null,"costUsdToday":null,"cognifiedToday":0}"#);
    assert_eq!(off.memory_status(), None);
    assert_eq!(Machine::at("http://127.0.0.1:1").memory_status(), None, "no machine, no line");
}

#[test]
fn a_registry_scope_for_memory_lists_its_keys_and_the_board_lists_m_and_q() {
    let keys: Vec<&str> = crate::keys::BINDINGS.iter().filter(|b| b.scope == crate::keys::Scope::Memory).map(|b| b.keys).collect();
    for key in ["f", "a", "o", "Q"] {
        assert!(keys.contains(&key), "{key} in {keys:?}");
    }
    let board: Vec<&str> = crate::keys::BINDINGS.iter().filter(|b| b.scope == crate::keys::Scope::Board).map(|b| b.keys).collect();
    assert!(board.contains(&"M") && board.contains(&"Q"));
    assert!(board.contains(&"?"), "? is still the key sheet");
}
