# @threa/enclave

Per-instance Express service that runs the AI loop for end-to-end encrypted
scratchpads invited to the built-in Ariadne persona. It holds no database
credentials and never logs payload contents.

**Runtime: Node, not Bun.** The enclave must do X25519 HPKE (decap) at runtime
to unwrap the per-stream key, and Bun 1.3.x's WebCrypto lacks X25519
`deriveBits`. Bun is still the bundler — `bun build --target=node` inlines the
workspace TS into one self-contained ESM file (`dist/index.mjs`) that Node runs;
the Docker runtime stage is plain `node:22-slim` with no `node_modules`. This is
the one service in the monorepo that runs on Node.

It generates an Enclave Instance Key (EIK) at boot, registers it with the
backend, heartbeats so the live set reflects liveness, and owns assigned
sessions via `POST /sessions`: the backend assigns an encrypted scratchpad turn
(ciphertext + the SSK wrap addressed to this EIK + the sessionId), the enclave
acks 202 and runs the turn _asynchronously_ — unwrapping the SSK, opening the
message(s), running the same `AgentRuntime` loop the backend uses for non-E2E
personas (over an enclave-only LLM client: OpenRouter, zero-retention, single
egress), and sealing each reply back under the SSK. While the loop runs it
refreshes the session heartbeat and streams each sealed reply back the moment the
loop sends it (so an interim "I'll look into it" lands ahead of the final answer),
then acks completion. Plaintext exists only in-process, for the loop's duration,
and is never logged.

## Trust boundary (5a)

5a descopes the TEE to operational separation only. Trust is "operator runs
the published binary"; future migration to a real TEE (Nitro / Confidential
VM / Confidential Space) is a deployment-shape change, not a protocol
change.

What the enclave does today:

- Generates a fresh X25519 EIK at boot, registers it with the backend, and
  heartbeats every 30s so the backend's live set reflects current liveness.
- Exposes `/pubkey` (the registered EIK), `/healthz`, and `/attestation`
  (source commit + build hash) for liveness and verification.
- Owns assigned sessions via `POST /sessions`: acks 202, then asynchronously
  unwraps the SSK with its in-memory EIK, runs the agent loop (text +
  tool-calling capable; no tools and no mid-turn reconsideration wired yet),
  refreshes the session heartbeat while working, streams each sealed reply back
  as the loop sends it (`.../messages`), and acks completion (`.../complete`).
- Best-effort revokes its key on graceful shutdown; the backend's staleness
  window tombstones the row within 2 minutes regardless.

What the enclave does not do:

- No database connection. No persistence of any kind. Everything is
  in-memory and per process lifetime.
- No payload logging. The access-log serializer emits only `{id, method, url}`
  per request — no request/response bodies and no headers, so neither the
  `Authorization` nor the `X-Internal-Api-Key` header is ever written (the
  `pino-http` `redact` paths are belt-and-braces on top of that).
- No outbound traffic except the backend (register/heartbeat/revoke + the
  per-session heartbeat/messages/complete callbacks) and the OpenRouter API (the LLM upstream).

## Environment

| Variable                        | Required             | Purpose                                                                                              |
| ------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`                          | no (default `3011`)  | Listen port for `/pubkey`, `/healthz`, `/attestation`, `/sessions`.                                  |
| `ENCLAVE_SELF_URL`              | yes                  | URL the backend stores as this instance's reachable address (e.g. `https://enclave-eu-1.threa.dev`). |
| `BACKEND_BASE_URL`              | yes                  | Regional backend base URL — target for register/heartbeat/revoke.                                    |
| `INTERNAL_API_KEY`              | yes                  | Shared bearer secret guarding the enclave's calls to `/internal/enclave-runtimes/*`.                 |
| `OPENROUTER_API_KEY`            | yes                  | The enclave's only outbound LLM credential; calls OpenRouter with zero-retention routing.            |
| `OPENROUTER_BASE_URL`           | no                   | Override OpenRouter base URL (default `https://openrouter.ai/api/v1`).                               |
| `ENCLAVE_HEARTBEAT_INTERVAL_MS` | no (default `30000`) | Heartbeat cadence; the backend's staleness window is 2 minutes.                                      |

## Egress allow-list (operational)

In production the egress firewall should pin the enclave to exactly:

- `BACKEND_BASE_URL` — for `/internal/enclave-runtimes/*`: registration,
  heartbeat, revoke, and the per-session heartbeat/messages/complete callbacks.
- `OPENROUTER_BASE_URL` (`openrouter.ai`) — the LLM upstream for `/sessions`.

No other outbound traffic is required.

## Running locally

`bun run dev` bundles with Bun and runs the bundle on Node (with `--watch`):

```sh
ENCLAVE_SELF_URL=http://localhost:3011 \
BACKEND_BASE_URL=http://localhost:3001 \
INTERNAL_API_KEY=$INTERNAL_API_KEY \
OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
bun run dev
```

Confirm the row landed in the backend:

```sql
SELECT id, instance_id, key_id, instance_url, last_seen_at, revoked_at
FROM enclave_runtimes
ORDER BY registered_at DESC LIMIT 5;
```
