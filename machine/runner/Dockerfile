# Stage container: runs one pipeline stage through the factory runner and exits.
# Built by `pnpm --filter @hardness/machine runner:build` (runner/build.sh) with the repository
# root as the build context, so the factory package and the contracts it shares with the
# machine are copied in from this checkout. Credentials are passed by the machine at
# `docker run` time and are never part of the image.
FROM node:24-slim

ARG GH_VERSION=2.63.2
ARG GO_VERSION=1.25.1
ARG FACTORY_REF=unknown

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git ca-certificates ripgrep curl \
 && arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_${arch}/bin/gh" \
 && gh --version \
 && rm -rf /var/lib/apt/lists/*

# Go, for repos whose suite is `go test ./...` (fixtures/golden-cli is one). The stage runs
# with HOME=/tmp on a read-only root, so the module and build caches land on the tmpfs;
# GOTOOLCHAIN=local keeps a go.mod from downloading another toolchain mid-stage.
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" | tar -xz -C /usr/local \
 && /usr/local/go/bin/go version
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local

# The factory runner and the contracts package it shares with the machine, installed with the
# workspace's own lockfile so the image runs exactly what the checkout tests. The Agent SDK
# is installed now, so a stage needs no network to start.
WORKDIR /factory-src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json contracts/
COPY factory/package.json factory/
RUN corepack enable \
 && corepack pnpm install --frozen-lockfile --prod --filter @hardness/factory... \
 && rm -rf /root/.cache /root/.local/share/pnpm
COPY contracts/src contracts/src
COPY factory factory
RUN echo "${FACTORY_REF}" > /factory-src/factory/.ref \
 && chmod -R a+rX /factory-src
ENV LUNA_FACTORY_ROOT=/factory-src/factory

# Not root: Claude Code refuses some modes as root, and the stage should not own the image.
USER node
WORKDIR /work
ENTRYPOINT ["node", "/factory-src/factory/src/main.ts"]
