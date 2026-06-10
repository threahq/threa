# Agent Runtimes Unification — Phase 0.1: Required-sources commit payload + sealed reply sources (E2EE-9)

## Goal

First item of the Phase 0 migration plan in `docs/plans/agent-runtimes-unification-redesign.md`
(§2.4, item 0.1). The shared agent loop accumulates citation `SourceItem[]`s from tool
results and hands them to `sendMessage`, but the commit payload's `sources` field was
optional — so the enclave host silently destructured only `{ content }` and every
researched E2E answer rendered with zero citations (audit finding E2EE-9). This PR makes
`sources` a required field of the commit payload (empty array = none, omission doesn't
compile) and threads the sources through the sealed reply payload to the browser, which
renders them under the decrypted reply.

## What Was Built

### Required-`sources` commit payload (shared loop)

`AgentRuntimeConfig.sendMessage` now takes `{ content: string; sources: SourceItem[] }`
with `sources` required. The loop always passes the accumulated array (possibly empty).
A host that ignores citations no longer type-checks.

**Files:**

- `packages/agent-runtime/src/runtime/agent-runtime.ts` — required `sources` on the
  `sendMessage` config field; `commitMessage` passes the array unconditionally.
- `packages/agent-runtime/src/runtime/agent-runtime.test.ts` — the §2.8 q4 spike test:
  a turn whose tool results carried sources must commit non-empty sources; a sourceless
  turn commits `[]`, not `undefined`.
- `apps/backend/src/features/agents/persona-agent.ts` — companion `doSendMessage`
  tightened to the required shape; stub-mode call passes `sources: []`.

### Sources inside the sealed payload (crypto)

`E2eSealedPayload` gains an optional `sources` field carried INSIDE the SSK ciphertext —
sources reveal what was researched, so they must never travel as a cleartext column or
wire field (the E2EE-9 design constraint). A reply with neither attachments nor sources
still seals the bare markdown string, byte-identical to every E2E message already
written; older payloads parse unchanged.

**Files:**

- `packages/crypto/src/sealed-payload.ts` — `SealedSourceItem` (structural twin of
  `@threa/types`' `SourceItem`; the crypto package stays dependency-free, mirroring how
  `EnclaveStreamEnvelope` mirrors `StreamEnvelope`), `serializeSealedPayload(content,
refs?, sources?)`, `parseSealedPayload` returns validated `sources` (malformed
  elements dropped, same defence as `isAttachmentRef`).
- `packages/crypto/src/index.ts` — exports.

### Enclave commits sealed sources

The enclave's `sendMessage` (the E2EE-9 bug site) now destructures `{ content, sources }`
and seals `serializeSealedPayload(content, undefined, sources)` under the reply SSK.
The wire shape (`SealedReply`) is unchanged: ciphertext + envelope only; the backend
callback handler needs no change and never sees the sources.

**Files:**

- `apps/enclave/src/agent/run-turn.ts` — seal sources into the reply payload.
- `apps/enclave/src/agent/run-turn.test.ts` — enclave-path spike test: a turn whose
  `web_search` (hermetic fetch stub) carried a source seals it inside the reply payload
  and the owner's SSK recovers it; a sourceless reply stays a bare string.

### `EnclaveSealedReply` → `SealedReply` rename (§2.6 rule 1)

Per the redesign's forward-compatibility rules, sealed wire types touched by Phase 0.1
are renamed out of the enclave namespace — they are a shared sealed vocabulary any
owner-granted sealed actor may produce, not enclave-owned. Full rename, no deprecated
alias (INV-49). `EnclaveSealedStep` is deliberately untouched here; it renames in
Phase 0.2 when it is extended (same rule).

**Files:**

- `packages/types/src/api.ts`, `packages/types/src/index.ts` — rename + doc comment.
- `apps/enclave/src/agent/run-turn.ts`, `backend-callbacks.ts`, `run-turn.test.ts`,
  `sessions.test.ts` — updated imports.

### Rendering decrypted reply sources

The browser's sealed-payload open path surfaces `sources` through the decrypt cache, and
the message bubble renders a collapsible "Sources (n)" list under a decrypted E2E reply.
The render gate is the decrypted payload itself (the stream axis), never "is this the
enclave".

**Files:**

- `apps/frontend/src/lib/crypto/message-envelope.ts` — `DecryptedMessageContent.sources`,
  populated by the v2 open path (v1 fan-out predates sources → `[]`).
- `apps/frontend/src/hooks/use-decrypted-message-content.ts` — `decrypted` variant
  carries `sources`.
- `apps/frontend/src/components/timeline/message-sources.tsx` — new `MessageSourceList`
  (Shadcn Collapsible, styled after the trace dialog's `SourceList`).
- `apps/frontend/src/components/timeline/message-event.tsx` — threads `sources` from the
  decrypt hook into `MessageLayout` next to `attachmentRefs`.
- `apps/frontend/src/components/timeline/message-sources.test.tsx`,
  `apps/frontend/src/lib/crypto/__tests__/message-envelope.test.ts` — tests.

## Design Decisions

### Sources ride inside the ciphertext, not on the wire

**Chose:** extend the sealed payload wrapper (`E2eSealedPayload.sources`).
**Why:** the audit's explicit design constraint — sources reveal what was researched.
The backend `/messages` callback and `agent_session` projections stay plaintext-free.
**Alternatives considered:** a cleartext `sources` field on `SealedReply` or the
messages row — rejected by E2EE-9's constraint.

### Bubble-level rendering for sealed reply sources

**Chose:** render decrypted sources under the E2E reply bubble (`MessageSourceList`).
**Why:** the sealed message payload is the only carrier of reply sources for E2E (the
server can't put them in `agent_session_steps.sources`, which is how plaintext replies
surface citations in the trace dialog). The bubble is where the decrypted payload
renders. The E2E trace dialog's per-step sources (including the `message_sent` step)
are Phase 0.2 (E2EE-14).

### `SealedSourceItem` defined in `@threa/crypto`

**Chose:** a structural twin of `SourceItem` local to the crypto package.
**Why:** `@threa/crypto` is dependency-free (only `@hpke/core`); pulling `@threa/types`
in would invert the dependency direction. Same precedent as `AttachmentRef` (crypto)
and `EnclaveStreamEnvelope` (types), bridged by structural typing.

## What's NOT Included

- **0.2 (E2EE-14):** sealed sources on trace steps (`EnclaveSealedStep` → `SealedStep`
  rename happens there, when the type is touched).
- Plaintext bubbles do not grow a source list — plaintext replies keep their existing
  surfaces (inline markdown citations + trace dialog `SourceList`).
- Bot `/complete` sources (N-5) — Phase 2.3 per the migration plan.
- No schema changes; no migrations.

## Status

- [x] Required `sources` on the runtime commit payload + spike tests
- [x] Sealed payload carries sources; enclave seals them; tests
- [x] `EnclaveSealedReply` → `SealedReply` rename
- [x] Frontend decrypt path + `MessageSourceList` rendering + tests
- [x] Typecheck, lint, agent-runtime/crypto/enclave/frontend/backend-unit/backend-e2e suites green
