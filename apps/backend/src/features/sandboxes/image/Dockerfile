FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 jq \
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
