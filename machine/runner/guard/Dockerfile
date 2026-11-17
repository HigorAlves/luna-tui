# The stage guard: SafeAgents (https://github.com/huggingface/safeagents), a proxy between a stage's agent and the model API that
# blocks tool calls the model makes on its own. The machine runs it as a container beside the egress proxy (RFC 0012, Track B).
# Built by machine/runner/build.sh --guard with machine/runner as the context (`-f guard/Dockerfile`; Dockerfile.dockerignore sends only
# luna-env and guard/). No credential is baked in or passed as a variable: the machine hands secrets as files under /run/luna-secrets,
# and luna-env turns them into variables for the one process that starts.
FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS build
# uv from PyPI at a pinned version, no install script.
ARG UV_VERSION=0.13.7
# SafeAgents is v0.0.1 and has no releases: pinned to a full commit (upstream main on 2026-11-17, the day this was added, so the
# build is what was read) and checked against the sha256 of that commit's tarball. A bump is a new commit sha and a new sha256 together.
ARG SAFEAGENTS_SHA=dcf38e0a911d6e6a53966d46ecf1d9d6b86e3c01
ARG SAFEAGENTS_SHA256=58853244c79c2c283f9134230269112099aa810a0f220e9e513ae7ecaf56da41
ENV UV_NO_CACHE=1 UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy PIP_DISABLE_PIP_VERSION_CHECK=1
COPY guard/requirements.lock guard/build-requirements.lock /tmp/
RUN pip install --no-cache-dir "uv==${UV_VERSION}" \
 && python -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], '/tmp/safeagents.tar.gz')" \
      "https://github.com/huggingface/safeagents/archive/${SAFEAGENTS_SHA}.tar.gz" \
 && echo "${SAFEAGENTS_SHA256}  /tmp/safeagents.tar.gz" | sha256sum -c - \
 && mkdir /tmp/src && tar -xzf /tmp/safeagents.tar.gz -C /tmp/src --strip-components=1 \
 && uv venv /opt/build && uv pip install --python /opt/build/bin/python --require-hashes -r /tmp/build-requirements.lock \
 && uv venv /opt/guard \
 && uv pip install --python /opt/guard/bin/python --require-hashes -r /tmp/requirements.lock \
 && (cd /tmp/src && /opt/build/bin/hatchling build --target wheel --directory /tmp/wheel) \
 && uv pip install --python /opt/guard/bin/python --no-deps /tmp/wheel/*.whl \
 && /opt/guard/bin/safeagents --help >/dev/null

FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS base
COPY --from=build /opt/guard /opt/guard
# luna-env: exports the files of /run/luna-secrets as variables, then runs the command (the same script as the runner image's).
COPY luna-env /opt/luna/bin/luna-env
# No package tools at run time: pip is taken out of the base, and uv and the build backend stayed in the first stage.
RUN python -m pip uninstall -y pip >/dev/null 2>&1 \
 && chmod 0755 /opt/luna/bin/luna-env \
 && chmod -R a+rX /opt/guard /opt/luna

# The final image is the base's files with none of its metadata: python's own image sets GPG_KEY (the public fingerprint it checked the
# source with), a name that looks like a secret and would fail the guard's own "no credential variable" check.
FROM scratch
COPY --from=base / /
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8
LABEL dev.hardness.guard="1"
EXPOSE 8787
USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["/opt/luna/bin/luna-env", "/opt/guard/bin/safeagents"]
