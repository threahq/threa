FROM node:24-bookworm-slim

# The runner passes these from config.ts, the lists Railway boxes install too.
ARG APT_PACKAGES
ARG PYTHON_PACKAGES
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pip jq $APT_PACKAGES \
  && pip install --no-cache-dir --break-system-packages $PYTHON_PACKAGES \
  && rm -rf /var/lib/apt/lists/*

# Commands run as a plain user in a directory it owns. PID 1 stays root, so a
# command can neither kill the box's idle timer nor keep it alive. The uid is
# fixed so it never matches the backend's, which the API broker runs as.
# /opt/threa is mounted from the backend with the CLI and the broker.
RUN useradd --uid 10001 --create-home --shell /bin/sh sandbox \
  && mkdir -p /work/attachments \
  && chown -R sandbox:sandbox /work \
  && ln -s /opt/threa/threa /usr/local/bin/threa

WORKDIR /work
