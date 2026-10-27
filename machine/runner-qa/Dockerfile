# QA stage container: the stage image plus the browsers the e2e pack drives.
# Built by `pnpm --filter @hardness/machine runner-qa:build` (runner/build.sh --qa), which
# builds hardness-runner:dev first so both images come from the same checkout.
ARG BASE=hardness-runner:dev
FROM ${BASE}

# Playwright is pinned to a release at least two weeks old. Chromium only: it keeps the
# image smaller than the three-browser default.
ARG PLAYWRIGHT_VERSION=1.63.0
ARG AGENT_BROWSER_VERSION=0.39.2
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && npm install -g --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" "agent-browser@${AGENT_BROWSER_VERSION}" \
 && playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/*

# agent-browser reuses Playwright's chromium: Chrome for Testing has no Linux arm64 build, so
# `agent-browser install` would fail on Apple Silicon hosts. One browser also keeps the image smaller.
RUN ln -s "$(find /ms-playwright -maxdepth 3 -type f -name chrome -path '*chromium-*' | head -n1)" /usr/local/bin/chromium-qa
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium-qa

USER node
