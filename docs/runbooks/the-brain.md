# Run the company brain

This runbook covers the company brain ([RFC 0010](../rfcs/0010-company-brain-on-omnigraph.md)): starting it, checking it, rebuilding the graph, upgrading omnigraph and recovering a stuck lock. The examples use the `pnpm dev` ports. Under `pnpm start` the machine is on `4318` and asks for its API token.

## Start it

1. Run `pnpm brain`. It writes the tokens file once and starts the service.
2. Put `MACHINE_BRAIN_URL=http://127.0.0.1:8090` in `.env` (`http://brain:8080` for the machine in compose).
3. Restart the machine, then check it:

   ```sh
   curl -s 127.0.0.1:4317/brain/health
   ```

`enabled: false` means the machine has no URL or could not read the three `luna-*` tokens. The machine's log says which. `ok: false` with `enabled: true` means the server did not answer.

## See what the last projection did

`GET /brain/health` has `last`: how many tasks it read, how many entities it loaded, how many rows it skipped as unchanged, how many edges it removed, and each hygiene query with its row count.

- A `note` that names the journal means `<state dir>/brain/journal.json` is damaged. The projector stops and never writes over it. Put a copy back, or move the file away to start a new journal from the machine's records.
- A `note` names an error code from the server. `forbidden` means a wrong token. `bad_request` usually means a row the schema refuses, and the message says which.
- A hygiene query with rows means the graph holds something it should not. `agents_without_owner` lists agent actors with no person. `prs_without_card` lists pull requests with no card.

To run the projector now:

```sh
curl -s -X POST 127.0.0.1:4317/brain/project
```

## Ask it a question

From the board, press the brain's key (see the key table in `board/README.md`), type a question and press enter. The answer names the rows it rests on.

It can answer about cards, pull requests, verdicts, components, lessons and a repository's rules. It also finds incidents by title, and the policy, control and approved-answer pages of a wiki by title. For a page it gives the path, never the text: open the wiki to read it.

From a shell:

```sh
curl -s -X POST 127.0.0.1:4317/brain/ask -H 'content-type: application/json' -d '{"question":"How far off was the estimate for the egress proxy card?"}'
```

The machine reads rows out of the graph with named queries, and the `brain_ask` pack answers from them on `claude:haiku`. `known: false` means the rows did not hold the answer. When the graph has no row for the question at all, the machine answers that itself and runs no pack.

- `brain_off` (503): the machine has no `MACHINE_BRAIN_URL`. See "Start it".
- `agents_off` (503): the machine runs no packs (`MACHINE_AGENTS=off`).
- `brain_ask_failed` (502): the pack's run failed or gave no valid answer. Ask again.

Search is by words, not by meaning. A question that uses other words than the cards' titles finds nothing. Name the ticket key, or a word from the title.

## Decide the claims that wait

On the board, `L` or `:memory` opens the Memory view. Each row is a claim the retro handed over: its risk tier, what Jev's answer and the code rules come to, and the statement. The detail shows the quote, its source and the rules that made it yours. `a` verifies and `x` rejects. `h` and `l` switch to the verified, rejected and refused claims.

From a shell:

```sh
curl -s 127.0.0.1:4317/brain/claims                                # the claims that wait, and the stats
curl -s -X POST 127.0.0.1:4317/brain/claims/<id>/verify
curl -s -X POST 127.0.0.1:4317/brain/claims/<id>/reject -H 'content-type: application/json' -d '{"reason":"only true for that card"}'
```

A refused claim never waits. The code checks turned it away, and `refusal` says why: its quote is not in its source, it holds a secret or an address, or its statement reads as an instruction.

## Remember a note of your own

```sh
curl -s -X POST 127.0.0.1:4317/brain/remember -H 'content-type: application/json' \
  -d '{"text":"The staging database is restored from the nightly dump every Monday.","repo":"/Users/me/shop"}'
```

A note is a statement of 12 to 300 characters. It is verified at once and becomes a lesson. A rule for agents does not belong here: put it in `docs/agents/project-context.md`.

## Let Jev decide alone

A repository starts in `shadow`: Jev's outcome is recorded beside each claim, and you decide all of them. The `stats` of `GET /brain/claims?repo=<path>` say how that went:

- `decided`: the claims you decided for which Jev had an outcome.
- `agreed`: how many of those it would have decided the same way.
- `missed`: how many it would have verified and you rejected. This is the number that matters most.

`ready` turns true at 50 decided claims, 95 in 100 agreed and no miss, and the Memory view's header then says "the shadow bar is met". Nothing changes the mode for you. When you trust it, set `brain: { admit: auto }` in that repository's `luna.yaml`. Jev then verifies and rejects alone, and you see only the claims it asks about. To stop taking claims from the retro, set `admit: off`.

## See what Jev did alone, and undo it

In the Memory view, `h` and `l` reach the page "since last week". It lists what Jev verified alone (a flagged claim is one it was not fully sure of), what it rejected alone, the lessons at risk and the contested claims. From a shell:

```sh
curl -s '127.0.0.1:4317/brain/digest?days=7'
```

- `x` on a claim Jev verified rejects it. `a` on a claim Jev rejected verifies it. Both ask first. On the verified and rejected pages the same keys work on any claim, whoever decided it.
- A lesson at risk rests on a claim that was rejected since. It stays in the graph, and no agent reads it any more. Nothing more is needed.
- A contested pair says opposite things. Reject one of the two claims to settle it.

A claim you reject after Jev verified it counts as a miss. One miss makes `ready` false again, which is the signal to go back to `shadow`.

## Let runs read the brain

Two keys in a repository's `luna.yaml`, both off until you set them:

```yaml
brain:
  tell: on                  # the brain_query tool answers, and reply drafts get the brain's rows
  precedents: [risk_score]  # these decision packs read their own earlier answers, with the truth
```

Turn on one thing at a time, and look at what it changes:

1. For a decision pack, run its eval cases before and after: `pnpm eval --pack risk_score --engine <its engine>`. A precedent is the pack's own earlier answer on a similar card, with what really happened. It can anchor the pack on the past, so check that the scorecard does not get worse.
2. For `tell: on`, read a triage run's transcript after a card or two. A `brain_query` call shows as a tool call with the query's name, and the answer's `verdict` is `ok`, `refused` (a name or a parameter an agent may not use) or `skipped` (the brain is off or not told to this repository).

The brain must hold something first. A new brain has no verdict with a known truth and no lesson, so precedents and queries come back empty until cards have closed.

## Read it from Claude Code

Your own Claude Code sessions can read the graph over MCP, with the token that only reads:

```sh
claude mcp add --transport http luna-brain http://127.0.0.1:8090/mcp \
  --header "Authorization: Bearer $(node -p "require(require('os').homedir() + '/.config/hardness/brain-tokens.json')['luna-reader']")"
```

The server lists its tools to any token, and its policy decides what runs: `luna-reader` can read and run the stored queries, and every write is refused. This is your own session, outside the machine: the list of queries a pack may run does not apply to it.

The server's MCP endpoint was checked with a plain MCP client (`initialize`, `tools/list` and a `tools/call` of `query`). It was not checked from Claude Code itself.

## Rebuild the graph

A rebuild empties the graph and loads the journal back. Use it after an upgrade, or when the graph and the journal disagree.

```sh
curl -s -X POST 127.0.0.1:4317/brain/rebuild
```

The journal is `<state dir>/brain/journal.json`. It holds every row the brain was given. Keep it: the machine prunes old events, stage runs and decision records, so the journal is the only copy of what was learned from them.

To start over from the machine's records alone, stop the machine, move the journal away and rebuild. Cards come back from the task table. A fact that came from pruned history, such as an old card's estimate, comes back null.

## Upgrade omnigraph

Omnigraph's storage format changes between minor versions, and an upgrade is one-way. So an upgrade is a new, empty graph and a rebuild.

1. Read the release notes for the versions in between. Look for a change to the HTTP contract version (the adapter sends `0.14`) and to the cluster commands that `brain/boot.sh` uses.
2. Change the image digest in `compose.yaml`. Keep `platform` until the project publishes an `arm64` image.
3. Remove the old graph, then start the new one:

   ```sh
   docker compose --profile brain down
   docker volume rm hardness-dev_brain-data
   pnpm brain
   ```

4. Run the live test against it. It loads every row type and runs every stored query:

   ```sh
   BRAIN_LIVE_URL=http://127.0.0.1:8090 \
   BRAIN_LIVE_FACTS_TOKEN=<luna-facts token> BRAIN_LIVE_READER_TOKEN=<luna-reader token> \
   pnpm --filter @hardness/machine exec vitest run src/adapters/omnigraph/live.test.ts
   ```

   The test leaves a few rows whose keys start with `live`. The rebuild in the next step removes them.
5. Rebuild: `curl -s -X POST 127.0.0.1:4317/brain/rebuild`. Check that every hygiene query in the answer has zero rows.

If the live test fails, put the old digest back, remove the volume again and rebuild. Nothing is lost, because the journal was not touched.

## Change the schema

1. Change the tables in `contracts/src/brain.ts`, then run `pnpm brain:schema`. Change `brain/queries/*.gq` and `BRAIN_QUERIES` together.
2. Run `pnpm --filter @hardness/contracts test`. It holds the schema file, the queries and the policies to the contracts.
3. Restart the service. `boot.sh` applies the change.

Omnigraph adds a type or a nullable property in place. It refuses a changed key, a changed cardinality and a changed property type. For those, remove the volume and rebuild, as in an upgrade.

## A lock stops the server

The server's log says `state_lock_held` and names a lock id. This happens when something other than `boot.sh` started the server, or when a second process used the volume.

1. Make sure no other container uses the `brain-data` volume.
2. Restart the service: `docker compose --profile brain restart brain`. `boot.sh` clears the lock it finds.

Never point a second server or an `omnigraph` command at the volume while the service runs. Omnigraph supports one writing process per cluster.
