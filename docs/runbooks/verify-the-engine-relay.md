# Verify the engine relay

This runbook runs condition 2 of [RFC 0009](../rfcs/0009-sandbox-state-of-the-art.md). The egress proxy relays the Claude API, so a Claude stage holds a placeholder and never the real credential. Nobody has run the relay against the real API yet. Run this smoke test once before you rely on the relay.

The test makes one tiny real model call. It runs on your machine, never in CI. It needs a Claude credential.

## 1. Run it with the subscription token

```sh
pnpm --filter @hardness/machine relay:smoke
```

The script finds the credential as the machine does. It reads `CLAUDE_CODE_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `~/.config/hardness`. It starts the relay on `127.0.0.1` and gives the SDK only a placeholder. It prints no credential value.

With no credential, the script prints what to set and exits with code 2.

## 2. Run it again with an API key

Environment variables win over files. So blank the token and pass the key:

```sh
CLAUDE_CODE_OAUTH_TOKEN= ANTHROPIC_API_KEY=<your key> pnpm --filter @hardness/machine relay:smoke
```

The first line of the output names the credential kind. Check that it says "API key" on this run and "subscription token" on the first.

## 3. Read the output

Each check prints `PASS` or `FAIL`. Look at these:

- **The streaming check.** "The reply streams" must pass. Partial messages must arrive before the result. A fail means the relay buffers the response.
- **`permissionMode`.** The script prints `init permissionMode`. The env scrub forces it to `default`, so `dontAsk` is not honoured. An unlisted tool is denied and does not hang. The script then prints a note.
- **The tools.** "A tool in allowedTools runs (Read)" must pass. "A tool outside allowedTools is denied (Bash)" must pass too.
- **The relay log.** The script prints one JSON line for each request the relay saw. Every status must be 200 to 399. Look for any `refused: "path"` line. It means the SDK sent a call that the relay does not allow. The allow-list is `POST /v1/messages` and `POST /v1/messages/count_tokens`.

The last line says "all checks passed", or how many failed. The exit code is 0 only when all pass.

## 4. If a check fails

- A `refused: "path"` line names a path the SDK needs. Do not widen the allow-list yet. Decide first whether the call is safe, and record it in RFC 0009.
- A 401 means the relay did not swap the credential. Check the credential kind against the header in the log.
- Any extra host or call that the placeholder hid turns the RFC's go into a no-go for the relay. Stop and say so in the RFC.

## 5. Roll back

Set `MACHINE_ENGINE_RELAY=off` on the machine and restart it. Claude stages then hold the real credential again, as before the relay.

Codex, OpenAI and Jev stages are not relayed. This switch does not change them.
