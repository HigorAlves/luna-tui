# RFC 0007 — Memory for the machine, on Cognee

- **Author:** Higor Alves
- **Status:** Draft
- **Created:** 2026-11-06
- **Discussion:** the PR that adds this file
- **Decision deadline:** 2026-11-13
- **Builds on:** [RFC 0006](0006-diagram-v2-2-alignment.md) (the retro at `reviewing_memory`, the code graph, the visibility rules of dedup and `card_search`)

## Summary

Every card starts cold. The only things carried from one card to the next are the binding rules in `docs/agents/project-context.md`, which a retro proposes and a person approves, and the code graph. This RFC adds memory. The machine remembers what happened on past cards and what the company's and the project's documents say. It hands the relevant part to each pack as data, and it lets people ask it questions from the board, Slack and their Claude Code sessions.

Memory is [Cognee](https://docs.cognee.ai/) (Apache-2.0), run from its **official image, unchanged**, with its UI. Cognee calls OpenAI itself, with an **opt-in OpenAI API key of its own**, to build its graph and to write answers. Embeddings stay local (fastembed), so search never needs OpenAI.

Everything Luna-specific lives in the machine:
- **An adapter** (`machine/src/adapters/cognee/`) that talks to Cognee's REST API.
- **A metadata table** in our Postgres that remembers where each item came from.
- **The packs** that decide what is worth remembering.

Cognee's calls to OpenAI are the one model path outside packs, and CLAUDE.md records it as an exception.

## Goals

In shipping order:

1. **Stop repeated mistakes.** Plan, Build and Verify recall what went wrong on similar past cards: escalations and their reasons, Verify findings, scope reds, CI failure classes, review fix rounds, and a person's corrections.
2. **Smarter triage and dedup.** Triage sees how similar past cards turned out (actual size, retries, risk against what was predicted). Dedup shortlists by meaning as well as by words.
3. **Reviewer preferences.** What each team's reviewers keep asking for reaches the implementer before the PR opens.
4. **Project knowledge Q&A.**
   - The repo's own docs, a local folder of company documents (md, txt, pdf) and the code of `main` are indexed and linked into one graph.
   - Packs can draw on it.
   - People can ask questions on the board, in Slack and from Claude Code, and get answers that cite their sources.

## Non-goals

- **Replacing `project-context.md`.** It stays the short, binding, git-reviewed list of rules. Memory is advisory and is never an instruction.
- **Replacing Graphify.** Graphify stays the pipeline's map of the code: Triage's owners, Plan's `locate` and `code_map`, and Build's regression sweep. Cognee's code graph of `main` is added for Q&A only (see Code graphs).
- **Changing Cognee.** No fork, no routes added to its API, no image built on top. Everything Luna needs is on the machine's side of the HTTP line. An upgrade is a new pinned digest.
- **Routing Cognee's model calls through packs.** A bridge that would answer Cognee's LLM calls on a Codex engine was considered and left out (see Alternatives). Cognee's own OpenAI key is simpler, and the key's owner opts in knowing it is metered.
- **Confluence, Google Drive and other remote document stores.** A later RFC; each needs a port, an adapter and its own permission model.
- **Cognee Cloud.** Cognee itself runs on the machine. (The text it extracts from still goes to OpenAI; see Risks.)
- **Memory inside the stage container.** Containers never reach Cognee; the machine answers for them.

## Background

- **What exists.**
  - The retro (`machine/src/application/stages/memory.ts`) computes predicted-against-actual facts (`retroFactsOf`), asks `worth_learning`, and proposes rules for `project-context.md` in a draft PR after a person approves.
  - Recalibration and graph misses are recorded for the eval loop.
  - Dedup is lexical: `similar` shortlists five cards with no embeddings.
  - `card_search` returns titles of the same repository's cards from the same source.
  - Ground truth for every gate lands under `<state dir>/ground-truth/`.
- **What the test drive of 2026-11-06 showed.** A one-line README move hit six machine bugs. A second card of the same shape would meet the same Verify findings and the same scope misunderstanding, because nothing from the first card reaches it.
- **Cognee, as of v1.6.1 (2026-09).**
  - What ships: a Python library, CLI, REST API (port 8000), MCP server (port 8001) and a local web UI (port 3000: Graph, Datasets, Search, Sessions), Apache-2.0. The official image is `cognee/cognee`.
  - Operations: `remember` / `recall` / `improve` / `forget` (formerly `add` / `cognify` / `search` / `memify`).
  - Model use: extraction (`cognify`) and the answer-writing search types call an LLM, OpenAI by default (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`).
  - Core dependencies, so in the official image (checked in its `pyproject.toml` and Dockerfile): fastembed, `pypdf` and the code graph's extractor `enola-cli`.
    - fastembed's model (`BAAI/bge-small-en-v1.5`, about 67 MB) downloads on first use into the Hugging Face cache (`HF_HOME`).
    - With an LLM key set and no `EMBEDDING_*` setting, Cognee embeds with OpenAI.
    - Office formats need the `unstructured` extra, which the image leaves out.
  - The REST API takes text, files, URLs and repository paths into named datasets, each with `external_metadata`. HTTP search takes a query, a search type, a list of datasets, `topK`, `onlyContext`, `nodeName` and a `codeQuery` (the docs said otherwise; the image's OpenAPI and M0 say so).
  - The API is multi-user by default (`ENABLE_BACKEND_ACCESS_CONTROL`), with login endpoints.
- **Ports.** Laminar already publishes `127.0.0.1:8000` and `8001` in our `compose.yaml`.

## Proposed design

### High-level shape

```
                ┌──────────────────────── machine (TS) ─────────────────────────┐
 card closes ──▶│ MemoryWriter: machine facts + memory_extract lessons           │
 PR merges ────▶│   (Jev: memory_worth, memory_conflict; person at retro gate)   │
 docs change ──▶│        │                                                       │
                │        ▼                                                       │
                │ application/memory.ts (port) ── adapters/cognee/ (REST client) │
                │ memory_items table (Postgres): provenance, anchors, status     │
                └──────┬─────────────────────────────────────────────────────────┘
                       │ REST, a machine user's token, internal network
                ┌──────▼─────────────────────────────────────────────────────────┐
                │ cognee (official image, pinned digest, unchanged)               │
                │ LLM: OpenAI, its own key ─────▶ egress proxy ─▶ api.openai.com  │
                │ embeddings: fastembed, local (weights on `cognee-models`)       │
                │ SQLite + LanceDB + Kuzu on the `cognee-data` volume             │
                └──────▲─────────────────────────────────────────────────────────┘
                       │ 127.0.0.1:8010 (API), 127.0.0.1:3000 (UI), profile memory-ui
                    you, in a browser, to look
```

- **Read path:** the machine pushes `context.memory` into a pack's StageInput, and the `memory_recall` luna tool asks the machine (the `card_search` pattern).
- **Ask surfaces:** the board pane, the luna MCP `recall` tool on the host, and the Slack conversation route.

### Cognee, as shipped

- **The official `cognee/cognee` image,** pinned by digest in `compose.yaml`, with its own `cognee-data` volume, and Cognee's default embedded stack (SQLite, LanceDB, Kuzu). Not our Postgres: the graph-on-Postgres path is a demo, and memory should not share the machine's migrations.
- **The LLM.**
  - `LLM_PROVIDER=openai`, with the key read from `~/.config/hardness/cognee-openai-key` (mode 600, like the machine's other secrets).
  - The key is its own, not the `OPENAI_API_KEY` of the `openai:*` engines. We recommend a separate OpenAI project with its own monthly budget, so memory's spend has a hard ceiling and shows on its own line.
  - `LLM_MODEL` comes from the model catalog: `contracts/src/models.ts` gets a `cognee` entry with its price. `pnpm start` renders `~/.config/hardness/cognee.env` from the catalog, so no model ID is written in `compose.yaml`.
  - **No key: local mode.** Without the file, Cognee runs keyless. It extracts with its local GLiNER model (a shallower graph, no answer-writing search), and recall and the code graph work as with a key. The Floor says which mode memory is in. `memory: off` in `luna.yaml` or `MACHINE_MEMORY=off` turns it off; then the port is `noMemory()` and Luna works as before.
- **Embeddings, local.**
  - `EMBEDDING_PROVIDER=fastembed` with `BAAI/bge-small-en-v1.5`, set explicitly; with a key present Cognee would otherwise embed with OpenAI.
  - Recall never calls OpenAI, so search is fast, free, and works while OpenAI is down.
  - `HF_HOME` and `FASTEMBED_CACHE_PATH` point under `/cognee-storage/models` on the `cognee-data` volume, filled once on first start. (The image runs as uid 1000 and only `/cognee-storage` is its own: a separate volume mounted elsewhere is root's and the download fails.)
  - The embedder's ID is in the catalog at zero price.
- **Network.** Cognee sits on an internal compose network with the machine. Its only way out is the machine's egress proxy, whose list allows `api.openai.com`, plus `huggingface.co` and its CDN while `cognee-models` is empty.
- **Other settings.** Auth stays on, with one machine user (`machine@luna.example.com`: Cognee refuses reserved domains such as `.local`) whose password the machine keeps in `~/.config/hardness/cognee-password`; the UI logs in as that user. `FASTAPI_USERS_JWT_SECRET` is set from `~/.config/hardness/cognee-jwt-secret`, or every token dies when the container restarts. Cognee's auto-feedback is off.
- **Dataset names.** Cognee refuses dots and spaces in a name; colons are fine. `repoSlug()` is already safe, and a channel or project id is made safe the same way.
- **Formats.** v1 indexes md, txt and pdf. Office formats are listed as skipped (Q8).
- **The UI.**
  - Where: Cognee's `frontend` service, on its own profile `memory-ui`, which `pnpm start` brings up by default as it does `observe`.
  - Ports, localhost only: the API at `127.0.0.1:8010`, because Laminar holds 8000 and 8001, and the UI at `127.0.0.1:3000`. The UI's backend URL and Cognee's CORS origin are set to match.
  - **The UI is for looking.** What someone adds or deletes there is reconciled by the machine (see Forgetting). The board's memory view is where memory is changed with a record.
- **Optional per repo.** `luna.yaml` `memory: off` turns memory off for a repository.

### Cost and visibility of Cognee's calls

- **Spend.** The OpenAI project's own budget is the hard ceiling. The machine reads `GET /api/v1/quotas/usage` hourly and shows memory's token use on the board's Floor beside the packs' spend. M0 checks what it reports.
- **A soft cap in the machine.** `memory.daily_cognify_items` (default 200). Past it, the machine stops asking `cognify` until the next day. Items stay searchable as chunks, and their graph waits. The first index of a big company folder is spread over days this way, with progress on the board.
- **Traces.** Cognee's calls are not in Laminar. Each `cognify` and answer-writing search the machine asks for is logged as a machine event (dataset, item count, duration, tokens when the usage endpoint gives them).
- **CLAUDE.md** gets two sentences:
  - Cognee, the memory service, calls OpenAI itself with its own opt-in key (`cognee-openai-key`), its model named in the catalog. This is the one model path outside packs, and memory is off without it.
  - A local embedding model serving Cognee is not a pack: it writes no text, runs offline and holds no credential.

### Key interfaces

- **`contracts`: `MemoryItem`.** One row of the machine's `memory_items` table per thing sent to Cognee:
  - `id`.
  - `kind`: `lesson`, `outcome`, `finding`, `escalation`, `review_ask`, `decision`, `doc` or `code`.
  - `repo`, or `null` for company documents.
  - `source`: `{ kind: github | slack | jira | tui | doc | code, ref }`.
  - `dataset`: the Cognee dataset's name and id.
  - `cogneeDataId`.
  - `anchors`: the files and the commit they were true at.
  - `provenance`: the card, the run, the pack, `machine` or `person`.
  - `trust`: `fact` (from the machine's records), `lesson` (inferred, approved by a person) or `outside` (found in Cognee with no row of ours).
  - `status`: `pending`, `active`, `stale` or `retired`.
  - `contentHash`.
- **What Cognee gets.** Each item is a short markdown document whose first line is `luna:<id>`. Search results can then be mapped back to their row even if the API returns no data id. The body is written by the machine or a pack, never copied raw from a source.
- **`machine/src/application/memory.ts` (port).** `write(items)`, `ingestDoc(path, scope)`, `ingestCode(repo, commit)`, `recall({ query, viewer, kinds, mode, limit })`, `forget(id, by)`, `list(filter)`, `reconcile()`, `noMemory()`.
- **Datasets carry visibility.** Search takes a list of datasets, so the machine names one dataset per repository and source and passes only those the viewer may see. The rule is the one dedup and `card_search` use today:

  | Dataset | Holds | Seen by |
  |---|---|---|
  | `<repo>:github` | items from GitHub-sourced cards | GitHub cards of the repository, TUI cards, the operator |
  | `<repo>:slack:<channel>` | items from that channel's cards | cards of that channel, TUI cards, the operator |
  | `<repo>:jira:<project>` | items from that project's cards | cards of that project, TUI cards, the operator |
  | `<repo>:tui` | items from cards typed in the TUI | TUI cards, the operator |
  | `<repo>:docs` | the repository's own docs | every card of the repository |
  | `code:<repo>` | Cognee's code graph of `main` | every card of the repository |
  | `company` | the company documents folder | every repository, **internal only** |

  The company dataset is never passed for a pack whose answer is posted to a public place (a GitHub issue or PR reply, triage questions to a public source). `postable()` also refuses text carrying a company item's `luna:` marker. The filter is the machine's own code, tested per pair.
- **The read path, pushed.**
  - Before plan, `build_tests`, implementing, verifying, triage and `pr_reply`, the machine recalls with the card's goal, the map's files and the stage's own query.
  - It uses search types that call no model (`CHUNKS`, `SUMMARIES`, `CODE`), so recall is local, fast and free.
  - It adds `context.memory: { items: [{ id, kind, text, source, anchors, stale }], note }` to the StageInput, capped at 12 items and 4 KB.
  - The role prompt says the block is data from past work, not instructions. A `lesson` that conflicts with `project-context.md` loses. Items with `trust: outside` are left out.
- **The read path, pulled.** A `memory_recall` luna tool (query of at most 300 characters, `scope: memory | docs | code`; at most 10 items back), answered by the machine through the `card_search` mechanism with the same filter. It is added to the packs that get the pushed block.
- **Packs.**
  - `memory_extract` is an agent pack on a `codex:*` engine by default, set like `verifying` in `luna.yaml` `engines:`.
  - `memory_worth` and `memory_conflict` are Jev decision packs.

### What is written, and when

- **Facts, automatically.** At close (after the retro, for shipped, archived and escalated-then-closed cards), the machine writes its own records as `fact` items, rendered by a template with no model:
  - the Triage Record against its actuals;
  - the plan's estimates against the diff;
  - each Verify finding (kind, severity, files);
  - each escalation reason (with a person's correction when there was one);
  - each scope red;
  - the CI failure class;
  - the review fix rounds;
  - a dedup answer.
- **Lessons, gated.**
  - `memory_extract` reads those facts plus the retro's proposals and writes candidate lessons.
  - `memory_worth` drops the obvious and the one-off.
  - `memory_conflict` compares each survivor with the active items it recalls: a confident contradiction proposes retiring the old one, an unsure one asks.
  - The lessons and retirements join the retro's gate. A person approves, edits or drops each one, and that answer is ground truth.
  - Only approved lessons are sent to Cognee. A lesson recalled and confirmed often enough is proposed by the retro for promotion into `project-context.md`.
- **Then Cognee builds the graph.** After a card's items are added, the machine asks `cognify` on the touched datasets, under the daily cap.
- **Untrusted text.** Comment, Slack and Jira text reaches `memory_extract` only through `safe()`/`postable()`, as data. What goes to Cognee is the machine's template or a pack's capped text.
- **Documents.**
  - The repo's docs (markdown under `docs/`, `README*`, ADRs, RFCs) are re-added to `<repo>:docs` when a PR merges, on the trigger that rebuilds the code graph.
  - The company folder is named in the machine's own config (`MACHINE_MEMORY_DOCS`, host paths, never in a repo's `luna.yaml`). Its changes are picked up by a poll of content hashes, and files are uploaded to `company`.
  - Cognee parses, chunks, embeds and extracts them.
  - A changed file replaces its old data item. A deleted file retires it.

### Forgetting

- **Anchored to commits.** An item about files records the commit it was true at. Recall marks it `stale` when those files changed by more than `memory.stale_lines` since. A merged revert retires the items its PR's card created.
- **The Jev contradiction gate** at write time, as above.
- **A board memory view.** Browse a repository's or the company's memory, see each item's provenance, and forget it (`POST /memory/:id/forget`, which deletes the Cognee data item and marks the row `retired`). Each forget is recorded as ground truth and feeds the `memory_conflict` evals.
- **Reconciling the UI.**
  - **Additions.** A pass (`reconcile()`, hourly and on the memory view's open) lists each dataset's items. Anything in Cognee with no row of ours, such as an upload made in Cognee's UI, gets a row with `trust: outside`. It is shown on the board and left out of pushed recall until a person adopts it.
  - **Deletions.** A row whose data item disappeared is marked `retired`, with the note "deleted outside Luna".

### Ask surfaces

- **The board's ask pane** (`?`). An answer with citations: card ids, files and pages, PRs, symbols. Viewer: the operator, who sees everything. It is written by Cognee's `GRAPH_COMPLETION` over the viewer's datasets or by a `memory_answer` pack over recalled items (Q7).
- **Claude Code sessions.** The luna MCP server on the host gets a read-only `recall` tool that calls the machine's API with its bearer token. It returns items, not answers: the session's own model reasons over them.
- **Slack.** The `slack_triage` conversation route recalls with the channel as viewer. It sees that channel's items, the repository's docs and code, and the company dataset. The reply is still a draft a person taps to post.
- **Cognee's UI** for browsing the graph, at `127.0.0.1:3000`.

### Code graphs

Two graphs, each with one job.

**Cognee's code graph of `main`, for Q&A.**
- **What it holds.** Cognee's code pipeline (the `enola` extractor, a core dependency) builds modules, symbols, routes, services, storage, request flows, `calls` and `imports` edges. Docstrings and docs link to their symbols with `describes` edges. Its core makes no model calls.
- **Why it is in memory.** It shares a store with card history and documents. A question can go from a symbol to the RFC that describes it to the card whose escalation changed it, in one graph.
- **When it is built.** On the trigger that rebuilds Graphify's graph of `main` (the ship monitor sees a merge), with the poll as fallback, into `code:<repo>`.
- **How it is fed.** Cognee reads a repository from a path it can see (`ACCEPT_LOCAL_FILE_PATH=true`, `COGNEE_ALLOWED_LOCAL_FILE_ROOTS=/repos`), and its extractor writes a `.enola` folder inside it, so the path must be writable. The machine exports `origin/<default>` from the card-independent repository it already keeps with `git archive` (no `.git`, so nothing in it is ever handed to git again) into `<state>/memory/code/<slug>/<commit>/`, mounted at `/repos`, and adds `/repos/<slug>/<commit>`. The previous commit's copy is deleted once the new graph is built.
- **How it is queried.** `memory_recall` `scope: "code"` uses `SearchType.CODE`. The pipeline's own stages keep reading Graphify.
- **Unverified.** That the code pipeline can be started and queried over the REST API alone, with no change to Cognee. M0 checks. If it cannot, Q&A falls back to Graphify's graph of `main`, linked to memory by file path, and M5b is dropped (Q5).

**Graphify's graph of the card's branch, for Build and Verify.**
- **When it is built.** After each slice commit that the machine records (the bundle accepted into `M`), the machine builds Graphify's graph of that commit. It is the same sandbox job as the graph of `main`, over a clean checkout of the commit taken from `M`, never from `W`, so the host-git rule holds.
- **Where it lives.** `<state>/graphs/<repo-slug>/cards/<task>/<commit>/`. The next run of the card (the next slice, the regression sweep, Verify's fresh workspace) gets it mounted read-only.
- **How agents choose.** The graph tools gain `--graph branch|main`, defaulting to `branch` when one exists.
- **Cost and failure.** Incremental where Graphify can update from the previous commit, a full build otherwise. A build that fails or runs past `graph.branch_build_minutes` (3) leaves the previous branch graph in place, with a note; it never fails the card. Closing the card deletes its graphs.
- **Not memory.** It lands as its own wave, G1, parallel to the memory waves.

### Failure modes and invariants

- **Cognee is down or slow.** Recall has a 2 s budget. A miss is a note on the run, and the pack runs without the block. A write is queued in `memory_items` (status `pending`) and retried, never lost silently.
- **OpenAI is down, the key is revoked, or the budget is spent.** `cognify` fails, and the items stay searchable as chunks, because embeddings are local. The machine retries at the next window and shows the error on the Floor. Pushed recall never needs OpenAI.
- **Wrong memory.** It is data, capped and cited. A pack is told that `project-context.md` and the card's own evidence win. The board view and the contradiction gate remove it.
- **Leaks across sources.** The visibility filter is the dataset list, chosen by the machine. Tests pin each source pair and the company dataset's exclusion from public-posting packs.
- **Prompt injection in what Cognee reads.** A document can carry text aimed at the model inside Cognee's extraction prompt. Cognee's calls have no tools. The worst they can do is write a wrong fact into the graph, which lands in a dataset no wider than its source's.
- **Cognee upgrades.** Only the REST contract matters to us. The adapter's contract tests run against the pinned digest in CI, so an upgrade that breaks them fails the PR that bumps the digest, not a card.

### Migration: eight waves

| Wave | Delivers | Ships when |
|---|---|---|
| M0 | Spike on the official image with no change, decides go or no-go. Checks: fastembed runs from a seeded volume with OpenAI as the LLM; a PDF parses; search results map back to `luna:` ids; the usage endpoint reports tokens; the code graph can be built and queried over REST on this repo's TypeScript and Rust. Measures recall p95, OpenAI cost of a `cognify` of this repo's `docs/` and of one closed card, the code graph's build time, answers on about 20 real questions (Cognee's `GRAPH_COMPLETION` against a `memory_answer` pack, and against Graphify for code), memory on Docker Desktop | numbers in this RFC's notes |
| M1 | Compose service (pinned digest, internal network, egress list, the UI profile, auth, the rendered env), the `cognee` and embedder catalog entries, the CLAUDE.md exception, the port and adapter with `noMemory()`, `memory_items` and `MemoryItem`, `luna.yaml` `memory:`, the usage on the Floor | machine suite green with memory on and off; with no key, nothing starts and every card runs as before |
| M2 | Goal 1: automatic facts at close; `memory_extract`, `memory_worth`, `memory_conflict`; lessons at the retro gate; `context.memory` pushed to plan/build/verify; the `memory_recall` tool; evals | eval set shows fewer repeated findings with memory on |
| M3 | Goal 2: vector shortlist joins lexical `similar`; triage gets similar cards' actuals | dedup precision/recall on the labelled pairs no worse, recall better |
| M4 | Goal 3: review asks as items (reviewer, team, files); recalled for files those reviewers own | — |
| M5 | Goal 4: documents, repo docs on merge and the company folder by poll; the company dataset and its public-posting exclusion | leak tests green |
| M5b | Cognee's code graph of `main` per repository, rebuilt on merge; `memory_recall` `scope: "code"` | the question set from M0 answered with citations to symbols |
| M6 | Ask surfaces (board pane, MCP `recall`, Slack route), the board memory view with forget, reconciliation of the UI's changes, commit anchoring and revert retirement | — |
| G1 | Graphify's graph of the card's branch per slice commit, mounted into later runs and Verify; `--graph branch\|main` | Build and Verify suites green; a slice's graph build under the time limit on this repo |

M2 to M5b depend on M1; M6 depends on M2, M5 and M5b. G1 depends on nothing here and can run in parallel.

## Implementation notes (M0, 2026-11-06)

The spike ran the official image (`cognee/cognee@sha256:84584ead…`, 3.79 GB, Cognee's enola 0.4.30) on this machine, keyless, on Docker Desktop.

- **Go.** Everything the design needs is in the REST API of the unchanged image.
- **Writes.** `POST /add` takes `raw_data` items with `external_metadata` (`{"luna_id": …}`) and a `node_set`, and returns one data id per item. `GET /datasets/{id}/data` returns each item's `externalMetadata`, so `reconcile()` maps Cognee's items to our rows by `luna_id`, not by parsing text.
- **Recall.** `POST /search` with `searchType: CHUNKS`, `onlyContext: true`, `verbose: true` returns `objects_result` with a score, the chunk's text, its `document_id` (the data id) and its `external_metadata`, in 0.07 to 0.15 s. A dataset with no graph yet returns an error for that dataset only. `GRAPH_COMPLETION` with `onlyContext` returns the graph's triplets with no model call (0.12 s), useful context for the ask surfaces.
- **Keyless.** `cognify` with no key extracts with GLiNER, which Cognee installs on first use (about a minute, so its index needs the egress list once, like the embedder). That made "local mode" the default without a key, instead of memory off.
- **The code graph.** A local path is detected as a code project. The read-only mount failed (the extractor writes `.enola` inside the repository). A writable `git archive` copy of `main` (1,638 files) built in 12 s: 9,783 nodes, 24,087 edges, 7,196 symbols (2,042 with docs), 17 flows. Facts by language: TypeScript 8,708, Rust 1,422, markdown 1,008. Q5 is answered: TypeScript and Rust are both covered (the board's `client.rs` functions are symbols). Keyless, the 674 document files of the project are left out of the code graph (their pipeline needs a model); the repository's docs reach memory through `<repo>:docs` anyway.
- **Code reads.** `capabilities`, `architecture` (it found the machine's Hono routes), `search`, `impact_analysis` and `ask` (a no-model, ranked walk; 0.05 s) answer through `searchType: CODE` with a `codeQuery`.
- **Auth and paths.** Register refuses reserved e-mail domains. Without `FASTAPI_USERS_JWT_SECRET` tokens die on restart. The image runs as uid 1000 and only `/cognee-storage` is writable by it, so the model caches live there.
- **Resources.** 1.65 GB of memory after the code graph, on a host with 7.7 GB for Docker.
- **Pending a key:** the OpenAI cost of a `cognify` (Q2), what `/sessions/cost-by-model` reports, `GRAPH_COMPLETION`'s written answers (Q7), and PDFs outside a code project.

## Alternatives considered

### A bridge: Cognee's LLM calls answered by the machine on a Codex engine
- **What it is.** Cognee's OpenAI-compatible endpoint points at the machine, which runs each call as a `memory_llm` pack in a serving container.
- **What it gives.** It keeps the rule that every model call is a pack, runs on the Codex subscription, and puts every call in Laminar under our budget.
- **Why not chosen.** It is a bridge, a pack, a factory `serve` mode and JSON-schema plumbing to build and keep working, before memory does anything. The direct key needs none of it. It can still be added later behind the same configuration (Cognee only sees an endpoint and a key) if spend or the rule calls for it.

### Our own routes on top of Cognee
- **What it is.** An image `FROM cognee/cognee` with our routes mounted in the same process, writing pre-extracted facts with `add_data_points` and querying with Python-only search options.
- **Why not.** We would maintain code against Cognee's library internals, which renamed its core API within a year.

### Cognee with no LLM (GLiNER)
- **Why not.** GLiNER finds names, not lessons or relationships, and the answer-writing search stays off.

### pgvector in our own Postgres, no Cognee
- **What it lacks.** Document loaders, chunking, graph extraction, graph retrieval, the code graph and a UI; we would build each one.
- **Status.** If M0 fails, this is the fallback, and the port keeps the swap cheap.

### The TypeScript SDK in the machine
- **Why not.** Native bindings over an experimental Rust engine, tied to the platform. It runs in the machine's own process, so a crash takes the machine down.

### Keep doing what we do
- **What it is.** `project-context.md` stays the only carried knowledge.
- **Why not.** It holds rules, not cases. It grows only through a person's review of each retro, and it cannot answer a question.

## Open questions

- **Q1. Does the official image work as is?** M0 decides: local embeddings with an OpenAI LLM, mapping results back to `luna:` ids, the usage endpoint. If one fails without a configuration fix, the fallback is the "our own routes" alternative, then pgvector.
- **Q2. Cost.** What does a closed card, the repo's docs, and a company folder of a given size cost in OpenAI tokens? M0 measures; the OpenAI project's budget and `memory.daily_cognify_items` are the guards.
- **Q3. Should answers cite only, or also act?** Preferred: cite only. Opening a card from an answer is a later wave.
- **Q4. The company folder's scope.** One folder for the whole machine, or one per team? Preferred: one folder in v1, with subfolders becoming their own datasets later.
- **Q5. Does `enola` cover TypeScript and Rust well, over REST?** Answered by M0: yes (TypeScript 8,708 facts, Rust 1,422 on this repo, 12 s). M5b goes ahead.
- **Q6. Two graphs of `main`.** If M5b's answers prove better after three months, should the pipeline's stages move to Cognee's graph and Graphify keep only the branch graph? Preferred: decide then, from data.
- **Q7. Who writes answers on the ask surfaces?** Either Cognee's `GRAPH_COMPLETION` over the viewer's datasets (on the OpenAI key) or our `memory_answer` pack over recalled items (on Codex). M0 compares them on the question set. Preferred: the one with more correct citations.
- **Q8. Office formats.** docx, pptx and xlsx need Cognee's `unstructured` extra, which the official image leaves out. Should we convert them to PDF or markdown on the machine before upload, or build Cognee's image with that extra (`COGNEE_EXTRAS=docs`, still their Dockerfile, unchanged)? Preferred: their Dockerfile with the extra, if M0 shows the image size is acceptable.

## Risks and unknowns

- **Data goes to OpenAI.** Every item Cognee extracts from (card facts, approved lessons, the repo's docs, company documents, docstrings) is sent to OpenAI under that API account's terms. Company documents are the sensitive part. The folder holds only what the owner is willing to send; the RFC says so, and the board says so next to the folder setting.
- **Spend.** Metered and outside our packs' accounting. The OpenAI project budget is the hard ceiling, and the Floor shows the usage.
- **Memory poisoning.** A wrong lesson that is approved steers many cards. Mitigations: capped, cited, labelled as data, contradiction-checked, forgettable, and never above `project-context.md`.
- **Leaks across sources.** A bug in the dataset choice posts private text publicly, so it gets its own eval set.
- **Cognee's prompts are not ours.** We cannot tune extraction without a fork. M0's question set is the check.
- **Upstream churn.** Contained by the pinned digest and the adapter's contract tests.
- **Docker Desktop resources.** One more always-on service with an embedder, and the UI, measured in M0.
- **Does it help?** Recall that is not used, or that misleads, costs tokens for nothing. The M2 eval gate decides whether the pushed block stays on by default.

## Success criteria (three months after M6)

- On the replay eval set, the same finding kind on the same files recurs at least 30% less often with memory on.
- Verify rounds per card drop. Escalations whose reason a recalled item named drop.
- Dedup recall on the labelled pairs rises with precision no lower.
- People use the ask surfaces weekly, and at least 80% of answers carry a citation a person marks correct in the board view.
- No company-dataset text appears in a public post (leak tests in CI, and a check of posted text).
- With no key or with Cognee stopped, every suite passes and every card runs as before.
