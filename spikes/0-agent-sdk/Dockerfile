# Phase 0 spike: can the Agent SDK run a stage inside a throwaway container?
# Credentials are passed at `docker run` time, never baked into the image.
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY run.mjs ./

# Claude Code refuses some modes as root, and the stage should not own the image anyway.
USER node
ENTRYPOINT ["node", "/runner/run.mjs"]
