FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 nodejs jq \
  && rm -rf /var/lib/apt/lists/*

# Commands run as a plain user in a directory it owns. PID 1 stays root, so a
# command can neither kill the box's idle timer nor keep it alive.
RUN useradd --create-home --shell /bin/sh sandbox \
  && mkdir -p /work/attachments \
  && chown -R sandbox:sandbox /work

WORKDIR /work
