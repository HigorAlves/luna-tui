# RFC 0013 — Designer agents: design specs, accessibility, design parity and an MCP bridge

- **Author:** Higor Alves
- **Status:** Draft
- **Created:** 2026-11-19
- **Decision deadline:** 2026-11-26
- **Discussion:** to come (the PR that adds this file)
- **Related:** [RFC 0002](./0002-native-agent-runtimes.md) (packs on each runtime), [RFC 0005](./0005-software-factory-v1-5.md) (Plan, Build, Verify, gates), [RFC 0009](./0009-sandbox-state-of-the-art.md) (egress, trust), [RFC 0011](./0011-small-agent-teams.md) (small teams, evals)

## Summary

Luna builds UI without looking at the design, and nothing checks that what it built is accessible. This RFC adds a team of four designer agents:
- a **design-spec writer** in Plan;
- a **ui-designer** helper that builds UI slices in Build;
- an **accessibility auditor** and a **design-parity reviewer** in Verify.

All four also run on demand from the TUI and Luna Notch. They read Figma and Mobbin through a new **MCP bridge**. The machine holds each MCP connection and its credential. It serves the allowed tools to the stage through the `luna` tools, over the mailbox the machine already reads. No token enters the sandbox, and egress stays default-deny.

## Goals

- A UI card is planned from its design. The plan carries a design spec: frames, tokens, components, states and accessibility notes.
- A UI card is built by an agent that has the spec and live, read-only access to the design.
- Verify judges a UI change against WCAG 2.2 AA and against its Figma frames. Blockers go back to Build, as Verify's findings do today.
- A person signs off on the design only when parity findings stay open.
- One mechanism (the bridge) gives any pack read-only MCP tools. Packs need no new egress, and no credential enters the container.
- Each phase is usable on its own and has an offline eval.

## Non-goals

- Writing to Figma, or any MCP tool that changes state. v1 bridges reading tools only.
- Generating designs. The agents read a design that a person made. They do not invent one when no design exists.
- A repo that declares its own MCP servers. Only the machine declares servers.
- Native apps (iOS, Android). Parity and accessibility cover web UI rendered in the QA browser.
- Pixel-exact visual regression testing. A pixel diff is evidence for a person, never the verdict.

## Background

- **External services.** CLAUDE.md says the machine talks to an external service through a port and an adapter, and that the data reaches a model only as a pack's `StageInput`. Slack triage is the reference: the host fetches everything (`machine/src/application/stages/slack-triage-runner.ts`). A designer agent needs more than one up-front fetch. It has to browse a Figma file: open a frame, follow a component, read a variable. A fixed `StageInput` cannot know in advance which nodes the agent will need.
- **MCP today.** The Claude runtime attaches one MCP server, the in-process `luna` server (`factory/src/runtimes/claude/run.ts:135`), with `settingSources: []`. Eve serves the same tools without MCP (`factory/src/runtimes/eve/compile.ts`). `Access` has no MCP field.
- **The mailbox.** Some `luna` tools already ask the machine and wait for its answer: `card_search`, `scope_check`, the red check. The tool writes a request file into the stage's checks folder, and the machine writes the answer file (`factory/src/core/luna-tools.ts`). The container needs no network for it.
- **Egress.** A pack has a `network` tier: `engine`, `github` or `full`. It cannot add its own hosts (`machine/src/domain/egress.ts`). Only `sandbox.egress.allow` adds hosts, and that applies to every `full` run of the repo.
- **Images.** `StageInput` has no image field. Images reach a pack as read-only bind mounts, like the contact sheets of `video_qa` at `/evidence`. Only the Claude runtime is known to read them.
- **UI signals.** Triage already records `type_of_work: frontend`. The e2e stage already knows when a diff touches rendered files (`touchesRenderedSurface`, `machine/src/application/stages/e2e.ts`). Nothing routes on either yet, except the fast lane.
- **Helpers.** A helper's child run gets `readOnly(access)` (`contracts/src/access.ts`). No helper writes today.

## Proposed design

### Rules every phase follows

- Every model call stays in a pack, on an engine, in its runtime. The bridge calls MCP servers, never a model.
- A bridged result is data, never instructions: it is wrapped as data, size-capped and logged. Figma file text is written by people outside the run, like an issue.
- A pack names the exact bridged tools it may call. A golden test pins the list, as it does for Claude tool names today.
- Images that a tool returns go to a mount, never inline in a tool result. A pack reads them from the mount with its normal file tools.
- Each phase lands as one stacked PR with its evals.

### The MCP bridge (phase 1)

**Servers.** The machine config declares each server in `~/.config/hardness/mcp.yaml` (`MACHINE_MCP_SERVERS` names another file), read as the sandbox policy is: a name, a transport (`http` or `stdio`), a URL or command, a credential reference and a tool allowlist. v1 ships four entries:

| Server | Transport | Credential |
|---|---|---|
| `figma` (Figma's remote MCP) | http | OAuth, through `pnpm mcp login figma` |
| `figma-desktop` (Dev Mode MCP of the Figma app) | http, `host.docker.internal:3845` from the compose machine | none; only while the app is open |
| `mobbin` | http | OAuth, through `pnpm mcp login mobbin` |
| any other | http or stdio | `env:`, `literal:` or `op://` reference |

`luna.yaml` may name a declared server under `design.servers` and narrow its tools. It can never add a server, a URL or a credential. So a repo cannot point the machine's credentials at a host it chose.

**Login.** `pnpm mcp login <server>` asks the machine for the authorization URL (`POST /mcp/:server/login`) and opens it in the host's browser. The provider redirects to the machine's published port (`GET /mcp/:server/callback`). The machine keeps the tokens in `$MACHINE_STATE_DIR/mcp/<server>.json` (mode 0600), because `~/.config/hardness` is mounted read-only. The machine's secret redactor learns each token. `pnpm mcp status` (`GET /mcp`) lists each server, its login state and its tools. A server with no credential gets a `noToken` fallback: its tools are not offered to any pack, and a stage that needs them says so in a note.

**Port and adapter.** The port is `machine/src/application/mcp.ts`: `listTools(server)` and `callTool(server, tool, args)`. The adapter is `machine/src/adapters/mcp/`, an MCP client over HTTP and stdio. The machine connects when a stage that needs a server starts, and closes the connection when the stage ends.

**In the stage.** `Access` gains `bridge: { server: string; tools: string[] }[]`. The factory serves each allowed tool as a `luna` tool named `<server>_<tool>`, for example `mcp__luna__figma_get_design_context` on Claude. Eve serves it bare. A call writes `mcp-<n>-request.json` into the checks folder. The machine checks the server and the tool against the pack's access and the repo's narrowing, calls the server and writes `mcp-<n>.json`. Each result is wrapped as data and capped at 64 KB. The image parts of a result are written to `/design/<n>-<i>.png`, a read-only mount. The stage needs no new host on its network.

**Audit.** Each call is a `design.mcp_call` row on the card: server, tool, arguments hash, bytes and outcome. A refused call (a tool that is not allowed, a server with no login) is a row too.

**Record and replay.** `MCP_BRIDGE_MODE=record|replay` makes the adapter write each call and result to an eval fixture, or answer from one. The evals of every later phase run offline on replayed calls.

### Design spec and accessibility audit (phase 2)

**The design reference.** The machine finds a card's design in three places. It parses Figma URLs from the issue or ticket body and its attachments. Else it uses `luna.yaml` `design.figma`, a file key and an optional page. An on-demand run takes a link field. The design reference is `StageInput.context.design`: file key, node IDs and where each came from.

**`design_spec` pack.** Role `design-spec-writer`, on the bridged Figma and Mobbin reading tools, read-only, network `engine`. It runs in Plan before the planner when triage records `type_of_work: frontend` or the card has a design reference. It answers a `DesignSpec`:
- frames and viewports;
- tokens (color, type, spacing, radius), from Figma variables where the file has them;
- components and their Code Connect mapping where one exists;
- states: default, hover, focus, disabled, loading, empty and error;
- accessibility notes from the file's annotations.

Where a frame has no state, the spec writer may cite a Mobbin pattern as a suggestion. It never presents a suggestion as the design. The planner reads the spec as data. A plan scenario can cite a spec frame by ID, and the parity reviewer later checks that frame.

**`a11y_audit` pack.** Role `a11y-auditor`. It runs in the QA image on network `full`, as `e2e` does, against the app that Verify started. It drives the browser itself because axe needs a live DOM. It runs axe-core through Playwright on each UI scenario's page and state. Then it judges what axe cannot: focus order and focus visibility, names and labels, contrast in hover and focus states, reduced motion, zoom to 200% and keyboard traps. It may read Mobbin for conventions. It answers findings by level, each with a WCAG success criterion, the page and state, the selector and the evidence (a screenshot and the axe rule).

**The level.** The default is WCAG 2.2 AA. axe `critical` or `serious` findings and judged failures are blockers. `moderate` and `minor` findings are `should_fix`. `luna.yaml` `design.a11y.level: AA | AAA` and `design.a11y.mode: gate | advisory` change it. `advisory` makes every finding `should_fix`.

**On demand.** From the TUI and Luna Notch:
- "spec from `<figma link>`";
- "audit accessibility of `<target>`", where the target is a QA target by name.

Each run goes through `POST /runs` as untrusted input, as Slack triage does. The output is a report on the board. One key (`c`) makes a card that carries the findings and the design reference into the pipeline.

### Design parity and the sign-off gate (phase 3)

**Capture.** When a change touches rendered files and has a design reference, Verify's browser run also takes screenshots. It captures each UI scenario at the viewports and states of the spec frames that the scenario cites. The machine writes them to `/evidence/parity/<scenario>/<viewport>-<state>.png`.

**`design_parity` pack.** Role `parity-reviewer`, read-only, network `engine`. It reads the captures from the mount and pulls the frame renders and design context through the bridge. It compares tokens first, from the computed styles that the capture also records (color, type, spacing, radius), then layout, then states. A pixel diff image goes to the evidence as an aid, never as the verdict. It answers findings by level, each naming the frame, the node and the build element.

**Where the results go.** Parity and accessibility findings join Verify's merged list. They follow `verify.build_rounds` like any blocker. `finding_classify` classifies them too. The PR's luna section gains a **Design & accessibility** block: the WCAG level, the open findings by level and the frame-and-build pairs as artifacts.

**`awaiting_design`.** After Verify, the card stops at this gate when:
- parity findings remain open (`should_fix` left, or blockers after the build rounds); or
- the parity reviewer's confidence is under the bar.

The gate shows each frame beside its build. A person approves, sends the card back with a note, or waives a finding with a reason. A waiver is ground truth for the parity evals. With no open parity finding, the gate does not fire.

### Image input on eve (phase 4)

The vision packs (spec writer, parity reviewer) must run on any family that a repo picks. So the eve runtime learns image input. When a pack reads a file under a mount that holds images (`/design`, `/evidence`), the eve runtime passes it to the model as an image, on engines whose catalog model takes images. The catalog in `contracts/src/models.ts` gains `vision: boolean`. An engine without vision is refused for a vision pack before a container starts. An eval of the `design_parity` cases on a `codex:*` engine must match the Claude baseline within the usual margin before `codex:*` joins those packs' `allowed` list.

### The ui-designer helper (phase 5)

**Role.** `ui-designer`, a helper of the implementer on UI cards. It has the design spec, the bridged Figma and Mobbin tools, and write access. It works tests-first, as the implementer does.

**Writable helper.** This is the first helper that writes. A helper keeps `readOnly(access)` unless its pack entry declares `writes: true`. The ui-designer is the only one that does.

**Parallel worktree.** When the implementer delegates a UI slice, the machine makes a branch from the implementer's head (`refs/luna/helper/<card>/<slice>`). It starts the helper in its own container on its own worktree. The implementer goes on with other slices.
- The plan's planned files decide ownership. A delegated slice locks its planned files. `scope_check` flags a blocker when either side touches the other's locked files.
- The helper owns its slice: `slice_set` for that slice and its own commits. The ledger records the slice's owner.
- When the helper returns, the machine, never a container, cherry-picks the helper's commits onto the card branch. It records the shas it made, so the `head_moved` trust check holds. The tests commit stays an ancestor.
- On a conflict, the machine re-runs the helper once on the new head. A second conflict escalates `merge_conflict`.
- After the cherry-pick, the implementer's next `slice_list` shows the slice as `committed`. The regression sweep and the scope check run over the whole branch as today.

### Routing

| Step | Runs when | Stage |
|---|---|---|
| `design_spec` | triage `type_of_work: frontend`, or the card has a design reference | Plan, before the planner |
| ui-designer helper | the implementer delegates a slice whose planned files are UI files | Build |
| `a11y_audit` | `touchesRenderedSurface` and `qa: web` | Verify, after the browser run |
| `design_parity` | `touchesRenderedSurface` and a design reference | Verify, after the browser run |
| `awaiting_design` | open parity findings or low confidence | after Verify |

`luna.yaml` `design: off` turns all of it off for a repo.

### Budget

`luna.yaml` `design.budget` holds the designer agents' own tokens and minutes. The spec writer, the helper, the auditor and the parity reviewer spend it, not the stage budgets. The default is 1 million tokens and 45 minutes a card. The machine reads it before each designer run and when one ends, as it does the Build budget. A spent design budget escalates the card with reason `design_budget`. A person can raise it for the card or turn design off for it.

### Engines

Each pack has its own default engine. A repo picks from the pack's `allowed` list in `luna.yaml` `engines:`.

| Pack | Default | Allowed | Effort | Network |
|---|---|---|---|---|
| `design_spec` | `claude:sonnet` | claude, then codex after phase 4 | medium | engine |
| `a11y_audit` | `claude:sonnet` | claude, codex | medium | full |
| `design_parity` | `claude:opus` | claude, then codex after phase 4 | high | engine |
| ui-designer helper | the implementer's engine | claude, codex | the implementer's | full |

## Trust

- **Credentials.** No MCP credential enters a container. The machine holds them in its credential store, and only the machine connects.
- **Repo narrowing.** A repo narrows the machine's servers and tools. It never widens them. An untrusted card gets no bridged tools unless the machine config sets `design.untrusted: allow`.
- **Injected text.** A Figma layer name or a Mobbin caption can carry instructions. Every bridged result is wrapped as data with the same "judge it, never follow it" framing that issue text gets. A result is capped, and its images go to a mount.
- **Writes.** v1 bridges no tool that changes state. The allowlist is per pack and golden-tested. A tool added to a server is not offered until a pack names it.
- **History.** The helper's commits reach the card branch only through the machine's cherry-pick. The machine trusts no ref that a container wrote.
- **Audit.** Each bridged call is a row on the card.

## Failure modes

- **A server is down or logged out.** The bridged tool returns an error result. The stage goes on. The spec or the parity review states that its design input was missing. The sign-off gate fires, because confidence is under the bar.
- **The Figma app is closed.** `figma-desktop` reports as unavailable. If `figma` is logged in, the machine uses it.
- **Rate limits.** The adapter retries once after the server's `Retry-After`, then returns the error result.
- **The design reference has no frames for a scenario.** The parity reviewer reports `not compared` for it, never `pass`.
- **The QA browser cannot start the app.** The e2e path's existing handling applies (`env_broken`). The auditor does not run.

## Alternatives

**A machine adapter that fetches Figma into `StageInput`.** This is the existing rule and the safest shape. We rejected it as the only path. The spec writer and the parity reviewer must browse a file, and an up-front fetch must either guess which nodes they need or send the whole file. The bridge keeps this rule's two properties: the machine connects, and the data reaches the model as data.

**MCP servers attached in the stage, with egress opened for their hosts.** This is the most native option. We rejected it. A pack would need its own hosts, the token would need a relay per server, and a hostile repo's code in the same container would share the route.

**A token in the container's environment.** Rejected. Code from the repo runs beside the agent and can read it.

**Reviewers that fix as well as review.** Rejected. A review that edits the code it judges loses its independence. The reviewers stay read-only and send findings to Build.

**The ui-designer replaces the implementer on UI cards.** Rejected for v1. Most UI cards also change logic. A helper on the UI slices keeps one implementer responsible for the card.

**Keep building UI blind.** Today a UI card's quality depends on how well the issue describes the design. Nothing catches accessibility failures before review.

## Open items

- **Figma's remote MCP and third-party clients.** Probed on 2026-11-19 (`machine/scripts/mcp-probe.ts`). `https://mcp.figma.com/mcp` answers 401 and publishes OAuth metadata: authorization server `https://api.figma.com`, scope `mcp:connect`, PKCE S256, a `state` parameter required, and dynamic client registration at `https://api.figma.com/v1/oauth/mcp/register`. The token endpoint takes only `client_secret_basic` or `client_secret_post`, so the machine registers as a confidential client and keeps the client secret beside the tokens. A registration from the machine was refused (`403 Forbidden`), so Figma accepts only clients it approved. Phase 1 therefore builds the bridge without any server-specific code and tests it on fixtures. `figma`, `figma-desktop` or a REST-based stdio server becomes an `mcp.yaml` entry once a Figma account is set up, and the live test happens then.
- **`op://` references.** They need the 1Password CLI installed and signed in inside the machine's image. `env:` works without it.
- **A server that refuses dynamic registration.** Figma's remote server needs a pre-registered client, saved as `<stateDir>/mcp/<server>.client.json`, which the provider reads.
- **`figma-desktop` reachability.** The app serves on the host's loopback. The compose machine reaches it through `host.docker.internal`, and only when it runs on the same computer as the app. Phase 1 states this in `pnpm mcp status`.
- **Mobbin's terms.** Using Mobbin screens as references inside an automated pipeline must fit its terms of use. To check before phase 2 enables it by default.
- **Computed-style capture.** Recording computed styles for each capture adds time to the browser run. Phase 3 measures it, and may cap it to the elements that the spec names.
  - *Measured (slice 30, QA image, agent-browser 0.39.2, 1440x4000 on a 300-element page, 200 of them kept by the probe):* the median of ten `qa-capture` calls is 0.38 s (range 0.36 to 0.39 s), under the 2 s bar, so the cap stays at 300 elements. Two things the probe showed: `agent-browser eval` prints the value as pretty-printed multi-line JSON (the tool parses the whole stdout, not the last line); and a screenshot that follows a viewport change after an idle gap stalls about 10 s, so the tool settles with an in-page wait through the driver instead of a sleep. A first capture straight after `open` still took about 10 s in four of four runs, and none after 2 s of idle, so the e2e prompt tells the agent to capture only once the page has settled.
- **Image input on Codex.** Probed 2026-11-20 (`factory/src/runtimes/eve/vision.live.test.ts`, `LUNA_LIVE_VISION=1`): `gpt-5.6-terra` (`codex:sol`) and `gpt-6-luna` (`codex:luna`) read an image from a tool result on the Codex backend: yes. Each named a red and a green square saved under a neutral name, and answered "unknown" when the image was withheld. `gpt-6-sol` (`openai:sol`, API key) was not probed and stays blind. Codex joins a vision pack only after `pnpm eval admit` (slice 60).
- **Helper concurrency limits.** Phase 5 starts with one helper at a time per card. More than one in parallel waits for numbers.

## Rollout

Five stacked PRs, in risk order. Each one is usable alone.
1. **Bridge.** Port, adapter, `pnpm mcp login | status`, machine server config, `Access.bridge`, the mailbox call, record and replay, and the CLAUDE.md amendment below.
2. **Spec and audit.** `design_spec`, `a11y_audit`, the design reference, `design.budget`, routing in Plan and Verify, and on-demand reports with make-card.
3. **Parity.** Capture, `design_parity`, the PR section and `awaiting_design`.
4. **Eve vision.** Image input on eve, `vision` in the catalog, and the parity eval on codex.
5. **Helper.** The writable helper, its parallel worktree, file locks, the cherry-pick and `merge_conflict`.

The CLAUDE.md rule on external services becomes: *"External services are talked to from the machine through a port in `machine/src/application/<service>.ts` and an adapter in `machine/src/adapters/<service>/`, with a `noToken…()` fallback. Their data reaches a model only as a pack's `StageInput`, or as a result of a bridged MCP tool that the machine called (RFC 0013)."*

## Evals

- **Spec.** Replayed Figma files with known tokens, components and states. The judge scores coverage and the absence of invented values.
- **Accessibility.** Seeded pages with known axe violations and planted judged failures (a focus trap, a missing label, low focus contrast). Scored on recall by level and on false blockers.
- **Parity.** Frame and build pairs with planted differences (a token swap, spacing drift, a missing state) and clean pairs. Scored on recall and false blockers. Waivers from `awaiting_design` become new cases.
- **Helper.** Cards with a UI slice and a logic slice: both land, scope stays clean, and no cherry-pick conflicts.

## Success criteria

Three months after phase 3:
- 80% or more of UI cards with a design reference reach the PR with no open parity blocker.
- The rate of false a11y blockers, from a person's waivers and dismissals, stays under 10%.
- No MCP credential in any container, environment or log. A test checks it.
- At most one `awaiting_design` stop per UI card on average.

## Decided

The grilling session of 2026-11-19 settled each of these:
- The roster: spec writer, accessibility auditor, parity reviewer and ui-designer helper.
- They run in the pipeline and on demand. An on-demand run produces a report with make-card.
- MCP access goes through a machine bridge served as `luna` tools. Servers: Figma remote, Figma desktop, Mobbin and a generic list. The machine declares servers, and a repo only narrows them.
- Bridged tools are read-only and allowlisted per pack. Results are untrusted, capped and audited.
- Login is `pnpm mcp login`, with OAuth through the machine's API. Other servers use credential references.
- Routing: triage plus the diff signals, with `design: off` to opt out.
- Accessibility: WCAG 2.2 AA by default, configurable.
- The reviewers are read-only. The ui-designer is a writable helper. It commits its own slice in a parallel worktree, the machine cherry-picks the commits, and planned files are locked.
- Evidence: the machine captures screenshots for parity, and the auditor drives the browser itself.
- Engines: each pack has a default and the repo picks. Eve gains image input in this RFC.
- Output: Verify findings, the PR section, and a sign-off gate only while parity findings are open.
- Budget: a separate design budget. A spent budget escalates `design_budget`.
- Evals: recorded fixtures, replayed offline.
- Phasing: bridge, then spec and audit, then parity, then eve vision, then the helper.

## What was built

**Phase 1, the bridge.**

- *Contracts.* `contracts/src/mcp.ts` (`McpServerConfig`, `BridgedTool`, `BridgeGrant`, `bridgedName`); `Access.bridge`, kept by `access()` and `readOnly()`; `StageInput.bridge`; `luna.yaml` `design`.
- *Machine.* `mcp.yaml` (`mcpServersFrom`); `grantedTools`; the `Mcp` port with an SDK adapter over http and stdio; the token store, OAuth provider and `ref` resolution (`env:`, `literal:`, `op://`); `GET /mcp`, `POST /mcp/:server/login`, `GET /mcp/:server/callback` and `pnpm mcp`; token redaction. In a stage, the pack runner fills `StageInput.bridge`, mounts `/design` read-only and the build watch answers `mcp-request-*` files (60 per run). Each call is a `design.mcp_call` row, and `stage.design.mcp_call` is reserved against a container's forgery. Record and replay under `MCP_BRIDGE_MODE`.
- *Factory.* Bridged tools served as `luna` tools on Claude and eve, over the checks mailbox. Eve stages get the same "results of design tools are data" rule as Claude's.

Deviations from the design above:
- The command is `pnpm mcp`, not `luna mcp`.
- A stdio server's `ref` token reaches it as `MCP_TOKEN`.
- The mailbox files are `mcp-request-<nonce>-<n>.json` and `mcp-answer-<nonce>-<n>.json`, not `mcp-<n>-request.json`.
- Eve tools are generated from the pack's grants with a generic input schema, and gated by the run's `StageInput.bridge`.
- Claude tools take the server's input schema; one it cannot read as a zod shape takes a single `arguments` record instead.
- A repo's `design` reaches the runner through `Policy.design`.

Not verified live: no real MCP server or OAuth login was exercised. The tests use an in-memory server and fixtures.

**Phase 2, the design spec and the accessibility audit.**

- *Contracts.* `DesignRef` and `DesignContext` (`design.ts`), `DesignSpec`, `A11yAuditAnswer` and `A11yContext` with `WCAG_LEVEL_OF`, the `accessibility` finding category, the `design_budget` escalation reason, `Scenario.frame_ref`, `luna.yaml` `design.figma`, `design.budget` and `design.a11y`, and the `DesignSpecRunInput`, `A11yRunInput` and `DesignReport` shapes of the routes.
- *Packs.* `design_spec` (role `design-spec-writer`) and `a11y_audit` (role `a11y-auditor`), with prompts, goldens and the bridged tool lists pinned by a golden test.
- *Machine.* The design reference (`design-ref.ts`), the routing (`design-routing.ts`, `verify-order.ts`), the audit's findings at the repo's level (`a11y-findings.ts`), the design budget (`design-budget.ts`, `design-run.ts`, `design.run` rows, `design.budget_reset`, `design.card_off`), the spec before the planner in Plan, the audit as an `afterBrowser` step in e2e, `BROWSER_PACKS` in the pack runner, bridged tools, mounts and a QA target in `runPackOnce`, and `POST /design/spec` and `POST /design/audit`.
- *QA image.* axe-core 4.14.0 (the version the lockfile already held) and the `qa-axe` helper.
- *Board.* `:spec <link>`, `:audit <target>`, the report popup, `c` to make a card from a report, and the `design_budget` label.
- *Evals.* The runner replays a case's `mcp/` folder and runs a browser pack in the QA image. Three `design_spec` cases on replayed fixtures and three `a11y_audit` cases on seeded pages.

Deviations from the design above:
- The audit runs inside the `e2e` stage, as a step after a passing browser run. There is no new task state and no `design_review` column.
- An a11y blocker follows `verify.e2e_rounds`, not `verify.build_rounds`, because it rides the e2e loop. The same blocker sent back after `build_rounds` does not escalate by itself. Phase 3 may extend the blocker set to e2e.
- `a11y_audit` is Claude-only (`claude:sonnet`, `claude:opus`) until an a11y eval on `codex:sol` matches the Claude baseline. The RFC table also lists codex. `design_spec` stays Claude-only until phase 4.
- The on-demand runs are two routes, `POST /design/spec` and `POST /design/audit`, over `PackRuns`, not `POST /runs`. A client of `POST /runs` would have to send a target URL and its credential, which the machine could not check. Both packs are route-only.
- An on-demand run counts as trusted for bridged-tool grants only. The caller holds the machine token, so it is the operator. The sandbox and the prompts still treat every input and tool result as untrusted data.
- In agent mode, with no `verify.e2e.start` and no deploy, there is no app URL, so the audit is skipped and `detail.a11y` says so. It does not run against an unrelated QA target.
- An a11y finding's id leaves out the axe rule and the state. Two rules or two states on the same criterion, selector and page merge into one finding, and the higher severity wins. This is on purpose, and a test pins it.
- The decision route now carries `design: "off"`: a person's answer to a `design_budget` escalation can turn design off for the card.
- The board gets `:spec` and `:audit`, a report popup (`:report` reopens it) and `c` to make a card. The report is held by the board; the machine keeps nothing of it.

Not verified live: no Figma server was reached, so the Figma tool names are the documented ones and the eval fixtures are written by hand. The QA image was built locally once, by an implementer, and has not run an audit against a real app. No `pnpm eval` run on a model has happened, so no baseline exists for either pack.

**Phase 3, design parity and the sign-off gate.**

- *Contracts.* `design-parity.ts` (`CapturePlan`, `ParityCapture`, `DesignParityAnswer`, `DESIGN_STATES`), `VerifyDesignReport` (`design-report.ts`; `DesignReport` stays phase 2's on-demand report), `StageInput.context.parity` and `parityPlan`, the `awaiting_design` state, the `designGate` stage event, `luna.yaml` `design.parity.bar` and `.publish`, and `PrExtra.design`.
- *Pack.* `design_parity` (role `parity-reviewer`), with its prompt, golden and bridged tool list. It drives no browser: it reads PNGs and styles from a mount.
- *QA image.* `qa-capture` writes `/out/files/qa/parity/<scenario>/<viewport>-<state>.png` and a `.styles.json` beside it. Measured: a median of 0.38 s per capture. A first capture right after `open` stalls about 10 s, so the e2e prompt says to capture once the page has settled.
- *Machine.* The capture plan from the spec and the scenarios (`parity-plan.ts`), the captures collected into the run, parity as an `afterBrowser` step and a sub-run `<runId>-parity` (`design-parity.ts`), `settleParity` (findings, merge, cap, gate reasons), `pairImages` (`adapters/image/parity-pairs.ts`), the e2e design blocker set, `awaiting_design` in the transition table and the pipeline, `waiveDesignFinding` and its route, `reports.verify.design` (`designOf`), the PR block and the pairs as Evidence (`design-publish.ts`, `GitHub.repoPrivate`), and `design.waived` and ground truth under `ground-truth/design_parity/`.
- *Board.* The `awaiting_design` gate (`a`, `r`), `:waive` and `:accept`, and a Design page that shows each frame beside its build.
- *Evals.* Seven `design_parity` cases on drawn frames and captures (`make-fixtures.mjs`, pngjs), and `pnpm eval harvest --pack design_parity`, which turns each waiver into a case.

Deviations from the design above:
- Capture is a tool the e2e agent calls (`qa-capture`), not something the machine does around the run. Only the agent knows when the page has settled.
- Parity is an e2e sub-run (`<runId>-parity`) behind the `afterBrowser` step, not a new task state. Only the gate is a state.
- A waiver has two kinds: `not_a_difference` (the reviewer was wrong) and `accepted` (it is a difference, and fine). The first becomes a case that expects no finding on the node; the second one that expects no blocker, with the reason in the rubric.
- The frame | build diff is made on the host with `pngjs` and `pixelmatch`, not by the model. A frame with no render, or a pair that fails, is `not compared`, never a pass.
- `design.parity.publish: auto` publishes the pairs only on a private repository. An unknown visibility counts as public.
- "Kept at sign-off" is derived (an approved gate and its findings that are not waived), not stored.
- The harvest reads the waiver file and the sub-run's own folders (`in/stage.json`, the frame render in `design/`, the capture in the e2e run's `parity/`), not a bundle copied at waiver time. The case replays the render as a `get_screenshot` answer keyed by `{ fileKey, nodeId }`, because the machine records no bridged call outside `MCP_BRIDGE_MODE=record`. It holds the waived frame alone. The plan's `writeTruthBundle` and the `design_parity` recording in the pack runner were not built.

Known gap: the ship monitor's restack rebuilds the PR body without the card's facts, so the Design & accessibility block drops, as the findings already did.

Not verified live: no Figma account, so no real frame has been compared. No live parity run has happened (the tests use in-memory fixtures and drawn PNGs), and no saved eval baseline exists for `design_parity`, because `pnpm eval` needs a Claude login. The Figma tool names and answers in the eval fixtures are hand-written. The harvest ran only on synthetic waivers.

**Phase 4, image input on eve.**

- *Image mounts (slice 50).* `IMAGE_ROOTS` (`/design`, `/evidence`, `factory/src/core/roots.ts`) are read roots on both runtimes. The runner passes the ones present as `paths.images`; Claude adds them to its read roots and `additionalDirectories`, eve to its guard's.
- *Attachments (slice 51).* eve writes each file a tool returns under `.eve/attachments` in the workspace. The sandbox connection now maps that path to `<state>/attachments` (`LUNA_EVE_ATTACHMENTS`), so no image lands in the worktree. The path is normalised before the prefix check, so a `..` cannot climb out of the store.
- *The catalog (slice 52).* `caps.vision` is required on every model. `AgentPack.vision?: true` is set on `design_spec` and `design_parity`. `visionProblem(pack, engine)` says what is wrong, and `engines.test.ts` checks that no vision pack allows a blind engine.
- *Refusal (slice 53).* `chooseEngine` refuses a blind engine as it refuses one a pack does not allow. `fallbackCandidates` never yields one. The pack runner checks again for a resumed or handed engine, before the container starts, and the factory checks in `main.ts` after the effort check. `pnpm eval` refuses it too.
- *The eve gate (slice 54).* `read_file`'s model output goes through `visionGate`. On an engine with vision it is eve's own, an image as a file part. Without, it is the text line plus a note that the engine cannot read images. The runner sets `LUNA_EVE_VISION` from `caps.vision`, and a compiled subagent takes its own engine's vision. A dry run's session options carry `vision`.
- *Conformance (slice 55).* A table row reads a PNG under an image mount. On a fake whose engine sees, it checks the image part reached the model, and that no `.eve` folder appears in the worktree. `EveOptions.vision` is the seam for a fake and for the probe.
- *The live probe (slice 56).* `factory/src/runtimes/eve/vision.live.test.ts`, run with `LUNA_LIVE_VISION=1` on the Codex login. See the open item on Codex. `gpt-5.6-terra` (`codex:sol`) and `gpt-6-luna` (`codex:luna`) pass; their catalog entries are `vision: true`. Two 64x64 fixtures (`red.png`, `green.png`) live in `factory/test-fixtures/vision/`.
- *The 3 MiB drop (slice 57).* The bridge drops an image over `MAX_IMAGE_BYTES` (3 MiB) before the per-call and per-run caps. It counts in `McpAnswer.imagesDropped` with the other drops.
- *Admission (slice 58).* `pnpm eval admit --pack <p> --engine <e> --against <claude:*> [--write]` (`evals/src/admission.ts`) compares two saved baselines and writes `evals/baselines/<engine>/<pack>.admission.json`. `TIE_POINTS = 0.02` is the margin; at least `MIN_CASES_TO_MOVE` (8) graded cases. A test fails when a vision pack allows a non-Claude engine with no passing record.
- *Docs (slice 59).* The runbook [admit an engine to a vision pack](../runbooks/admit-an-engine-to-a-vision-pack.md), the evals README's margin fixed to 2 points, and the architecture and configuration notes.

Deviations from the design above:
- eve shows any image its `read_file` reads, wherever it is, as Claude's `Read` does. The image mounts matter as read roots, not as a gate on image parts (decision D2).
- The catalog started with all three OpenAI entries at `vision: false` (D3). The probe flipped `gpt-5.6-terra` and `gpt-6-luna`. `gpt-6-sol` is API-only and was not probed, so it stays false.
- The probe passed on the Codex backend, so decision D4's fallback (a wrapper that moves the image into a user message) was not needed.
- The margin is `TIE_POINTS` (2 points), not the 3 the evals README had said (D6).
- `video_qa` does not get `vision: true` (D9): it judges from text when it must. Only its comment changed.
- Where the gate is checked: besides `chooseEngine`, the pack runner and the factory each refuse a blind engine, so a resumed or handed engine cannot slip by.
- `recall` and `falseBlockerRate` count in the gate only where both baselines carry them. The parity grader does not record them yet, so today the gate rests on the pass rate.

Not done, on purpose: Codex sees images but is in no vision pack. `design_parity` and `design_spec` still allow only Claude engines. It joins after `pnpm eval admit` passes against the Claude baselines (slice 60, a follow-up PR). No `design_parity` or `design_spec` baseline is saved yet, because that needs a live Claude run. `gpt-6-sol` is unprobed.

Not verified live: the probe ran on the Codex login only. No live run of a vision pack on any engine has happened, and no `pnpm eval admit` has run on real baselines.

**Phase 5, the ui-designer helper.**

- *Contracts and pack.* `ui_design` (role `ui-designer`, `claude:sonnet` and `claude:opus`, `vision: true`, not on demand), `UiDesignAnswer` (`escalation` set means it could not build), `AgentPack.helpers[].writes`, `StageInput.context.delegation` and `context.helper`, the `merge_conflict` escalation reason, `BuildProgress.slices` and `.helper`, and `BuildReport.picked`.
- *Delegation rule.* `domain/delegation.ts`: `isUiSlice`, `locksOf`, `delegable` and the minute limits (`MIN_HELPER_MINUTES` 8, `IMPLEMENTER_RESERVE_MINUTES` 3).
- *Git.* `adapters/git/helper.ts`: the helper workspace, `takeHelperCommits`, `pickOnto` (plumbing, no work tree), `pickBundle`, `advanceBranch` (compare-and-swap), `landInWorktree`, and the boot check of the git version. Locks in the scope check (`locked_file`).
- *Machine.* `helperRuns` (`stages/helper-runs.ts`), the coordinator of one card's helpers; the build watch's three queues (`helper-request`, `pick-request`, `pick-ack`); the machine's `build.helper_*` rows (`domain/helper-events.ts`); the design budget counting helper minutes and tokens; `decideEscalation` facts for `merge_conflict` and `design_budget`; the board's owner and helper state (`reports.ts`).
- *Factory.* `slice_delegate` and `slice_wait`, the pick handshake in the container, `releaseOrphans`, and the `ui_design` run's own branch gate and importer.
- *Evals.* Three `ui_design` cases (`card-hover-focus`, `panel-empty-error`, `field-a11y`) on `fixtures/golden-ui`, and `pnpm eval build-helper`. An end-to-end test with fake containers and real git (`helper-runs.e2e.test.ts`, 12 cases) runs in CI.

Deviations from the design above:
- **D1.** `delegate` did not become parallel inside the container. Two luna tools, `slice_delegate` and `slice_wait`, go through the checks mailbox (`helper-request-…`, `helper-answer-…`, `helper-state-<slice>.json`), and the machine starts the container. `slice_wait` returns after at most 240 s, and it waits through a re-run after a conflict.
- **D2.** A pure UI slice is one where every planned file that is not a test renders and none is a manifest or a lockfile. A `package.json` change stays with the implementer, although `touchesRenderedSurface` counts it as rendered.
- **D3.** A slice that shares a planned file with another slice is refused, and the refusal names the files. A shared file of a slice that is already committed is no refusal.
- **D4.** A take that touches a locked file is not an escalation: nothing is picked, the slice goes back to the implementer, and a `build.helper_refused` row records it. After a security review the take also has an allowlist: a path must be one the slice planned, or a new file in a planned file's directory. A manifest, `.github/` and the card's test files are always refused. That reason is `out_of_slice`, and it is handled like `locked_file`.
- **D5.** The pick is plumbing (`git merge-tree --write-tree`), which needs git 2.40 or later. `node:24-slim` is bookworm with git 2.39, so `machine/Dockerfile` is now `FROM node:24-trixie-slim` (git 2.47, Node 24.22) and the machine checks the version at boot. `machine/runner/Dockerfile` stays on `node:24-slim`, on purpose.
- **D6.** A helper does not share a Codex login with the implementer: it takes the first Claude engine of its `allowed` list. Today `implementing` allows only Claude, so this is a guard, and a test pins it.
- **D7.** After a pass the machine waits for a running helper within its limit (its start plus its `budgetMinutes`) and picks itself. After anything else it cancels the helper. A cancelled helper's `build.helper_ended` row says `cancelled`, which it did not at first: it said `failed` until the last fix of the phase.
- **D8.** `merge_conflict` stops the card when the implementer's run ends, not at once. The reason is decided by a fact. Build rewrites every other escalation reason of the implementer to `other`, so the machine sets `detail.escalationFact` together with `detail.escalation`, and `decideEscalation` reads that for `merge_conflict` and for `design_budget`. `design_budget` applies only after a pass.
- **D9.** A card with no design reference does not delegate.
- **D10.** Both evals: the CI test (slice 83) and the local `ui_design` cases and `pnpm eval build-helper` (slice 84).
- `advanceBranch` checks by itself that the new tip descends from the old one (`merge-base --is-ancestor`), and `pickBundle` takes only a ref under `refs/luna/helper/`. Both came out of the security review of slices 70 to 76, with the allowlist above.
- The factory writes its ledger only after the machine's `pick-done`. It first marked the slice committed before the ack and counted a missing `pick-done` as success; a refusal now resets the merge (`git reset --keep`, only while HEAD is still the picked tip), and a timeout keeps it until the next `syncPicks` sees the machine's `committed` state and a HEAD that holds the tip.
- The helper's effort is the repo's `effort.implementing`. There is no per-task effort to read.
- The `build.helper_*` kinds are the machine's own rows (`EMITTABLE` in `ports.ts`), not entries of `STAGE_REPORTS`, and `isReservedKind` reserves the whole prefix. A container's rows of those kinds are dropped at ingest. The design budget counts the `design.run` rows and the `build.helper_ended` rows, and Build's budget skips the rows stamped `by: "ui-designer"`.
- The board reads a helper's state from the rows. A re-run after a conflict writes no start row, so the attempt and the state come from the last row. The Rust board ignored the new fields at first; since the review it shows them (see below).
- The `ui_design` cases and the build-helper cards share one fixture repo, `fixtures/golden-ui`, with a logic file, three scenario tests and a tokens file.

Not verified live: no Figma account, so no real frame has reached the helper and the Figma answers in the `ui_design` fixtures are hand-written (the live Figma test is deferred). No `pnpm eval --pack ui_design` run has happened, so there is no baseline. `pnpm eval build-helper` has not run either: it is written and its report shaping is tested without a model, but a real run needs a Claude login and the stage image. The `ui_design` checks read the answer, not the commits, so "the scenario tests are green" and "the spec's token names are in the code" rest on the judge's reading of what the helper says until a run keeps its worktree. No live run of the helper in a real container with a real model has happened. The end-to-end test uses fake containers.

**After the merge: a review and its fixes.**

A team of reviewers read PR #235 after it merged. Each took one lane: the bridge, the packs and the budget, parity, the gate, vision and admission, the board, and the helper on each side. One more read it for security. A second review then read the fixes. These are the changes:

- *Artifacts and captures.* Ingest skips an artifact whose path is absolute, holds `..`, or whose real parent is outside the run's real `out` folder. That hole is older than this RFC; the review found it through the captures. `collectCaptures` keeps only files that really live under the run's `parity` folder. A capture's width must be the viewport's or a whole multiple of it. `qa-capture` no longer writes `captures.jsonl` (nothing read it), and it stops after 60 s (`QA_CAPTURE_TIMEOUT_MS`) as a driver failure, exit 124.
- *Parity.* A frame past the capture cap is a `not_compared` row ("over the capture cap"), not a dropped one. With no capture at all, no `design_parity` sub-run starts and each row says `no capture`. A finding stands only on a row the reviewer compared. The machine places it by frame and state from its own plan. It never reads the model's word for the viewport. It drops a finding on a state that nobody compared, with a note. The finding's id takes the plan row's node.
- *Waivers.* A waiver holds in later rounds. The `design.waived` row keeps the finding's id, the kind and a hash. For a parity finding the hash covers the expected and built values. For an accessibility finding it covers the state and the axe rule (or `judged`). When a later round raises a finding with the same id and hash, the machine shows it as waived. It does not count it or send it back. A changed value opens it again, and a row with no hash waives nothing. Waiving a finding twice does nothing the second time, and the counts move in the report the finding came from.
- *The gate and the budget.* The machine writes `design.budget_reset` and `design.card_off` in the decision's own transaction. It reads `design: "off"` on a decision only for a `design_budget` escalation. `design.budget.max_tokens: 0` and `max_minutes: 0` are config errors that point to `design: off`.
- *The bridge.* A pack run closes its MCP connection however it ends. The client drops a cached connection only after a transport failure, not after a JSON-RPC error such as bad arguments. It connects again on the next call. Bridged calls queue in the factory, and one the machine does not answer in time returns `timed out waiting for the machine`. `designRefOf` merges node ids across sources, 20 at most.
- *Login.* A login that needs the browser keeps the stored tokens until the callback stores new ones. `GET /mcp` adds two fields. `loginPending` is true while a login that this process started is outstanding, for ten minutes at most. `loginFailed` is true when the last login's callback failed, or nobody finished it. `pnpm mcp login` waits on both, because an old token still reads as `loggedIn`. A new login for a server replaces its earlier one.
- *The audit.* The `a11y_audit` prompt passes `--level`, and uses `--inject` for a page behind a login or with state. `qa-axe` gives Playwright `NO_PROXY` as its bypass list.
- *The helper, on the machine.*
  - A helper's lock binds the implementer's commits made after the helper first started, less the commits the machine picked. The lock stays after the pick has landed. A file the implementer committed before it delegated is no violation. One committed after is, also when a conflict re-ran the helper.
  - A pick counts as landed when the card's tip is the picked tip or descends from it. So the end of a run never picks a slice twice. `cancel()` waits for the queue of picks and acks.
  - On a git older than 2.40 the machine turns delegation off and `context.delegation` says why. It no longer fails at the first pick.
  - The stuck detector does not count `slice_wait`. A helper must start within 75 s (`HELPER_START_LIMIT_MS`), inside the factory's 90 s wait. `helper-state-<slice>.json` carries the picked commit once the slice is `committed`.
  - At boot the machine removes helper clones that no run uses. It deletes a helper's refs once its pick has landed, and keeps them for a helper that did not land.
- *The helper, in the factory.* The factory handles `picking` like `returned`, and sends a lost ack again. When the machine refuses a re-sent ack, the factory takes the merge back only while HEAD is still the picked tip. With commits on top, it keeps the branch and tells the agent to stop and report. A slice the helper handed back (`refused`, `failed`, `cancelled`, `merge_conflict`) returns to the implementer as `pending` with a note. `slice_delegate` answers at once when delegation is off. The role and the prompt state the take rule.
- *The board.* Build and Now show a Designer block (each slice's owner and the helper's state), and `merge_conflict` has its own words. `:accept` says "difference accepted". The board asks the design-budget question even when it has not loaded the card's detail. The report popup wraps and shows the suggested fix. The Design page's cursor counts wrapped rows.
- *Evals.* `pnpm eval admit` exits 2 when it cannot compare two baselines: a metric missing on one side, fewer than 8 cases, or different case ids. It says when it decided on the pass rate alone. `pnpm eval harvest --pack design_parity` writes nothing without `--include-images`, prints each image it wrote, and replaces the card's Figma file key with a stand-in. `pnpm eval build-helper` stops on an interrupt and deletes its scratch folder after a pass.

The review did not reach everything. Nobody read these closely: the audit's mapping of findings, `qa-axe` as an attack surface, `designOf` in the reports, and eve's bridged tools and read-size check. Three things stay as they are, on purpose. The machine still writes `build.budget_reset` before its decision. `qa-capture` kills only its direct child on a timeout. The board's Runs and Evidence pages still count the cursor in unwrapped lines, which is older than this RFC. The factory's unit tests cover the hand-back and the `picking` retry. The end-to-end test does not drive them through the real coordinator.
