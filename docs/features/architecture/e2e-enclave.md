---
title: E2E Enclave (Sealed Ariadne)
status: building
audience: internal
kind: subsystem
invariants: [INV-E1, INV-E2, INV-E7]
entry_points:
  - apps/enclave/src/index.ts
  - apps/enclave/src/sessions.ts
  - apps/enclave/src/agent/session-runner.ts
  - apps/enclave/src/agent/run-turn.ts
  - apps/enclave/src/agent/trace-observer.ts
  - apps/backend/src/features/enclave-runtimes/dispatch/enclave-invoke-worker.ts
  - apps/backend/src/features/enclave-runtimes/forwarder.ts
  - apps/backend/src/features/enclave-runtimes/session-handlers.ts
  - packages/crypto/src/stream-key.ts
public_site: false
summary: >
  A separate, database-less enclave process runs the Ariadne agent loop for
  end-to-end encrypted scratchpads: the backend assigns a sealed turn it cannot
  read, the enclave unwraps the per-stream key in memory, runs the same
  AgentRuntime as non-E2E personas, and seals every reply and trace step back
  under that key.
related: [public/e2e-encrypted-scratchpads.md]
---

## The gist

For non-encrypted scratchpads the Ariadne assistant runs inside the regional
backend, which can read the message it's replying to. That's impossible for an
encrypted stream — the backend only holds ciphertext. The **enclave** exists to
square that circle: it's a small, separate process that holds _no_ database
credentials, decrypts a turn only in memory for the life of that turn, and seals
its output back before anything leaves the process. The backend's role is reduced
to a courier — it relays sealed bytes it cannot open (INV-E7).

The design north star is **parity, not a parallel assistant**: the enclave runs
the _same_ `AgentRuntime` loop the backend uses, emits the _same_ trace lifecycle,
and produces the _same_ message/step shapes. The only intended differences are
(a) input and output are encrypted, and (b) the tool surface is narrower. A user
should not be able to tell they're talking to the enclave except for the lock.

If you only want the mental model, stop here. The rest is the mechanism.

## How it works

**Runtime.** The enclave is the one service in the monorepo that runs on **Node,
not Bun**: it must do X25519 HPKE decap at runtime to unwrap the per-stream key,
and Bun 1.3.x's WebCrypto lacks X25519 `deriveBits`. Bun is still the _bundler_ —
`bun build --target=node --format=esm` inlines the workspace TS into one
self-contained `dist/index.mjs` that plain `node:22-slim` runs with no
`node_modules` (`Dockerfile.enclave`). A consequence worth remembering: the
enclave's logger uses a _synchronous_ pino-pretty stream, not `pino.transport`,
because a transport worker can't resolve `pino-pretty` from a single-file bundle
(`packages/agent-runtime/src/logger.ts`).

**Lifecycle.** At boot the enclave generates a fresh **Enclave Instance Key (EIK)**
(X25519), registers it with the backend, and heartbeats every 30s so the backend's
live set reflects liveness (`apps/enclave/src/index.ts`). It exposes `/pubkey`,
`/healthz`, and `/attestation` (source commit + build hash). On graceful shutdown
it best-effort revokes its key; the backend's 2-minute staleness window tombstones
the row regardless.

**Dispatch (backend → enclave).** When a turn is owed in an encrypted stream, the
`enclave-invoke-worker` builds an `EnclaveSessionAssignment` — the sealed prompt,
sealed history, the SSK wrap(s) addressed to a live EIK, the system prompt (clear,
non-secret), model id, the per-stream `allowedToolCategories` policy (read from
`stream_policies`, keyed by the root like the rest of the E2E identity), and
non-secret `trigger` metadata — and `POST`s it to the enclave via the
`forwarder`. The worker inserts the running session row and its `started` event in
**one transaction** (INV-7) and, if assignment fails, drives the session through
`failSessionWithLifecycle` so the card terminates instead of spinning forever.

**Running the turn.** `sessions.ts` validates the assignment (Zod — note that
`allowedToolCategories` and `trigger` _must_ be declared in the schema, or Zod
silently strips them and the policy/context step vanish), acks `202`, and runs the
turn detached. `session-runner.ts` unwraps the SSK with the in-memory EIK, opens
the sealed messages, and runs the agent loop (`run-turn.ts`) over an enclave-only
OpenRouter client (zero-retention, single egress). Each reply is sealed and
streamed back the moment the loop emits it, so an interim "I'll look into it" lands
ahead of the final answer; then it acks completion.

**Trace parity.** `trace-observer.ts` mirrors the in-process trace lifecycle:
`step:started` on step open, snapshot `substep`s as research progresses, a CONTEXT
("Triggered by") step sealed from the `trigger` metadata, and a finalize on
complete. Every step's content is sealed with AAD bound to `streamId|stepId|
senderId` (anti-shuffle), and the client reads the AAD off the envelope rather than
reconstructing it. The backend's `session-handlers.ts` persist these sealed steps
and relay them over the socket without reading them.

**Abort.** A user's "Stop research" routes by ownership: if the session is owned by
an enclave, the backend forwards a `POST /sessions/:id/cancel` (the `forwarder`'s
`cancelSession`), which trips a per-session `AbortController`; the research
sub-loop returns partial findings and the turn still replies. For in-process
(non-enclave) sessions the backend uses its local abort registry instead.

## Details worth knowing

- **Tools.** The enclave exposes web research, `read_url`, and `general_research`
  only (`apps/enclave/src/agent/tools.ts`), gated by the per-stream
  `allowedToolCategories`. If the policy excludes `web`, the enclave runs with _no_
  tools. It cannot call workspace APIs — that would require plaintext egress, which
  the trust model forbids.
- **Server short-circuits (INV-E2).** Outbox handlers that read content — companion
  auto-reply, GAM memo extraction, naming polish, search indexing, mention
  extraction — short-circuit on encrypted streams via an `isE2eStream` check.
- **E2E flag atomicity (INV-E1).** The `e2e_streams` row is written in the same
  transaction as the stream, so there is never a window where the stream exists but
  its E2E flag doesn't. The repository layer (plus a check constraint) carries the
  "never treat E2E content as plaintext" guarantee.
- **Deploy shape.** `Dockerfile.enclave` is sound (multi-stage Bun-build →
  unprivileged `node:22-slim`, `EXPOSE 3011`) and `apps/enclave/railway.toml` now
  wires it to a deploy target (`Dockerfile.enclave`, `healthcheckPath = "/healthz"`),
  matching every other service. Bringing up an instance is then just: create the
  Railway service and set the four required env vars (`ENCLAVE_SELF_URL`,
  `BACKEND_BASE_URL`, `INTERNAL_API_KEY`, `OPENROUTER_API_KEY` — see
  `apps/enclave/README.md`); the enclave self-registers with the backend over
  `BACKEND_BASE_URL`, so no backend config change is needed. Pin the egress
  allow-list to the backend and OpenRouter only.
  All E2E DB migrations are **additive** (new tables + new nullable columns; nothing
  dropped), and E2E is opt-in per scratchpad with no global flag, so the encrypted
  path can ship without affecting any existing plaintext stream or user.
- **Trust boundary (5a).** Today trust is "the operator runs the published binary";
  the enclave is operationally separated, not yet a hardware TEE. Migrating to a
  real TEE (Nitro / Confidential VM / Confidential Space) is a deployment-shape
  change, not a protocol change — the sealed envelope is portable.

## Invariants

- **INV-E1** — the E2E flag is written atomically with the stream; repository +
  check-constraint enforcement prevents treating E2E content as plaintext.
- **INV-E2** — content-reading outbox handlers short-circuit on encrypted streams.
- **INV-E7** — the backend persists and relays only ciphertext for encrypted
  streams; it never holds the plaintext or the keys to read it.

## Entry points

- `apps/enclave/src/index.ts` — boot, EIK registration, heartbeat, route table.
- `apps/enclave/src/sessions.ts` — assignment validation, the `/sessions` and
  `/sessions/:id/cancel` HTTP shells.
- `apps/enclave/src/agent/session-runner.ts` — SSK unwrap, abort wiring, turn
  orchestration.
- `apps/enclave/src/agent/run-turn.ts` — the agent loop, tool gating, CONTEXT step.
- `apps/enclave/src/agent/trace-observer.ts` — sealed trace lifecycle parity.
- `apps/backend/src/features/enclave-runtimes/dispatch/enclave-invoke-worker.ts` —
  builds and dispatches the sealed assignment, owns the session lifecycle.
- `apps/backend/src/features/enclave-runtimes/forwarder.ts` — backend → enclave
  HTTP (assign, cancel).
- `apps/backend/src/features/enclave-runtimes/session-handlers.ts` — persists and
  relays sealed steps/messages/completion.
- `packages/crypto/src/stream-key.ts` — SSK seal/open/wrap primitives.
