# Turn on gVisor

gVisor (`runsc`) is a container runtime that puts a user-space kernel between a container and the host. The machine can run untrusted cards under it. A card is untrusted when its GitHub author is not an owner, member or collaborator. See "Trust" in [architecture.md](../architecture.md).

**Nobody has tested this on a host with `runsc`.** The code asks the daemon for the runtime and passes `--runtime`. No run of this repository has used `runsc`. Try it on a card you can lose first. [RFC 0009](../rfcs/0009-sandbox-state-of-the-art.md) lists this under "Still open".

## 1. Install `runsc`

Follow gVisor's own install guide for your host. Install the `runsc` binary and the `containerd-shim-runsc-v1` shim. gVisor is a Linux runtime. Your Docker daemon must run on Linux.

## 2. Register it with the Docker daemon

Add the runtime to the daemon's `daemon.json`:

```json
{ "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } } }
```

Restart the Docker daemon. Then check that the daemon lists the runtime:

```sh
docker info --format '{{json .Runtimes}}'
```

The output must have a `runsc` key. The machine runs the same command before the first container that needs the runtime.

## 3. Set the policy

Edit `~/.config/hardness/sandbox.yaml`, or the file named by `MACHINE_SANDBOX_POLICY`. Set the runtime for untrusted cards:

```yaml
runtime: { default: runc, untrusted: runsc }
```

To run every card under gVisor, set `default: runsc` too.

Restart the machine. It reads the policy file at start, so an edit counts after a restart. An unknown or invalid key stops the machine at start and names the key.

## 4. Check it

Start an untrusted card, such as an issue from an author outside the repository. The task gets a note: "This card runs untrusted ... the runsc container runtime". Its stage, check, install, app and service containers start with `--runtime runsc`. The egress proxy always stays on `runc`.

## Service names and the proxy

Under `runsc`, Docker's DNS does not resolve other containers by name or alias. The machine writes each service's name and address into the container's `/etc/hosts` with `--add-host`. So `postgres://postgres/app` works under `runsc` as under `runc`. A repo needs no change.

A DNS lookup that the proxy refuses leaves no row in the card's refused hosts under `runsc`. The lookup does not reach the proxy's resolver the way it does under `runc`. Read a missing host from the command's own error, not from the proxy rows.

## Docker Desktop

Do not use gVisor on Docker Desktop. It shows files shared from the host as owned by root, so a container cannot write the worktree as its own user. Use a Linux host.

## If it fails

Without `runsc` in the daemon, the card ends as `env_broken` at step `runtime`. The reason says the policy names a runtime that the daemon does not have. Do one of these:

- Install and register `runsc` (steps 1 and 2), then re-run the card.
- Set `runtime.untrusted` back to `runc` and restart the machine.

## Roll back

Set `runtime: { default: runc, untrusted: runc }` and restart the machine. Containers that already run keep their runtime.
