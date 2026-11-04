# Video stage container: the QA image plus the tools that turn an approved set of scenarios into a
# narrated walkthrough, offline: kokoro-js for the voice, whisper (transformers.js) for word
# timestamps, a time-driven card page rendered through Playwright, ffmpeg to compose and measure.
# Built by `pnpm --filter @hardness/machine runner-video:build` (runner/build.sh --video) with the
# repository root as the build context. The models are downloaded here, once, into /models; at
# run time the tools never reach the network (jobs run with --network none).
ARG BASE=hardness-runner-qa:dev
FROM ${BASE}

USER root
COPY machine/runner-video/package.json machine/runner-video/package-lock.json /video-tools/
RUN cd /video-tools && npm ci --no-audit --no-fund && rm -rf /root/.npm
COPY machine/runner-video/tools /video-tools/tools
COPY machine/runner-video/cards /video-tools/cards

# kokoro q8 (about 90 MB) and whisper-tiny.en (about 40 MB) land in /models; --warm runs one
# phrase through each so every file the tools will ask for is there (the voice file included).
ENV LUNA_MODELS=/models
RUN mkdir -p /models /tmp/warm \
 && node /video-tools/tools/narrate.ts --warm \
 && chmod -R a+rX /models /video-tools \
 && rm -rf /tmp/warm /root/.cache

USER node
