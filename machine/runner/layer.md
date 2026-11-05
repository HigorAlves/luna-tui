# The machine's layer: `/opt/luna`

Everything a stage needs of the machine is in one directory of the runner image, so it can be copied onto
another image (a repository's own base) and run there: `COPY --from=<runner image> /opt/luna /opt/luna`.

| Path | What |
| --- | --- |
| `bin/luna-stage` | the stage's entry: the factory on the layer's Node, the layer's tools first on `PATH` |
| `bin/node`, `bin/rg` | wrappers that run `libexec/<name>` with `lib/` in `LD_LIBRARY_PATH` (only for these two, and what they start) |
| `bin/gh`, `bin/codex`, `bin/graphify` | the GitHub CLI (static), the Codex CLI (`codex/`), Graphify (from `python/`) |
| `libexec/` | the real Node and ripgrep binaries |
| `lib/` | the shared libraries those two need, everything except glibc itself (libstdc++, libgcc, pcre2 ...) |
| `python/` | a relocatable standalone Python (python-build-standalone, pinned) with the pinned Graphify installed in it; the base image's Python is never used or touched |
| `graph-tools/build.py` | the graph build, run with `python/bin/python3` |
| `factory-src/` | the factory and contracts with their production dependencies and built eve agents; `/factory-src` is a symlink to it in the runner image |
| `KEY` | the layer's key (see below) |

## Supported bases

Linux, glibc (2.31 or newer, what the bundled Node needs), the host's architecture (amd64 or arm64). Alpine (musl) and
other architectures are refused by the machine before a build. Not in the layer: git, Go, Rust, a C toolchain, the
repository's own toolchain. Those come from the base (or, in the machine's own image, from the image).

## Version

The layer's key is the runner image's `dev.hardness.build` label, a hash over the factory, contracts, lockfile, graph
tools, Dockerfile and the two scripts here; `build.sh` also writes it to `KEY` inside the layer. An unchanged key means
the image is not rebuilt. A repository's image tag is derived from this key (`repoImageTag`), so a new layer rebuilds it.

## Checks

`machine/runner/check-layer.sh <image>` checks the entry, the tools and the copy onto a stock `python:3.13-slim`.
`RUNNER_REPO=hardness-runner-test-x machine/runner/build.sh` builds under another name, leaving `hardness-runner:dev` alone.
