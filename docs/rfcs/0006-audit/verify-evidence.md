# Diagram v2.2 vs code: ⑤ Verify and ⑥ Evidence

- Diagram: `the v2.2 diagram's Mermaid source`, lines 558-631 (Verify) and 632-710 (Evidence).
- Code: `the repository root` (head `5c4fd1e`). Every path in the table is relative to that root.
- Design record: `docs/rfcs/0005-software-factory-v1-5.md` (cited as "RFC"). The RFC was written against the v1.5 diagram; v2.2 elements it never mentions are counted as gaps, not deviations.
- Read only: no tests were run, nothing was executed against a live task.

## Counts

| Status | ⑤ Verify | ⑥ Evidence | Total |
|---|---|---|---|
| MATCH | 16 | 22 | 38 |
| PARTIAL | 16 | 17 | 33 |
| MISSING | 12 | 9 | 21 |
| DIFFERENT | 6 | 7 | 13 |
| DEVIATION (recorded in the RFC) | 7 | 8 | 15 |
| Total | 57 | 63 | 120 |

## Top gaps by impact

1. **Verify does not run in a fresh sandbox** (V2, V3, V5). Checks and review run in new containers but over the implementer's own host worktree; nothing is cloned at the head SHA, there is no `env_hash`, and no env finding. "Works on the builder's tree" is never tested. `machine/src/application/stages/pack-runner.ts:159-161`, `verify.ts:139-140`.
2. **An e2e or Evidence failure goes back to Build with nothing attached** (V52, V40, E63). `latestVerifyingFindings` reads only `verifying`, `ci_watch` and failed `implementing` events, so after a failed browser run the implementer is handed the last Verify pass's leftover findings and no word about the failed scenarios or the cause. `machine/src/application/pipeline.ts:1612-1626`.
3. **No preview deploy, no start/seed config, no preview URL on the task** (V22, V23, V29, V30, V31, E19, E43). E2E drives a static `qa_targets[]` URL shared by every task, or a dev server the agent guesses from `package.json`. `contracts/src/stage.ts:412-425`, `factory/prompts/e2e.md:26`.
4. **The video is never screened for secrets or personal data** (E29). Frames are sampled into contact sheets, but neither the critic's prompt, role or skill nor the measure job looks for them; the RFC's own critic row asks for it. `factory/prompts/video_qa.md`, `machine/runner-video/tools/lib/measure.ts:89-112`.
5. **PRs always target the default branch** (V43). No `card.base`, so a stacked task opens against `main` and its diff shows the parent's changes too. `machine/src/adapters/github/octokit.ts:357-361`.
6. **Two Build rounds per loop, not one** (V24). `LOOP_CAP = 3` per loop (verify, e2e, ci), so a person is asked on the third failure; none of the four limits is configurable. `machine/src/domain/transition.ts:7, 125-131`.
7. **The Finding schema is the old review-contract shape** (V10, V13). No `id`, `criterion_ref` or `category`; severity is free text; duplicates are never merged; `finding_classify` sees only the six most confident. `contracts/src/stage.ts:80-92`, `verify.ts:60, 343-345`.
8. **The reviewer is the same model family as the implementer, and is not kept from its trail** (V6, V7, V8). `verifying` is `only("claude:opus")`; another family is only the optional `second-opinion` helper. The task's shared SDK session dir is mounted in the verifier's container and the pack is granted `slice_list`; the Triage Record is never rendered into its prompt. `contracts/src/packs.ts:731-741`, `pack-runner.ts:245-246, 326`, `factory/prompts/verifying.md`.
9. **The draft PR body carries almost none of the template** (V44). Title, Why, Criteria, `Closes #N`, Jira link; no record link, plan version, scenarios ↔ tests, findings, out-of-map files, preview URL, card link or markers until Ship publishes the Evidence section. `machine/src/domain/prbody.ts:26-41`.
10. **Evidence Pack is missing `results{unit, integration, e2e, coverage_delta}`, finding resolutions, `preview_url`, `local_path` and `version`** (E41-E45), and there is no Verify Report contract to take them from (V57). `contracts/src/stage.ts:583-611`.

Also notable: no mutation testing (V19, V21); no typed judge per e2e step and no blast-radius E2E suite (V33, V35); CI watch polls every 30 s with no webhook (V45); TTS voice and language are not configurable (E16); captures need a browser run, so an API or CLI change gets text only (E6, E9); no reviewer thumbs or edited-section capture (E59); none of the nine `verify.*` / `ci.status` / `evidence.*` event names exist (V55, E60); retention defaults to 90 days, not 180 (E37).

## Misunderstandings (built, and contradicts the diagram, with no RFC record)

- **Order of Verify** (V16): the project's checks run first and a red check ends the stage before any review; the diagram reviews first and runs the suite only when there is no blocker.
- **"One round, then escalate"** read as a three-failure cap (V24).
- **Evidence format criteria** (E6): the diagram sends an API or CLI change to `screenshots_or_terminal`; the code's `text` label is "no user-visible surface: an API, a library, docs, data, infrastructure".
- **"Pack complete? no → fix sections"** (E58): an incomplete pack fails Ship and asks a person; nothing repairs it.
- **A flake that stays red after its re-run** goes to Build as `fixable` (V51, `ci.ts:232`), where the diagram's human node lists "2nd flake".
- **Evidence can fail back to Build** (E63) although the stage is drawn as "degrade, never block".

## ⑤ Verify

| # | Diagram element (quote the key words) | Status | Evidence (path:line) | Note |
|---|---|---|---|---|
| V1 | ENTRY "Build Report (branch · SHA · env_hash · diff summary · declared files · tests)" | PARTIAL | contracts/src/packs.ts:144-158; machine/src/application/stages/verify.ts:136-140 | No Build Report contract. Verify reads `task.branch` and `task.worktreePath`; the implementing answer has `commit`, `diffSummary`, `outOfMap[]`. No `env_hash` anywhere (grep over machine/, contracts/, factory/: none). |
| V2 | "Fresh sandbox from branch · state: verifying" · "new box · clone at head SHA" | DIFFERENT | machine/src/application/stages/pack-runner.ts:159-161, 330; verify.ts:139-140, 195-201; machine/src/bootstrap/stages.ts:116 | State `verifying` exists. Each check and the review get a new container, but both mount the implementer's own host worktree; nothing is cloned at the head SHA. No RFC record. |
| V3 | "rebuild from env_hash" | MISSING | none | No environment hash, no rebuild step. |
| V4 | "Playwright + browsers pre-installed" | PARTIAL | machine/runner-qa/Dockerfile:9-18; pack-runner.ts:328 | Only the QA image (e2e, recording) has Playwright 1.63.0 and Chromium; the verifying container is the base runner image. |
| V5 | "env_hash mismatch or build failure → finding (severity: blocker, cause: env)" | MISSING | verify.ts:207-216; contracts/src/stage.ts:492 | Closest: exit 127 (a tool missing from the image) escalates to a person. No env finding, no `cause` on Finding. `EscalationReason` has `env_broken`, which no machine code or prompt sets. |
| V6 | Reviewer policy "different model family than the implementer when available, else same family with fresh context" | DEVIATION | contracts/src/packs.ts:721, 731, 741; docs/configuration.md:7 | `verifying` is `only("claude:opus")`; the implementer is `claude:sonnet`, or opus itself on the stronger retry. Another family reviews only as the `second-opinion` helper on `codex:sol`, left out with a note when the Codex login is missing. RFC ⑤: "The `verifier` keeps the second opinion." Not a config. |
| V7 | "no access to implementer reasoning or iteration log" | PARTIAL | machine/src/domain/stage-input.ts:177-179; pack-runner.ts:238, 245-246, 326; machine/src/adapters/docker/docker.ts:148; packs.ts:735; factory/prompts/verifying.md:40 | The ledger goes only to implementing and reviewing_memory, and the run is a new session. But the per-task SDK session dir (every stage's transcripts) is mounted at `/session` in the verifier's container, the pack is granted `slice_list`, and the prompt points at "slice commits". Guards keep tool paths to /work, /out and scratch (factory/src/core/guards.ts:497-498); whether that fully closes `/session` was not verified. |
| V8 | "sees: diff · plan · scenarios · Triage Record · Graphify" | PARTIAL | factory/prompts/verifying.md:5-25, 40; stage-input.ts:144; pack-runner.ts:343 | Diff (git), plan brief/criteria/assumptions, scenarios, blast radius and the `/graph` mount: yes. `task.record` is in the stage input but `verifying.md` has no `{{task.record}}`, so the verifier is never shown the Triage Record. |
| V9 | "LLM · Independent review" | MATCH | packs.ts:726-745; factory/roles/verifier/role.md:4-18 | It also writes and commits tests, which the diagram does not ask of it. |
| V10 | Finding schema "id · severity{blocker, should_fix, nit} · file:line · criterion_ref? · category{correctness, missing_criterion, security, error_handling, convention, performance} · description · suggested_fix" | DIFFERENT | contracts/src/stage.ts:80-92; verify.ts:75-76 | `{path, line, start_line?, side?, severity: string, title, body, suggestion_code?, confidence}`. No `id`, `criterion_ref` or `category`; severity is free text in the review-contract words (bug, security, test, perf, question, suggestion, nit), mapped to blocker/should_fix/nit only for calibration. No RFC record. |
| V11 | "Typed decision · Classify findings" | MATCH | packs.ts:479-489, 1017; verify.ts:295-324 | `finding_classify`, choice blocker/should_fix/nit. Only the six most confident findings are asked (verify.ts:60, 298). |
| V12 | "severity validation" (does it change the verdict?) | DEVIATION | verify.ts:294, 356-362 | No. Recorded as `detail.classified` and `detail.calibration`. RFC ⑤: "used to calibrate the verifier's own severities, not to override them"; wave 4: "no verdict changes". |
| V13 | "duplicates merged" | MISSING | verify.ts:343-345 | Findings are concatenated (`[...reviewed, ...coverageFindings]`); nothing deduplicates. |
| V14 | "confidence per finding" | MATCH | verify.ts:311 | |
| V15 | "Blockers?" yes → Build | MATCH | verify.ts:99-100, 356-362; machine/src/domain/transition.ts:351-353 | Fails on a `bug` or `security` finding at confidence ≥ 0.8, or a failed scenario result. |
| V16 | Order: review → classify → "Blockers?" → full suite | DIFFERENT | verify.ts:163-257 (checks), 326-331 (review) | Inverted: the project's checks run first and a red check fails the stage before any review. No RFC record. |
| V17 | "Full test suite · unit · integration · contract" | PARTIAL | verify.ts:171-184, 18, 20; machine/src/domain/checks.ts:8-15 | Runs `luna.yaml` `checks[]` whose `paths` match the change plus its blast radius, else detected test/lint/typecheck. No unit/integration/contract notion; not necessarily the full suite. 30-minute budget. |
| V18 | "coverage on touched files before vs. after" | DEVIATION | verify.ts:259-291; machine/src/domain/coverage.ts | Patch coverage of the added lines. RFC wave 4: "Nothing runs the suite on the base commit, so there is no 'before' number". |
| V19 | "optional mutation testing on new tests (config)" | MISSING | none | No tool, key or finding. |
| V20 | Config "coverage drop on touched files > 0.5% → finding" | DEVIATION | verify.ts:278-290 | Any uncovered added line in a file is a `test` finding at confidence 0.9; no threshold. Same RFC wave 4 bullet. |
| V21 | Config "mutation score < 0.6 → should_fix" | MISSING | none | |
| V22 | Config "e2e: project deploy{command, url_pattern, health_check, timeout 15 min}" | MISSING | contracts/src/stage.ts:412-425 | `qa_targets[]{name, url, credential, reentrant}`: a static URL. |
| V23 | Config "sandbox start{command, seed_script}" | MISSING | factory/prompts/e2e.md:26 | The agent picks `dev` or `start` from `package.json`; no config, no seed. |
| V24 | Config "one Build round per finding set, then escalate" | DIFFERENT | transition.ts:7, 9, 125-131 | `LOOP_CAP = 3` per loop (verify, e2e, ci): two Build rounds, a person on the third failure; `IMPLEMENTER_CAP = 6`. No RFC record. |
| V25 | Config "env_flake retry 1" | MATCH | machine/src/application/stages/e2e.ts:179-199 | |
| V26 | Config "CI flaky re-run 1" | MATCH | machine/src/application/stages/ci.ts:217-232 | |
| V27 | Config "auto-rebase 1" | PARTIAL | machine/src/application/stages/deliver.ts:70-87; ci.ts:163-180 | Once in Deliver and once more in CI watch (RFC ⑤ says so). None of the four limits in this block is configurable. |
| V28 | "Green and no coverage drop?" no → Build | PARTIAL | verify.ts:231-257, 278-290 | A red check fails to Build. Coverage never fails the stage (RFC wave 4: "it never fails the stage by itself"). |
| V29 | "Project has ephemeral deploy?" | DIFFERENT | e2e.ts:119-130 | The gate asked is: `qa` not `none`, a web surface, and a change that touches a rendered file; else e2e is skipped with a reason. |
| V30 | "Deploy preview per card · project's own deploy · wait for health check · preview URL stored on the card" | MISSING | none (grep preview_url, previewUrl, health_check: none) | |
| V31 | "Start app in sandbox · start command · seed script (synthetic data only) · local URL" | PARTIAL | factory/prompts/e2e.md:26; factory/roles/qa-validator/role.md:10 | With no QA target the agent boots the dev server in the QA container. No seed script, no synthetic-data rule. State `e2e` matches. |
| V32 | "per scenario: LLM turns given/when/then into Playwright steps · runs them" | MATCH | factory/plugin/skills/playwright-qa/SKILL.md:26-50; factory/prompts/e2e.md:8-9, 28; packs.ts:746-761 | agent-browser is the fallback driver. |
| V33 | "typed judge per step pass/fail" | MISSING | factory/prompts/e2e.md:30; packs.ts:172-183 | The QA agent scores each scenario itself; Playwright asserts per `test.step`. No decision pack per step. The RFC lists "E2E judged per step" as the diagram's ask (line 42) and designs nothing for it. |
| V34 | "artifacts: trace · screenshots · console logs per scenario" | PARTIAL | playwright-qa/SKILL.md:60-65; qa-validator/role.md:35-41 | Per-scenario `trace-<id>.zip`, `console-<id>.log` and video on the Playwright driver; one `console.log` and a HAR, no trace, on agent-browser. |
| V35 | "plus blast-radius E2E suite" | MISSING | verify.ts:173-174 | Only the approved scenarios are driven. Blast radius widens Verify's check selection, not an E2E suite. |
| V36 | "All pass?" no → Failure cause | MATCH | e2e.ts:175-178 | |
| V37 | "Typed decision · Failure cause · product_bug · test_bug · env_flake · confidence" | MATCH | packs.ts:492-502, 1018; e2e.ts:153-173 | Below the bar it is read as `product_bug` (RFC appendix). |
| V38 | "evidence (trace ref)" | MISSING | packs.ts:492-502; contracts/src/stage.ts:571-578 | A choice and a confidence; the context is the failed rows; no artifact reference in or out. |
| V39 | "env_flake → retry once" | MATCH | e2e.ts:179-186 | Empties `runs/<id>/out` first. |
| V40 | "product_bug · test_bug" → Build | PARTIAL | e2e.ts:179; transition.ts:355-358 | It goes to Build, but see V52: the failure is not attached. |
| V41 | "2nd flake" → Human | MATCH | e2e.ts:187-199 | `escalation: "flaky_tests"`. |
| V42 | "Open PR · state: delivering · draft PR" | MATCH | deliver.ts:60-66, 91 | |
| V43 | "base = card.base (stacked PRs target the parent's branch, diff shows only the child)" | MISSING | machine/src/adapters/github/octokit.ts:357-361; machine/src/application/github.ts:136 | The base is always the repo's default branch; `NewPr` has no base and the task has none. |
| V44 | "body from template: summary · Triage Record link · plan version · scenarios ↔ tests · findings and resolutions · declared out-of-map files · preview URL · card link · markers for Evidence section" | PARTIAL | machine/src/domain/prbody.ts:26-41; machine/src/domain/evidence-markdown.ts:65-84 | Body is the title line, `## Why`, a `## Criteria` checklist, `Closes #N`, `Jira: <url>`. Scenarios, findings and out-of-map files only arrive with the Evidence section at Ship; the rest never. |
| V45 | "CI watch · state: ci_watch · GitHub checks via webhook, poll fallback 2 min" | DIFFERENT | ci.ts:77-78, 108-126 | Poll only, every 30 s, 45-minute cap; no webhook receiver. No RFC record. |
| V46 | "LLM reads failing job logs" | MATCH | ci.ts:55-68, 192 | A 20 000-character tail to the `ci_watch` pack. |
| V47 | "base moved → auto-rebase once" | PARTIAL | ci.ts:148-151, 164-180 | Only when GitHub says `CONFLICTING`, not whenever the base moved. |
| V48 | "conflict → attempt resolve once" | DEVIATION | ci.ts:167-169; deliver.ts:73-83 | A rebase that stops is aborted and escalates. RFC wave 4: "a rebase that stops is aborted and names the conflicted files … makes CI watch escalate with verdict `conflict_unresolvable`". |
| V49 | "CI green?" yes → exit | MATCH | ci.ts:185-189; transition.ts:363-365 | A PR with no checks configured also passes. |
| V50 | "Typed decision · CI failure class · flaky · infra · real · conflict_unresolvable · confidence · failing job ref" | DEVIATION | packs.ts:219-231, 842-860; ci.ts:192-215 | An agent pack (`ci-investigator`, sonnet, 30 turns): `fixable, flake, infra, needs_debug, green, conflict_unresolvable` and `runUrl`. No confidence, so no confidence policy applies. RFC ⑤: "`ci-investigator` gains `conflict_unresolvable`"; the decision appendix has no CI row. |
| V51 | "flaky → re-run once" · "real" → Build · "infra · conflict" → Human | MATCH | ci.ts:208-232 | A flake still red after its re-run goes to Build as `fixable` (ci.ts:232), not to a person. |
| V52 | "→ ④ BUILD · findings / failure attached" | PARTIAL | machine/src/application/pipeline.ts:1612-1626, 1649; factory/prompts/implementing.md:32-33 | Verify and CI findings reach the implementer as `priorFindings`. An e2e or Evidence failure does not: only `verifying`, `ci_watch` and failed `implementing` events are read. |
| V53 | "Human · luna-tui item · infra · unresolvable conflict · 2nd flake · 2nd round" | PARTIAL | transition.ts:112-116, 127-129; ci.ts:152-162, 209-214 | `escalated` with a reason and options. "2nd round" is the third failure (V24). |
| V54 | "Capture ground truth · findings the human dismissed or added · failure causes corrected" | DEVIATION | e2e.ts:185; machine/src/application/stages/evidence.ts:413-427; machine/src/application/decision-truth.ts:30, 38 | Machine facts only: the e2e re-run labels `e2e_failure_cause`; a ship approval that kept a finding labels it "not a blocker". No way to dismiss or add a finding or correct a cause; nothing for CI class. RFC wave 7: "Truth is written by the machine when a fact settles it, and only then." |
| V55 | Events "verify.started · verify.findings · verify.e2e_done · pr.opened · ci.status · verify.done" | PARTIAL | pipeline.ts:1633, 1667, 1731; deliver.ts:91 | Only `pr.opened` exists by name. The rest are generic `stage.started`, `stage.note`, `stage.finished` carrying the stage. |
| V56 | Consumers "luna-tui · Tickets sync (in review + PR link) · metrics" | MATCH | machine/src/application/jira-sync.ts:140-149, 162-163; machine/src/adapters/http/replay.ts:8 | Jira gets "PR opened: <url>" and the `jira.on[state]` transition. |
| V57 | EXIT "Verify Report · PR number · head SHA · findings[] with resolutions · test results · coverage delta · E2E results + artifacts · env reproduction result · overrides[]" | PARTIAL | verify.ts:360-377; e2e.ts:138-149; deliver.ts:88-92 | No Verify Report contract: the facts sit in four `stage.finished` details. No head SHA, resolutions, env reproduction result or `overrides[]`. |

## ⑥ Evidence

| # | Diagram element (quote the key words) | Status | Evidence (path:line) | Note |
|---|---|---|---|---|
| E1 | ENTRY "Verify Report + Build Report + card (Triage Record · plan · scenarios)" | PARTIAL | machine/src/application/stages/evidence.ts:236-240 | Reads the task, the approvals, the latest `implementing` and `verifying` finishes and the e2e run folder; no report contracts (V1, V57). |
| E2 | "Collect proof · state: evidence · pull from the card, never regenerate" | MATCH | evidence.ts:75-176, 389-412; machine/src/domain/evidence-pack.ts:41-58 | Nothing is re-run. Not pulled: test results, coverage, a preview URL. |
| E3 | "Typed decision · Evidence format" | MATCH | contracts/src/packs.ts:505-515, 1020; evidence.ts:265-283 | A re-run keeps the previous pack's format (evidence.ts:265-267). |
| E4 | Labels "video · screenshots_or_terminal · text_only" | DEVIATION | contracts/src/stage.ts:585; packs.ts:509-513 | `video, captures, text`. RFC ⑥: "`choice` video/captures/text". |
| E5 | "video: UI/flow change + E2E ran on a running system" | MATCH | packs.ts:510; evidence.ts:300-310 | Plus a mechanical veto (image, recording or steps, a known re-entrant target), RFC wave 5. |
| E6 | "screenshots_or_terminal: API / CLI change" · "text_only: CI/CD · config · infra · pure refactor" | DIFFERENT | packs.ts:511-512; evidence.ts:311-314 | `captures` is "a user-visible change screenshots show well enough"; `text` is "no user-visible surface: an API, a library, docs, data, infrastructure". An API or CLI change gets text, and captures without a browser run is vetoed to text. Not in the RFC. |
| E7 | "output: format · reason · confidence" | PARTIAL | packs.ts:505-515; evidence.ts:277 | Choice and confidence; no reason field (RFC: "reasons as labels"). |
| E8 | "Text evidence · pack sections only · diff summary · test results · logs excerpt" | PARTIAL | evidence.ts:373; evidence-pack.ts:41-58 | A pack with no media. No diff summary, test results or log excerpt in it. |
| E9 | "Screenshots / terminal capture · request–response pairs · CLI recording · annotated · from E2E artifacts when available" | PARTIAL | evidence.ts:370-386 | Only the browser run's files: up to 30 screenshots, the stitched recording, the manifest and the HAR. No request–response capture, no terminal recording; Evidence produces nothing of its own. |
| E10 | "VIDEO PIPELINE · parallel sandboxes" · "run concurrently" | DEVIATION | machine/src/application/stages/video.ts:203-230 | Sequential: narrate → cards → recording → compose → measure. RFC wave 5: "**narration runs before recording** so the recorder holds each scene for its clip". The RFC body (line 88) still says the "two parallel agents … are kept". |
| E11 | "degrade, never block" | PARTIAL | evidence.ts:359-367; video.ts:99-103 | Any failure degrades to captures, except a usage limit, which fails the stage (evidence.ts:363). |
| E12 | "LLM · Video script · input: Triage Record goal + approved scenarios (not the diff)" | MATCH | factory/prompts/video_script.md:8-23; packs.ts:778-793 | Also the pack's facts, `steps.jsonl` and chapters; `/work` is readable, read-only. |
| E13 | "Script schema: intro{what was asked, why} · chapters[]{scenario_id, narration, look_at[], cta} · outro{how to verify}" | DEVIATION | packs.ts:188-197; machine/runner-video/tools/lib/timeline.ts:8-42 | `{script, timeline, facts[], durationEstimateS}`; the timeline has `scenes[]` of `card` (hook, chapter, end) or `demo`. No `look_at[]`; `cta` is a `texts[]` role. RFC table (line 94) and wave 5: "The timeline is ours". |
| E14 | "target ≤ 4 min" | MATCH | timeline.ts:45, 74; machine/runner-video/tools/compose.ts:31; machine/runner-video/tools/lib/measure.ts:97 | The prompt asks for 45 to 120 s (video_script.md:29). |
| E15 | "Agent A · Narration · TTS from script" | MATCH | machine/runner-video/tools/narrate.ts:45-68; video.ts:204 | A job with no model (RFC: "script, no model"). |
| E16 | "(voice + language in config)" | MISSING | narrate.ts:15; machine/runner-video/tools/speech.ts:9-10; video.ts:204 | The voice is the tool's default `af_heart`; the machine never passes `--voice`; the ASR model is English only. No `luna.yaml` key. |
| E17 | "intro slides from Triage Record" | PARTIAL | machine/runner-video/tools/cards.ts:30; machine/runner-video/cards/card.html:29-37; video.ts:206 | Hook, chapter and end cards rendered from the timeline the director wrote from the record. |
| E18 | "output: intro.mp4 + narration.wav + timings.json" | DIFFERENT | narrate.ts:53-73; compose.ts:42 | `narration/scene-<id>.norm.wav` per scene, `narration.json` (durations, words, captions), `cards/card-<id>.mp4`. |
| E19 | "Agent B · Recording · LLM writes Playwright script from scenarios → runs against preview URL" | PARTIAL | factory/prompts/recording.md:8-32; evidence.ts:292-294, 354 | Against the QA target; there is no preview URL. |
| E20 | "highlights · captions · CTA overlays · chapter markers" | PARTIAL | machine/runner-video/tools/fixture.ts:48-49, 58-71, 85-92 | `mark`, `caption`, `highlight`, `cursorTo`. No CTA overlay; no tool renders the timeline's `cta` texts (only validated: factory/plugin/skills/video-script/SKILL.md:36). |
| E21 | "output: recording.mp4 + chapters.json" | DIFFERENT | video.ts:216-224 | `recording.webm` and `timing.json` (marks). |
| E22 | "sandbox 1" · "sandbox 2" | MATCH | machine/src/application/video-jobs.ts:33-48; video.ts:108-124 | Tool jobs run with no network and no credential; the recorder is its own sub-run in the video image. |
| E23 | "Compose · deterministic (ffmpeg) · intro + recording aligned to timings · burn captions and CTAs · ≤ 4 min" | PARTIAL | compose.ts:30-45; machine/runner-video/tools/lib/compose-plan.ts:95 | Captions are burned; CTAs are not. |
| E24 | "output: evidence.mp4 · captions.vtt · chapters.json" | DIFFERENT | compose.ts:37-44; video.ts:310-317 | `walkthrough.mp4`, `captions.srt` and `captions.vtt`, `chapters.ffmeta` (embedded), `cover.jpg`, `meta.json`. The pack attaches the `.srt`, not the `.vtt`; no `chapters.json`. |
| E25 | "Typed decision · Video QA · output: pass · issues[] · confidence" | DEVIATION | packs.ts:209-216, 809-825; video.ts:240-264 | An agent pack `video_qa` (`claude:haiku`, `codex:sol` fallback): nine 1-10 scores, P0-P2 defects, `ship` or `one_more_pass`; no confidence. The host recomputes ship (every score ≥ 8, no P0, no measured FAIL). RFC table line 98 and wave 5. |
| E26 | "every approved scenario present" | MATCH | timeline.ts:77-78; video.ts:218-219; factory/prompts/video_qa.md:11-12 | |
| E27 | "duration ≤ budget" | MATCH | machine/runner-video/tools/lib/measure.ts:97 | |
| E28 | "audio present and in sync" | MATCH | lib/measure.ts:102-108; packs.ts:213; machine/runner-video/tools/measure.ts:112-115 | Loudness and true peak too; sync is the critic's score against the re-heard transcript. |
| E29 | "no secrets / PII on screen (frame sampling)" | MISSING | factory/prompts/video_qa.md; factory/roles/video-critic/role.md; lib/measure.ts:89-112 | Frames are sampled into contact sheets, but nothing looks for secrets or personal data (grep over the critic's prompt, role and skill: none). The RFC's own critic row asks for it (line 98). Only PR markdown text is redacted (machine/src/domain/evidence-markdown.ts:13-25). |
| E30 | "QA pass?" fail → "regenerate once · back to script with issues" | MATCH | video.ts:265-268, 296-305 | `video_fix` with the critic's P0 and P1 defects and the measured FAILs as cards. |
| E31 | "2nd fail → degrade" | MATCH | video.ts:297-300; evidence.ts:362-367 | To captures, with the scores kept on the pack. |
| E32 | Config "video budget 4 min" | PARTIAL | timeline.ts:45 | A constant, not config. |
| E33 | Config "regenerate 1× then degrade" | PARTIAL | video.ts:272-306, 190-193 | Hardcoded, plus one extra director round when the timeline breaks a rule. |
| E34 | Config "TTS voice/language" | MISSING | as E16 | |
| E35 | Config "storage target (release asset / object store)" | PARTIAL | machine/src/application/evidence-publish.ts:14, 84 | Release assets on a draft pre-release `luna-evidence` only; not configurable, no object-store adapter (RFC Q2, still open). |
| E36 | Config "path evidence/<card>/<sha>/" | MATCH | machine/src/application/evidence-store.ts:34-37 | Under the machine's state dir. |
| E37 | Config "retention 180 d" | DIFFERENT | contracts/src/stage.ts:436; machine/src/config.ts:194, 288; machine/src/main.ts:132-139 | `evidence.retention_days`, else `MACHINE_RETENTION_DAYS`, default 90. Local copies only: release assets are never swept (RFC wave 5). |
| E38 | Config "PR section markers for idempotent updates" | MATCH | evidence-markdown.ts:6-8, 101-118 | |
| E39 | "Evidence Pack · one schema, every card" | MATCH | contracts/src/stage.ts:583-611 | |
| E40 | "summary_for_humans · scenarios ↔ tests · declared_files[] · risk + rollback · how_to_verify · head_sha" | MATCH | contracts/src/stage.ts:584-593; evidence.ts:145-146 | Renamed: `summary`, `scenarios[]{text, test, result}`, `outOfMap[]`, `risk`, `rollback`, `howToVerify`, `commitSha` (RFC line 63). `test` is the manifest row's first evidence path, not a test name. |
| E41 | "results{unit, integration, e2e, coverage_delta}" | MISSING | contracts/src/stage.ts:583-611 | Only per-scenario results. Not in the RFC's schema either. |
| E42 | "findings + resolutions" | PARTIAL | contracts/src/stage.ts:587; evidence-pack.ts:47 | `findings: string[]` ("severity: title (path:line)"). No resolutions, though RFC line 63 says "`findings[]` with resolutions". |
| E43 | "preview_url" | MISSING | evidence.ts:297-299 | `howToVerify` holds the QA target's URL or "follow steps.md". |
| E44 | "media[]{type, url, local_path}" | PARTIAL | contracts/src/stage.ts:594; evidence.ts:383-386; evidence-publish.ts:108 | `{kind, label, url}`: `url` is the local path until Ship replaces it with the asset URL; never both. |
| E45 | "version" · exit "Evidence Pack v1" | MISSING | contracts/src/stage.ts:610 | An `at` timestamp only. |
| E46 | "Store media · upload to storage target · never into git history · local copy under evidence/<card>/<sha>/" | DEVIATION | evidence.ts:382; evidence-publish.ts:84-107; video.ts:114-121 | The local copy is made in Evidence; the upload happens at Ship, after the gate (RFC wave 5, quoted at E52). Never in git; a HAR is never uploaded. |
| E47 | "Publish · PR description: replace between markers" | MATCH | evidence-publish.ts:110-118 | Skipped when the body has under 2000 characters of room. |
| E48 | "PR comment with pack summary" | MATCH | evidence-publish.ts:120-126 | One upserted comment, the token's own. |
| E49 | "card attachment" | MATCH | evidence.ts:415-416 | `task.evidence` and `pack.json`, written in Evidence, before the gate. |
| E50 | "ticket comment via ⓪ Tickets sync" | PARTIAL | machine/src/application/jira-sync.ts:119-126, 140-148, 221-235 | Jira hears "PR opened", then a summary on merge (`task.shipped`) and on close. Nothing when the pack is published. |
| E51 | "mark PR ready for review" | MATCH | machine/src/application/stages/ship.ts:108 | Done in `shipping`. |
| E52 | WHEN: Publish sits inside ⑥, before the ship gate | DEVIATION | transition.ts:367-368, 250-251; ship.ts:55-58, 101-108 | Evidence ends at `awaiting_ship` with a draft PR and nothing on GitHub. After a person approves the preview, `shipping` pushes, runs `packComplete`, uploads, writes the body and the comment and marks the PR ready. RFC wave 5: "**Publishing happens at Ship, after the preview.** The ship gate shows the pack; approving it publishes." |
| E53 | "Typed decision · Pack complete?" | DEVIATION | evidence-pack.ts:60-73; ship.ts:55-56 | A script. RFC ⑥: "`pack_complete` is a script". |
| E54 | "all sections present" | MATCH | evidence-pack.ts:63-66 | |
| E55 | "head_sha = PR head" | MATCH | evidence-pack.ts:67; ship.ts:44-54 | Compared with the pushed worktree head; GitHub's view is only a note. |
| E56 | "media links resolve" | PARTIAL | evidence-pack.ts:68-71 | Local paths must exist; http URLs are not fetched, and the check runs before the upload, so published links are never checked. |
| E57 | "summary ≤ 200 words" | MISSING | evidence-pack.ts:31-39, 63 | Only non-empty. The summary is one machine-built sentence, so it cannot exceed the limit today. |
| E58 | "Complete?" no → "fix sections" | DIFFERENT | ship.ts:56; transition.ts:374 | An incomplete pack fails Ship, which asks a person ("ship failed"). Nothing repairs it. |
| E59 | "Capture ground truth · reviewer feedback on usefulness (luna-tui thumbs) · sections humans edit" | MISSING | evidence.ts:315, 331-332; evidence-publish.ts:112-116 | Only the shipped format labels `evidence_format`. A send-back note becomes a video fix card and is not kept as truth; no thumbs; a person's edit to the PR section is overwritten on republish. |
| E60 | Events "evidence.started · evidence.media_ready · evidence.published · evidence.stale" | MISSING | pipeline.ts:1633, 1731; video.ts:98 | Generic `stage.started` and `stage.finished` for `evidence`, `stage.note` lines "video: …", `task.shipped` on merge. Ship readiness reads the pack, not an event. |
| E61 | STALE "head_sha changes → evidence.stale → regenerate affected parts only" | PARTIAL | ship.ts:47-53; transition.ts:318-321; machine/src/application/stages/ship-fixes.ts:259-264; evidence.ts:285-289 | `head_moved` sends the task back to Evidence with the format kept. After a ship fix, `evidence_valid` picks valid, refresh_text (re-stamp and republish) or refresh_media (Evidence again). A full re-run rebuilds the whole pack and a new film on the old browser run (RFC wave 5 known limits: "the pack still rests on the last browser run and says so"). |
| E62 | EXIT "PR ready for review · Evidence Pack v1 · head_sha" | DEVIATION | transition.ts:367-368 | The exit is `awaiting_ship` with a draft PR; see E52. |
| E63 | (not drawn) Evidence fails back to Build | DIFFERENT | evidence.ts:112-123, 148-160; transition.ts:369-370 | A missing manifest, or an approved scenario without a row, fails the stage and counts against the e2e loop, with nothing attached for the implementer (V52). |

## Not verified

- Nothing was run: every row is from reading the source at `5c4fd1e`. Tests, the images and a live task were not exercised.
- Whether the factory guards fully stop the verifier from reading the shared `/session` mount (V7): the guard's root list was read, the SDK's own file access was not traced.
- `factory/plugin/skills/video-critic/SKILL.md`, `video-script/SKILL.md` and `demo-recording/SKILL.md` were grepped, not read in full; the "no secret or PII check" finding (E29) rests on those greps plus the prompt, role and measure code.
- The TUI's rendering of the pack and the ship gate (board code) was not opened; "card attachment" (E49) is judged from the task row and `pack.json` only.
- `machine/src/application/stages/ship-monitor.ts` and `ship-fixes.ts` were read by grep around `head_moved` and `evidence_valid` only (E61).
- The RFC copy inside the worktree was not compared with the docs-branch copy used here.
