# Verify the stage guard

This runbook runs slice B1 of [RFC 0012](../rfcs/0012-ticket-safety-and-stage-guard.md). The stage guard sits between a Claude stage and the engine relay. Nobody has run it with a real token and the real SDK yet.

The test makes real model calls. It runs on your machine, never in CI. It needs a Claude credential, the engine relay and the egress proxy.

## 1. Run a stage with a real token

1. Build the images: `pnpm images`. It builds the guard image too (`RUNNER_GUARD_IMAGE`).
2. Set the policy in `~/.config/hardness/sandbox.yaml`: `guard: { trusted: log, untrusted: block }`.
3. Start the machine and run one card through a stage that has tools, such as Build.
4. Run a second card that comes from a GitHub author outside `OWNER`, `MEMBER` and `COLLABORATOR`. That card is untrusted.

The machine says at start if the guard cannot run. `GET /health` lists it under `notInForce` when the relay or the egress proxy is off.

## 2. Read the journal and the card events

The journal is `<runDir>/guard/calls.jsonl`. The run folder is under the machine's state directory (`MACHINE_STATE_DIR`). Each line is one call the guard judged.

The card shows `guard.blocked`, `guard.flagged` and `guard.suspicious` rows. A row holds the tool, the findings and the reason. It never holds the arguments or the task. Read them in `GET /tasks/:id`, under its recent events, or on the board.

On an untrusted card, one `guard.blocked` row holds the card. The card ends `escalated` with the reason `guard_blocked`. The gate runs after the stage ends, so it is not live.

## 3. A false positive

A false positive is a `guard.blocked` row for a call that a normal build needs. Look for:

- A build or test command that the findings call a reach for the environment.
- A call that the stage repeats, because the notice told the agent to try something else.
- A trusted card with many `guard.flagged` rows for ordinary work.

The guard has no allow-list. The way to loosen it is the mode. Set `guard.untrusted: log`, or `guard.trusted: log`, in `sandbox.yaml`. In `log` the guard records and passes every call. You can also raise `block_severity` to `critical`.

Record each false positive and the finding that caused it in RFC 0012.

## 4. Switch modes

- `off`. No guard starts for that trust.
- `log`. The guard records what it would block and passes the call. This is the default.
- `block`. The guard replaces a blocked call with a notice. On an untrusted card, the stage then ends `guard_blocked`.

A repo's `luna.yaml` may ask for a stricter mode. It can never loosen the owner's policy. Restart the machine after you edit `sandbox.yaml`.

## 5. Roll back

- Set `guard: { trusted: off, untrusted: off }` in `sandbox.yaml`. No guard starts.
- Or set `MACHINE_ENGINE_RELAY=off` on the machine. The guard sits in front of the relay, so no guard starts. Claude stages then hold the real credential again.

Restart the machine. A card already held as `guard_blocked` waits for a person: retry the stage or abandon the card.

## 6. The B1 checklist

Record each result in RFC 0012. Any "no" is a no-go for `block`.

- [ ] A real token and the real SDK run a stage through the guard and the relay.
- [ ] A blocked tool call in a streamed reply reaches the stage as a notice. The SDK does not hang or retry without end.
- [ ] The false-positive rate on a normal build stage is acceptable. Count the `guard.blocked` and `guard.flagged` rows over a few runs.
- [ ] `NO_PROXY` matches the guard's IP address. The stage reaches the guard and not through the proxy.
- [ ] No extra host appears in `sandbox.egress_blocked` rows.
- [ ] A real judge call has an acceptable time, with a Jev pack start. Run it with a Jev key.
- [ ] The judge route works under compose: a guard container reaches `host.docker.internal:4319`.
- [ ] The linux/amd64 guard image builds.
