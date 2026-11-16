# RFC 0009 — Sandbox state of the art: the gaps against the Claude Code, Agent SDK and eve guidance

- **Author:** Higor Alves
- **Status:** Draft (2026-11-16)
- **Created:** 2026-11-16
- **Discussion:** the stacked PR on `feat/sandbox-hardening`
- **Related:** [RFC 0002](./0002-native-agent-runtimes.md) (runtimes), [RFC 0007](./0007-token-economy.md) (house style)

## Summary: the review

On 2026-11-16 the sandbox was reviewed against three documents: the Claude Code sandbox docs, the Agent SDK secure-deployment guide and eve's sandbox docs. This RFC records the gaps, and the evidence for the two spikes that decide the plan's later waves.

What already holds:
- The whole agent process runs inside the stage container: read-only root, non-root uid, `no-new-privileges`, and pids, memory and CPU limits.
- Each run has a per-run `--internal` network and a default-deny egress proxy.
- Git crosses the boundary only as checked bundles.
- eve runs on the `stage-local` provider inside the container.

The gaps:

| Gap | Guidance | Slice |
|---|---|---|
| Containers keep Docker's default capabilities and share the host IPC namespace by default | Drop all capabilities; private IPC | S1 |
| Service containers have no hardening | Same flags as stages, with a short add list | S1 |
| Nothing checks that Docker's seccomp profile is active | Refuse to run on `seccomp=unconfined` | S1 |
| Secret values ride as `-e` flags and show in `docker inspect` | Mount secrets as files | S2 |
| The SDK's children inherit the Claude credential | Set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | S3 (done) |
| The SDK may phone home | Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | S3 (done) |
| The Claude credential lives in the stage | A proxy injects it; the stage holds a placeholder | S4 spike, S5 |
| No Bash sandbox inside the container | The SDK's optional `sandbox` layer | S6 spike, S7 |
| Repos set their own sandbox policy, trust and image | A machine policy file, trust levels | S8 to S13 |

### What S3 found in the SDK

The scrub's logic is in the native binary (`claude` 2.1.311, SDK 0.3.311), not in the JS bundle. The JS only registers the name.

With `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` the binary removes these from what the agent spawns (Bash, hooks, MCP stdio servers):
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_OAUTH_TOKEN` and its sessions and refresh variants.
- The Foundry, AWS and Azure keys, `GOOGLE_APPLICATION_CREDENTIALS`, and a long list of CI and registry tokens.
- Credential-file pointers such as `KUBECONFIG`, `NETRC`, `DOCKER_CONFIG`, `SSH_AUTH_SOCK` and `CLAUDE_CONFIG_DIR`.

It does not strip `OPENAI_API_KEY`, `CODEX_HOME`, `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`. The machine already passes a stage only its engine's credential, so those never meet a Claude run.

Two limits:
- The SDK process itself keeps the credential. The scrub protects its children only. S5 is the fix for the process.
- With the scrub on, the binary forces the permission mode to `default` and warns, so `dontAsk` is not honoured. `allowedTools` stays the explicit allow-list, and a headless run has nobody to ask. This is not yet checked with a real tool call; S3's test covers only the options the runtime passes.

The eve side was already safe. A test now shows that `stage-local` gives a command no credential variable, even when the server holds all six.

## Spike: the SDK through a credential relay

**Question.** Can the SDK run with a placeholder credential and a base URL that points at a relay, so the real credential never enters the stage?

**What ran.** A scratch relay (a node HTTP server on `127.0.0.1`) and a logging CONNECT proxy, outside the repo. The relay logs method, path and header names, never values. One SDK `query()` ran per credential kind, with the prompt "Reply with OK", `maxTurns: 1`, no tools, `ANTHROPIC_BASE_URL` at the relay, the placeholder `luna-relay-placeholder`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `HTTPS_PROXY` at the logging proxy.

**Limit of this run.** The spike ran on a machine with no real Claude credential: no `CLAUDE_CODE_OAUTH_TOKEN`, no `ANTHROPIC_API_KEY`, no file under `~/.config/hardness/`. The relay therefore answered `401` itself and forwarded nothing. No model call was made. The request shape is recorded; the forward, the streaming and the real-credential path are not tested.

**Results.**

| | OAuth token | API key |
|---|---|---|
| Base URL honoured | yes | yes |
| Request | `POST /v1/messages?beta=true` | `POST /v1/messages?beta=true` |
| Credential header | `authorization: Bearer <value>` | `x-api-key: <value>` |
| `anthropic-beta`, `anthropic-version` | present | present |
| SDK on a `401` | retries (`api_retry` events), then ends with an error result | same |

Other headers, the same for both: `accept`, `content-type`, `user-agent`, `x-app`, `x-claude-code-session-id`, `anthropic-dangerous-direct-browser-access`, and the `x-stainless-*` set.

**Other hosts.** With `HTTPS_PROXY` at a logging proxy, no CONNECT arrived: the SDK contacted no host but the base URL in this run.

**A trap.** The SDK sends a plain-HTTP base URL through `HTTP_PROXY` when it is set. The first run sent every request to the proxy, and none reached the relay. The stage sets `HTTP_PROXY` for the egress proxy, so the relay address must be in `NO_PROXY`. S5 must set it and test it.

**Not tested.**
- Streaming. The relay must pass server-sent events without buffering. The run never reached a `200`.
- Whether a real OAuth token triggers calls that the placeholder does not (a profile or a refresh call). The binary knows `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`; the stage must not hold one.
- Whether a real credential changes the hosts contacted.

### Go / no-go for S5

**Go, with the first S5 test as the missing proof.**

Reasons:
- The SDK honours `ANTHROPIC_BASE_URL` for both credential kinds.
- It sends the credential in exactly one header per kind, so the relay can replace it by name: `authorization` or `x-api-key`.
- It sent only `POST /v1/messages` and contacted no other host. A relay that forwards only that path to `api.anthropic.com` matches the plan.
- Nothing seen forces a change to the S5 design.

Conditions:
1. S5 starts with a test of streaming through the proxy relay: chunks must arrive as they are sent.
2. Before S5 merges, one tiny real call per credential kind runs through the finished relay, with the owner's credential. That run records any extra host and any call the placeholder hid. If it shows one, S5 stops and this section changes to no-go.
3. The relay address goes in `NO_PROXY` in the stage.

## Spike: bubblewrap nested in the stage

**Question.** Can the SDK's optional `sandbox` layer (bubblewrap) run inside the stage container, under Luna's flags? This decides S7.

**Setup.**
- Docker Engine 29.9.3 (Docker Desktop 4.99.0), linuxkit kernel 7.0.14, aarch64, runc 1.5.2.
- Image: `node:24-slim` plus bubblewrap 0.8.0 and socat, run as uid 1000.
- Flags: `--init --read-only --tmpfs /tmp --security-opt no-new-privileges --cap-drop ALL --ipc private --pids-limit 1024`.

**Results.**
- **Default seccomp.** Both `bwrap` forms fail with "No permissions to create new namespace". `unshare -U` gets `EPERM`.
- **The cause is Docker's default seccomp profile, not the kernel.** `max_user_namespaces` is 64024 and `unprivileged_userns_clone` is 1. The default profile allows `unshare`, `setns`, `mount`, `umount2`, `sethostname` and `clone3` only with `CAP_SYS_ADMIN`. It allows `clone` only without the namespace flags, and never allows `pivot_root`. `--cap-drop ALL` therefore denies them all.
- **`seccomp=unconfined`.** The weaker-nested form works. A fresh `/proc` mount still fails, so `enableWeakerNestedSandbox: true` is required regardless.
- **A custom profile** (the default plus unconditional `unshare`, `clone`, `mount`, `umount2` and `pivot_root`) works under the Luna flags.
- **gVisor.** Not available on this host, so not tested.
- **Native Linux.** Not tested. Ubuntu 24.04's AppArmor user-namespace restriction may add a second blocker.

### Go / no-go for S7

**No-go.**

Enabling the layer means shipping a seccomp profile that opens the user-namespace, mount and `pivot_root` calls. These are the entry points of many past kernel CVEs. That trades away the container's hardening for a layer that guards only the Bash tool, while the whole stage already runs in the container. The Claude Code docs call the layer optional when an outer container isolates.

Revisit only with gVisor, or after an explicit decision to accept a custom profile, tested on native Linux.
