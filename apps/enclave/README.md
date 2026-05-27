# @threa/enclave

Per-instance Bun + Express service that runs the AI loop for end-to-end
encrypted scratchpads invited to the built-in Ariadne persona. It mirrors the
regional backend's stack (Express 5, pino) but holds no database credentials
and never logs payload contents.

## Trust boundary (5a)

5a descopes the TEE to operational separation only. Trust is "operator runs
the published binary"; future migration to a real TEE (Nitro / Confidential
VM / Confidential Space) is a deployment-shape change, not a protocol
change.

What the enclave does:

- Generates a fresh X25519 EIK at boot, registers it with the backend, and
  heartbeats every 30s so the backend's live set reflects current liveness.
- Accepts `POST /invoke` from the backend, decrypts the inbound history
  using the EIK private key, runs `AgentRuntime` against the persona's
  configured model, captures the reply, and seals it as a multi-recipient
  envelope addressed to `[UIK, ...EIKs]` from the request.
- Returns the ciphertext reply alongside sidecar telemetry (tokens, latency,
  model, cost) so the backend can record AI usage without seeing plaintext.

What the enclave does not do:

- No database connection. No persistence of any kind. Everything is per-call
  and in-memory.
- No payload logging. Access logs carry timing, status, and request IDs
  only. The `Authorization` header is redacted at the `pino-http` layer.
- No workspace-aware tools in 5a — `tools: []` is hard-wired. Web tools
  (`web_search`, `read_url`) land in 5a.4 on top of the encrypted trace
  steps shipped in 5a.3.

## Environment

| Variable                        | Required             | Purpose                                                                                                                        |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                          | no (default `3011`)  | Listen port for `/invoke`, `/pubkey`, `/healthz`.                                                                              |
| `ENCLAVE_SELF_URL`              | yes                  | URL the backend uses to reach this instance (e.g. `https://enclave-eu-1.threa.dev`).                                           |
| `BACKEND_BASE_URL`              | yes                  | Regional backend base URL — target for register/heartbeat/revoke.                                                              |
| `INTERNAL_API_KEY`              | yes                  | Shared bearer secret with the backend. Same secret guards `/invoke` and the enclave's calls to `/internal/enclave-runtimes/*`. |
| `OPENROUTER_API_KEY`            | yes                  | LLM provider key. Pin a zero-retention `provider.order` upstream.                                                              |
| `ENCLAVE_HEARTBEAT_INTERVAL_MS` | no (default `30000`) | Heartbeat cadence; the backend's staleness window is 2 minutes.                                                                |

## Egress allow-list (operational)

In production the egress firewall should pin the enclave to:

- `BACKEND_BASE_URL` — for `/internal/enclave-runtimes/*` registration,
  heartbeat, and revoke (plus the encrypted-step endpoint added in 5a.3).
- OpenRouter (`https://openrouter.ai`) — LLM upstream.
- Future: Tavily (`https://api.tavily.com`) once 5a.4 wires `web_search`.

No other outbound traffic is required.

## Running locally

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
