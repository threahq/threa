#!/usr/bin/env bash
set -Eeuo pipefail

compose_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/production-image-smoke.compose.yml"
readonly compose_file
readonly service="${1:-}"
readonly image="${2:-}"
readonly project="threa-image-smoke-${$}-${RANDOM}"
readonly compose=(docker compose --env-file /dev/null --project-name "$project" --file "$compose_file")

case "$service" in
  backend | control-plane | db-read-proxy | enclave) ;;
  *)
    echo 'Usage: scripts/smoke-production-image.sh <backend|control-plane|db-read-proxy|enclave> <local-image-tag>' >&2
    exit 2
    ;;
esac
if [[ -z "$image" || $# -ne 2 ]]; then
  echo 'Usage: scripts/smoke-production-image.sh <backend|control-plane|db-read-proxy|enclave> <local-image-tag>' >&2
  exit 2
fi

active_pid=
run_bounded() {
  timeout --kill-after=2s "$@" &
  active_pid=$!
  wait "$active_pid"
  active_pid=
}

cleanup() {
  local status=$? deadline=30s stop_timeout=10
  trap - EXIT INT TERM
  if [[ -n "$active_pid" ]]; then
    kill -TERM "$active_pid" 2>/dev/null || true
    wait "$active_pid" 2>/dev/null || true
  fi
  if (( status == 130 || status == 143 )); then
    deadline=4s stop_timeout=1
  elif (( status != 0 )); then
    timeout --kill-after=1s 30s "${compose[@]}" logs --no-color --tail 200 2>&1 | tail -c 16000 >&2 || true
  fi
  if ! timeout --kill-after=1s "$deadline" "${compose[@]}" down --volumes --remove-orphans --timeout "$stop_timeout" >&2; then
    (( status != 0 )) || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export SMOKE_IMAGE="$image"
run_bounded 30s docker image inspect "$image" >/dev/null
echo "[$service] smoke testing $image in Compose project $project"
run_bounded 150s "${compose[@]}" up --wait --wait-timeout 120 --pull missing --renew-anon-volumes "$service"

case "$service" in
  backend)
    readonly runtime=bun port=3001 path=/health expected='{"status":"ok"}'
    ;;
  control-plane)
    readonly runtime=bun port=3003 path=/readyz expected='{"status":"ok"}'
    ;;
  db-read-proxy)
    readonly runtime=bun port=3010 path=/readyz expected='{"ok":true}'
    ;;
  enclave)
    readonly runtime=node port=3011 path=/healthz expected='{"status":"ok"}'
    ;;
esac

readonly probe="
const response = await fetch('http://127.0.0.1:${port}${path}')
const body = await response.text()
if (!response.ok || body !== '${expected}') {
  throw new Error(response.status + ' ' + body)
}
console.log(body)
"
if [[ "$runtime" == bun ]]; then
  run_bounded 30s "${compose[@]}" exec -T "$service" bun -e "$probe"
else
  run_bounded 30s "${compose[@]}" exec -T "$service" node --input-type=module -e "$probe"
fi

if [[ "$service" == enclave ]]; then
  readonly pubkey_probe="
const response = await fetch('http://127.0.0.1:3011/pubkey')
const body = await response.json()
if (
  !response.ok ||
  typeof body.instanceId !== 'string' ||
  typeof body.keyId !== 'string' ||
  typeof body.publicKey !== 'string' ||
  Buffer.from(body.publicKey, 'base64url').length !== 32
) {
  throw new Error(JSON.stringify(body))
}
console.log(JSON.stringify(body))
"
  run_bounded 30s "${compose[@]}" exec -T enclave node --input-type=module -e "$pubkey_probe"
fi
