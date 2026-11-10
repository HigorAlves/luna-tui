# Run the token economy

This runbook covers the daily tasks of the token economy (RFC 0007). You can see what it learned, drop a wrong fact, approve a tool mask, import old runs and turn parts off. It also says what to check when a run ends with "the loop guard stopped the run". [Architecture](../architecture.md#token-economy) explains how each part works.

Every route here needs a repository that the machine knows. Name it by its absolute path. A path that the machine does not know gets a 400. With `MACHINE_ECONOMY=off`, the routes do not exist.

## See a repository's economy

Ask the machine for the repository's status:

```sh
curl -s '127.0.0.1:4317/economy?repo=/Users/me/shop'
```

The board shows the same data in its Economy view. Open it with `:economy`.

Read the answer in these parts:

- `envelopes` has, for each pack, the number of `samples` and the `envelope`. A null `envelope` means the guard only records. It acts after `economy.guard.envelope_min_samples` passing runs.
- `guard` lists the last 50 things the loop guard did: `gate`, `judge`, `redirect` and `stop`.
- `facts` lists every learned fact with its `state`, its `source` and its counts.
- `tools` lists, for each pack, the approved `mask` and the `proposal` with its evidence.
- `cost` gives effective tokens for the work (`exec`) and for the economy's own calls (`overhead`). When `overheadUnpriced` is above 0, `overhead` is a floor.

## Drop a wrong fact

1. Find the fact in `facts`. Note its `id` and read its `text`.
2. Send the drop. The machine never tells the fact again and never learns its key again:

   ```sh
   curl -s -X POST 127.0.0.1:4317/economy/facts/<id>/drop -H 'content-type: application/json' -d '{"repo":"/Users/me/shop"}'
   ```

3. Check that the answer is `{"dropped":true}`. The fact now has the state `dropped`.

A `false` answer means that the repository holds no fact with that id.

## Approve or restore a tool mask

The machine proposes a tool when no run ever used it. The proposal waits in `tools.<pack>.proposal`. Each unit has `unusedRuns` and `cards`.

1. Read the proposal. Check that you want each unit gone from that pack.
2. Approve it. The units become the pack's mask:

   ```sh
   curl -s -X POST 127.0.0.1:4317/economy/mask/approve -H 'content-type: application/json' -d '{"repo":"/Users/me/shop","pack":"implementing"}'
   ```

3. Check that the answer is `{"approved":true}`. The next run of the pack starts without those units.

The mask applies on Claude runs only. eve runs ignore it and emit an `economy_mask_skipped` note.

To bring a unit back, restore it. The unit is `web`, `agent`, `skill:<name>` or `luna:<tool>`. The machine never proposes it again:

```sh
curl -s -X POST 127.0.0.1:4317/economy/mask/restore -H 'content-type: application/json' -d '{"repo":"/Users/me/shop","pack":"implementing","unit":"web"}'
```

A `false` answer means that the pack does not have that unit.

## Import past runs

The machine learns from each run that finishes after you turn the economy on. To learn from runs that already exist, import them once:

```sh
curl -s -X POST 127.0.0.1:4317/economy/import -H 'content-type: application/json' -d '{"repo":"/Users/me/shop"}'
```

The answer is `{"runs": <number folded>}`. A second call answers `{"runs":0}`. The import gives envelopes from passing runs and tool evidence from Claude runs. Old runs carry no observation. So the import teaches no fact and writes no cost record.

## Turn a mechanism, or everything, off

For one repository, set the key in its `luna.yaml`:

```yaml
economy:
  loop_guard: off      # no redirect and no stop
  facts: free          # free facts only, no model call (off: none)
  tool_prune: off      # no evidence, no proposal, no mask
```

The next run reads the new value. The other keys are in [configuration](../configuration.md#the-economy-section-the-token-economy).

For the whole machine, set `MACHINE_ECONOMY=off` and restart the machine. No run then gets a guard, a fact or a mask. The machine learns nothing more. It leaves the files under `<state dir>/economy/` as they are.

To make a repository start over, stop the machine. Then delete the folder `<state dir>/economy/<repo slug>/`. A missing file reads as empty.

## When a run ends with "the loop guard stopped the run"

The guard ended the run and the machine escalated the card. Use these steps to find out why.

1. Read the escalation reason on the card. It names the cause, the count of the repeated failure and the calls spent.
2. Open the run's `events.jsonl` at `<state dir>/runs/<run id>/out/events.jsonl`. Find the `economy.guard` rows.
3. Read the sequence. A `gate` row means the gate opened. A `judge` row means the guard asked the machine. A `redirect` row means the run got a note. The `stop` row names the cause.
4. If the cause is `environment`, fix the environment. Look for a missing command, a refused host or a missing credential.
5. If the cause is `repeating_failure` or `wrong_approach`, read the failing test and the plan. The plan can be wrong.
6. If the cause is `backstop`, the segment ran past the envelope and no judge said it was fine. Read the `envelopes` of the pack in `GET /economy`.
7. If the envelope is too tight, raise `economy.guard.backstop_mult`. Raise `economy.guard.envelope_min_samples` to get a steadier envelope. Or set `loop_guard: off` for the repository.
8. Resume or send back the card as you do for any other escalation.

A stop means that the guard judged the run to repeat one failure. It does not say that the code is wrong.
