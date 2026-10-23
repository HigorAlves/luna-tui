# Stage container: runs one pipeline stage with the Claude Agent SDK and exits.
# Built by `pnpm --filter @hardness/machine runner:build`. Credentials are passed by the
# machine at `docker run` time and are never part of the image.
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY runner.mjs ./

# Not root: Claude Code refuses some modes as root, and the stage should not own the image.
USER node
ENTRYPOINT ["node", "/runner/runner.mjs"]
