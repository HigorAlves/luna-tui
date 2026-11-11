//! Test helpers for the screens: draw the whole app into a test terminal and read it back as text, and
//! cards at the four moments the task view is built around. No machine is needed; the app is built the way
//! the app tests build it, against whatever `Machine::from_env` finds, and its detail is set by hand.

// Later slices use these; until each is used, some are not.
#![allow(dead_code)]

use ratatui::{Terminal, backend::TestBackend};
use serde_json::{Value, json};

use crate::{
    app::App,
    client::Machine,
    model::{Task, TaskDetail},
    ui,
};

/// Where nothing listens (the discard port): the machine every test app talks to.
pub const DEAD_MACHINE: &str = "http://127.0.0.1:9";

/// A machine client pointed at `DEAD_MACHINE`; every call fails at once, as it does offline.
pub fn dead_machine() -> Machine {
    Machine::at(DEAD_MACHINE)
}

/// Titles of the fixture cards, for `render(..).contains(TITLE)` checks.
pub const PLAN_GATE_TITLE: &str = "Add CSV export to reports";
pub const RUNNING_BUILD_TITLE: &str = "Retry failed webhook deliveries";
pub const ESCALATED_TITLE: &str = "Migrate sessions to the new store";
pub const SHIP_STAGE_TITLE: &str = "Rate limit the public API";

/// Draws `ui::draw` into a `width` x `height` terminal and returns the screen, one string per row.
pub fn render(app: &mut App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|frame| ui::draw(frame, app)).unwrap();
    let buffer = terminal.backend().buffer().clone();
    (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
}

/// A ticket as the machine sends it; `extra` is merged over the defaults.
pub fn task_json(id: &str, title: &str, state: &str, column: &str, extra: Value) -> Value {
    let mut task = json!({
        "id": id, "title": title, "description": "Users ask for the report as a file they can open in a spreadsheet.",
        "criteria": [], "repoPath": "/work/app", "branch": format!("task/{}", &id[..8]), "worktreePath": "/work/wt",
        "state": state, "column": column, "waitingOnYou": false, "running": false, "queued": false,
        "retries": {"verify": 0, "e2e": 0, "ci": 0, "total": 0}, "resumeTo": null, "reason": null,
        "createdAt": "2026-10-22T09:00:00.000Z", "updatedAt": "2026-10-22T10:00:00.000Z"
    });
    for (key, value) in extra.as_object().into_iter().flatten() {
        task[key] = value.clone();
    }
    task
}

fn stage_run(id: &str, stage: &str, attempt: u32, status: &str, cost: f64) -> Value {
    json!({"id": id, "stage": stage, "attempt": attempt, "status": status, "costUsd": cost, "turns": 12,
        "startedAt": "2026-10-22T09:00:00Z", "endedAt": if status == "running" { Value::Null } else { json!("2026-10-22T09:30:00Z") }})
}

/// An app with `task` listed and its popup open on `detail`.
pub fn open_card(task: Value, detail_rest: Value) -> App {
    let mut detail = json!({"task": task, "stageRuns": [], "approvals": [], "events": [], "artifacts": []});
    for (key, value) in detail_rest.as_object().into_iter().flatten() {
        detail[key] = value.clone();
    }
    let task: Task = serde_json::from_value(task).unwrap();
    let detail: TaskDetail = serde_json::from_value(detail).unwrap();
    let mut app = App::new(dead_machine());
    app.tasks.push(task.clone());
    app.detail = Some(detail);
    app.open_detail(task.id);
    app
}

/// A feature card at the plan gate: 5 criteria, 3 assumptions, 4 slices, 6 cases, 5 mapped files and one flagged check.
pub fn plan_gate_app() -> App {
    let criteria = [
        "exports every column the report shows",
        "escapes commas, quotes and newlines",
        "declares UTF-8 with a byte-order mark",
        "streams a large report without loading it whole",
        "a person without access gets a 403",
    ];
    let task = task_json("aaaaaaaa1111", PLAN_GATE_TITLE, "awaiting_approval", "Plan", json!({"waitingOnYou": true, "criteria": criteria}));
    let cases: Vec<Value> = (0..6)
        .map(|i| json!({"id": format!("S{}", i + 1), "title": format!("case {} proves criterion {}", i + 1, i % 5 + 1), "criterion": criteria[i % 5], "approach": "run the suite and read the output", "type": if i < 5 { "happy" } else { "failure" }, "layer": if i % 2 == 0 { "unit" } else { "integration" }}))
        .collect();
    open_card(
        task,
        json!({
            "stageRuns": [stage_run("r1", "triage", 1, "passed", 0.42), stage_run("r2", "plan", 1, "passed", 0.71), stage_run("r3", "test_design", 1, "passed", 0.35)],
            "approvals": [
                {"id": "t1", "kind": "awaiting_test_check", "requested": {"cases": cases}, "decision": "approved", "createdAt": "2026-10-22T09:40:00Z", "decidedAt": "2026-10-22T09:45:00Z"},
                {"id": "p1", "kind": "awaiting_approval", "decision": null, "createdAt": "2026-10-22T09:50:00Z", "requested": {
                    "lane": "plan", "risk": {"level": "medium"}, "verdicts": {"coverage": "proceed", "plan": "flag", "risk": "proceed"},
                    "brief": "Add a CSV export endpoint to the reports API and a button on the report page.\n\n- the endpoint streams rows\n- the button calls it",
                    "criteria": criteria,
                    "planIssues": ["step 3 names a file outside the code map"],
                    "rollback": "Revert the commit; the export route owns no data.",
                    "plan": {"out_of_scope": ["XLSX export"], "migration": "none needed", "acceptance_criteria": criteria.iter().enumerate().map(|(i, t)| json!({"id": format!("C{}", i + 1), "text": t})).collect::<Vec<_>>()},
                    "assumptions": ["CSV only, no XLSX", "the report page already knows the report id", "the export uses the viewer's permissions"],
                    "slices": [
                        {"title": "Add the CSV writer", "est_loc": 90, "touchpoints": ["src/reports/csv.ts"]}, {"title": "Add GET /api/reports/:id/export.csv", "est_loc": 120, "touchpoints": ["src/reports/api.ts"]},
                        {"title": "Stream large reports", "est_loc": 80, "touchpoints": ["src/reports/api.ts", "src/reports/csv.ts"]}, {"title": "Add the export button", "est_loc": 60, "touchpoints": ["src/reports/page.tsx"]}
                    ],
                    "map": {"components": ["reports"], "files": [
                        {"path": "src/reports/api.ts", "role": "change"}, {"path": "src/reports/csv.ts", "role": "change"},
                        {"path": "src/reports/page.tsx", "role": "change"}, {"path": "src/reports/model.ts", "role": "read"},
                        {"path": "src/reports/__tests__/api.test.ts", "role": "test"}
                    ]},
                    "flagged": ["plan"]
                }}
            ]
        }),
    )
}

/// A plan gate as `machine/src/application/stages/plan.ts` builds its `requested`: flagged sentences as the machine writes them (and three
/// bare check names), `planIssues` from the plan check's script, the planner's own `plan.flags`, a `coverageReport` with `open` notes (a
/// sentence each), `gaps` and `untestable` as criterion ids, steps carrying both `files` and `touchpoints`, scenarios tied by `criterion_ref`.
pub fn real_plan_gate_app() -> App {
    let criteria = [
        "exports every column the report shows",
        "escapes commas, quotes and newlines",
        "declares UTF-8 with a byte-order mark",
        "rejects a report over 1M rows",
        "a person without access gets a 403",
    ];
    let task = task_json("abababab1111", "Add CSV export to reports", "awaiting_approval", "Plan", json!({"waitingOnYou": true, "criteria": criteria}));
    let scenario = |id: &str, title: &str, text: &str, reference: &str, kind: &str| {
        json!({"id": id, "title": title, "criterion": text, "criterion_ref": reference, "approach": "run the suite and read the output", "type": kind, "layer": "unit"})
    };
    let cases = vec![
        scenario("S1", "every column of the report is in the header row", criteria[0], "C1", "happy"),
        // The criterion text as the scenario carries it differs from the plan's (a tab): the tie is the ref.
        scenario("S2", "a comma inside a cell is quoted", "escapes commas,\tquotes and newlines", "C2", "happy"),
        scenario("S3", "the file starts with the byte-order mark", criteria[2], "C3", "happy"),
    ];
    let steps = [
        ("P1", "Add the CSV writer", 90, vec!["src/reports/csv.ts"]),
        ("P2", "Add GET /api/reports/:id/export.csv and its CI check", 120, vec!["src/reports/api.ts", ".github/workflows/ci.yml"]),
        ("P3", "Add the export button", 60, vec!["src/reports/page.tsx"]),
    ];
    let steps: Vec<Value> = steps
        .into_iter()
        .map(|(id, title, loc, files)| json!({"id": id, "title": title, "description": title, "est_loc": loc, "files": files, "touchpoints": files, "new_files": [], "done_when": ["it works"], "acceptance": ["it works"]}))
        .collect();
    open_card(
        task,
        json!({
            "stageRuns": [stage_run("r1", "triage", 1, "passed", 0.42), stage_run("r2", "plan", 1, "passed", 0.71)],
            "approvals": [{"id": "p1", "kind": "awaiting_approval", "decision": null, "createdAt": "2026-10-22T09:50:00Z", "requested": {
                "summary": "Add CSV export", "brief": "Add a CSV export endpoint to the reports API and a button on the report page.",
                "criteria": criteria, "assumptions": ["CSV only, no XLSX"],
                "slices": steps.iter().map(|s| json!({"title": s["title"], "est_loc": s["est_loc"], "touchpoints": s["touchpoints"], "acceptance": ["it works"]})).collect::<Vec<_>>(),
                "rollback": "Revert the commit; the export route owns no data.",
                "plan": {
                    "version": 1, "brief": "Add a CSV export endpoint.", "rollback": "Revert the commit; the export route owns no data.", "out_of_scope": ["XLSX export"],
                    "acceptance_criteria": criteria.iter().enumerate().map(|(i, t)| json!({"id": format!("C{}", i + 1), "text": t})).collect::<Vec<_>>(),
                    "steps": steps,
                    "flags": ["the CSV writer may need a streaming rewrite for very large reports", "P3 depends on a design the ticket does not attach"]
                },
                "planIssues": ["P2 touches .github/workflows/ci.yml, which the code map does not name and the step does not declare new", "the plan has no rollback for the CI change"],
                "riskRaised": "a step touches a control-plane file: .github/workflows/ci.yml",
                "cases": cases,
                "coverageReport": {"score": 0.6, "bar": 0.8, "gaps": ["C4", "C5"], "thin": [], "untestable": ["C4"], "open": ["C5 has no scenario: a person without access gets a 403"],
                    "per": criteria.iter().enumerate().map(|(i, t)| json!({"id": format!("C{}", i + 1), "text": t, "scenarios": [], "types": []})).collect::<Vec<_>>()},
                "risk": {"level": "high", "machine": "high", "scores": {"blast_radius": 4}},
                "approvalRule": {"needed": 2, "text": "Needs 2 approvers."},
                "verdicts": {"coverage": "flag", "plan": "flag", "risk": "proceed"},
                "size": {"verdict": "over", "planned_loc": 270},
                "lane": "full",
                "map": {"components": ["reports"], "stale": true, "behind": 41, "files": [{"path": "src/reports/api.ts", "role": "change"}, {"path": "src/reports/csv.ts", "role": "change"}]},
                "flagged": [
                    "coverage: excused as untestable, not covered: C4 (rejects a report over 1M rows)",
                    "plan outside map", "outside approver not checked: CODEOWNERS unreadable",
                    "over the size limit", "over the size limit: kept whole by a person",
                    "coverage", "plan", "map stale", "replan: the planner did not say what it changed", "triage.size"
                ]
            }}]
        }),
    )
}

/// A running Build card: 3 slices (scenarios) and the budget used against its limits.
pub fn running_build_app() -> App {
    let task = task_json("bbbbbbbb2222", RUNNING_BUILD_TITLE, "implementing", "Build", json!({"running": true, "updatedAt": "2099-01-01T00:00:00.000Z", "spentUsd": 0.63}));
    open_card(
        task,
        json!({
            "stageRuns": [stage_run("r1", "triage", 1, "passed", 0.2), stage_run("r2", "implementing", 1, "running", 0.63)],
            "buildProgress": {
                "scenarios": [{"id": "S1", "state": "green"}, {"id": "S2", "state": "green"}, {"id": "S3", "state": "red"}],
                "budget": {"iterations": 4, "tokens": 52000, "minutes": 7.5, "limits": {"max_iterations": 12, "max_tokens": 400000, "max_minutes": 45.0}},
                "lastCheckpoint": {"sha": "9f3c2a1d5e", "follows": "green scenario"}
            }
        }),
    )
}

/// An escalated card: the machine's reason with its confidence, a summary and the tail of the failing output.
pub fn escalated_app() -> App {
    let task = task_json("cccccccc3333", ESCALATED_TITLE, "escalated", "Build", json!({"reason": "the build budget is spent: 12 of 12 iterations, 3 consecutive reds", "retries": {"verify": 2, "e2e": 0, "ci": 0, "total": 2}}));
    open_card(
        task,
        json!({
            "stageRuns": [stage_run("r1", "implementing", 1, "failed", 1.1), stage_run("r2", "implementing", 2, "failed", 1.4)],
            "approvals": [{"id": "e1", "kind": "escalated", "decision": null, "createdAt": "2026-10-22T10:00:00Z", "requested": {
                "escalationDecision": {"reason": "too_complex", "confidence": 0.82, "source": "decision", "agentReason": "too_complex"},
                "summary": "The session table migration cannot run twice; the test seeds rows the migration rejects.",
                "outputTail": "FAIL migrate.test.ts\n  expected 3 rows, received 2\n  at migrate (src/sessions/migrate.ts:41)\nTests: 1 failed, 11 passed"
            }}]
        }),
    )
}

/// A ship-stage card: the watched PR, the evidence artifacts and the verify findings.
pub fn ship_stage_app() -> App {
    let pack = json!({"verdict": "pass", "artifactCount": 3, "summary": "The limiter answers 429 past the limit.",
        "diffSummary": {"what": "Rate limits the public API per key with a sliding window.", "why": "C2: one client must not starve the rest.", "files": ["src/limit.ts"], "added": 42, "removed": 3}});
    let task = task_json("dddddddd4444", SHIP_STAGE_TITLE, "awaiting_ship", "Ship", json!({"waitingOnYou": true, "evidence": pack}));
    open_card(
        task,
        json!({
            "stageRuns": [stage_run("r1", "verifying", 1, "passed", 0.5), stage_run("r2", "evidence", 1, "passed", 0.3)],
            "artifacts": [
                {"id": "a1", "kind": "screenshot", "path": "/out/files/limit-429.png", "label": "429 after the limit", "stageRunId": "r2"},
                {"id": "a2", "kind": "log", "path": "/out/files/verify.log", "label": "verify", "stageRunId": "r1"},
                {"id": "a3", "kind": "report", "path": "/out/files/evidence.md", "label": "evidence pack", "stageRunId": "r2"}
            ],
            "reports": {"verify": {"findings": [
                {"severity": "should_fix", "title": "the limiter keys on the proxy address", "path": "src/limit.ts", "line": 31},
                {"severity": "nit", "title": "name the window constant", "path": "src/limit.ts", "line": 8}
            ]}},
            "ship": {
                "pr": {"number": 412, "url": "https://github.com/acme/app/pull/412"}, "head": "9f3c2a1", "ready": false,
                "checklist": [{"id": "checks", "ok": true, "detail": "12 of 12 passed"}, {"id": "review", "ok": false, "detail": "waiting for a reviewer"}],
                "autoMerge": {"allowed": false, "reason": "review is required"}, "review": {"required": true, "by": "platform"}, "fixRounds": 1
            }
        }),
    )
}

/// A card at the ship gate as the machine sends it: `requested.evidence` is the cut-down object (`format`, `summary`, `media`, `commitSha`,
/// `risk`; no `diffSummary`, no scenarios), the whole pack is `task.evidence`. With `preview` the gate carries the whole pack as `requested.pack`
/// instead and the task has none yet.
pub fn real_ship_gate_app(preview: bool) -> App {
    let pack = json!({"verdict": "pass", "artifactCount": 3, "summary": "The limiter answers 429 past the limit.", "format": "markdown", "scenarios": [], "results": [],
        "diffSummary": {"what": "Rate limits the public API per key with a sliding window.", "why": "C2: one client must not starve the rest.", "files": ["src/limit.ts"], "added": 42, "removed": 3}});
    let trimmed = json!({"format": "markdown", "summary": "The limiter answers 429 past the limit.", "media": [], "commitSha": "9f3c2a1", "risk": "medium"});
    let extra = if preview { json!({"waitingOnYou": true}) } else { json!({"waitingOnYou": true, "evidence": pack.clone()}) };
    let task = task_json("dbdbdbdb4444", SHIP_STAGE_TITLE, "awaiting_ship", "Ship", extra);
    let mut requested = json!({"gate": "ship_approval", "head": "9f3c2a1", "prUrl": "https://github.com/acme/app/pull/412", "number": 412, "risk": "medium",
        "question": "safe to release now?", "checklist": [{"id": "ci", "ok": true, "detail": "CI green on 3 of 3 checks"}], "evidence": trimmed});
    if preview {
        requested["pack"] = pack;
    }
    open_card(task, json!({"approvals": [{"id": "s1", "kind": "awaiting_ship", "decision": null, "createdAt": "2026-10-22T10:00:00Z", "requested": requested}]}))
}

/// A card at the triage questions: two questions, each with the machine's suggested answer.
pub fn questions_app() -> App {
    let task = task_json("eeeeeeee5555", "Fix the invoice rounding", "awaiting_answers", "Triage", json!({"waitingOnYou": true}));
    open_card(
        task,
        json!({"approvals": [{"id": "q1", "kind": "awaiting_answers", "decision": null, "createdAt": "2026-10-22T10:00:00Z", "requested": {
            "questions": [{"question": "Round half up or half to even?", "recommended": "half to even"}, {"question": "Which currency does the report use?", "recommended": "the account currency"}]
        }}]}),
    )
}

/// The release question for a high-risk card: the checklist as it was when asked.
pub fn release_question_app() -> App {
    let task = task_json("ffffffff6666", "Rotate the signing keys", "awaiting_ship", "Ship", json!({"waitingOnYou": true}));
    open_card(
        task,
        json!({"approvals": [{"id": "s1", "kind": "awaiting_ship", "decision": null, "createdAt": "2026-10-22T10:00:00Z", "requested": {
            "gate": "ship_approval", "risk": "high", "question": "safe to release now?",
            "checklist": [{"id": "ci", "ok": true, "detail": "CI green on 3 of 3 checks"}, {"id": "pack", "ok": true, "detail": "Evidence Pack complete"}]
        }}]}),
    )
}

/// The board with a card in every column: Intake to Done, a gate waiting on the person in Plan and in Ship, an
/// escalation in Build and four closed cards in Done. For the board's width tests.
pub fn full_board_app() -> App {
    let rows: [(&str, &str, &str, &str, Value); 13] = [
        ("a1", "Fix the typo in the onboarding email", "draft", "Intake", json!({})),
        ("a2", "Support dark mode in the dashboard charts", "draft", "Intake", json!({})),
        ("b1", "Rotate the signing keys", "triaging", "Triage", json!({"running": true, "updatedAt": "2099-01-01T00:00:00.000Z"})),
        ("c1", PLAN_GATE_TITLE, "awaiting_approval", "Plan", json!({"waitingOnYou": true})),
        ("d1", "Retry failed webhook deliveries with exponential backoff and a dead letter queue", "implementing", "Build", json!({"running": true, "updatedAt": "2099-01-01T00:00:00.000Z"})),
        ("d2", ESCALATED_TITLE, "escalated", "Build", json!({"reason": "build budget spent"})),
        ("e1", "Paginate the audit log", "verifying", "Verify", json!({"running": true, "updatedAt": "2099-01-01T00:00:00.000Z"})),
        ("f1", "Cache the pricing lookups", "evidence", "Evidence", json!({"running": true, "updatedAt": "2099-01-01T00:00:00.000Z"})),
        ("g1", SHIP_STAGE_TITLE, "awaiting_ship", "Ship", json!({"waitingOnYou": true})),
        ("h1", "Upgrade the queue client", "closed", "Done", json!({})),
        ("h2", "Drop the legacy export route", "closed", "Done", json!({})),
        ("h3", "Fix the flaky session test", "closed", "Done", json!({})),
        ("h4", "Document the retry policy", "closed", "Done", json!({})),
    ];
    let mut app = App::new(dead_machine());
    app.tasks.clear();
    for (i, (key, title, state, column, extra)) in rows.into_iter().enumerate() {
        let id = format!("{key}{:010}", i);
        let task: Task = serde_json::from_value(task_json(&id, title, state, column, extra)).unwrap();
        app.tasks.push(task);
    }
    app
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fixture_talks_to_the_dead_machine_and_never_to_the_environment() {
        for app in [plan_gate_app(), running_build_app(), escalated_app(), ship_stage_app(), questions_app(), release_question_app(), full_board_app()] {
            assert_eq!(app.machine.base(), DEAD_MACHINE);
        }
    }

    #[test]
    fn the_plan_gate_card_renders_its_title() {
        let mut app = plan_gate_app();
        assert!(render(&mut app, 120, 40).contains(PLAN_GATE_TITLE));
    }

    #[test]
    fn the_running_build_card_renders_its_title() {
        let mut app = running_build_app();
        assert!(render(&mut app, 120, 40).contains(RUNNING_BUILD_TITLE));
    }

    #[test]
    fn the_escalated_card_renders_its_title() {
        let mut app = escalated_app();
        assert!(render(&mut app, 120, 40).contains(ESCALATED_TITLE));
    }

    #[test]
    fn the_ship_stage_card_renders_its_title() {
        let mut app = ship_stage_app();
        assert!(render(&mut app, 120, 40).contains(SHIP_STAGE_TITLE));
    }

    #[test]
    fn the_fixtures_carry_the_data_the_task_view_will_show() {
        let mut app = plan_gate_app();
        let screen = render(&mut app, 180, 50);
        for needle in ["Add the CSV writer", "▸ Code map  5 files", "plan flag"] {
            assert!(screen.contains(needle), "{needle} missing in\n{screen}");
        }
        let mut app = running_build_app();
        assert!(render(&mut app, 120, 50).contains("4 of 12"));
        let mut app = escalated_app();
        assert!(render(&mut app, 120, 50).contains("82% sure"));
        let mut app = ship_stage_app();
        assert!(render(&mut app, 120, 50).contains("waiting for a reviewer"));
    }

    #[test]
    fn a_hostile_title_is_clean_on_the_board_and_in_the_popup() {
        let hostile = "A\u{1b}[31mB\rC\u{7}D\u{202e}E\u{200b}F";
        let mut app = plan_gate_app();
        app.tasks[0].title = hostile.into();
        let board = {
            app.mode = crate::app::Mode::Normal;
            render(&mut app, 120, 40)
        };
        assert!(board.contains("A [31mB C D E F"), "{board}");
        app.open_detail(app.tasks[0].id.clone());
        let popup = render(&mut app, 120, 40);
        assert!(popup.contains("A [31mB C D E F"), "{popup}");
        for bad in ['\u{1b}', '\r', '\u{7}', '\u{202e}', '\u{200b}'] {
            assert!(!board.contains(bad) && !popup.contains(bad), "{bad:?} reached the screen");
        }
    }
}
