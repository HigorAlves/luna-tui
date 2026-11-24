# The machine itself, for `docker compose up`. Stages still run as sibling containers
# through the host's Docker socket, so this image only needs the docker CLI, git and gh.
# Build context is the repo root (it needs the pnpm workspace and packages/contracts/).
# trixie, not bookworm: the ui-designer helper's pick (git merge-tree --write-tree --merge-base) needs git 2.40 or newer; bookworm has 2.39, trixie 2.47.
FROM node:24-trixie-slim

ARG GH_VERSION=2.63.2
ARG PNPM_VERSION=12.14.0

COPY apps/machine/runner/fetch-release.sh /tmp/fetch-release.sh
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && arch="$(dpkg --print-architecture)" \
 && sh /tmp/fetch-release.sh cli/cli "v${GH_VERSION}" "gh_${GH_VERSION}_linux_${arch}.tar.gz" /tmp/gh.tar.gz \
 && tar -xzf /tmp/gh.tar.gz -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_${arch}/bin/gh" && rm /tmp/gh.tar.gz \
 && gh --version \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "pnpm@${PNPM_VERSION}"

COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
# The shared tsconfig/vitest presets: machine's tsconfig extends one, so it must be a linked workspace package.
COPY config config
COPY packages/contracts/package.json packages/contracts/
COPY apps/machine/package.json apps/machine/
RUN pnpm install --frozen-lockfile --filter @hardness/machine...

COPY packages/contracts packages/contracts
COPY apps/machine/src apps/machine/src
# The timeline rules the video stage checks on the host are the video tools' own pure library.
COPY apps/machine/runner-video/tools/lib apps/machine/runner-video/tools/lib
COPY apps/machine/tsconfig.json apps/machine/

WORKDIR /app/apps/machine
ENV MACHINE_HOST=0.0.0.0
EXPOSE 4317
CMD ["pnpm", "start"]
