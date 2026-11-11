//! The task view's first pages, one per job: Review at the plan gate, Now while a stage runs, Why it stopped,
//! Result, and the page of a gate that asks a question. Each is a main text and its reference groups.

use ratatui::text::{Line, Span};
use serde_json::Value;

use crate::{
    detail::{assumptions_group, card_group, checks_group, gate_main_facts, gate_ref_group, map_group, muted, plain, record_group},
    model::{Approval, Task, TaskDetail},
    reference::{Page, RefGroup},
    text::{self, ellipsis, truncate_middle},
    theme,
};

/// A heading line of a page: bold in the terminal's own colour.
fn title(text: &str) -> Line<'static> {
    Line::from(Span::styled(text.to_string(), theme::heading()))
}

/// `prefix` then `text` wrapped under itself: the first line starts with the prefix spans, the rest with as many spaces.
fn hanging(prefix: Vec<Span<'static>>, text: &str, width: usize) -> Vec<Line<'static>> {
    let used: usize = prefix.iter().map(|s| text::cells(&s.content)).sum();
    let parts = text::wrap(&plain(text), width.saturating_sub(used).max(10), 0);
    let mut out = Vec::new();
    for (i, part) in parts.into_iter().enumerate() {
        let lead = if i == 0 { prefix.clone() } else { vec![Span::raw(" ".repeat(used))] };
        let mut spans = lead;
        spans.push(Span::raw(part.trim_start().to_string()));
        out.push(Line::from(spans));
    }
    out
}

/// A flag line: `⚑ ` and the words, in the flag style, wrapped under the glyph.
fn flag_line(text: &str, width: usize) -> Vec<Line<'static>> {
    text::wrap(&plain(text), width.saturating_sub(2).max(10), 0)
        .into_iter()
        .enumerate()
        .map(|(i, part)| Line::from(Span::styled(format!("{}{}", if i == 0 { "⚑ " } else { "  " }, part.trim_start()), theme::flag())))
        .collect()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(plain)).collect()).unwrap_or_default()
}

/// What the plan gate flags, one line each with the machine's reason where it gave one: the plan check's issues and the planner's
/// own flags, a coverage check's open notes and criteria excused as untestable, an unsure risk, a stale code map, a raised or
/// overridden risk, a triage field to correct. A flagged check with no reason is named: `⚑ plan check flagged`.
fn flags(approval: &Approval, width: usize) -> Vec<Line<'static>> {
    let r = &approval.requested;
    let mut out = Vec::new();
    let mut explained: Vec<&str> = Vec::new();
    let issues: Vec<String> = strings(&r["planIssues"]).into_iter().chain(strings(&r["plan"]["flags"])).collect();
    if !issues.is_empty() {
        explained.push("plan");
        for issue in &issues {
            out.extend(flag_line(&format!("plan: {issue}"), width));
        }
    }
    let coverage: Vec<String> = ["open", "gaps"].iter().flat_map(|k| strings(&r["coverageReport"][*k])).collect();
    if !coverage.is_empty() {
        explained.push("coverage");
        for note in &coverage {
            out.extend(flag_line(&format!("coverage: {note}"), width));
        }
    }
    for untestable in strings(&r["coverageReport"]["untestable"]) {
        out.extend(flag_line(&format!("excused as untestable: {untestable}"), width));
    }
    let named: Vec<String> = r["flagged"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|f| !f.starts_with("triage.")).map(plain).collect();
    let mut checks: Vec<(String, bool)> = approval.checks().into_iter().filter(|(_, v)| matches!(v.as_str(), "flag" | "ask")).map(|(n, v)| (n, v == "ask")).collect();
    for name in named {
        if !checks.iter().any(|(n, _)| *n == name) {
            checks.push((name, false));
        }
    }
    for (name, unsure) in checks {
        if !explained.contains(&name.as_str()) {
            out.extend(flag_line(&if unsure { format!("{name} check is unsure") } else { format!("{name} check flagged") }, width));
        }
    }
    for field in r["flagged"].as_array().into_iter().flatten().filter_map(Value::as_str).filter_map(|f| f.strip_prefix("triage.")) {
        out.extend(flag_line(&format!("triage {} flagged · T corrects the record", plain(field)), width));
    }
    if r["map"]["stale"].as_bool() == Some(true) {
        let behind = r["map"]["behind"].as_u64().map_or("many".to_string(), |n| n.to_string());
        out.extend(flag_line(&format!("the code map's graph is {behind} commits behind the default branch"), width));
    }
    if let Some(line) = approval.risk_raised_line() {
        out.extend(flag_line(&format!("risk raised: {line}"), width));
    }
    if let Some(line) = approval.risk_override_line() {
        out.extend(flag_line(&line, width));
    }
    if r["keptWhole"].as_bool() == Some(true) {
        out.extend(flag_line("kept whole: you chose not to split this plan", width));
    }
    out
}

/// One of the plan's scenarios, read off the gate's cases.
struct Scenario {
    id: String,
    kind: String,
    layer: String,
    title: String,
    criterion: Option<String>,
}

impl Scenario {
    /// `S1 happy · unit`
    fn tag(&self) -> String {
        let mut tag = format!("{} {}", self.id, self.kind);
        if !self.layer.is_empty() {
            tag.push_str(&format!(" · {}", self.layer));
        }
        tag
    }
}

fn scenarios(detail: Option<&TaskDetail>) -> Vec<Scenario> {
    let Some(gate) = detail.and_then(TaskDetail::cases_approval) else { return Vec::new() };
    gate.requested["cases"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, c)| {
            Some(Scenario {
                id: c["id"].as_str().map_or(format!("S{}", i + 1), plain),
                kind: c["type"].as_str().map_or("happy".to_string(), plain),
                layer: c["layer"].as_str().map(plain).unwrap_or_default(),
                title: plain(c["title"].as_str()?),
                criterion: c["criterion"].as_str().map(str::to_string),
            })
        })
        .collect()
}

/// The criteria with their ids: the plan's own (`plan.acceptance_criteria`, `C1`…), else the gate's list numbered in order.
fn criteria(approval: &Approval, task: &Task) -> Vec<(String, String)> {
    let planned: Vec<(String, String)> = approval.requested["plan"]["acceptance_criteria"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| Some((c["id"].as_str().map(plain)?, plain(c["text"].as_str()?))))
        .collect();
    if !planned.is_empty() {
        return planned;
    }
    let listed = strings(&approval.requested["criteria"]);
    let listed = if listed.is_empty() { task.criteria.iter().map(|c| plain(c)).collect() } else { listed };
    listed.into_iter().enumerate().map(|(i, text)| (format!("C{}", i + 1), text)).collect()
}

/// The plan's steps: number, description, and what it touches. Falls back to the gate's slices.
fn steps(approval: &Approval, width: usize) -> Vec<Line<'static>> {
    let r = &approval.requested;
    let items = match r["plan"]["steps"].as_array().filter(|a| !a.is_empty()) {
        Some(steps) => steps,
        None => match r["slices"].as_array() {
            Some(slices) => slices,
            None => return Vec::new(),
        },
    };
    let mut out = vec![title("Steps")];
    for (i, step) in items.iter().enumerate() {
        let Some(text) = step["description"].as_str().or_else(|| step["title"].as_str()) else { continue };
        let number = format!("  {:<3}", i + 1);
        out.extend(hanging(vec![Span::styled(number, theme::label())], text, width));
        let files: Vec<String> = ["files", "touchpoints"].iter().flat_map(|k| strings(&step[*k])).collect();
        let shown: Vec<String> = files.iter().take(2).map(|f| truncate_middle(f, 36)).collect();
        let mut meta = Vec::new();
        if let Some(loc) = step["est_loc"].as_u64() {
            meta.push(format!("~{loc} lines"));
        }
        if !shown.is_empty() {
            meta.push(format!("{}{}", shown.join(", "), if files.len() > 2 { format!(" +{}", files.len() - 2) } else { String::new() }));
        }
        if !meta.is_empty() {
            out.push(Line::from(Span::styled(format!("     {}", ellipsis(&meta.join(" · "), width.saturating_sub(5))), theme::dim())));
        }
    }
    out
}

/// A short block with a title: nothing when `text` is empty.
fn block(name: &str, text: &str, width: usize) -> Vec<Line<'static>> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let mut out = vec![Line::default(), title(name)];
    out.extend(text::markdown(text, width, 2));
    out
}

/// The plan gate's page: what to look at first (flags), then the decision material (brief, criteria with their scenarios, steps, rollback),
/// with the triage record, risk, checks, code map, assumptions and the card's facts as reference.
pub(crate) fn review_page(task: &Task, detail: Option<&TaskDetail>, width: usize, ref_width: usize) -> Page {
    let Some(d) = detail else { return Page::of(vec![title("Review"), Line::default(), muted("  loading…".into())]) };
    let Some(approval) = d.latest_approval("awaiting_approval") else {
        return Page::of(vec![title("Review"), Line::default(), muted("  no plan yet: triage and the planner write one once the ticket starts".into())]);
    };
    let r = &approval.requested;
    let mut main = flags(approval, width);
    // What this gate is really asking when it is not the plan itself: a split, a reply, an archive.
    let ask = gate_main_facts(approval);
    if let Some(reply) = approval.reply() {
        main.extend(block("Reply (a posts it where the ticket came from and closes it)", &reply, width));
    }
    if approval.outcome() == Some("archive") {
        main.extend(block("Archive (a archives the ticket)", &approval.archive_reason().unwrap_or_else(|| "no reason given".into()), width));
    }
    if !ask.is_empty() {
        if !main.is_empty() {
            main.push(Line::default());
        }
        main.extend(ask);
    }
    if !main.is_empty() {
        main.push(Line::default());
    }
    main.push(title("Brief"));
    match r["brief"].as_str().filter(|b| !b.trim().is_empty()) {
        Some(brief) => main.extend(text::markdown(brief, width, 2)),
        None => main.push(muted("  (none)".into())),
    }

    let all = scenarios(detail);
    let mut long: Vec<(String, &Scenario)> = Vec::new();
    let rows = criteria(approval, task);
    if !rows.is_empty() {
        main.extend([Line::default(), title("Criteria")]);
    }
    for (id, text) in &rows {
        main.extend(hanging(vec![Span::raw("  "), Span::styled(format!("{id:<4}"), theme::label())], text, width));
        let mine: Vec<&Scenario> = all.iter().filter(|s| s.criterion.as_deref() == Some(text.as_str())).collect();
        let indent = Span::raw("      ");
        match mine.len() {
            0 => main.push(Line::from(vec![indent, Span::styled("⚑ no scenario", theme::flag())])),
            1..=2 => {
                for s in &mine {
                    main.extend(hanging(vec![indent.clone(), Span::styled(format!("{}  ", s.tag()), theme::label())], &s.title, width));
                }
            }
            n => {
                main.push(Line::from(vec![indent, Span::styled(format!("✓ {n} scenarios"), theme::label())]));
                long.extend(mine.into_iter().map(|s| (id.clone(), s)));
            }
        }
    }

    let steps = steps(approval, width);
    if !steps.is_empty() {
        main.push(Line::default());
        main.extend(steps);
    }
    let rollback = r["rollback"].as_str().or_else(|| r["plan"]["rollback"].as_str()).unwrap_or_default();
    main.extend(block("Rollback", rollback, width));
    let out_of_scope = strings(&r["plan"]["out_of_scope"]);
    if !out_of_scope.is_empty() {
        main.extend(block("Out of scope", &out_of_scope.iter().map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n"), width));
    }
    main.extend(block("Migration", r["plan"]["migration"].as_str().or_else(|| r["migration"].as_str()).unwrap_or_default(), width));
    if approval.names_needed() > 1 || approval.rule_line().is_some() {
        let given = approval.approvers();
        let names = if given.is_empty() { String::new() } else { format!(" ({})", plain(&given.join(", "))) };
        main.push(Line::default());
        main.push(Line::from(vec![Span::styled(format!("{:<11}", "Approvals"), theme::label()), Span::raw(format!("{} of {} given{names}", given.len(), approval.names_needed()))]));
    }

    let mut groups = Vec::new();
    groups.extend(gate_ref_group(approval, ref_width));
    groups.extend(record_group(task, r, ref_width));
    groups.extend(checks_group(approval));
    if !long.is_empty() {
        let lines: Vec<Line<'static>> = long
            .iter()
            .map(|(id, s)| Line::from(vec![Span::styled(format!("{id:<4}"), theme::label()), Span::raw(ellipsis(&format!("{}  {}", s.tag(), s.title), ref_width.saturating_sub(4)))]))
            .collect();
        groups.push(RefGroup::new("scenarios", "Scenarios", format!("{} listed", long.len()), lines));
    }
    groups.extend(map_group(r, ref_width));
    groups.extend(assumptions_group(r, ref_width));
    groups.push(card_group(task, detail, ref_width, crate::model::now_secs()));
    Page { main, groups }
}

#[cfg(test)]
mod tests {
    use crate::{
        detail::Section,
        testkit::{plan_gate_app, render},
    };

    fn open_review() -> crate::app::App {
        let mut app = plan_gate_app();
        app.detail_section = Section::Review;
        app
    }

    /// The main pane of a 180-column render: the screen's rows cut to the text between the rail and the side pane.
    fn main_pane(screen: &str) -> String {
        screen.lines().map(|r| r.chars().skip(17).take(94).collect::<String>().trim_end().to_string()).collect::<Vec<_>>().join("\n")
    }

    /// The rail's rows of a 180-column render of a card: the popup's left column, below its bar.
    fn rail_of(screen: &str) -> String {
        screen.lines().skip(8).take(14).map(|r| r.chars().skip(9).take(14).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn the_plan_gate_opens_on_review_with_flags_then_brief_criteria_steps_and_rollback_in_that_order() {
        let mut app = plan_gate_app();
        assert_eq!(app.detail_section, Section::Review);
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        let at = |needle: &str| main.find(needle).unwrap_or_else(|| panic!("no {needle:?} in\n{main}"));
        assert!(at("⚑ ") < at("Brief") && at("Brief") < at("Criteria") && at("Criteria") < at("Steps") && at("Steps") < at("Rollback"), "{main}");
        assert!(main.contains("⚑ plan: step 3 names a file outside the code map"), "the flag carries the plan check's reason\n{main}");
        assert!(main.contains("  • the endpoint streams rows"), "the brief goes through the markdown renderer\n{main}");
        for gone in ["Criteria to build", "Slices", "Outcome", "Checks", "Code map"] {
            assert!(!main.contains(gone), "{gone} belongs to the reference, not the first page\n{main}");
        }
    }

    #[test]
    fn at_180x50_the_first_page_holds_the_flags_the_brief_the_criteria_and_the_steps() {
        let mut app = plan_gate_app();
        let main = main_pane(&render(&mut app, 180, 50));
        for want in ["⚑ plan:", "Brief", "Criteria", "C5  a person without access", "Steps", "4  Add the export button"] {
            assert!(main.contains(want), "{want} is on the first screen\n{main}");
        }
    }

    #[test]
    fn each_criterion_is_printed_once_with_its_scenarios_under_it() {
        let mut app = open_review();
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        for text in ["exports every column the report shows", "escapes commas, quotes and newlines", "a person without access gets a 403"] {
            assert_eq!(main.matches(text).count(), 1, "{text} appears once in the main pane\n{main}");
        }
        let c1 = main.lines().position(|l| l.contains("C1  exports every column")).expect("C1 row");
        let rows: Vec<&str> = main.lines().collect();
        assert!(rows[c1 + 1].contains("S1 happy · unit  case 1 proves criterion 1"), "{}", rows[c1 + 1]);
        assert!(rows[c1 + 2].contains("S6 failure · integration  case 6 proves criterion 1"), "{}", rows[c1 + 2]);
        let c2 = rows.iter().position(|l| l.contains("C2  escapes commas")).unwrap();
        assert!(rows[c2 + 1].contains("S2 happy · integration"), "{}", rows[c2 + 1]);
    }

    #[test]
    fn a_criterion_with_no_scenario_says_so_and_one_with_many_folds_them_into_a_reference_group() {
        let mut app = open_review();
        {
            let d = app.detail.as_mut().unwrap();
            let gate = d.approvals.iter_mut().find(|a| a.kind.as_deref() == Some("awaiting_test_check")).unwrap();
            let cases = gate.requested["cases"].as_array_mut().unwrap();
            cases.retain(|c| c["criterion"] != "a person without access gets a 403");
            for n in 0..2 {
                cases.push(serde_json::json!({"id": format!("X{n}"), "title": format!("extra {n}"), "criterion": "escapes commas, quotes and newlines", "type": "edge", "layer": "unit"}));
            }
        }
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        let c5 = main.lines().position(|l| l.contains("C5  a person without access")).unwrap();
        assert!(main.lines().nth(c5 + 1).unwrap().contains("⚑ no scenario"), "{main}");
        let c2 = main.lines().position(|l| l.contains("C2  escapes commas")).unwrap();
        assert!(main.lines().nth(c2 + 1).unwrap().contains("✓ 3 scenarios"), "{main}");
        assert!(screen.contains("Scenarios"), "the full list is a reference group\n{screen}");
        assert!(!main.contains("extra 0"), "the scenario titles stay out of the main pane\n{main}");
    }

    #[test]
    fn steps_come_with_their_size_and_files_and_the_rest_of_the_plan_stays_short() {
        let mut app = open_review();
        let screen = render(&mut app, 180, 60);
        let main = main_pane(&screen);
        let step = main.lines().position(|l| l.contains("2  Add GET /api/reports/:id/export.csv")).expect("step 2");
        assert!(main.lines().nth(step + 1).unwrap().contains("~120 lines · src/reports/api.ts"), "{main}");
        for want in ["Rollback", "Revert the commit; the export route owns no data.", "Out of scope", "XLSX export", "Migration", "none needed"] {
            assert!(main.contains(want), "{want} missing in\n{main}");
        }
        assert!(!main.contains("Approvals"), "a plan one name may approve has no approvers line: {main}");
    }

    #[test]
    fn outcome_risk_and_checks_are_in_the_reference_and_the_rail_has_review_in_place_of_plan_and_tests() {
        let mut app = open_review();
        let screen = render(&mut app, 180, 60);
        for want in ["Outcome    plan", "Risk       medium", "✓ coverage proceed", "⚑ plan flag", "▸ Code map  5 files"] {
            assert!(screen.contains(want), "{want} missing in\n{screen}");
        }
        let rail = rail_of(&screen);
        assert!(rail.contains("Review"), "{rail}");
        assert!(!rail.contains("Plan") && !rail.contains("Tests"), "Plan and Tests are not sections at this gate\n{rail}");
    }

    #[test]
    fn a_narrow_review_still_leads_with_the_flags_and_folds_the_reference_under_the_text() {
        let mut app = open_review();
        let screen = render(&mut app, 100, 80);
        let at = |needle: &str| screen.find(needle).unwrap_or_else(|| panic!("no {needle:?} in\n{screen}"));
        assert!(at("⚑ plan: step 3") < at("Brief") && at("Steps") < at("── reference") && at("── reference") < at("▸ Code map"), "{screen}");
    }

    #[test]
    fn after_the_gate_is_passed_the_rail_shows_plan_and_tests_again() {
        let mut app = plan_gate_app();
        app.tasks[0].state = "implementing".into();
        app.detail.as_mut().unwrap().task.state = "implementing".into();
        app.detail_section = Section::Plan;
        let screen = render(&mut app, 180, 60);
        let rail = rail_of(&screen);
        assert!(rail.contains("Plan") && rail.contains("Tests") && !rail.contains("Review"), "{rail}");
    }
}

#[cfg(test)]
mod approver_tests {
    use crate::{
        detail::Section,
        testkit::{plan_gate_app, render},
    };

    #[test]
    fn a_plan_that_needs_two_names_says_how_many_have_given_theirs_in_one_line() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Review;
        let gate = app.detail.as_mut().unwrap().approvals.iter_mut().find(|a| a.requested["lane"].is_string()).unwrap();
        gate.requested["approvalRule"] = serde_json::json!({"needed": 2, "outside": "required", "text": "Needs 2 approvers."});
        gate.requested["approvers"] = serde_json::json!(["ana"]);
        let screen = render(&mut app, 180, 60);
        assert!(screen.contains("Approvals  1 of 2 given (ana)"), "{screen}");
    }

    #[test]
    fn a_flagged_check_with_no_reason_is_named_and_a_plan_with_no_flags_has_no_flag_block() {
        let mut app = plan_gate_app();
        app.detail_section = Section::Review;
        {
            let gate = app.detail.as_mut().unwrap().approvals.iter_mut().find(|a| a.requested["lane"].is_string()).unwrap();
            gate.requested["planIssues"] = serde_json::json!([]);
        }
        let screen = render(&mut app, 180, 60);
        assert!(screen.contains("⚑ plan check flagged"), "{screen}");
        {
            let gate = app.detail.as_mut().unwrap().approvals.iter_mut().find(|a| a.requested["lane"].is_string()).unwrap();
            gate.requested["verdicts"] = serde_json::json!({"coverage": "proceed", "plan": "proceed", "risk": "proceed"});
            gate.requested["flagged"] = serde_json::json!([]);
        }
        let screen = render(&mut app, 180, 60);
        let main: String = screen.lines().skip(8).map(|r| r.chars().skip(17).take(94).collect::<String>()).collect::<Vec<_>>().join("\n");
        assert!(!main.contains("⚑ plan") && !main.contains("check flagged"), "{main}");
    }
}
