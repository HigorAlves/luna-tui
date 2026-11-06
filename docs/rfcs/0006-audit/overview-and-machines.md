# Gap audit: v2.2 diagram (Overview, ⓪ Conversation Machine, ⓪ Ticket Machine) against the code at the head of the stack

- Design: `the v2.2 diagram's Mermaid source` lines 1-65 (overview), 66-143 (conversation), 144-287 (tickets).
- Code: `W` = `the repository root` (branch `feat/factory-v1-5-wave-7`, head `5c4fd1e`). Evidence paths are relative to `W`.
- Design record: `RFC` = `docs/rfcs/0005-software-factory-v1-5.md`.
- Read only. No tests run. RFC 0004 / the notch ignored (the `chat_triage` pack and `POST /runs` exist for it and are only named where they are the closest thing built).

**The one fact that explains most rows.** RFC 0005 was written against the v1.5 diagram: "Source diagram: Software Factory, Flow Diagram, Draft v1.5 (eight Mermaid panels: Overview, Intake, Triage, Plan, Build, Verify, Evidence, Ship)" (RFC:9). It has no panel for either ⓪ machine and no shared backlog, and lists as a non-goal "Retiring the TUI's Jira, Slack or PR inbox: the machine keeps talking to every source itself" (RFC:27). So the two ⓪ machines in v2.2 were never designed or scheduled in any wave; what stands in their place is the pre-RFC Slack inbox and Jira intake/sync/watch. Differences there are unrecorded (MISSING / PARTIAL / DIFFERENT), not DEVIATIONs.

Status key: MATCH · PARTIAL · MISSING · DIFFERENT · DEVIATION (RFC records why) · N/A.

## 1. Overview (diagram lines 1-65)

| # | Diagram element | Status | Evidence (path:line) | Note |
|---|---|---|---|---|
| O1 | SRC "Chat platforms: Slack · Teams · Discord (future)" | PARTIAL | machine/src/adapters/slack/web-api.ts, socket-mode.ts; contracts/src/stage.ts:257-258 | Slack only. Teams exists only as `source: "teams"` in the `chat_triage` context a client sends; no Teams adapter. Discord: nothing (drawn as future). |
| O2 | CONV "⓪ Conversation Machine: adapters · thread object · typed decisions · weighted priority · relate to card / backlog · drafts in luna-tui · outbound updates" | PARTIAL | machine/src/application/slack-inbox.ts:1-8; docs/architecture.md:70 | Built as "the Slack inbox": one adapter, an item per thread, an agent pack (not typed decisions), no weighted priority, no relation step, drafts yes, outbound partly. Detail in section 2. |
| O3 | TT "Task tools: Jira · Linear · GitHub Issues (future)" | PARTIAL | machine/src/adapters/jira/rest.ts; machine/src/application/intake.ts:57-107 | Jira yes. GitHub Issues intake already exists (label poll), ahead of "(future)". Linear: nothing. |
| O4 | TM "⓪ Ticket Machine: assigned to me · validity gate · urgency · complexity · blast radius · do vs. not-do · bot comment · recommendation · two-way sync" | PARTIAL | machine/src/application/jira-intake.ts:1-9; jira-sync.ts:1-11; jira-watch.ts:1-9 | Built as JiraIntake (triage_signals then the jira_intake pack) + JiraSync + JiraWatch. No do-vs-not-do, no recommendation, no backlog. Detail in section 3. |
| O5 | OTH "Other sources: manual · automation" | MATCH | machine/src/adapters/http/app.ts:277; machine/src/application/intake.ts:97-104 | `POST /tasks` from the TUI; GitHub label intake. |
| O6 | BL "Shared backlog · owned by the Ticket Machine · tickets + chat candidates · ranked by cost of delay ÷ cost of doing" | MISSING | machine/src/adapters/persistence/migrations/1793100000000-RetireBacklog.ts:3 | No backlog object, list, score or ranking anywhere (grep `backlog/wsjf/cost of delay/demand` over machine, contracts, factory, board: only this migration). The `backlog` task state was retired: "A new ticket lands in Intake (`draft`); the `backlog` state is gone". The Intake column of drafts is the only pre-start list and it is not scored. |
| O7 | ST1 states "draft · setup · awaiting_setup" | MATCH | contracts/src/index.ts:63-65 | |
| O8 | ST1 "card created · dedup · context" | PARTIAL | RFC:70, RFC:182; contracts/src/packs.ts:993-1026 (no `intake_dedup`); machine/src/application/jira-intake.ts:122; intake.ts:85 | Card and context yes. Dedup MISSING: the RFC designed `intake_dedup` ("Runs on `POST /tasks` for every source; a confident duplicate merges") but no wave in the Migration table (RFC:115-124) carries it and no implementation note mentions it; the pack does not exist. Only exact-source idempotency (same Jira key, same GitHub issue number). Unrecorded gap. |
| O9 | ST2 states "triage · awaiting_answers" | MATCH | contracts/src/index.ts:66-67 | |
| O10 | ST2 "Jev signals → LLM triage → Triage Record" | MATCH | docs/architecture.md:8; contracts/src/decision-defaults.json (triage_signals default `jev`) | |
| O11 | ST3 states "test_design · awaiting_test_check · awaiting_approval" | DEVIATION | contracts/src/index.ts:68-70; docs/architecture.md:34-35,42 | The Plan stage runs in `test_design`, shown in column "Approved"; its gate `awaiting_approval` is shown in column "Triage"; `awaiting_test_check` is unreachable. RFC:220 "No state was added: the plan stage runs in the `test_design` state and column."; RFC:221 "`awaiting_test_check` stays in the enum, unreachable on the feature route"; RFC:26 non-goal "Renaming stages, columns or task states". |
| O12 | ST3 "Graphify · code-map · risk · plan · TDD scenarios · human approval" | MATCH | docs/architecture.md:9 | Overview level only. |
| O13 | ST3b "Fast lane: Low risk · S size" | MATCH | docs/architecture.md:8-9 | `fast_lane` (risk none or low, size tiny or small) on `plan_fast` / `test_design_fast`; the single approval still applies. |
| O14 | ST4 states "implementing · paused_rate_limit · escalated" | MATCH | contracts/src/index.ts:71-73 | |
| O15 | ST4 "sandbox · red → green · regression · scope check · push branch" | DEVIATION | docs/architecture.md:10; RFC:242, RFC:245 | Two items differ, both recorded. Push: "pushed as it lands, but to a checkpoint ref, `refs/luna/wip/<branch>`, not to the branch" (RFC:242). Regression: runs in Verify, not Build: "Verify reads the current graph, takes the files whose nodes import or call nodes in the changed files" (RFC:245). |
| O16 | ST5 states "verifying · e2e · delivering · ci_watch" | MATCH | contracts/src/index.ts:74-77 | |
| O17 | ST5 "independent review · full suite · E2E preview · PR · CI" | MATCH | docs/architecture.md:11-12,17-18 | Overview level only; not verified in depth (another section's scope). |
| O18 | ST6 state "evidence"; "Jev format · video (narration ∥ recording) · Evidence Pack · publish" | DEVIATION | contracts/src/index.ts:78; contracts/src/decision-defaults.json (`evidence_format` default `claude:haiku`); docs/architecture.md:14-16 | State and pieces match. "Jev format" differs: the slot's default engine is haiku, by RFC:300 "By the rule, haiku is the default on nine slots". Whether narration and recording run in parallel: not verified. |
| O19 | ST7 states "awaiting_ship · shipping · reviewing_memory"; "maintenance loop · readiness · auto-merge L/M · close loop · learn" | MATCH | contracts/src/index.ts:79-81; docs/architecture.md:19-23 | Auto-merge is off unless the repo sets `policy.auto_merge` (RFC:164 "`policy.auto_merge` defaults to off per repo"). |
| O20 | DONE "closed" | MATCH | contracts/src/index.ts:82 | |
| O21 | ARC "Archive · with reason · any stage" | MATCH | machine/src/domain/transition.ts:155-157; contracts/src/stage.ts:485 | `archived` with `archiveReason` from any non-terminal state (`POST /tasks/:id/archive`, the TUI's `Z`). |
| O22 | NOTE "Jev by default" | DEVIATION | contracts/src/decision-defaults.json; RFC:298, RFC:300 | Defaults are per slot from the scorecard: haiku on nine, `codex:luna` on two, Jev on `event_class`, `comment_intent` and (unmeasured) `triage_signals`. RFC:298 "The default per slot is data the contracts read." |
| O23 | NOTE "swappable for Claude Haiku or Codex" | MATCH | RFC:205; contracts/src/packs.ts:593 | allowed `jev`, `claude:haiku`, `codex:luna`. |
| O24 | NOTE "constrained to a JSON schema with a confidence field" | MATCH | contracts/src/questions.ts:19-34 | choice and score carry `confidence`; yesno carries `p`. |
| O25 | NOTE "same contract, same gates — only calibration quality differs" | MATCH | RFC:206; contracts/src/packs.ts:1000 | `policy` `{proceed, flag}` per question, engine-independent. |
| O26 | Edge SRC ↔ CONV | PARTIAL | machine/src/application/slack-inbox.ts:446-530, 853-864; threads.ts:101-115 | In: search, history, replies, Socket Mode. Out: your reply, the shipped summary. |
| O27 | Edge TT ↔ TM | PARTIAL | machine/src/application/jira-intake.ts:118-135; jira-watch.ts:114-126; jira-sync.ts:111-164 | In: JQL poll and a five-minute refresh. Out: comments and transitions. No webhooks. |
| O28 | Edge CONV "human tap: create card" → ① | MATCH | board/src/slack.rs:154,171; machine/src/application/slack-inbox.ts:866-885; adapters/http/app.ts:444 | The `t` key. |
| O29 | Edge TM "human tap: create card" → ① | DIFFERENT | machine/src/application/jira-intake.ts:160-173; intake.ts:97-104 | A `ready` Jira issue (and any labelled GitHub issue) becomes a `draft` card with no tap. The human tap comes later: Start (`a`, board/src/keys.rs:348). No RFC record. |
| O30 | Edge CONV "candidates" → BL | MISSING | (see O6) | |
| O31 | Edge TM "schedule" → BL | MISSING | (see O6) | |
| O32 | Edge BL "human tap" → ① | MISSING | board/src/keys.rs:348 | Closest: pressing Start on a draft. |
| O33 | Edge OTH → ① | MATCH | machine/src/adapters/http/app.ts:277 | |
| O34 | Edge ①→②→③→④→⑤→⑥→⑦→Done | MATCH | contracts/src/index.ts:32-58; docs/architecture.md:5-23 | |
| O35 | Edge ⑦ "close the loop" → ⓪ machines "outbound reply · ticket status + comment" | MATCH | machine/src/application/threads.ts:101-115; jira-sync.ts:119-126, 162-163; RFC:285 | Shipped summary in the source Slack thread, on the GitHub issue, once on the Jira ticket; Jira status through `jira.on` (`closed: Done`). |
| O36 | Edge ② "fast lane" → ③b → ④ | MATCH | docs/architecture.md:9 | |
| O37 | Edge ② "conversation → reply" → Done | DEVIATION | machine/src/domain/transition.ts:337; pipeline.ts:169, 693 | Waits at `awaiting_approval` for one click, then ends `archived` (`not_for_agent`), not `closed`. RFC:219 "Archive and conversation outcomes open the approval gate and are confirmed with one click; ... a conversation ends as `not_for_agent`". Unrecorded part: for a Slack-sourced task the reply is not posted in the originating thread (see C40). |
| O38 | Edge ④ "plan_wrong" → ③ | DEVIATION | machine/src/domain/transition.ts:315-316 | Goes to ② Triage. RFC:209 "`plan_wrong` from Build or Verify on the feature route re-runs triage with retries kept". |
| O39 | Edge ⑤ "findings · failures" → ④ | MATCH | docs/architecture.md:18; RFC:42 | The transition line itself was not read. |
| O40 | Edge ⑦ "re_plan" → ③ | DEVIATION | machine/src/application/stages/ship-monitor.ts:206 | Escalates `plan_wrong`, which re-runs ② Triage. RFC:284 "`re_plan` escalates `plan_wrong`". |
| O41 | Edge ⑦ "refresh media" → ⑥ | MATCH | docs/architecture.md:21; machine/src/domain/transition.ts:319-320 | |
| O42 | Edge ③ "rejected" → Archive | PARTIAL | machine/src/domain/transition.ts:199; contracts/src/stage.ts:485 | The gate has approve and send back (re-plans); rejecting is the general archive (`Z`, reason `rejected`), not a gate decision. |
| O43 | Edge ② "archive" → Archive | MATCH | machine/src/domain/transition.ts:337; pipeline.ts:169 | One click confirms. |
| O44 | Edge ① "duplicate → merge" → Done | MISSING | (see O8) | No duplicate detection, no merge. |

## 2. ⓪ Conversation Machine (diagram lines 66-143)

| # | Diagram element | Status | Evidence (path:line) | Note |
|---|---|---|---|---|
| C1 | ADP "PLATFORM ADAPTERS · one per chat platform · plug-in" | PARTIAL | machine/src/application/slack.ts:74-99 | One port named `Slack` with Slack-shaped calls (`searchMentions`, `conversations`, `openSocket`): not a platform-neutral plug-in interface. |
| C2 | AS "Slack adapter" | MATCH | machine/src/adapters/slack/web-api.ts; socket-mode.ts | User token over `fetch`; Socket Mode for pushes. |
| C3 | AT "Teams adapter" | MISSING | contracts/src/stage.ts:257-258 | Only a context shape for a client-sent batch. |
| C4 | AD "Discord adapter (future)" | N/A | - | Drawn as future; nothing built. |
| C5 | AX "… any chat platform" | MISSING | machine/src/application/slack.ts:74 | No generic chat port. |
| C6 | CM "Canonical Message: id · thread id · channel · author · text · permalink · timestamp" | PARTIAL | machine/src/domain/slack-item.ts:97-110 | `IncomingMessage` has these, but it is Slack's own (`slackTs`, channel kinds), not canonical. |
| C7 | CM "attachments" | MISSING | machine/src/application/slack.ts:43-53 | `RawMessage` carries no files or attachments (the `file_share` subtype is accepted, its file is dropped). |
| C8 | CM "mentions" | PARTIAL | machine/src/domain/slack-item.ts:50-52, 109 | Only "does it mention me" and the watch keys in `matched`; no list of mentions. |
| C9 | CM "edited / deleted" | MISSING | machine/src/application/slack-inbox.ts:281-287; adapters/slack/socket-mode.ts:9-22 | An edit or deletion envelope only flags the channel for the next poll; the item has no edited or deleted state. Whether an edit of an already-read message ever updates the item: not verified (history is read after the cursor only). |
| C10 | CV "Conversation object · one per thread" | PARTIAL | contracts/src/slack.ts:97-132; machine/src/domain/slack-item.ts:126-169 | `SlackItem`, id `<channel>:<thread ts>`, several messages fold into one. Only threads that address you exist as items. |
| C11 | CV "history" | PARTIAL | contracts/src/slack.ts:107-108 | Up to three earlier messages; the latest text replaces the previous. |
| C12 | CV "participants" | MISSING | contracts/src/slack.ts:102 | Only the latest author. |
| C13 | CV "classification" | PARTIAL | contracts/src/slack.ts:63-82 | `triage`: priority, category, expectsReply, summary, why, refs, deadline. |
| C14 | CV "linked card or backlog item" | PARTIAL | contracts/src/slack.ts:131; machine/src/application/slack-inbox.ts:883 | `linked.taskId` only after `t`; `linked.pr` when the text holds a PR URL. No backlog. |
| C15 | CV "open draft" | MATCH | contracts/src/slack.ts:72 | `triage.draft`. |
| C16 | CV "idempotent by message id · ordered per thread" | MATCH | machine/src/domain/slack-item.ts:147-151, 120 | A message at or before the stored ts changes nothing; rows keyed by id in `slack_items`. |
| C17 | DB "Debounce · wait until thread settles (60–120 s)" | MISSING | machine/src/application/slack-inbox.ts:355, 308-312; docs/configuration.md:64 | No settle window. Triage starts as soon as a poll has saved its rows; polls run every 60 s; a socket event schedules a poll 3 s later. |
| C18 | DB "explicit mention bypasses" | N/A | - | Nothing to bypass. |
| C19 | DB "thread changed while draft pending → regenerate" | MATCH | machine/src/domain/slack-item.ts:152-168, 185-199 | A newer message or a moved thread sets `retriage`; the new triage replaces the draft. |
| C20 | EN "thread history" | PARTIAL | machine/src/application/slack-inbox.ts:703-712 | Three earlier messages as `@name: text`. |
| C21 | EN "author profile (customer / exec / engineer)" | PARTIAL | machine/src/application/slack.ts:62-66; machine/src/domain/slack-rules.ts:239 | id, name, isBot; a hand-kept VIP list (at least P1). No role. |
| C22 | EN "channel config" | PARTIAL | machine/src/domain/slack-rules.ts:236; slack-item.ts:86-94 | Muted channels and watches with a priority floor, in the rules file and `slack_watches`. |
| C23 | EN "open cards · backlog · recent Evidence Packs · docs" | MISSING | contracts/src/packs.ts:942-958; factory/roles/slack-triager/role.md:4 | The pack has no access and no tools ("You have no tools and nothing to look up"); the batch holds only the items. |
| C24 | JC "Typed decisions · kind: incident · bug · request · question · FYI · chatter" | DIFFERENT | contracts/src/packs.ts:942-958, 279-297; contracts/src/slack.ts:16 | An agent pack (`slack_triage`, kind `agent`, haiku, three turns), not a decision pack. Its `category` is blocker · decision · question · request · fyi · social · automated: no `incident`, no `bug`. |
| C25 | JC "needs reply?" | MATCH | contracts/src/packs.ts:286 | `expectsReply`. |
| C26 | JC "each with confidence" | MISSING | contracts/src/packs.ts:279-297 | The answer has no confidence at all. |
| C27 | JR "Typed decision · Related to existing work? search board + backlog (embeddings · card links · Jira keys)" | MISSING | contracts/src/packs.ts:292; machine/src/domain/slack-item.ts:260-265 | Nothing searches the board. Closest: `refs` (PR, issue, Jira key or URL as written in the text) and a PR-URL match against the PR inbox. No embeddings anywhere (grep). |
| C28 | JR outputs "related_to_in_progress · related_to_backlog · new_candidate · none" | MISSING | - | |
| C29 | KO "Knock-outs: production down · data loss · security?" | PARTIAL | machine/src/domain/slack-rules.ts:59-63, 240; factory/roles/slack-triager/role.md:8 | "Always P0 keywords" in the rules file (template: `incident`, `outage`) floor to P0; the role's P0 rubric names a production incident. No data-loss or security check. |
| C30 | KO "yes → P0" | PARTIAL | machine/src/domain/slack-rules.ts:240, 264 | The floor is applied after the model answers; there is no relation step to skip to. |
| C31 | WS "Weighted scoring model: who ×3 · what ×3 · impact ×2 · time sensitivity ×2 · demand ×1 · each 1–3 · confidence-weighted · sum → P0–P3 · weights in config · sub-scores logged" | MISSING | factory/roles/slack-triager/role.md:6-11; machine/src/application/slack-inbox.ts:757, 765-767 | The model picks P0–P3 against a prose rubric; rules floor it; a hand override outlives re-triage. No factors, weights, sub-scores or config. |
| C32 | CF "Confidence ok?" · "low → ask in luna-tui" | MISSING | machine/src/application/slack-inbox.ts:655-658 | No confidence. Closest: an untriaged item is listed with `triage: null`, and `!` / `-` set the priority by hand. |
| C33 | RT "Relation" gate (in progress · backlog · new candidate · none) | MISSING | - | |
| C34 | R1 "Attach thread to card · notify card owner · priority inherited" | MISSING | - | |
| C35 | R2 "Bump backlog item · demand score +1 · priority recomputed" | MISSING | - | |
| C36 | R3 "Add to backlog · pre-Intake list · ordered by score · thread links + sub-scores as hints" | MISSING | - | Closest: `t` makes a draft card in Intake. |
| C37 | R4 "No action · chatter / FYI · recorded only" | MATCH | machine/src/domain/slack-item.ts:24, 45-46; slack-rules.ts:241-259 | `fyi` split, done by itself after seven days; app posts settled by the rules as `automated` P3. |
| C38 | LD "LLM · Draft reply" | DIFFERENT | contracts/src/packs.ts:290-291; factory/roles/slack-triager/role.md:19 | The draft is a field of the same triage call (at most two sentences), not a separate step after the relation. |
| C39 | LD "status from card state + Evidence Pack · answer from docs · 'it's queued, here's where'" | MISSING | factory/roles/slack-triager/role.md:4 | The drafter sees no card, pack or doc. |
| C40 | LD "never argues · tone from past edits" | PARTIAL | factory/roles/slack-triager/role.md:19, 26; machine/src/domain/slack-rules.ts:276-281 | Tone comes from the hand-written Notes section. Learned lines carry priority direction only; edits are not captured. "Never argues" is not in the role. |
| C41 | UI "luna-tui · draft shown to the responsible human" | MATCH | board/src/app.rs:2491 | The `S` view; `r` opens the reply pre-filled with the draft. |
| C42 | UI "Send · Edit" | MATCH | board/src/slack.rs:153, 170 | `r`, edit, ctrl+s posts as you. |
| C43 | UI "Ignore" | MATCH | board/src/slack.rs:155-156, 172-173 | `d` (done) or `s` (snooze). |
| C44 | UI "Create card" | MATCH | board/src/slack.rs:154, 171 | `t`. |
| C45 | UI "one open draft per thread" | MATCH | contracts/src/slack.ts:98, 72 | One item per thread, one draft on it. |
| C46 | UI "expires 24 h" | MISSING | machine/src/domain/slack-item.ts:22-26 | No draft expiry. The timers that exist: waiting on them after 24 h, an FYI done after 7 d, done kept 30 d, a reply SLA of 10m/30m/1h/1h. |
| C47 | HD "Human decision" (send / edit · ignore · create card) | MATCH | board/src/slack.rs:128-137 | Plus nudge, open, priority up and down. |
| C48 | SND "Send via adapter · reply posted in the source thread" | MATCH | machine/src/application/slack-inbox.ts:853-864 | `postMessage` with the item's thread ts, mrkdwn escaped. |
| C49 | GT "Capture ground truth: sent as-is · edited (diff) · ignored" | PARTIAL | machine/src/application/slack-inbox.ts:816-826, 833, 862 | Recorded: `lowered` when cleared with no reply, `raised` when replied to within an hour, per author or channel, in `slack-triage.learned.md`. Not recorded: whether the draft was sent as written or edited (`reply(id, text)` never sees the draft), no diff. |
| C50 | GT "→ classifier · weights · draft tone" | PARTIAL | machine/src/application/slack-inbox.ts:716-717 | The learned lines ride in the next triage prompt as priority hints. No weights to tune, no tone learning. The decision log (RFC:294) covers decision packs only, so `slack_triage` leaves no record. |
| C51 | CC "create_card(...) → ① INTAKE · always a human tap" | MATCH | machine/src/application/slack-inbox.ts:866-885 | |
| C52 | CC "hints carried as lower-confidence inputs" | PARTIAL | machine/src/application/slack-inbox.ts:877-882; contracts/src/slack.ts:165-168 | Title from the triage summary, the thread quoted in the description, `source.kind = slack`. Priority, category and refs are not passed; no `classification`. |
| C53 | OUT "from ⑦ Ship (close the loop) · posted to the originating thread" | MATCH | machine/src/application/threads.ts:101-115 | |
| C54 | OUT "status changes · posted to the originating thread" | DIFFERENT | machine/src/application/threads.ts:117-140; docs/configuration.md:60 | They go to a thread the machine opens per task in `MACHINE_SLACK_CHANNEL` with a bot token (and to the GitHub issue), not to the thread the task came from. |
| C55 | OUT "questions from awaiting_answers · posted to the originating thread" | PARTIAL | machine/src/application/threads.ts:37, 78 | One line, "Needs you: answer triage's questions.", in the machine's own thread; the questions themselves are not posted. |
| C56 | OUT conversation reply to the source (overview edge ② → Done) | PARTIAL | machine/src/application/threads.ts:82, 131-140; pipeline.ts:693 | `task.reply` goes through the same `reply()`: GitHub issue and the machine's own thread. A Slack-sourced task's originating thread never gets it. RFC:72 says "the machine posts the reply to the source thread (Slack, Jira or the GitHub issue)"; no note records the difference. |
| C57 | SC "opted-in channels only" | DIFFERENT | machine/src/application/slack-inbox.ts:485-515, 518-530; slack-rules.ts:236 | Opt-out: every mention through search and a sweep of every channel you are in; muted channels are dropped. |
| C58 | SC "DMs excluded unless invited" | DIFFERENT | machine/src/application/slack-inbox.ts:517, 526-528 | The opposite: DMs are read on every poll and always become items. |
| C59 | SC "no drafts into threads where humans are actively replying" | PARTIAL | factory/roles/slack-triager/role.md:16 | A prompt rule (an answer already in the thread makes `expectsReply` false, so no draft). Nothing is ever posted without a keypress. |
| C60 | SC "rate limits" | MATCH | machine/src/application/slack-inbox.ts:128, 140, 342-344; slack-triage.ts:58 | Five-minute backoff, 40 history calls per poll, batches of 25. |
| C61 | SC "secrets / PII check before storing or copying into a card" | MISSING | machine/src/application/slack-inbox.ts:870-876 | Text is stored and copied into the card as written; only outgoing mrkdwn is escaped. |
| C62 | Chain CM → CV → DB → EN → JC → JR → KO → WS → CF → RT → R1..R4 → LD → UI | DIFFERENT | machine/src/application/slack-inbox.ts:446-626, 693-762 | Built chain: poll → fold → rules pre-pass (drop, floors, app posts settled) → one `slack_triage` call (priority, category, expectsReply, draft) → floor → board. |

## 3. ⓪ Ticket Machine (diagram lines 144-287)

| # | Diagram element | Status | Evidence (path:line) | Note |
|---|---|---|---|---|
| T1 | ADP "TASK-TOOL ADAPTERS · one per tool · plug-in" | PARTIAL | machine/src/application/jira.ts:100-119; intake.ts:12-22 | A `Jira` port and a `GitHub` port, each with its own intake loop; no common task-tool port. |
| T2 | TJ "Jira adapter · API" | MATCH | machine/src/adapters/jira/rest.ts:35 | REST v3, basic auth, retries, ADF both ways. |
| T3 | TJ "webhooks + periodic reconcile" | PARTIAL | machine/src/application/jira-intake.ts:86-103; docs/architecture.md:81 | Polling only: the repo's `every` for intake, five minutes for linked issues. No webhook route (grep `webhook` in machine/src: none). |
| T4 | TL "Linear / GitHub Issues (future)" | PARTIAL | machine/src/application/intake.ts:57-107 | GitHub Issues intake exists (label `ready-for-agent`), with `triage_signals` but no validity agent. Linear: nothing. |
| T5 | TX "… any task tool" | MISSING | - | |
| T6 | SCOPE "Assigned to me / my team?" | DIFFERENT | docs/configuration.md:135; machine/src/application/jira-intake.ts:119 | Scope is whatever JQL the repo writes (`jira.intake.jql`; the documented example is `project = PLAT AND labels = luna AND status = Ready`). Assignee is never read. |
| T7 | IGN "Ignore · not in scope · no comment" | MATCH | machine/src/application/jira-intake.ts:119 | Issues outside the JQL are never read. |
| T8 | CT "Canonical Ticket: key · title · description · type · status · their priority · labels · comments · due date · permalink" | MATCH | machine/src/application/jira.ts:65-81 | `JiraIssue`. Jira-shaped, not canonical across tools. |
| T9 | CT "reporter · assignee · components · links (blocks · duplicates · epic) · attachments · sprint" | MISSING | machine/src/adapters/jira/rest.ts:35 | `ISSUE_FIELDS` asks for summary, description, status, issuetype, priority, duedate, labels, updated, comment. |
| T10 | CT "timestamps" | PARTIAL | machine/src/application/jira.ts:79, 61 | `updated` and each comment's `created`; no issue `created`. |
| T11 | CT "idempotent by key + updated" | PARTIAL | machine/src/application/jira-intake.ts:122-127, 140-149 | One task per key; `answered` remembers key → `updated` in memory (lost on restart; `spokeLast` covers that from the comments). |
| T12 | TO "Ticket object · one per key" | PARTIAL | contracts/src/jira.ts:8-22; contracts/src/stage.ts:27 | No ticket object before a card exists; after, `Task.jira` (`JiraLink`) and `source.kind = jira`. |
| T13 | TO "assessment history" | MISSING | docs/architecture.md:79; contracts/src/stage.ts:463-481 | One `classification` on the card; the jira_intake run folder "goes once the run answered"; an issue that got a brief or a refusal leaves only its Jira comment. |
| T14 | TO "linked card" | MATCH | docs/architecture.md:82 | One open task per issue (`409 already_linked_elsewhere`). |
| T15 | TO "open drafts" | MISSING | - | Nothing about a ticket is drafted for approval. |
| T16 | TO "SLA clocks" | PARTIAL | contracts/src/jira.ts:33-42 | Gate, stage, cycle and Jira-due clocks, on the card only. |
| T17 | TO "field ownership: tool owns description/reporter · factory owns status/links" | PARTIAL | machine/src/application/jira-sync.ts:162-163; jira-intake.ts:163-165 | In practice: the machine writes comments, transitions and optional fields, never the Jira description; the card's own title and description are rewritten by the pack. Not a stated ownership model. |
| T18 | EN "comments" | MATCH | contracts/src/stage.ts:698-699 | |
| T19 | EN "linked tickets · epic context · same reporter / component history" | MISSING | machine/src/adapters/jira/rest.ts:35 | Not read. |
| T20 | EN "Graphify: which code the text points at" | DIFFERENT | contracts/src/packs.ts:924-941; factory/roles/jira-triager/role.md:4, 15 | Read, Glob and Grep over a clean read-only checkout; `jira-intake-runner.ts` mounts no graph (grep `graph`: none). `code_map` runs later, in Plan. |
| T21 | EN "board + backlog search" | MISSING | machine/src/application/jira-intake.ts:122 | Only "is there a task with this key". |
| T22 | JV "Typed decision · Validity" | DIFFERENT | contracts/src/packs.ts:924-941, 76-86 | An agent pack (`jira_intake`, `claude:sonnet`, eight turns), verdict `ready` / `needs_brief` / `not_for_agent`, no confidence. |
| T23 | JV "goal/outcome · repro steps or acceptance criteria" | PARTIAL | factory/roles/jira-triager/role.md:8-9; contracts/src/packs.ts:411 | The role judges it in prose; `triage_signals.ready` asks about testable criteria. |
| T24 | JV "bounded scope" | PARTIAL | contracts/src/packs.ts:412-420 | Only the `size` rubric (tiny to large); no bounded-or-not answer. |
| T25 | JV "duplicate?" | MISSING | contracts/src/packs.ts:425; machine/src/application/jira-intake.ts:154 | `archive_reason: duplicate` is a label of `triage_signals`, but intake acts only on `kind = question`, and the model is shown no other ticket to compare. |
| T26 | JV "project/repo identifiable" | PARTIAL | machine/src/application/jira-intake.ts:88-105; factory/roles/jira-triager/role.md:9 | The repo is the one whose `luna.yaml` JQL matched; `needs_brief` when "the issue points at a system this repository does not contain". |
| T27 | JV "reporter reachable" | MISSING | machine/src/application/jira.ts:65-81 | Reporter is not read. |
| T28 | VG "Workable?" → needs_info | MATCH | machine/src/application/jira-intake.ts:176-179 | `needs_brief`. |
| T29 | VG → duplicate | MISSING | - | |
| T30 | VG → not_ours | PARTIAL | machine/src/application/jira-intake.ts:181 | `not_for_agent` (not code in this repo, or needs a person). |
| T31 | VG → valid | MATCH | machine/src/application/jira-intake.ts:161 | `ready`. |
| T32 | NI "bot comment lists exactly what's missing" | MATCH | machine/src/application/jira-intake.ts:48-54 | Up to three questions, each with the answer the agent would pick. |
| T33 | NI "status → waiting for reporter" | MISSING | machine/src/application/jira-intake.ts:176-179 | A comment only; no transition at intake. |
| T34 | NI "SLA: 3d reminder · 10d → park" | MISSING | machine/src/application/jira-intake.ts:123-127; sla-actions.ts:16, 33-40 | No reminder and no park for an unanswered brief; the issue is read again only when it changes. Closest: `sla.gate` (1h) reminder and `sla.archive` (off by default) on a card at `awaiting_setup` / `awaiting_answers`. |
| T35 | NI → UI (human tap before the comment) | DIFFERENT | machine/src/application/jira-intake.ts:177 | Posted at once, no tap. |
| T36 | DUP "Duplicate · link to existing card / ticket · comment · close or merge" | MISSING | machine/src/application/jira-intake.ts:122 | Same-key skip only. |
| T37 | NO "Not ours · route to the right team · comment" | PARTIAL | machine/src/application/jira-intake.ts:181 | Comment "Not for an agent: <reason>" once; no routing. |
| T38 | ASSESS "typed answers → weighted scoring in code" | PARTIAL | machine/src/application/classify.ts:26-39; contracts/src/packs.ts:389-425 | Typed answers exist (`triage_signals`: kind, area, ready, size, urgency, risk, archive, archive_reason). No scoring in code: they are kept on the card as hints. |
| T39 | A1 "Urgency: who · what · impact · time sensitivity (sprint / due date) · demand" | PARTIAL | contracts/src/packs.ts:422; machine/src/application/jira-intake.ts:195-197 | One `urgency` score (low, normal, high, urgent) from title, description and labels; due date, priority and sprint are not in its input. |
| T40 | A2 "Complexity: files/components via Graphify · unknowns · cross-team deps · new infra" | PARTIAL | contracts/src/packs.ts:412-420 | One `size` score from the text; no Graphify at this point. |
| T41 | A3 "Blast radius: dependents of touched code · traffic · data sensitivity · reversibility" | PARTIAL | contracts/src/packs.ts:423, 430-432; machine/src/domain/blast-radius.ts:1-3 | At intake one `risk` score. `risk_score` (blast radius, reversibility, data sensitivity) runs in ③ Plan, after a card exists; graph dependents are read only by Verify's sweep. No traffic. |
| T42 | A4 "Risk of doing vs. not doing · cost of doing · cost of delay" | MISSING | - | |
| T43 | KO "security / compliance deadline → top · can't reproduce + no reporter → park" | MISSING | - | |
| T44 | WS "urgency → P0–P3 · complexity → S/M/L/XL · blast radius → Low/Med/High" | PARTIAL | contracts/src/packs.ts:412-423 | Four-level rubrics with other names (low..urgent, tiny..large, none..high); not derived by a model in code. |
| T45 | WS "priority = cost of delay ÷ cost of doing (WSJF-style) · confidence-weighted · weights in config" | MISSING | docs/configuration.md:94-164 | No priority score. Confidence gates per question (`policy.decisions`) are the only tunable. |
| T46 | WS "sub-scores kept" | PARTIAL | contracts/src/stage.ts:480; machine/src/application/pack-runs.ts:314 | `classification.signals` on the card and a decision record under `<state>/decisions/triage_signals/`. |
| T47 | Order "valid → assessment" | DIFFERENT | machine/src/application/jira-intake.ts:152-160 | Reversed: the signals run first and the validity agent second, with the signals as a hint. |
| T48 | SZ "Typed decision · Change size estimate · est_loc · est_files · reviewable{yes, no} · confidence · Graphify · similar past cards (actual LOC)" | MISSING | contracts/src/stage.ts:161; machine/src/application/stages/memory.ts:207-209 | Closest: the `size` rubric; `est_loc` per plan slice (③); the retro's predicted-against-actual LOC after the merge. |
| T49 | SG1 "est_loc ≤ limit and reviewable?" | MISSING | - | No size gate before a card. |
| T50 | DCFG "target 1–2k LOC per ticket · hard limit 2.5k · max 8 children per parent · max 3 rounds · nesting depth 2" | MISSING | - | No ticket splitting anywhere (grep `decompos/children/child ticket/subtask/epic`: nothing relevant). None of the five values exists. |
| T51 | LD "LLM · Decompose · children[]: title · goal · acceptance_criteria[] · files_hint[] · est_loc · depends_on[] · order" | MISSING | factory/src/core/decide.ts:31 | Closest shape: a plan's `slices[]` (title, est_loc, touchpoints, acceptance), which stay inside one card and one PR. |
| T52 | JD "Typed decision · Split check" (limit · cover without gap or overlap · acyclic · testable · ok · issues[]) | MISSING | contracts/src/packs.ts:458 | Closest: `plan_check.slices_cover_criteria`. |
| T53 | SG2 "Split valid?" (issues → refine · ok → D4 · 3 rounds → D5) | MISSING | - | |
| T54 | CMT "Post assessment as bot comment · via API" | PARTIAL | machine/src/application/jira-intake.ts:156, 171, 177, 181 | Comments go out through the API, but they are "Picked up … <reason>", the brief, or the refusal. |
| T55 | CMT "scores + why + size estimate" | PARTIAL | machine/src/application/jira-intake.ts:156, 171 | The classification line is in the comment only on the question refusal; the ready path carries the pack's one-line reason, no scores, no size. |
| T56 | CMT "updated on re-assessment" | MISSING | machine/src/application/jira.ts:109-110 | The port can only add a comment. |
| T57 | CMT "no custom fields" | PARTIAL | docs/configuration.md:145-147; machine/src/application/jira-sync.ts:199-212 | The assessment uses none, but `jira.fields` lets a repo set custom fields on a transition (the example writes the PR url). |
| T58 | REC "Typed decision · Recommendation: do_now · schedule · decline · split · needs_decision" | MISSING | contracts/src/packs.ts:77 | Closest: the intake verdict (ready, needs_brief, not_for_agent) and, after Start, triage's outcome (plan, fast_lane, conversation, archive). |
| T59 | RT edges (do_now → D1 · schedule → D2 · decline → D3 · split (manual) → LD · needs_decision → D5) | MISSING | - | |
| T60 | D1 "Promote candidate · draft: 'ready for Intake' with hints" | DIFFERENT | machine/src/application/jira-intake.ts:161-169 | The card is created outright in `draft`, with the pack's title, description and criteria and the classification. No promotion step to approve. |
| T61 | D2 "Schedule · place in shared backlog by priority score" | MISSING | - | |
| T62 | D3 "LLM · Draft decline reply · why not · alternatives · never auto-posted" | DIFFERENT | machine/src/application/jira-intake.ts:156, 181; intake.ts:91 | The refusal is posted on the issue at once ("Not for an agent: …"), one line, no alternatives. Contradicts "never auto-posted". |
| T63 | D4 "Draft split for approval · parent becomes epic · create child tickets via adapter · link parent · children re-enter assessment · parent closes when all children ship" | MISSING | machine/src/application/jira.ts:116; jira-tasks.ts:190 | `createIssue` exists but only for `J` (an issue from a card). |
| T64 | D5 "Needs decision · cost of doing vs. cost of delay side by side · blast radius High" | MISSING | docs/architecture.md:9 | Closest, much later: a High-risk plan needs two approvers. |
| T65 | UI "luna-tui · Approve · Edit · Ignore · Create card" | DIFFERENT | board/src/app.rs:1695-1810; board/src/inbox.rs:1-17 | The board has no ticket inbox. Jira shows up as draft cards in Intake and as the `J` link picker; the Inbox view lists gates of cards, not tickets. |
| T66 | UI "always a human tap for anything leaving the machine" | DIFFERENT | machine/src/application/jira-intake.ts:156-181; jira-sync.ts:111-164 | Picked-up, brief and refusal comments, PR opened, gate lines, the closing comment and every status transition leave with no tap. |
| T67 | ACT "Act via adapter: post reply · transition status" | PARTIAL | machine/src/application/jira-sync.ts:167-190, 240-242 | Both exist, automatic. |
| T68 | ACT "create child tickets" | MISSING | - | |
| T69 | GT "Capture ground truth: approved · edited (diff) · ignored · overridden scores → classifier · weights · drafts" | MISSING | RFC:295; docs/architecture.md:79; evals/ (no `jira_intake` folder) | Nothing records what a person did with an intake verdict. `triage_signals` leaves a decision record but RFC:295 lists no truth derivation for it. Plan-gate ground truth exists, for ③ only. |
| T70 | CC "create_card(...) → ① INTAKE · ticket link · assessment as lower-confidence hints" | PARTIAL | machine/src/application/jira-intake.ts:167-168; contracts/src/stage.ts:461-462 | Content matches (the Jira source, the classification "A hint for people and for jira_intake; it decides nothing alone"). The call is automatic, not a tap. |
| T71 | BQ "One list for tickets and chat candidates · ranked by the same cost-of-delay ÷ cost-of-doing score" | MISSING | (see O6) | |
| T72 | BQ "demand bumps from ⓪ Conversation" | MISSING | - | |
| T73 | BQ "stale → re-assess or decline" | MISSING | machine/src/application/sla-actions.ts:16 | A draft never ages. Closest: `sla.archive` on two gates of a started card. |
| T74 | BQ "depends_on rule: schedulable when every dependency is closed OR has an open PR (state ≥ delivering)" | MISSING | machine/src/domain/merge-readiness.ts:56 | Closest, at the other end: merge readiness is blocked by an open `Depends on #N` / `Blocked by #N` in the PR body. |
| T75 | BQ "→ card.base = dependency's branch (stacked) else main" | MISSING | machine/src/domain/task.ts (no base field found) | Not verified exhaustively: a grep for `base` in the task domain shows only a diff-against-base comment. |
| T76 | BQ "top of list · human tap" → UI | MISSING | - | |
| T77 | S1 "Mirror factory → ticket · status transitions" | MATCH | machine/src/application/jira-sync.ts:162-163, 167-190 | Through `jira.on`, by status name; a blocked move is marked and retried. |
| T78 | S1 "PR + Evidence Pack links" | PARTIAL | machine/src/application/jira-sync.ts:140-149, 222-237 | "PR opened: <url>" once; the closing comment names the PR, the criteria, the verdicts and the evidence artifacts by label; the shipped summary carries media urls. Only with `comments` not `none`. |
| T79 | S1 "awaiting_answers questions as comments" | PARTIAL | machine/src/application/jira-sync.ts:42, 158-159 | "Needs you: answer triage's questions." and only with `comments: gates`; the questions are not posted. |
| T80 | S1 "close the loop on ship" | MATCH | machine/src/application/jira-sync.ts:119-126; RFC:285 | Once per task. |
| T81 | S2 "Ticket → factory events: priority bumped" | PARTIAL | machine/src/application/jira-watch.ts:120-123; docs/architecture.md:84 | Mirrored onto the link every five minutes and it moves the gate SLA (High halves it); no event, no re-assessment. |
| T82 | S2 "scope edited · reassigned · comment added" | MISSING | machine/src/application/jira-watch.ts:117-121 | The watch reads status, priority, due date and type. Description, assignee and comments are not compared once a card exists. |
| T83 | S2 "→ re-assess · raise event to the card's current stage" | MISSING | machine/src/application/jira-watch.ts:124-126 | The only event is `jira.moved`, when the issue reaches Done, Cancelled or Won't Do; a person then decides. |
| T84 | SLA "acknowledge within X" | PARTIAL | machine/src/application/jira-intake.ts:171; contracts/src/jira.ts:35 | No acknowledge clock on a ticket; the "Picked up" comment is the acknowledgement, and the gate clock (1h) starts once a card waits. |
| T85 | SLA "resolve by priority" | PARTIAL | docs/architecture.md:84 | A cycle clock (created to closed) that is not by priority; the gate clock is halved or doubled by Jira priority; the Jira due date is its own clock. |
| T86 | SLA "stale N days → re-assess / decline" | PARTIAL | machine/src/application/sla-actions.ts:16, 33-35; docs/configuration.md:154 | `sla.archive` (off by default) archives a card left at `awaiting_setup` or `awaiting_answers` as `sla_expired`. No re-assessment, nothing for a draft or a ticket with no card. |
| T87 | Chain SCOPE → CT → TO → EN → JV → VG → ASSESS → SZ → SG1 → CMT → REC → RT → D1..D5 → UI → HD → ACT → GT | DIFFERENT | machine/src/application/jira-intake.ts:118-183 | Built chain: JQL match → skip if a task has the key or the machine spoke last → `triage_signals` (a sure question is refused) → `jira_intake` agent → `ready`: a draft card and a comment; `needs_brief` / `not_for_agent`: a comment. |

## 4. What exists today that the diagram replaces or renames

| Today (code) | Diagram v2.2 |
|---|---|
| **Slack inbox** (`machine/src/application/slack-inbox.ts`, the board's `S` view): personal inbox of what addresses you, priority P0–P3 picked by the `slack_triage` agent pack, reply SLA 10m/30m/1h/1h, splits needs_reply / waiting_on_them / decide / fyi / snoozed / done, watches, VIPs, quiet hours, digest, nudge, snooze | ⓪ Conversation Machine: a team-facing intake of opted-in channels, typed decisions with confidence, a weighted score, a relation to cards and backlog. The inbox's personal features (splits, snooze, nudge, digest, reply SLA, read cursor) have no node in the diagram. |
| `SlackItem` (one per thread, three messages of context) | Conversation object (full history, participants, linked card or backlog item) |
| `slack_triage` (agent, no tools) answering `category` + `priority` + `draft` in one call | Typed decisions (kind, needs reply) → relation decision → knock-outs → weighted score → separate draft LLM with card state and docs |
| Rules file `slack-triage.md` (VIPs, muted, always-P0 words, SLA, notes) and `slack-triage.learned.md` (lowered / raised) | Scope and quiet rules, weights in config, ground truth (sent as-is / edited diff / ignored) |
| `ThreadReplies` (`threads.ts`): a machine-owned Slack thread per task in `MACHINE_SLACK_CHANNEL`, plus GitHub issue comments | Outbound updates posted to the originating thread through the same adapter |
| `chat_triage` + `POST /runs` (for a client's Slack or Teams batch; built for the notch) | The nearest thing to a platform-neutral message shape; not wired to any machine loop |
| **JiraIntake** (`jira-intake.ts`): per-repo JQL poll → `triage_signals` → `jira_intake` agent (ready / needs_brief / not_for_agent) → draft card or comment, all automatic | ⓪ Ticket Machine: scope by assignee, validity as a typed decision, four assessments, a WSJF score, a size estimate, decomposition, a recommendation, and a human tap before anything leaves |
| `TaskClassification` on the card (kind, area, ready, size, urgency, risk, archive) | Assessment with sub-scores kept and an assessment history per ticket |
| **JiraSync** (`jira-sync.ts`): state → status by `jira.on`, comments by `jira.comments` level | S1 Mirror factory → ticket |
| **JiraWatch** (`jira-watch.ts`): status, priority, due date, type every five minutes; `jira.moved` | S2 Ticket → factory events with re-assessment |
| `J` on the board (link, search, create an issue from a card) | No node; the diagram's direction is ticket → card only |
| **GitHubIntake** (`intake.ts`, label poll) | "Linear / GitHub Issues (future)" adapter |
| **PR inbox** (`pulls.ts`, the board's `P` view) and PR tasks (`ci_fix`, `review`, `address`) | Not in these three panels |
| Intake column (`draft` cards, unordered; `backlog` state retired by migration) | Shared backlog, ranked, pre-Intake |
| SLA clocks on a card (gate, stage, cycle, Jira due; `sla.archive`) | SLA clocks on a ticket (acknowledge, resolve by priority, stale) and the needs-info 3d / 10d clock |
| Plan `slices[]` inside one card and one PR; `too_complex` → one run on a stronger engine | Decomposition loop into child tickets (1–2k LOC, 2.5k limit, 8 children, 3 rounds, depth 2) |

## 5. Top 10 gaps by impact

1. **No shared backlog and no ranking** (O6, O30-O32, T61, T71-T76). Nothing holds candidates before Intake, nothing scores them, and the `backlog` state was removed. Every "schedule", "bump", "top of list" edge has no target.
2. **No weighted scoring model on either machine** (C31, T42-T45). Priority in Slack is the model's pick; tickets get rubric scores kept as hints. No cost of delay, no cost of doing, no weights in config, no knock-outs for security or compliance.
3. **No decomposition loop and no size gate** (T48-T53, T63). No `est_loc` estimate before a card, none of the five limits, no child tickets, no epic.
4. **Human tap is not where the diagram puts it** (O29, T35, T60, T62, T66). Jira and GitHub intake create cards and post comments, refusals included, with no tap; the diagram says "always a human tap for anything leaving the machine" and "never auto-posted".
5. **No relation to existing work and no dedup** (O8, O44, C27-C28, C33-C36, T25, T36). `intake_dedup` is in the RFC's design and appendix, in no wave and in no note; no board search, no embeddings, no attach-to-card, no demand bump.
6. **Conversation triage is not typed decisions** (C24, C26, C32). One agent call, other categories than the diagram's kinds, no confidence, so no confidence gate and nothing for the decision log, the scorecard or the truth capture to work on. Same for ticket validity (T22).
7. **Ticket → factory events are missing** (T81-T83). An edited scope, a reassignment or a new comment on a linked issue changes nothing on the card; only a Done-category status raises an event.
8. **Outbound updates miss the originating thread** (C54-C56, T79). Status lines, the `awaiting_answers` notice and the conversation reply go to the machine's own Slack thread; only the shipped summary reaches the source thread. The questions themselves are posted nowhere (Slack or Jira).
9. **Ground truth for both machines is thin** (C49-C50, T69). Slack keeps a lowered / raised counter per author; nothing keeps sent-as-is against edited, nothing keeps what a person did with a Jira intake verdict, and `jira_intake` has no eval folder.
10. **Scope and safety rules differ** (C57-C58, C61, C17, C46, T6, T34). Channels are opt-out and DMs always in; no secrets or PII check before a message is stored or copied into a card; no debounce (triage runs right after each 60 s poll); no 24 h draft expiry; ticket scope is a free JQL, not assignee; no 3d / 10d needs-info clock.

## 6. Misunderstandings (built in a way that contradicts the diagram)

- **Auto-posting and auto-creating** on the ticket side (T35, T60, T62, T66, O29): `machine/src/application/jira-intake.ts:156-181`, `intake.ts:91-104`.
- **DMs and channel scope inverted** (C57, C58): `machine/src/application/slack-inbox.ts:517-530`.
- **Assessment before validity** (T47): `machine/src/application/jira-intake.ts:152-160`; and of the eight signals only `kind = question` is ever acted on (`classify.ts:20-24`).
- **A second, machine-owned Slack thread** for task updates instead of the source thread (C54): `machine/src/application/threads.ts:117-140`.
- **The backlog was removed, not built** (O6): `machine/src/adapters/persistence/migrations/1793100000000-RetireBacklog.ts:3`.
- **Draft bundled into triage** (C38): the reply is written before, and without, any knowledge of cards, packs or docs.
- Recorded, so not misunderstandings: `plan_wrong` and `re_plan` return to ② Triage (O38, O40); a conversation ends `archived` after a click (O37); the Plan stage sits in the "Approved" column and its gate in "Triage" (O11); checkpoint pushes go to `refs/luna/wip/…` and the regression sweep runs in Verify (O15); decision slots default per scorecard, not Jev (O22).

## 7. Not verified

- Whether an edited Slack message that was already read ever updates its item (C9).
- Whether narration and recording run in parallel (O18); the Verify → Build loop's line in `transition.ts` (O39); stage internals of ③-⑦ beyond `docs/architecture.md` (other sections' scope).
- `card.base` / stacked branches: no field found in `machine/src/domain/task.ts`, pipeline branch code not read (T75).
- `machine/src/application/pulls.ts`, `adapters/github/octokit.ts` and the board's rendering code (`ui.rs`) were not read; board evidence is from `slack.rs`, `keys.rs`, `inbox.rs` and greps of `app.rs`.
- Whether intake's `triage_signals` calls run on the haiku fallback when Jev has no key (the comment in `classify.ts:1-4` says both "else its fallback engine" and "Without a Jev credential it says nothing").
- No test was run; every claim is from reading.
