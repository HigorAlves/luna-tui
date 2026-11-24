# RFC 0009 — Sandbox state of the art: the gaps against the Claude Code, Agent SDK and eve guidance

- **Author:** Higor Alves
- **Status:** Accepted, built (2026-11-16)
- **Created:** 2026-11-16
- **Discussion:** [PR #228](https://github.com/higoralves/luna-tui/pull/228)
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
- **gVisor.** Not available on this host at the time of this spike. A later test ran it; see "Test: gVisor" below.
- **Native Linux.** Not tested. Ubuntu 24.04's AppArmor user-namespace restriction may add a second blocker.

### Go / no-go for S7

**No-go.**

Enabling the layer means shipping a seccomp profile that opens the user-namespace, mount and `pivot_root` calls. These are the entry points of many past kernel CVEs. That trades away the container's hardening for a layer that guards only the Bash tool, while the whole stage already runs in the container. The Claude Code docs call the layer optional when an outer container isolates.

Revisit only with gVisor, or after an explicit decision to accept a custom profile, tested on native Linux.

## What was built

PR #228 builds every slice but S7, which the spike turned down. Below is each slice as it stands, and where it differs from the plan.

### S1 to S3: containers, secrets and the SDK's env scrub

- **S1.** Every container drops all capabilities and uses a private IPC namespace. Stage, check, app and install containers also get `no-new-privileges`, a read-only root and a pids limit. A service keeps five capabilities, because official database images start as root. Before the first container starts, the machine reads `docker info`. A daemon with no seccomp filter, or with `unconfined`, ends the card as `env_broken` (step `seccomp`). A seccomp profile path that is missing or not JSON is refused too.
- **S2.** No secret is an argument or a `-e` of any container, so `docker inspect` shows none. The machine writes each secret as a file. The folder is 0755 and its files are 0644. It sits inside a parent that is 0700 and owned by the machine's user. The container's user reads the files under `--cap-drop ALL` whatever its uid. `luna-env` in the runner image exports each file as a variable and then runs the command. It fails closed. A folder or file that it cannot read refuses the start, and so does a file whose name is not a variable name. It never prints a value. The machine and `luna-env` both refuse a secret named like a variable that changes loading or traffic.
- **S3.** The Claude runtime sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. The findings are above.

### S5: the Claude credential behind a relay

- The egress proxy serves a relay on port 3129 of the card network. The real credential is a 0444 file in a 0700 folder, mounted into the proxy alone. The stage holds a placeholder of the same kind and `ANTHROPIC_BASE_URL`. The relay address is in `NO_PROXY`.
- The final allow-list is `POST /v1/messages` and `POST /v1/messages/count_tokens`, with any query string. The relay refuses any other method or path with 403. It refuses any path with a `%` in it.
- `--relay-deny-local <cidr>` is the subnet of the `hardness-egress` bridge. The relay refuses a request whose local address is inside it, so the proxy's other address is no way in.
- The placeholder and the kind are in `meta.json`, a second 0444 file. They are never on the proxy's command line, where `/proc/<pid>/cmdline` would show them.
- The proxy reads the token file once at start-up. A missing or empty file, or a newline in the token, stops it with exit 1 and a line that names the problem. A read that fails later answers 502, with the reason `credential`.
- The relay passes status, headers and body through unchanged, so a 429 or a 401 reaches the usage-limit fallback. `MACHINE_ENGINE_RELAY=off` restores the old behaviour.

### S4 and S6: the spikes

The two spikes are above. S4 gave a go with conditions. S6 gave a no-go, so S7 is not built. `bash_sandbox` in the machine policy is accepted and does nothing. The machine warns at start, and `GET /health` lists it under `notInForce`.

### S8 and S9: the machine policy and the bounds on a repo

- The owner writes `sandbox.yaml` (see [configuration.md](../configuration.md)). A repo's `luna.yaml` can ask for less than the policy allows and never more.
- The policy covers cpu and memory, the process limit (`limits.max_pids`), the seccomp profile, the runtime per trust, the cache split, the image sources (`images.repo_base`, `images.devcontainer`), the egress hosts a repo may add, and the proof of a `luna.yaml`.
- It covers every container the machine starts: stage, check, install, app and service containers, on-demand pack runs, evals, the graph build and the video tools. A service is capped at the cpu and memory of the container it runs beside.
- A host that a repo chose passes `egress.deny`, `repo_hosts` and `max_repo_hosts`. What the policy drops is in `bounds` on the repo's row in `GET /repos`.

### S10: trust

- A card is untrusted when its source is a GitHub issue or PR from an author outside `OWNER`, `MEMBER` and `COLLABORATOR`. Intake and the PR inbox record GitHub's `author_association` as `authorAssociation` on the card's source. A GitHub card with no association on record counts as untrusted. Cards and candidate lookups from the ticket machine record it too: for a GitHub ticket the machine reads the association, or asks GitHub once. If the read fails, the card stays untrusted and a `card.trust_unread` row says so. A Jira card is trusted.
- An untrusted card gets its own cache volume and the runtime that `runtime.untrusted` names, such as gVisor `runsc`. The egress proxy always stays on `runc`.

### S11, S11b and S12: the image

- **S11.** The machine reads `.devcontainer/devcontainer.json`. Its `image` becomes the base, after the same approval and probe as `sandbox.image.base`. Its `containerEnv` reaches the repo's own commands, never an agent stage.
- **S11b.** A devcontainer `build.dockerfile` builds only after a person approves its exact content. The key is `dockerfile=sha256:<hex>`, over the Dockerfile's bytes, the sorted build args and the context path. The build runs on the default network, with open egress and no secret, because BuildKit refuses the per-run network. **The limit:** the approval covers the Dockerfile only. The other files in the build context are not covered, and a `COPY` can read them.
- **S12.** The probe checks each tool in the repo's `toolchains` against the image. A mismatch is a note, never a refusal.

### S13: the network of each pack

Every agent pack declares its network in `packages/contracts/src/packs.ts`: `engine`, `github` or `full`. Most packs reach only their engine. The writable build, verify, e2e, recording and setup stages are `full`.

### Review rounds

The review rounds found 24 issues, and the PR fixes all of them. A later gap round fixed what remained: the relay's start-up token check, the recovery of council containers and orphan proxies after a restart, the sweep of run secrets inside `recover()`, the `bash_sandbox` flag, and unit tests that no longer reach the real docker daemon.

## Still open

- Codex, OpenAI and Jev are not relayed. Their stages still hold the engine's credential.
- Condition 2, the real relay smoke, has not run. Run it before you rely on the relay. See [verify-the-engine-relay.md](../runbooks/verify-the-engine-relay.md).
- The eval scorecards for the eve 1.0.0 and SDK 0.3.325 bumps are still to run. The bumps shipped in this PR against "a bump goes alone", by the maintainer's choice.
- gVisor is tested behind an isolated docker daemon, not on a native Linux host that runs Luna's machine. See "Test: gVisor".

## Test: gVisor

This test ran gVisor `runsc` release-20261109.0 (arm64). It ran behind an isolated docker daemon (`docker:29-dind`, `--add-runtime runsc`), which ran on Docker Desktop 4.99. Docker Desktop's own settings did not change. The runner image came from `pnpm images` at this PR.

**What holds under runsc:**

- The stage flags hold: the root is read-only, `/tmp` takes writes and runs files, the uid is not root, no capability is in effect, and `no_new_privs` is set. The kernel reads `4.19.0-gvisor`.
- Luna's own start-up checks pass on that daemon. The seccomp filter is active, and `runsc` is listed. A runtime that is not there (`kata`) is refused as `RuntimeUnavailableError`.
- `luna-env` and Node 24 run from the runner image under runsc.
- The egress integration suite runs with `RUNNER_TEST_RUNTIME=runsc`. All 8 of its cases pass, and a ninth proves that the probe ran inside gVisor. A stage reaches no address directly, gets 403 for a host off the list, is refused for literals, `localhost`, the metadata address and private hosts, reaches the listed server through the proxy, and reaches no other run. The proxy stays on runc.

**What gVisor changes:**

- **Docker Desktop.** gVisor shows the files that Docker Desktop shares from the host as root's (`0:0`). This held in every file-access mode tried: the default, `--directfs=false`, `--file-access-mounts=shared` and `--overlay2=none`. A stage's uid then cannot enter a 0700 folder or read its worktree. Files on the daemon's own disk keep their owner. The runtime check now refuses `runsc` on a Docker Desktop daemon, so the card ends `env_broken` with a reason instead of failing on file errors.
- **DNS.** gVisor's own network stack does not run Docker's embedded resolver (127.0.0.11). A container cannot resolve another container by name or alias, so a stage could not reach its services. Luna now writes each service's name and address into the container's `/etc/hosts` (`--add-host`). A refused outside lookup still fails, but it does not reach the proxy, so it leaves no `blocked()` row.

**Still open:** run the same suite once on a native Linux host with `runsc` installed.
