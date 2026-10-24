# The machine itself, for `docker compose up`. Stages still run as sibling containers
# through the host's Docker socket, so this image only needs the docker CLI, git and gh.
# Build context is the repo root (it needs the pnpm workspace and contracts/).
FROM node:24-slim

ARG GH_VERSION=2.63.2
ARG PNPM_VERSION=12.14.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_${arch}/bin/gh" \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "pnpm@${PNPM_VERSION}"

COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json contracts/
COPY machine/package.json machine/
RUN pnpm install --frozen-lockfile --filter @hardness/machine...

COPY contracts contracts
COPY machine/src machine/src
COPY machine/tsconfig.json machine/

WORKDIR /app/machine
ENV MACHINE_HOST=0.0.0.0
EXPOSE 4317
CMD ["pnpm", "start"]
