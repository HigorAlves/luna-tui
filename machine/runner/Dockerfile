# Stage container: runs one pipeline stage through the factory runner and exits.
# Built by `pnpm --filter @hardness/machine runner:build` (runner/build.sh) with the repository
# root as the build context, so the factory package and the contracts it shares with the
# machine are copied in from this checkout. Credentials are passed by the machine at
# `docker run` time and are never part of the image.
FROM node:24-slim

ARG GH_VERSION=2.63.2
ARG GO_VERSION=1.25.1
ARG RUST_VERSION=1.99.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git ca-certificates ripgrep curl python3 python3-pip \
 && arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_${arch}/bin/gh" \
 && gh --version \
 && rm -rf /var/lib/apt/lists/*

# Graphify, pinned, for the machine's per-repo code graph: a graph build is this image with the
# entrypoint overridden to /graph-tools/build.py (code-only, no model), and a stage reads the
# result read-only at /graph with the `graphify query` verbs. Installed as root, before USER node.
ARG GRAPHIFY_VERSION=0.9.34
RUN pip3 install --no-cache-dir --break-system-packages "graphifyy==${GRAPHIFY_VERSION}"
COPY machine/runner/graph/build.py /graph-tools/build.py
RUN chmod -R a+rX /graph-tools

# Go, for repos whose suite is `go test ./...` (fixtures/golden-cli is one). The stage runs
# with HOME=/tmp on a read-only root, so the module and build caches land on the tmpfs;
# GOTOOLCHAIN=local keeps a go.mod from downloading another toolchain mid-stage.
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" | tar -xz -C /usr/local \
 && /usr/local/go/bin/go version
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local

# Rust, pinned, for repos whose suite is `cargo test` (the board is one). The toolchain lives
# under /usr/local so it is part of the image; at run time CARGO_HOME and CARGO_TARGET_DIR
# point at the repo's /cache volume, so the registry and build output survive a retry.
# `rustup` needs a C linker for the final link step: build-essential provides `cc`.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME_IMAGE=/usr/local/cargo
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev \
 && curl -fsSL https://sh.rustup.rs | CARGO_HOME=/usr/local/cargo sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" --component clippy --component rustfmt \
 && chmod -R a+rX /usr/local/rustup /usr/local/cargo \
 && /usr/local/cargo/bin/cargo --version \
 && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/local/cargo/bin:${PATH}"

# The Codex CLI, pinned: the eve runtime's chatgpt() models ask `codex app-server` for the
# ChatGPT login's token, and Codex owns its refresh (it rewrites $CODEX_HOME/auth.json, a per-run
# copy the machine mounts writable at /tmp/.codex). Without it eve would want an OS keychain.
ARG CODEX_VERSION=0.164.0
RUN npm install -g --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
 && codex --version \
 && rm -rf /root/.npm
ENV CODEX_HOME=/tmp/.codex EVE_TELEMETRY_DISABLED=1

# The factory runner and the contracts package it shares with the machine, installed with the
# workspace's own lockfile so the image runs exactly what the checkout tests. The Agent SDK
# and eve are installed now, so a stage needs no network to start. .pnpmfile.cjs keeps eve's
# optional framework peers (next, react, vite) out, which the lockfile records.
WORKDIR /factory-src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY contracts/package.json contracts/
COPY factory/package.json factory/
RUN corepack enable \
 && corepack pnpm install --frozen-lockfile --prod --filter @hardness/factory... \
 && rm -rf /root/.cache /root/.local/share/pnpm
COPY contracts/src contracts/src
COPY factory factory
# The eve agent of every pack an eve engine may run, compiled and built now (roles and packs are
# static): a stage on an eve engine starts the built server and sends its prompt. The build
# needs no Docker daemon.
RUN cd factory && node src/runtimes/eve/build.ts \
 && rm -rf /root/.cache
# Declared here, not at the top: every RUN after an ARG sees it as environment, so a new commit
# hash would otherwise rebuild the apt, pip, Go, Rust and Codex layers on every branch.
ARG FACTORY_REF=unknown
RUN echo "${FACTORY_REF}" > /factory-src/factory/.ref \
 && chmod -R a+rX /factory-src
ENV LUNA_FACTORY_ROOT=/factory-src/factory

# The machine runs the stage as its own host uid:gid (so the mounted worktree, run folder and
# session dir are writable). Named volumes copy the image's permissions on first use: an open
# /cache lets that user keep package-manager caches there. The image's own user is `node`,
# never root: Claude Code refuses some modes as root, and the stage should not own the image.
RUN mkdir -p /cache && chmod 0777 /cache
USER node
WORKDIR /work
ENTRYPOINT ["node", "/factory-src/factory/src/main.ts"]
