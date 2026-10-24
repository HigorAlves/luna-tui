# Stage container: runs one pipeline stage as an orc pack and exits.
# Built by `pnpm --filter @hardness/machine runner:build` (runner/build.sh), which puts the
# orc plugin in vendor/orc.tar. Credentials are passed by the machine at `docker run` time
# and are never part of the image.
FROM node:24-slim

ARG GH_VERSION=2.63.2
ARG ORC_SHA=unknown

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash jq git ca-certificates ripgrep curl \
 && arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_${arch}/bin/gh" \
 && gh --version \
 && rm -rf /var/lib/apt/lists/*

# The orc plugin (the directory holding .claude-plugin/plugin.json), pinned to one commit.
# The Agent SDK is installed now so a stage needs no network to start.
ADD vendor/orc.tar /
RUN echo "${ORC_SHA}" > /orc/.orc-ref \
 && npm install --omit=dev --no-audit --no-fund --prefix /orc/lib/factory \
 && chmod -R a+rX /orc
ENV PATH="/orc/bin:${PATH}"

WORKDIR /runner
COPY runner.mjs ./

# Not root: Claude Code refuses some modes as root, and the stage should not own the image.
USER node
ENTRYPOINT ["node", "/runner/runner.mjs"]
