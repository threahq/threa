# Phase 5a (redesign) — Ariadne enclave on a per-stream symmetric key (SSK)

> Supersedes the keying design in `.claude/plans/shiny-weaving-lovelace.md`.
> That plan's product context, threat model, and service-shell shape are still
> correct; its **keying design (one EIK + per-user UIK + per-message recipient
> fan-out, no per-stream key) is WRONG and is replaced wholesale here.** PR #646
> (`claude/e2e-5a-2-enclave-service`) implemented the old design and is being
> closed; keep its branch as read-only reference only.

## 0. Why we are redoing this

The shipped-and-closed design sealed each message to a per-message recipient
list `[UIK, ...liveEIKs]` with no per-stream key. Two fatal flaws:

1. **Cross-user leakage is not prevented cryptographically.** A bug in
   recipient-list construction could place another user's UIK on the list and
   nothing stops it.
2. **Message loss on enclave rotation.** EIKs are generated in-memory at boot
   and never persisted; when the enclave redeploys, history sealed to the old
   EIK is undecryptable by the new instance. The old orchestrator
   (`apps/enclave/src/orchestrator.ts` `decryptHistory`) **silently skipped**
   undecryptable history (catch + continue) → Ariadne gets amnesia after every
   deploy.

Confirmed in the closed code, all four target bugs are present:
`decryptHistory` catch-and-continue (silent skip); a single `capturedReply`
string (overwrite, not append); per-message `[UIK, ...EIKs]` recipients (no
SSK); and `replyMessageId`/`invocationId` minted fresh per `runJob` (not
idempotent on retry).

## 1. The design: per-stream symmetric key (SSK)

Every E2E scratchpad ("stream") owns its own AES-256 key — the **SSK** — scoped
to a **key generation** (integer, starts at 1). Messages are AEAD-sealed
directly under the current-generation SSK. The SSK itself is never stored in
plaintext on the server; it exists only **HPKE-wrapped** to each authorized
recipient's long-term public key — the active UIKs of stream members plus the
currently-live EIKs. Wraps live in a new `stream_e2e_key_wraps` table. Each
message references the SSK by `(stream_id, key_generation)`.

This single primitive fixes everything:

- **Cross-user isolation is cryptographic.** A non-member's UIK is never wrapped
  to the stream's SSK, so a recipient-list bug cannot expose the stream.
- **Enclave rotation is lossless.** When a new EIK appears, the client wraps the
  *existing* SSK to the new EIK and uploads it. The SSK never changes — only its
  wrappers — so all history stays readable. No silent skip.
- **Edits** re-seal one ciphertext under the same SSK; everyone authorized reads.
- **Member removal (Signal model):** bump `key_generation`, generate a new SSK,
  wrap to remaining members only. The removed member keeps wraps for old
  generations (reads history they already had) but gets no wrap for the new one.
- **Member add with inviter-chosen history visibility (required):**
  - *See history* → wrap the **existing** current-generation SSK to the new
    member's UIK (one row). No re-encryption.
  - *Start fresh* → bump generation; new SSK wrapped to old members + the new
    member; the new member has no wrap for older generations.
  This is a single bit chosen at invite time and surfaced in the invite UI.
- **Bonus:** closes operator-spoofing of Ariadne replies — a backend operator
  cannot seal new content under the SSK without an EIK or UIK private key.

EIKs stay ephemeral (privacy posture). Wraps to dead EIKs remain in the table
forever — harmless, since those private keys are gone.

### 1.1 Cryptographic operations (all client-side / enclave-side; server sees ciphertext only)

- **Generate SSK:** 32 random bytes (AES-256). Generation starts at 1.
- **Wrap SSK to a recipient:** `wrapStreamKey({ key, recipientPublicKey, aad })`
  → `{ enc, ct }`, where `aad = buildWrapAad({ streamId, keyGeneration,
  recipientKeyId })` binds the wrap to its `stream_e2e_key_wraps` slot so a
  malicious server can't relocate a wrap row to a different
  stream/generation/recipient. Thin wrapper over the existing HPKE `seal()`.
- **Unwrap SSK:** `unwrapStreamKey({ enc, ct, recipientPrivateKey, aad })` →
  `sskBytes` (validates recovered length === 32).
- **Seal a message:** `AES-256-GCM(ssk, iv, payload, aad)` →
  `{ iv, ciphertext }`. New thin helper `sealMessage` in `@threa/crypto`.
- **Open a message:** `AES-256-GCM-open(ssk, iv, ciphertext, aad)`. New helper
  `openMessage`.
- **AAD** continues to bind `streamId | messageId | senderId` via the existing
  `buildMessageAad`, so the server still can't shuffle envelopes between rows.

### 1.2 New message envelope shape

The current `Envelope` (`@threa/crypto/envelope.ts`) carries an inline
`recipients[]` (per-message HPKE fan-out). The SSK design moves recipient
wrapping out of the message and into `stream_e2e_key_wraps`, so the
message-level envelope becomes:

```ts
interface StreamEnvelope {
  v: number            // STREAM_ENVELOPE_VERSION = 2 (distinct from the v1 recipient-fan-out shape)
  keyGeneration: number
  iv: string           // base64 AES-GCM IV
  aad: string          // base64 AAD bytes
  // ciphertext stays in messages.ciphertext (BYTEA); also mirrored here is unnecessary
}
```

`messages.ciphertext BYTEA` holds the AES-GCM ciphertext (incl. tag);
`messages.envelope JSONB` holds `StreamEnvelope`; `messages.e2e_version` is the
new envelope version. A reader resolves the SSK from the wrap table by
`(stream_id, keyGeneration, theirKeyId)`, HPKE-opens it, then AES-opens the
message. **No new `messages` column is required** — `keyGeneration` rides inside
the envelope JSON.

## 2. Schema (new tables — global infra tables fall under the INV-8 exception; product tables are workspace-scoped)

### 2.1 `stream_e2e_keys` — generation metadata (no SSK plaintext)

```sql
CREATE TABLE stream_e2e_keys (
  id TEXT PRIMARY KEY,                       -- sek_<ulid>  (INV-2)
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  key_generation INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stream_id, key_generation)
);
CREATE INDEX idx_stream_e2e_keys_stream ON stream_e2e_keys (workspace_id, stream_id, key_generation DESC);
```

The active generation for sealing is tracked on `e2e_streams`
(`current_key_generation INTEGER NOT NULL DEFAULT 1`, added by migration). The
SSK bytes live *only* in `stream_e2e_key_wraps`.

### 2.2 `stream_e2e_key_wraps` — one wrap per (stream, generation, recipient key)

```sql
CREATE TABLE stream_e2e_key_wraps (
  id TEXT PRIMARY KEY,                       -- sekw_<ulid>
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  key_generation INTEGER NOT NULL,
  recipient_kind TEXT NOT NULL,              -- 'user' | 'enclave'  (TEXT, validated in code — INV-3)
  recipient_key_id TEXT NOT NULL,            -- UIK key_id or EIK key_id
  wrap_enc BYTEA NOT NULL,                   -- HPKE encapsulation
  wrap_ct BYTEA NOT NULL,                    -- HPKE-wrapped SSK bytes
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stream_id, key_generation, recipient_key_id)
);
CREATE INDEX idx_stream_e2e_key_wraps_gen ON stream_e2e_key_wraps (workspace_id, stream_id, key_generation);
CREATE INDEX idx_stream_e2e_key_wraps_recipient ON stream_e2e_key_wraps (recipient_key_id);
```

Wrap upload is race-safe: `INSERT ... ON CONFLICT (stream_id, key_generation,
recipient_key_id) DO NOTHING` (INV-20). Re-uploading an identical wrap is a
no-op.

### 2.3 `enclave_runtimes` — EIK registry (reuse closed PR's design verbatim)

```sql
CREATE TABLE enclave_runtimes (
  id TEXT PRIMARY KEY,                       -- elr_<ulid>
  instance_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  instance_url TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_enclave_runtimes_key_id ON enclave_runtimes (key_id);
CREATE INDEX idx_enclave_runtimes_live ON enclave_runtimes (last_seen_at DESC) WHERE revoked_at IS NULL;
```

Liveness derived: `revoked_at IS NULL AND last_seen_at > NOW() - 2 min`.
Multi-instance from day one; never a single-active-key assumption.

### 2.4 `enclave_invocations` — idempotent job identity + revive linkage (HR #6, HR #1)

```sql
CREATE TABLE enclave_invocations (
  id TEXT PRIMARY KEY,                       -- einv_<ulid>  (this IS the invocationId)
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  queue_message_id TEXT NOT NULL,            -- links to queue_messages.id for revive
  trigger_message_id TEXT NOT NULL,
  base_reply_message_id TEXT NOT NULL,       -- minted ONCE; per-output id = base-<index>
  session_id TEXT NOT NULL,                  -- agent_session id for the trace
  status TEXT NOT NULL,                      -- 'pending' | 'awaiting_wrap' | 'completed' | 'failed'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (queue_message_id)
);
CREATE INDEX idx_enclave_invocations_stream_status ON enclave_invocations (workspace_id, stream_id, status);
```

On the **first** job attempt the dispatcher `INSERT ... ON CONFLICT
(queue_message_id) DO NOTHING` then `SELECT` to read back, minting
`invocationId` / `base_reply_message_id` / `session_id` exactly once. On retry,
it reuses the existing row. Per-output ids = `${base_reply_message_id}-${index}`.
Because `MessageRepository.insert` uses `ON CONFLICT (stream_id,
client_message_id) DO NOTHING` and returns the existing row, re-writing the same
ids on retry is a no-op (verified: `messaging/repository.ts:385-423`).

### 2.5 `agent_session_steps` E2E columns (PR 5)

Additive (INV-17): `ciphertext BYTEA`, `envelope JSONB`, `e2e_version SMALLINT`.
For E2E sessions `content` and `sources` are `NULL`.

## 3. How the six hard requirements are met

### HR #1 — No message loss on enclave rotation (needs-wrap → soft-dead-letter → revive)

The dispatcher, **before** calling any enclave instance, resolves the set of
key generations spanned by the dispatched history window + the current
generation (for sealing the reply). It then needs a live EIK that has a wrap for
**every** generation in that set.

- If at least one live EIK is fully covered → dispatch to an instance whose EIK
  is covered. The enclave can decrypt all history and seal the reply.
- If **no** live EIK is fully covered → do not dispatch, do not process partial
  history. Instead:
  1. Throw `SoftDeadLetterError` (new sentinel). `QueueManager.processMessage`
     gains a small branch: a `SoftDeadLetterError` skips the retry/backoff path
     and goes straight to `moveMessageToDlq` (manager.ts:837-858). This avoids
     burning five backoff retries while the client catches up.
  2. The `ENCLAVE_PERSONA_AGENT` handler is registered with an `onDLQ` hook
     (existing seam, job-queue.ts:298-311; runs in the DLQ transaction with a
     `Querier`). The hook writes an `enclave:needs-wrap` outbox event carrying
     `{ streamId, invocationId, missing: [{ keyGeneration, eikKeyId, eikPublicKey }...] }`
     and flips `enclave_invocations.status = 'awaiting_wrap'` — atomically with
     the DLQ move.
- The frontend receives `enclave:needs-wrap` (it already holds the unlocked
  UIK, so it can unwrap the SSK for any generation it has a wrap for), re-wraps
  those SSK generations to the named live EIKs, and uploads via the wrap
  endpoint.
- **Uploading a wrap revives the job.** The wrap-upload handler, after
  persisting wraps, finds `enclave_invocations WHERE stream_id = ? AND status =
  'awaiting_wrap'` and calls `QueueRepository.unDlq(queue_message_id)`
  (repository.ts:393-414 — clears `dlq_at`, resets `failed_count`, sets
  `process_after = NOW()` for immediate retry) + sets status back to `'pending'`.
  The retried job re-checks coverage; now covered, it dispatches and processes
  in full.

Net: either the message is processed in full, or the user sees an "enclave is
updating, reply coming shortly" affordance (driven by the `enclave:needs-wrap`
event) — never silent loss.

### HR #2 — An invocation may produce MULTIPLE messages (append, not overwrite)

The enclave→backend response is `{ messages: [{ keyGeneration, iv, ciphertext,
envelope, e2eVersion }...], sidecar }`. The enclave orchestrator's `sendMessage`
callback **appends** each produced message to an array (replacing the closed
code's single `capturedReply`). The dispatcher iterates `messages` and writes
each via `MessageRepository.insert` with `clientMessageId =
${base_reply_message_id}-${index}`.

### HR #3 — Same trigger semantics as plaintext persona-agent

Per-message trigger, history fan-in via `MessageRepository.list`. The companion
outbox handler currently *skips* E2E streams (`companion-outbox-handler.ts:116`).
The new branch: if the stream is E2E **and** `invitedAgentKind === "enclave"`,
dispatch `JobQueues.ENCLAVE_PERSONA_AGENT` instead of skipping; otherwise keep
the skip. The mention handler keeps its E2E skip (ciphertext `@`-mentions are
invisible — always-on companion mode for enclave-invited E2E). No new trigger
model.

### HR #4 — Edits

Re-seal one ciphertext under the same SSK (same generation). `MessageRepository`
edit path is extended to update `ciphertext`/`envelope`/`e2e_version` (today
`updateContent` only touches `content_json`/`content_markdown`). Outbox
`message:edited` propagates; the frontend re-decrypts on render.

### HR #5 — Deletes

Soft-delete + tombstone (existing `softDelete` sets `deleted_at`; `list` already
filters `deleted_at IS NULL`). The enclave history fetch therefore never sees
tombstoned messages and always uses the latest ciphertext per message (edits
update in place). Accepted: the model may have seen pre-delete content in a
prior invocation — not engineered around.

### HR #6 — Idempotent job retries

Custom Postgres queue (`lib/queue/manager.ts`, `maxRetries` default 5 +
exponential backoff — NOT BullMQ). `invocationId` + `base_reply_message_id` are
minted **once per job** (persisted to `enclave_invocations` on first attempt,
reused on retry — §2.4), and per-output ids are `${base}-${index}`. Combined
with `MessageRepository.insert`'s `ON CONFLICT DO NOTHING`-returns-existing,
duplicate writes on retry are no-ops.

## 4. Accepted trade-offs (already signed off)

- Enclave-lifetime compromise window: a compromised running enclave exposes the
  SSKs wrapped to its EIK during its lifetime. Real fix = attested TEE (Nitro),
  future phase.
- No streaming replies in E2E (request/response, full sealed reply per
  invocation).
- Delete removes from storage + future context, not from an LLM's already-seen
  prior context.

## 5. PR stack (strict dependency chain, each independently mergeable)

> **PR 1 — the `@threa/crypto` + `@threa/agent-runtime` extraction — is ALREADY
> MERGED on `main`** (commit `da02c7e`, #642). The multi-recipient envelope, the
> AI wrapper, `AgentRuntime`, and the web/send tools are already shared
> packages. PR 2 below re-verifies that extraction and lands the genuinely-new
> SSK primitives as a small, standalone, self-testing package change so the
> service/protocol PRs that follow can import them without bundling crypto into a
> larger diff.

- **PR 1 (DONE, #642):** extract `packages/crypto/` + `packages/agent-runtime/`.
  Load-bearing; everything else imports from these.

- **PR 2 (THIS PR) — Audit extraction + SSK crypto primitives.** Re-verify #642's
  extraction is sound (crypto typechecks, envelope tests green, backend barrels
  re-export correctly). Add `packages/crypto/src/stream-key.ts`: the symmetric
  SSK layer that `envelope.ts` (recipient-fan-out, v1) deliberately can't
  express — `generateStreamKey`, `sealMessage`/`openMessage`/`openMessageAsString`
  (AES-256-GCM directly under the SSK, `STREAM_ENVELOPE_VERSION = 2`),
  `wrapStreamKey`/`unwrapStreamKey` (HPKE-wrap the SSK to a recipient UIK/EIK),
  `buildWrapAad` (binds a wrap to its `(streamId, keyGeneration, recipientKeyId)`
  slot), and the `StreamEnvelope`/`StreamKeyWrap` types. Export from the barrel;
  cover with vitest (round-trips, wrong-key/forged-AAD/bad-version rejections,
  the cross-recipient "two recipients open one SSK-sealed message" property,
  `buildWrapAad` determinism, 32-byte validation). Deliverable: `@threa/crypto`
  exposes the SSK API the protocol PR depends on, fully tested in isolation.

- **PR 3 — Enclave SERVICE SHELL.** `apps/enclave/` (Bun + Express):
  `/healthz`, `/pubkey`, `/attestation`; EIK generation + keystore;
  register/heartbeat/revoke against the backend; `enclave_runtimes` table +
  `enclave-runtimes/` feature folder (repo/service/handlers/barrel);
  internal shared-secret auth; SSRF guards on `instanceUrl`; invite flow setting
  `e2eInvitedAgentKind = "enclave"`; `active-keys` endpoint; invite UI.
  **No AgentRuntime yet** (`e2eCapable: false` on Ariadne). Deliverable: enclave
  deployable, visible in active-keys, invite works, **no replies yet.** Most of
  this is portable from the closed PR's scaffolding (high quality, reusable).

- **PR 4 — Enclave dispatcher + AgentRuntime in the enclave + the SSK protocol.**
  Tables `stream_e2e_keys` + `stream_e2e_key_wraps` + `enclave_invocations`;
  `e2e_streams.current_key_generation`; wrap repo + endpoints; frontend SSK
  gen/wrap/seal/open (using the PR 2 primitives) + member-add history-visibility
  bit; the `SoftDeadLetterError` queue enhancement + `enclave:needs-wrap` outbox
  event + revive-on-wrap-upload; `tools: []` hard-wired; multi-message output;
  idempotent job ids; edit/delete propagation; Ariadne `e2eCapable: true`.
  Deliverable: rotation-safe, multi-message E2E Ariadne replies with edits/deletes.

- **PR 5 — Encrypted trace.** `agent_session_steps.ciphertext/envelope/e2e_version`;
  step endpoint (invocationId-scoped); `EncryptedTraceObserver` in the enclave
  (seals each step under the SSK); frontend per-step decrypt renderer.
  Deliverable: trace UI works for E2E sessions; server sees only ciphertext.

- **PR 6 — Web tools.** `web_search` + `read_url` wired in the enclave (both call
  external services directly, no backend callback). Deliverable: Ariadne can
  search/read URLs inside an E2E scratchpad.

Each PR starts from a fresh branch off latest `origin/main` (e.g.
`claude/e2e-enclave-ssk-pr3`). No PR opened unless asked.

## 6. Out of scope (tracked separately)

The E2E **unlock UX** (passphrase re-entry on app open) is a separate track with
its own plan. This stack touches it only as far as the SSK protocol strictly
requires (the frontend must hold the unlocked UIK to wrap/unwrap SSKs).

## 7. Invariants to actively respect

INV-2 (`elr_`, `sek_`, `sekw_`, `einv_` prefixes), INV-3 (no DB enums —
`recipient_kind`/`status` are TEXT validated in code), INV-8 (workspace-scoped
product tables), INV-17 (append-only migrations), INV-20 (race-safe wrap upload
+ invocation insert), INV-28 (AI only via `createAI`), INV-19 (telemetry/usage
on every invocation via the sidecar), INV-13 (`EnclaveClient` + services
constructed once at boot), INV-30/41 (release DB connection across the enclave
HTTP call), INV-48 (spy on the `EnclaveClient` namespace; no `vi.mock` of shared
runtime), INV-51/52 (feature-folder colocation + barrels for `enclave-runtimes`,
the wrap feature, and `enclave-invocations`), INV-55 (Zod at boundaries),
INV-33 (centralize constants — generation start, staleness window, history
limit).

## 8. Reference (closed PR #646, read-only)

Reusable near-verbatim for PR 3: `apps/enclave/src/{config,keystore,register,
heartbeat,index,access-log}.ts`, `apps/enclave/package.json`,
`apps/backend/src/features/enclave-runtimes/{repository,service,handlers,index}.ts`,
the SSRF `isPermittedInstanceUrl` guard, the `createBearerAuth` timing-safe
check. **Discard and rewrite** for PR 4: `orchestrator.ts` (single
`capturedReply` + silent `decryptHistory` skip), `enclave-dispatcher.ts`
(per-message `[UIK, ...EIKs]` recipients, fresh ids per run, no SSK), and the
`/invoke` wire shape (must become SSK-based + multi-message).
