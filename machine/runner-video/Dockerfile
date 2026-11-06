# Video stage container: the QA image plus the tools that turn an approved set of scenarios into a
# narrated walkthrough, offline: kokoro-js for the voice, whisper (transformers.js) for word
# timestamps, a time-driven card page rendered through Playwright, ffmpeg to compose and measure.
# Built by `pnpm --filter @hardness/machine runner-video:build` (runner/build.sh --video) with the
# repository root as the build context. The models are downloaded here, once, into /models; at
# run time the tools never reach the network (jobs run with --network none).
ARG BASE=hardness-runner-qa:dev
FROM ${BASE}

USER root
# tesseract reads the text on the film's frames and on screenshots (the `frames` tool).
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
COPY machine/runner-video/package.json machine/runner-video/package-lock.json /video-tools/
RUN cd /video-tools && npm ci --no-audit --no-fund && rm -rf /root/.npm
COPY machine/runner-video/tools /video-tools/tools
COPY machine/runner-video/cards /video-tools/cards

# kokoro q8 (about 90 MB) and whisper-tiny.en (about 40 MB) land in /models; --warm runs one
# phrase through each so every file the tools will ask for is there. The tools run with no network, so a voice
# must be fetched here: the image carries the voices in LUNA_VOICES (a repository's `evidence.tts.voice` or
# `evidence.tts.language: en-GB` needs its voice in this list; a voice the image lacks fails the narrate job,
# which degrades the pack to screenshots).
ARG LUNA_VOICES="af_heart bf_emma"
ENV LUNA_MODELS=/models
RUN mkdir -p /models /tmp/warm \
 && for v in ${LUNA_VOICES}; do node /video-tools/tools/narrate.ts --warm --voice "$v"; done \
 && chmod -R a+rX /models /video-tools \
 && rm -rf /tmp/warm /root/.cache

USER node
