#!/usr/bin/env bash
# Cloudflare's API answers the occasional 5xx mid-deploy. A Pages or Workers
# deploy replaces the whole deployment, so repeating it in full is safe.
set -uo pipefail

# A job cancelled by a newer commit's deploy must not start another attempt.
trap 'exit 130' INT TERM

attempts=3

for attempt in $(seq 1 "$attempts"); do
  if bunx --no-install wrangler "$@"; then
    exit 0
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    delay=$((attempt * 20))
    echo "::warning::wrangler failed (attempt $attempt/$attempts), retrying in ${delay}s"
    sleep "$delay"
  fi
done

echo "::error::wrangler failed $attempts times"
exit 1
