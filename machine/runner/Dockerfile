# Stage container: runs one pipeline stage through the factory runner and exits.
# Built by `pnpm --filter @hardness/machine runner:build` (runner/build.sh) with the repository
# root as the build context, so the factory package and the contracts it shares with the
# machine are copied in from this checkout. Credentials are passed by the machine at
# `docker run` time and are never part of the image.
FROM node:24-slim

ARG GH_VERSION=2.63.2
ARG GO_VERSION=1.25.1
ARG RUST_VERSION=1.99.1

COPY machine/runner/fetch-release.sh /tmp/fetch-release.sh
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git ca-certificates ripgrep curl python3 python3-pip shellcheck \
 && arch="$(dpkg --print-architecture)" \
 && sh /tmp/fetch-release.sh cli/cli "v${GH_VERSION}" "gh_${GH_VERSION}_linux_${arch}.tar.gz" /tmp/gh.tar.gz \
 && tar -xzf /tmp/gh.tar.gz -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_${arch}/bin/gh" && rm /tmp/gh.tar.gz \
 && gh --version \
 && rm -rf /var/lib/apt/lists/*

# Graphify, pinned, for the machine's per-repo code graph: a graph build is this image with the
# entrypoint overridden to /opt/luna/graph-tools/build.py (below, in the machine's layer; the version is the label dev.hardness.graphify) (code-only, no model), and a stage reads the
# result read-only at /graph with the `graphify query` verbs. Installed as root, before USER node.
ARG GRAPHIFY_VERSION=0.9.34

# The machine's layer, /opt/luna: everything a stage needs of the machine, in one directory that runs
# when copied onto another glibc Linux image (machine/runner/layer.md). Its Python is a relocatable
# standalone build with its own Graphify, so the base image's Python is never touched. The same pinned
# Graphify as above: the graph is built and queried by one version. Node, ripgrep and their shared
# libraries, gh, the Codex CLI and the factory follow below.
ARG PYTHON_STANDALONE=20261026
ARG PYTHON_VERSION=3.13.18
RUN mkdir -p /opt/luna/bin /opt/luna/lib /opt/luna/libexec /opt/luna/graph-tools \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) parch=x86_64; psum=126343c54daff4068efc1ac269518d0cc202d57857794948103dd1454e8881be ;; \
      arm64) parch=aarch64; psum=b48451865bde9a39e2f3e71d7fdcbf1f32615f50f24d78dc50d04ede6501cf81 ;; \
      *) echo "unsupported architecture $arch" >&2; exit 1 ;; esac \
 && sh /tmp/fetch-release.sh astral-sh/python-build-standalone "${PYTHON_STANDALONE}" "cpython-${PYTHON_VERSION}+${PYTHON_STANDALONE}-${parch}-unknown-linux-gnu-install_only.tar.gz" /tmp/python.tar.gz \
 && echo "${psum}  /tmp/python.tar.gz" | sha256sum -c - \
 && tar -xz -C /opt/luna -f /tmp/python.tar.gz && rm /tmp/python.tar.gz \
 && /opt/luna/python/bin/python3 -m pip install --no-cache-dir "graphifyy==${GRAPHIFY_VERSION}" \
 && ln -s ../python/bin/graphify /opt/luna/bin/graphify \
 && /opt/luna/bin/graphify --help >/dev/null
COPY machine/runner/graph/build.py /opt/luna/graph-tools/build.py

# Go, for repos whose suite is `go test ./...` (fixtures/golden-cli is one). The stage runs
# with HOME=/tmp on a read-only root, so the module and build caches land on the tmpfs;
# GOTOOLCHAIN=local keeps a go.mod from downloading another toolchain mid-stage.
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" | tar -xz -C /usr/local \
 && /usr/local/go/bin/go version
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local

# Rust, pinned, for repos whose suite is `cargo test` (the board is one). The toolchain lives
# under /usr/local so it is part of the image; at run time CARGO_HOME and CARGO_TARGET_DIR
# point at the repo's /cache volume, so the registry and build output survive a retry.
# `rustup` needs a C linker for the final link step: build-essential provides `cc`.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME_IMAGE=/usr/local/cargo
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev \
 && curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors https://sh.rustup.rs | CARGO_HOME=/usr/local/cargo sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" --component clippy --component rustfmt \
 && chmod -R a+rX /usr/local/rustup /usr/local/cargo \
 && /usr/local/cargo/bin/cargo --version \
 && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/local/cargo/bin:${PATH}"

# The Codex CLI, pinned: the eve runtime's chatgpt() models ask `codex app-server` for the
# ChatGPT login's token, and Codex owns its refresh (it rewrites $CODEX_HOME/auth.json, a per-run
# copy the machine mounts writable at /tmp/.codex). Without it eve would want an OS keychain.
ARG CODEX_VERSION=0.164.0
RUN npm install -g --no-audit --no-fund --prefix /opt/luna/codex "@openai/codex@${CODEX_VERSION}" \
 && ln -s ../codex/bin/codex /opt/luna/bin/codex \
 && ln -s /opt/luna/codex/bin/codex /usr/local/bin/codex \
 && codex --version \
 && rm -rf /root/.npm
ENV CODEX_HOME=/tmp/.codex EVE_TELEMETRY_DISABLED=1

# The factory runner and the contracts package it shares with the machine, installed with the
# workspace's own lockfile so the image runs exactly what the checkout tests. The Agent SDK
# and eve are installed now, so a stage needs no network to start. .pnpmfile.cjs keeps eve's
# optional framework peers (next, react, vite) out, which the lockfile records.
WORKDIR /opt/luna/factory-src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY contracts/package.json contracts/
COPY factory/package.json factory/
RUN corepack enable \
 && corepack pnpm install --frozen-lockfile --prod --filter @hardness/factory... \
 && rm -rf /root/.cache /root/.local/share/pnpm
# pnpm itself, at the version package.json pins, on the layer's PATH ahead of corepack's shim. A container keeps corepack's
# cache on its own tmpfs (the machine sets COREPACK_HOME), so with corepack alone every check-time install downloaded pnpm
# through the egress proxy, and one network blip escalated the card as env_broken. A repo that pins another version
# downloads it, as before.
RUN version="$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '').split('+')[0]")" \
 && npm install -g --no-audit --no-fund --prefix /opt/luna/pnpm "pnpm@${version}" \
 && ln -s /opt/luna/pnpm/lib/node_modules/pnpm/pnpm /opt/luna/bin/pnpm \
 && /opt/luna/bin/pnpm --version \
 && rm -rf /root/.npm
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
RUN echo "${FACTORY_REF}" > /opt/luna/factory-src/factory/.ref \
 && ln -s /opt/luna/factory-src /factory-src
ENV LUNA_FACTORY_ROOT=/opt/luna/factory-src/factory

# Node and ripgrep go in as binaries with their shared libraries beside them (everything but glibc itself),
# behind wrappers that point only those two at the bundled libraries; gh is a static binary. luna-stage is
# the stage's entry: the factory on the layer's own Node, with the layer's tools first on PATH.
COPY machine/runner/luna-stage /opt/luna/bin/luna-stage
COPY machine/runner/layer-wrapper /opt/luna/bin/.wrapper
# The egress proxy (machine/runner/egress/proxy.ts): the machine starts it as a second container of this image, the only door
# out of a run's network. One file of erasable TypeScript on the layer's own Node; it is never run inside a stage container.
COPY machine/runner/egress/proxy.ts /opt/luna/egress/proxy.ts
ARG LAYER_REV=unknown
LABEL dev.hardness.graphify="${GRAPHIFY_VERSION}"
LABEL dev.hardness.egress="1"
RUN for bin in /usr/local/bin/node /usr/bin/rg; do ldd "$bin" | awk '/=> \//{print $3}'; done | sort -u \
      | grep -Ev '/(libc|libm|libdl|libpthread|librt|libutil|libresolv|ld-linux[^/]*)\.so' | xargs -r -I{} cp -L {} /opt/luna/lib/ \
 && cp /usr/local/bin/node /opt/luna/libexec/node && cp /usr/bin/rg /opt/luna/libexec/rg && cp /usr/local/bin/gh /opt/luna/bin/gh \
 && cp /opt/luna/bin/.wrapper /opt/luna/bin/node && cp /opt/luna/bin/.wrapper /opt/luna/bin/rg && rm /opt/luna/bin/.wrapper \
 && chmod 0755 /opt/luna/bin/* && echo "${LAYER_REV}" > /opt/luna/KEY \
 && chmod -R a+rX /opt/luna \
 && /opt/luna/bin/node --version && /opt/luna/bin/rg --version | head -1 && /opt/luna/bin/gh --version | head -1

# The machine runs the stage as its own host uid:gid (so the mounted worktree, run folder and
# session dir are writable). Named volumes copy the image's permissions on first use: an open
# /cache lets that user keep package-manager caches there. The image's own user is `node`,
# never root: Claude Code refuses some modes as root, and the stage should not own the image.
RUN mkdir -p /cache && chmod 0777 /cache
USER node
WORKDIR /work
ENV PATH="/opt/luna/bin:${PATH}"
ENTRYPOINT ["/opt/luna/bin/luna-stage"]
