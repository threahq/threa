#!/usr/bin/env bash
# Cloudflare's API answers the occasional 5xx mid-deploy. A Pages or Workers
# deploy replaces the whole deployment, so repeating it in full is safe.
set -uo pipefail

attempts=3

for attempt in $(seq 1 "$attempts"); do
  if bunx wrangler "$@"; then
    exit 0
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    delay=$((attempt * 20))
    echo "::warning::wrangler $1 failed (attempt $attempt/$attempts), retrying in ${delay}s"
    sleep "$delay"
  fi
done

echo "::error::wrangler $1 failed $attempts times"
exit 1
