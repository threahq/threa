# Phase 5a — Ariadne enclave (reuse AgentRuntime, web tools only)

## Context

Phases 1, 2 (Pi remote), and 3.5 (at-rest encryption) shipped. End-to-end encrypted
scratchpads work between a user and an external runtime (Pi). The remaining gap from
`docs/plans/e2e-encrypted-scratchpads.md` is **Phase 5 — Ariadne enclave**, which
closes the "private journaling against a first-party AI" use case (Kris's wife
journaling with Ariadne; a colleague reflecting with Pi-style privacy but against an
in-house persona).

The full Phase 5 in the doc calls for a real TEE (Nitro / Confidential VM /
Confidential Space) with reproducible builds, client-verified attestation, and
measurement pinning. That is overkill for the actual threat model — a side project
shared with a handful of friends who trust the operator. **5a descopes the TEE to a
separate Bun service with operational separation only:** no DB credentials, no
content logging (structured access logs with `{ts, userId, messageId, byteSize,
latencyMs, model, promptTokens, completionTokens}` only), separate deploy target,
egress allow-list pinned to the LLM provider + Tavily + the small set of
backend-internal endpoints (`/internal/enclave-runtimes/*`, the encrypted-step
endpoint). Trust shifts from "client cryptographically verifies the binary" to
"operator runs the published binary". Future migration to real TEE is a
deployment-shape change, not a protocol change.

## Architectural principle: minimize divergence

The enclave must run **the same AgentRuntime, the same tools, the same AI wrapper**
as the backend. We are "growing the roots" — every future agent improvement should
benefit both paths automatically. The differences are limited to:

- **Decryption / encryption boundary.** Enclave decrypts inbound envelopes, encrypts
  outbound replies + each trace step. The runtime sees plaintext `ModelMessage[]`.
- **No persistence on the enclave side.** Trace steps and the reply leave as
  ciphertext POSTed back to the backend; nothing writes to a local DB.
- **Tool allowlist.** Same tool implementations, but `enabledTools` in E2E mode
  excludes everything that requires backend access (every workspace tool,
  attachments, memos, GitHub, Linear, sub-agent fan-out).
- **Sidecar telemetry.** Token counts, model, provider, latency, cost ride
  alongside the ciphertext reply so the backend can write `ai_usage_records`.

**Crucially, we do NOT reuse `PersonaAgent` (the orchestrator) — only the layer
beneath it.** `PersonaAgent` is DB-bound (reads `contentMarkdown`, runs server-side
bag summarization, persists plaintext trace via `SessionTraceObserver`). The
enclave has its own thin orchestrator that mirrors `PersonaAgent`'s shape but
sources messages from the inbound invoke payload, sinks the reply via sealed-
envelope HTTP POST, and uses an `EncryptedTraceObserver`. Total enclave-side
orchestrator: ~200 LOC. The 700-LOC `PersonaAgent` body stays untouched.

## Decisions confirmed by user

1. **Trigger:** always-on companion mode. Ariadne replies to every user message in
   an E2E scratchpad she's invited to. `@`-mention parsing can't see plaintext.
2. **LLM provider:** OpenRouter with `provider.order` + `provider.allow_fallbacks:
   false` pinned to a zero-retention upstream. Same model as plaintext Ariadne
   (`openrouter:anthropic/claude-sonnet-4.6`).
3. **Tool scope (simplified):** *only* tools that don't talk back to the backend.
   `web_search` and `read_url`. Workspace tools (`list_streams`, `list_users`,
   `get_stream`, search tools, memo tools), attachments, GitHub, Linear — **all
   off in 5a**, added in a follow-up phase that builds the callback channel as
   an isolated unit. This keeps 5a focused on "the inference loop works
   end-to-end" without introducing a second auth/scope subsystem.

## E2E tool allowlist (default for enclave-invited scratchpads)

| Tool | Status | Why |
| --- | --- | --- |
| `send_message` | **on** | Reply mechanism; rerouted through enclave's sealed POST. |
| `web_search` | **on** | Existing `redactQuery()` strips ULIDs + secrets before Tavily; query is a sanitized derivative of content, same threat as plaintext Ariadne. No backend round-trip. |
| `read_url` | **on** | URL is external/public by nature; the user typed it. Direct `fetch`, no backend round-trip. |
| Everything else (search_* tools, list_* tools, get_stream*, describe_memo, workspace_research, attachment tools, GitHub, Linear, run_workspace_agent) | **off** in 5a | Every one of these requires a workspace-scoped backend callback. Punted to a later phase that builds the callback channel as a contained unit. |

The allowlist is enforced via the existing `enabledTools: string[] | null` field
on the persona, scoped per-context: persona's normal `enabledTools` for plaintext,
a new `e2eEnabledTools` field for E2E. Set on Ariadne in `built-in-agents.ts`.

## Architecture

### `packages/crypto/` — shared crypto primitives

Move (not copy) `apps/frontend/src/lib/crypto/{encoding,hpke,envelope}.ts` to a new
workspace package `@threa/crypto`. `@hpke/core` is its only runtime dep. The
frontend, the enclave, and the backend (for envelope-shape validation) all consume
it. Frontend keeps `message-envelope.ts`, `decrypt-cache.ts`, `keys.ts`,
`passphrase.ts` (those touch Dexie / TipTap / zustand and aren't isomorphic).

### `apps/enclave/` — new Bun + Express service

- **Stack:** Bun runtime, Express.js (mirrors the regional backend's stack so
  middleware patterns/HttpError handling transfer directly). No `pg`, no
  `@threa/backend-common`. Imports `@threa/crypto`, `@threa/types`, the AI
  wrapper + AgentRuntime + tools (see below).
- **Endpoints:**
  - `GET /healthz` — liveness probe.
  - `GET /pubkey` → `{ instanceId, keyId, publicKey: base64 }`.
  - `GET /attestation` (stub) → `{ source_commit_sha, build_hash }` —
    informational only; 5a doesn't ship client-side verification.
  - `POST /invoke` (shared-secret bearer auth) — full invocation; see wire shape.
- **Boot:** generate X25519 EIK; cache pubkey/keyId. POST
  `/internal/enclave-runtimes/register-key` to the backend with this instance's
  `{ instanceId, keyId, publicKey, instanceUrl }`. The instance owns its own
  EIK lifecycle — other instances' rows are not touched.
- **Multi-instance from day one.** Design assumes any number of enclave
  instances may be live concurrently. Each registers its own EIK row in
  `enclave_runtimes`. No code path may assume "exactly one active enclave" —
  we may run one today, but we plan for HA.
- **Liveness heartbeat:** periodic POST to
  `/internal/enclave-runtimes/heartbeat` (every ~30s) updates `last_seen_at`.
  Stale rows (e.g., `last_seen_at < now() - 2 minutes`) are filtered out of
  the active set without an explicit `revoked_at`. Explicit `revoked_at` only
  set on graceful shutdown or operator action.
- **Egress allow-list:** OpenRouter, Tavily, and the backend's
  `/internal/enclave-runtimes/*` + encrypted-step endpoint. Operationally
  enforced; documented in `apps/enclave/README.md`. Pinned `provider.order` for
  zero-retention.
- **Logging:** `pino` JSON access log only. Never payload bytes. The
  `userId`/`messageId` already cross the boundary as routing metadata.

### Reused agent primitives (no rewrites)

The enclave's `/invoke` handler builds `AgentRuntime` directly:

```text
POST /invoke arrives
  ↓
decrypt inbound message envelopes (using EIK private key)
  → build ModelMessage[] from decrypted history
  ↓
const tools = [
  createWebSearchTool({ tavilyApiKey, currentTime, timezone }),  // direct to Tavily, no callback
  createReadUrlTool(),                                            // direct fetch, no callback
]
  ↓
new AgentRuntime({
  ai, model, modelString, systemPrompt, messages,
  tools, maxTokens, temperature,
  sendMessage: doSendMessageEncrypted,           // seal reply + push back
  observers: [new EncryptedTraceObserver(...)],  // seal each step + push back
  telemetry, costContext,
})
  ↓
await runtime.run()
  → returns final ciphertext envelope + sidecar telemetry
```

`AgentRuntime`, the web tools, and the AI wrapper move to
`packages/agent-runtime/`. The enclave imports them directly. The backend's
`companion/tool-set.ts` stays in `apps/backend/` — it imports the workspace
tools (memos, GitHub, Linear, search) which are backend-coupled and not
needed in the enclave — and it picks up the web tools by re-exporting them
from `@threa/agent-runtime`. The enclave does not call `buildToolSet`; with
only two tools to wire, it constructs the array inline (~5 lines). Future
enclave tools that need backend callbacks will live in their own factory
once 5b ships the callback channel.

**What moves to `packages/agent-runtime/` in 5a.1:**

- `runtime/{agent-runtime, agent-events, agent-observer, agent-tool, otel-observer}.ts`
  + their tests + `truncation.ts` + `tool-trust-boundary.ts`
- `tools/{web-search, read-url, send-message, keep-response}-tool.ts` + tests
- `ai/{ai, text-utils, model-registry, openrouter-cost-interceptor, debug-callback,
  cost-tracking-callback}.ts` + tests + `models.yaml` + `fixtures/`
- `test-otel-setup.ts` (used by both the package's OTEL observer tests and the
  backend researcher trace test; exported as a separate sub-path so the side
  effects only fire when explicitly imported)

**What stays in `apps/backend/src/`:**

- `features/agents/companion/tool-set.ts` (imports workspace/memo/GitHub/Linear
  tools — the enclave doesn't need it)
- `features/agents/tools/{search-workspace, search-attachments, get-attachment,
  describe-memo, load-*, workspace-research, github/*, linear/*}.ts` (all
  workspace-coupled)
- `features/agents/runtime/session-trace-observer.ts` (writes the user-facing
  trace to PostgreSQL via `SessionTrace`)
- `lib/ai/{config-resolver, static-config-resolver, message-formatter,
  postgresql-checkpointer}.ts` (each imports backend-only domain modules)

Backend barrels (`features/agents/runtime/index.ts`,
`features/agents/tools/index.ts`, `lib/ai/index.ts`) re-export the moved
symbols so existing backend import paths keep working.

This is the load-bearing refactor and it merits its own commit before the enclave
service lands. See § Staging.

### Encrypted trace steps

Even with only web tools, the trace contains content fragments: `web_search`
queries, `read_url` URLs, AI-generated reasoning text on each step. We must
encrypt them in the enclave path.

- **Migration:** `agent_session_steps.ciphertext BYTEA`, `envelope JSONB`,
  `e2e_version SMALLINT` (additive, INV-17). For E2E sessions, `content` and
  `sources` are `NULL`. INV-E6.
- **Wire-side step endpoint:** new `POST /api/v1/workspaces/:wid/enclave/sessions/
  :sid/steps` (shared-secret auth + invocationId-scoped). Body:
  `{ stepNumber, stepType, ciphertext, envelope, e2eVersion, startedAt,
  completedAt, tokensUsed }`. Backend writes the row; broadcasts
  `agent_session:step:completed` carrying ciphertext + envelope.
- **Enclave-side observer:** new `EncryptedTraceObserver` class implements the
  same `AgentRuntimeObserver` interface as `SessionTraceObserver` (which is
  already a DI seam in `AgentRuntime`). On each step it seals the step content
  to `[UIK, EIK]`, POSTs to the new endpoint. Same as the existing trace observer
  in flow shape — only the payload is sealed.
- **Frontend trace renderer:** the existing `decrypt-cache` is per-message, not
  per-step. Extend it (or add a sibling `decrypt-step-cache`) keyed by
  `(sessionId, stepNumber)` so the trace dialog decrypts each step on demand with
  the unlocked UIK. The cache invalidates on lock identically to messages.

The `invocationId` referenced by the step endpoint is a one-time-use token
issued by the backend in the invoke payload and bound to that invocation's
session for the duration of the call (5-minute TTL, in-memory map). This is
the smallest fix that prevents a compromised enclave from posting steps to
arbitrary sessions — even though there are no workspace-tool callbacks in
5a, the step endpoint still needs a per-call scope token.

### EIK registration table (multi-instance from day one)

```sql
CREATE TABLE enclave_runtimes (
  id TEXT PRIMARY KEY,                       -- elr_<ulid>
  instance_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  instance_url TEXT NOT NULL,                -- dispatcher target for /invoke
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_enclave_runtimes_key_id ON enclave_runtimes (key_id);
CREATE INDEX idx_enclave_runtimes_live ON enclave_runtimes (last_seen_at DESC)
  WHERE revoked_at IS NULL;
```

Global (no `workspace_id`) — falls under CLAUDE.md INV-8's auth/infra exception.

**No single-active-key constraint.** Multiple instances run concurrently; each
owns its own EIK row. Key uniqueness is enforced on `key_id` globally (one row
per key), not on "active at a time". Liveness is derived: a row counts as live
when `revoked_at IS NULL AND last_seen_at > NOW() - INTERVAL '2 minutes'`. Old
rows are tombstoned in place — never auto-revoked by other instances'
registrations.

Key rotation is per-instance and local: an instance that rotates marks its own
prior row `revoked_at = NOW()` and inserts a new row in the same transaction.
Other instances' rows are unaffected.

**Recipient list scales with active instances.** When the frontend encrypts a
message to an enclave-invited stream, it fetches the *current set* of live
enclave keys and includes every one of them as a recipient alongside the UIK:
`recipients = [UIK, EIK_A, EIK_B, EIK_C, ...]`. The existing multi-recipient
HPKE envelope already supports arbitrary recipient counts. Any live instance
can decrypt and process the message; the dispatcher picks one at invocation
time.

The stream stores `e2eInvitedAgentKind = "enclave"` but **no pinned `keyId`**.
Pinning a single keyId would couple the stream to one instance and break HA.
Instead, each message envelope's recipient list reflects which enclave EIKs
were live at send time.

### Persona schema

`builtInAgentConfigSchema` in `apps/backend/src/features/agents/built-in-agents.ts`
gains:

```ts
e2eCapable: z.boolean().default(false)
e2eEnabledTools: z.array(z.string()).nullable().default(null)
```

Ariadne: `e2eCapable: true`, `e2eEnabledTools: [SEND_MESSAGE, WEB_SEARCH, READ_URL]`.
`EMPTY_AGENT_ID`: stays `false`.

The invite-enclave handler refuses to invite a persona with `e2eCapable !== true`.

### Backend orchestration

A new thin worker dispatches enclave invocations. **It does not run AgentRuntime
itself.** It:

1. Loads persona + stream + e2e_streams row for the triggering user.
2. Loads the encrypted message history (last N messages, ciphertext + envelope +
   sequence + author + timestamps).
3. Picks a live enclave instance from `enclave_runtimes` (filter
   `revoked_at IS NULL AND last_seen_at > NOW() - 2 minutes`). Selection
   strategy is random across live rows in 5a — sticky-by-session or
   least-loaded can come later without changing the wire shape.
4. Loads the current set of live enclave EIKs (same query) so the enclave can
   echo them as recipients on the reply envelope.
5. Mints a one-time `invocationId` and registers the session scope (for the
   encrypted-step endpoint).
6. POSTs to the picked instance's `instance_url + /invoke` with
   `{ invocationId, persona, history, recipients, sessionId, streamId }`.
   Recipients = `[UIK, ...liveEnclaveEIKs]`.
7. On HTTP error / timeout, falls back to another live instance (single retry
   with a different pick); after that, dead-letters the job with a clear
   error surfaced to the UI.
8. Receives the ciphertext reply + sidecar.
9. Writes the reply via `MessageRepository.create` (same path as user messages
   — ciphertext + envelope + placeholder markdown).
10. Records token usage via `AiUsageRecorder.record` with the sidecar.
11. Drops the invocationId scope.

This is the only new orchestrator. It lives in
`apps/backend/src/features/agents/enclave-dispatcher.ts` (~180 LOC, slightly
larger than the single-instance design once the live-set selection + retry
logic is in).

The companion-outbox-handler branches `if (isE2eStream && invitedAgentKind ===
"enclave")` → dispatches `JobQueues.ENCLAVE_PERSONA_AGENT` with the new job
shape. Mention-invoke-handler keeps its existing E2E skip (extracting `@ariadne`
from ciphertext is impossible; 5a is always-on companion mode for enclave-invited
E2E streams).

## Staging within 5a

Four sequenced PRs that each ship something:

### 5a.1 — `packages/agent-runtime/` extraction + `packages/crypto/`

Pure refactor. Move `AgentRuntime`, `buildToolSet`, the three web tools
(`web_search`, `read_url`, `send_message`), AI wrapper, model registry into the
new package. Workspace/memo/GitHub/Linear tools stay in `apps/backend/` for now
and the backend wires them in at its `buildToolSet` call site. Move HPKE
primitives into `packages/crypto/`. Backend continues to work unchanged; all
current callers re-import from the new packages. Tests pass. No behavior change.
This is the load-bearing commit because every subsequent step depends on the
enclave being able to import the shared code.

### 5a.2 — Enclave service, no tools, EIK registry, invite UI

`apps/enclave/` lands with `tools: []` hard-wired. The full encrypted journaling
loop works end-to-end (`packages/crypto/` round-trip, `AgentRuntime` running in
the enclave with no tools, sidecar telemetry, encrypted reply written back via
backend's existing `MessageRepository.create` path). Migration:
`enclave_runtimes`. Frontend: invite UI + multi-recipient `encryptMessage`.
Companion-outbox dispatch added.

**Deliverable:** Kris and his wife can journal against Ariadne in an E2E
scratchpad. No tools. Token cost shows up in usage.

### 5a.3 — Encrypted trace steps

Migration: `agent_session_steps.ciphertext/envelope/e2e_version`. New
`POST /api/v1/workspaces/:wid/enclave/sessions/:sid/steps` endpoint.
`EncryptedTraceObserver` in the enclave. InvocationId scope map for the step
endpoint. Frontend trace renderer decrypts steps on demand. Necessary
infrastructure for tools, ships even with `tools: []` because `AgentRuntime`
still emits step events for each model turn.

**Deliverable:** trace UI shows the same shape it does today (start, messages,
end) for enclave sessions, but the server only sees ciphertext.

### 5a.4 — `web_search` and `read_url`

Both tools call external services directly (Tavily, `fetch`) — no backend
callback needed. Wire them in the enclave's `buildToolSet`. Each tool's
arguments and outputs ride into the trace via the encrypted observer. No new
backend endpoints needed beyond what 5a.3 shipped.

**Deliverable:** Ariadne can web-search and read URLs inside an E2E scratchpad.
Trace shows the query/URL (encrypted, decryptable only by the user).

5a.1 → 5a.2 → 5a.3 → 5a.4 is the strict dependency chain.

## Critical files

### New code

| Path | Purpose |
| --- | --- |
| `packages/crypto/` | New shared package: `encoding.ts`, `hpke.ts`, `envelope.ts` (moved from frontend) |
| `packages/agent-runtime/` | New shared package: `runtime/`, `tool-set.ts`, `tools/{web-search,read-url,send-message}-tool.ts`, `ai/`, `model-registry.ts` (extracted from backend) |
| `apps/enclave/` | New Bun + Express.js service (mirrors regional backend stack); `src/{index,config,keystore,register,heartbeat,invoke-handler,orchestrator,encrypted-trace-observer,llm-client,access-log}.ts`; `Dockerfile`; `README.md` |
| `apps/backend/src/features/enclave-runtimes/{index,repository,service,handlers}.ts` | EIK registry feature folder (INV-51) |
| `apps/backend/src/features/agents/enclave-dispatcher.ts` | ~150 LOC orchestrator that dispatches one invocation to the enclave and writes the reply |
| `apps/backend/src/features/agents/enclave-dispatcher-worker.ts` | Thin worker registered against `JobQueues.ENCLAVE_PERSONA_AGENT` |
| `apps/backend/src/features/agents/enclave-client.ts` | HTTP client to the enclave's `/invoke` |
| `apps/backend/src/features/agents/enclave-invocation-scope.ts` | In-memory invocationId → sessionId map for the step endpoint |
| `apps/backend/src/db/migrations/<ts>_enclave_runtimes.sql` | New table (5a.2) |
| `apps/backend/src/db/migrations/<ts>_agent_session_steps_e2e.sql` | New ciphertext columns (5a.3) |

### Existing files modified (pattern, not enumeration)

- **`apps/backend/src/features/agents/built-in-agents.ts`** — schema gains
  `e2eCapable` + `e2eEnabledTools`; Ariadne set with the web-only allowlist.
- **`apps/backend/src/features/agents/companion-outbox-handler.ts:114-119`** —
  branch on `invitedAgentKind === "enclave"` to dispatch new queue.
- **`apps/backend/src/lib/queue/job-queue.ts`** — add `ENCLAVE_PERSONA_AGENT`.
- **`apps/backend/src/index.ts`** — construct `EnclaveClient` once at boot
  (INV-13); register new worker.
- **`apps/backend/src/routes.ts:236-242`** — add `/internal/enclave-runtimes/*`
  (shared-secret), `GET /api/v1/workspaces/:wid/enclave/active-key`,
  `POST /api/v1/workspaces/:wid/streams/:sid/invite-enclave`,
  `POST /api/v1/workspaces/:wid/enclave/sessions/:sid/steps`.
- **`apps/backend/src/features/e2e-streams/repository.ts`** — add
  `setInvitedAgent(streamId, kind, keyId)`.
- **`apps/backend/src/features/streams/`** — bootstrap `StreamWithPreview` gains
  `e2eInvitedAgentKind` only. **No pinned `keyId`/`publicKey` on the stream** —
  recipients are recomputed per-message from the live enclave set.
- **`packages/types/src/constants.ts`** — add `E2E_INVITED_AGENT_KINDS`.
- **`apps/frontend/src/lib/crypto/{hpke,envelope,encoding}.ts`** — delete (moved
  to `@threa/crypto`); other crypto files re-import from the package.
- **`apps/frontend/src/lib/crypto/message-envelope.ts`** —  `encryptMessage`
  takes `recipients: Array<{recipientKeyId, publicKey}>`; backward-compatible
  when length is 1.
- **`apps/frontend/src/lib/crypto/decrypt-cache.ts`** (or new
  `decrypt-step-cache.ts`) — add per-step keying for trace decryption (5a.3).
- **`apps/frontend/src/hooks/use-stream-or-draft.ts:561-593`** — multi-recipient
  encryption when `invitedAgentKind === "enclave"`: fetch current
  `active-keys`, include every live EIK alongside the UIK on each message.
- **`apps/frontend/src/db/database.ts`** — `Stream` IDB shape + sync engine
  carry `e2eInvitedAgentKind` only (no pinned key fields).
- **`apps/frontend/src/components/layout/sidebar/stream-item.tsx`** + scratchpad
  header — recipients popover renders the UIK fingerprint plus *all* current
  live enclave EIK fingerprints (variable-length list); "Invite Ariadne" button
  on empty E2E scratchpads.
- **`apps/frontend/src/api/enclave.ts`** (new) — `getActiveEnclaveKeys` (plural,
  returns array), `inviteEnclave`.
- **`Dockerfile.backend`** + new `Dockerfile.enclave` — `COPY packages/crypto/`,
  `COPY packages/agent-runtime/`.

### Reused, do not reimplement

| Existing utility | Path | Reuse for |
| --- | --- | --- |
| `AgentRuntime` | `apps/backend/src/features/agents/runtime/agent-runtime.ts` | The actual AI loop; runs identically in both processes |
| `buildToolSet` | `apps/backend/src/features/agents/companion/tool-set.ts` | Tool wiring; the only knob that changes is `enabledTools` |
| `web_search`, `read_url`, `send_message` tool implementations | `apps/backend/src/features/agents/tools/` | Move into `packages/agent-runtime/`; backend and enclave both use them |
| AI wrapper (`createAI`) | `apps/backend/src/lib/ai/ai.ts` | INV-28; only one AI call shape |
| `@hpke/core` envelope helpers | (moving to `@threa/crypto`) | Already shipped in Phase 1 |
| `MessageRepository.create` | `apps/backend/src/features/messaging/repository.ts:389-410` | Same E2E write path users use; reuse from `enclave-dispatcher.ts` |
| `E2eStreamsRepository.{isE2eStream,getByStreamId}` | `apps/backend/src/features/e2e-streams/repository.ts` | Outbox skip + recipient resolution |
| `AiUsageRecorder` | `apps/backend/src/features/ai-usage/` | INV-19 telemetry from the sidecar |
| `internalAuth` middleware | `apps/backend/src/routes.ts:236-242` | Shared-secret for enclave→backend calls |
| Frontend `decrypt-cache` | `apps/frontend/src/lib/crypto/decrypt-cache.ts` | Per-message decrypt; pattern reused for per-step trace decrypt |

## Wire shapes

```
GET  /pubkey                                            (enclave, public)
  Resp: { instanceId, keyId, publicKey: base64 }

POST /invoke                                            (backend → enclave, bearer)
  Body: {
    invocationId, sessionId, streamId,
    persona: { id, name, systemPrompt, model, temperature, maxTokens,
               e2eEnabledTools, currentTime, timezone },
    history: [{ id, authorId, authorType, createdAt,
                ciphertext, envelope, e2eVersion, sequence }, ...],
    recipients: [{ recipientKeyId, publicKey: base64 }, ...],   // [UIK, EIK]
    aadParts: { streamId, senderId },
    tavilyApiKey,                                       // for direct external calls
  }
  Resp: {
    reply: { ciphertext, envelope, e2eVersion },
    sidecar: { modelName, providerName, latencyMs,
               promptTokens, completionTokens, costUsd },
  }

POST /internal/enclave-runtimes/register-key            (enclave → backend, internalAuth)
  Body: { instanceId, keyId, publicKey: base64, instanceUrl }
  Resp: 201 { id }

POST /internal/enclave-runtimes/heartbeat               (enclave → backend, internalAuth)
  Body: { keyId }
  Resp: 204                                             // updates last_seen_at

POST /api/v1/workspaces/:wid/enclave/sessions/:sid/steps (enclave → backend, invocationId)
  Body: { invocationId, stepNumber, stepType, ciphertext, envelope, e2eVersion,
          startedAt, completedAt, tokensUsed? }
  Resp: 201 { id }

GET  /api/v1/workspaces/:wid/enclave/active-keys        (frontend → backend, workspace member)
  Resp: { keys: [{ instanceId, keyId, publicKey: base64 }, ...] }
  // Empty array when no live enclave instances; UI surfaces "no enclave available"

POST /api/v1/workspaces/:wid/streams/:sid/invite-enclave (frontend → backend, workspace member)
  Body: {}
  Resp: { stream } with updated e2eInvitedAgentKind="enclave"
  // Stream stores no pinned keyId; recipients are recomputed per-message
```

## Invariants to actively respect

- **INV-E1** — `enclave-dispatcher` writes only via `MessageRepository.create`
  with ciphertext + envelope + e2eVersion populated; the Phase 3.5 row-level
  constraint enforces this.
- **INV-E2** — companion + mention outbox handlers retain skips for non-enclave-
  invited E2E streams; only companion handler dispatches enclave queue.
- **INV-E6** — `agent_session_steps.ciphertext/envelope/e2e_version` ship in
  5a.3; for E2E sessions `content` and `sources` are `NULL`.
- **INV-9 / INV-13** — `EnclaveClient` + invocation scope map constructed once
  at backend boot; injected.
- **INV-19** — every enclave invocation records via `AiUsageRecorder` with
  sidecar values.
- **INV-28** — AI wrapper used in both processes; no raw SDK imports in the
  enclave.
- **INV-29** — `enclave-dispatcher.ts` colocates with `persona-agent.ts` in
  `features/agents/`. No shared base class.
- **INV-30 / INV-41** — `enclave-dispatcher` releases the DB connection before
  the HTTP call to the enclave; re-acquires for the reply write.
- **INV-48** — when testing the dispatcher, spy on the `EnclaveClient` namespace
  import; no `vi.mock(...)` for the shared agent runtime.
- **INV-51 / INV-52** — `enclave-runtimes/` is a feature folder with an
  `index.ts` barrel.
- **INV-2** — new ID prefix `elr_` for `enclave_runtimes`.

## Verification (cumulative across stages)

End-to-end on a single laptop, after all four sub-stages:

1. `bun run db:migrate`
2. `bun run dev:backend`, `bun run dev:enclave`, `bun run dev:frontend`
3. Confirm `enclave_runtimes` has one row with `revoked_at IS NULL`.
4. UI: create encrypted scratchpad, set passphrase, unlock.
5. Click "Invite Ariadne" → recipients popover shows the UIK fingerprint plus
   one EIK fingerprint per live enclave instance.
6. Type "What's on my mind about X?" — Ariadne replies; reply renders.
   With a second enclave instance running, the recipient list expands to two
   EIK fingerprints and dispatcher round-trips succeed against either.
7. Type "search Google for foo" — Ariadne invokes `web_search` (Tavily call
   leaves the enclave directly; backend sees only ciphertext step).
8. Type "fetch https://example.com" — Ariadne invokes `read_url`; trace step
   encrypted; clicking it decrypts and shows the fetched content inline.
9. **DB invariant check:** all enclave-written `messages` rows have
   `ciphertext NOT NULL`, `content_markdown = E2E_PLACEHOLDER`. All trace step
   rows for the session have `ciphertext NOT NULL`, `content IS NULL`.
10. **Backend log check:** grep for any prompt fragment — nothing.
11. **Enclave log check:** grep for any prompt fragment — nothing. Access logs
    have timing, sizes, model, token counts only.
12. **Usage check:** `ai_usage_records` rows tagged with the right session +
    workspace.
13. Restart enclave; the restarted instance's old row stops heartbeating and
    falls out of the live set (or is explicitly `revoked_at` on graceful
    shutdown); a new row appears for the new EIK. Concurrent second-instance
    rows are unaffected. Old conversation messages still decrypt via UIK
    regardless of enclave fleet churn.
14. **HA smoke test:** run two enclave instances; kill one mid-conversation;
    dispatcher falls back to the surviving instance on the next message
    without user-visible failure.

Tests:

- `packages/crypto/src/envelope.test.ts` — moved from frontend, still pass.
- `packages/agent-runtime/src/**/*.test.ts` — moved with the package; tests
  exercise tools + runtime without backend-specific deps.
- `apps/backend/src/features/enclave-runtimes/repository.test.ts` — register,
  rotate, revoke.
- `apps/backend/src/features/agents/enclave-dispatcher.test.ts` — given a
  stubbed `EnclaveClient`, dispatcher writes ciphertext via `MessageRepository`,
  calls `AiUsageRecorder.record`, never reads `contentMarkdown` from input.
- `apps/enclave/src/invoke-handler.test.ts` — given a stubbed LLM client and
  static EIK private key, round-trip ciphertext ↔ plaintext ↔ reply ciphertext
  with a tool call (web_search) in the middle.

## Explicitly out of scope (5b and later)

- **All workspace-aware tools.** `list_streams`, `list_users`, `get_stream`,
  `search_*`, `describe_memo`, `workspace_research`. Each requires an
  enclave→backend authenticated callback channel with invocationId-bound scope
  tokens. Built as a contained follow-up phase so 5a can ship the inference
  loop without that subsystem.
- **Attachment E2E in enclave-invited streams.** Attachment encryption is its
  own protocol slice (Phase 3 of the doc) — defer to a separate phase.
- **GitHub / Linear tools in the enclave.** Workspace integration tokens cross
  the trust boundary; punt to the post-callback-channel phase.
- **Real TEE attestation.** `GET /attestation` stub returns commit SHA + build
  hash for docs only.
- **Smarter dispatcher pick.** 5a uses random selection across the live set
  with one fallback retry; sticky-by-session, least-loaded, or queue depth
  awareness can come later without protocol changes.
- **`@`-mention inside E2E scratchpads.** Always-on companion semantics in 5a.
- **`bot_invocations` schema changes.** Pi-remote path stays as-is.
