# @threa/enclave

Per-instance Bun + Express service that will run the AI loop for end-to-end
encrypted scratchpads invited to the built-in Ariadne persona. It mirrors the
regional backend's stack (Express 5, pino) but holds no database credentials
and never logs payload contents.

This package is the **service shell**: it generates an Enclave Instance Key
(EIK) at boot, registers it with the backend, and heartbeats so the backend's
live set reflects current liveness. It does **not** reply to messages yet —
the `/invoke` endpoint, the agent runtime, and SSK unwrapping land in a
later PR.

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
- Best-effort revokes its key on graceful shutdown; the backend's staleness
  window tombstones the row within 2 minutes regardless.

What the enclave does not do:

- No database connection. No persistence of any kind. Everything is
  in-memory and per process lifetime.
- No payload logging. Access logs carry timing, status, and request IDs
  only. The `Authorization` header is redacted at the `pino-http` layer.
- No message replies yet — no `/invoke`, no agent runtime, no LLM upstream.

## Environment

| Variable                        | Required             | Purpose                                                                                              |
| ------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`                          | no (default `3011`)  | Listen port for `/pubkey`, `/healthz`, `/attestation`.                                               |
| `ENCLAVE_SELF_URL`              | yes                  | URL the backend stores as this instance's reachable address (e.g. `https://enclave-eu-1.threa.dev`). |
| `BACKEND_BASE_URL`              | yes                  | Regional backend base URL — target for register/heartbeat/revoke.                                    |
| `INTERNAL_API_KEY`              | yes                  | Shared bearer secret guarding the enclave's calls to `/internal/enclave-runtimes/*`.                 |
| `ENCLAVE_HEARTBEAT_INTERVAL_MS` | no (default `30000`) | Heartbeat cadence; the backend's staleness window is 2 minutes.                                      |

## Egress allow-list (operational)

In production the egress firewall should pin the enclave to:

- `BACKEND_BASE_URL` — for `/internal/enclave-runtimes/*` registration,
  heartbeat, and revoke.

No other outbound traffic is required in this shell. The LLM upstream
allow-list lands alongside the `/invoke` endpoint in a later PR.

## Running locally

```sh
ENCLAVE_SELF_URL=http://localhost:3011 \
BACKEND_BASE_URL=http://localhost:3001 \
INTERNAL_API_KEY=$INTERNAL_API_KEY \
bun run dev
```

Confirm the row landed in the backend:

```sql
SELECT id, instance_id, key_id, instance_url, last_seen_at, revoked_at
FROM enclave_runtimes
ORDER BY registered_at DESC LIMIT 5;
```
