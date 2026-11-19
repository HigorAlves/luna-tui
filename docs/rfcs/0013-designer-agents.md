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
| any other | http or stdio | `literal`, `op://` or `env:` reference, as for QA targets |

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
- **`figma-desktop` reachability.** The app serves on the host's loopback. The compose machine reaches it through `host.docker.internal`, and only when it runs on the same computer as the app. Phase 1 states this in `pnpm mcp status`.
- **Mobbin's terms.** Using Mobbin screens as references inside an automated pipeline must fit its terms of use. To check before phase 2 enables it by default.
- **Computed-style capture.** Recording computed styles for each capture adds time to the browser run. Phase 3 measures it, and may cap it to the elements that the spec names.
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

Nothing yet.
