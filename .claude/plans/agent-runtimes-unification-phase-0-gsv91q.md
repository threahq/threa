# Agent Runtimes Unification — Phase 0.1: Required-sources commit payload + sealed reply sources

## Goal

Close E2EE-9 (enclave replies drop all citation sources) — item 0.1 of the Phase 0
migration plan in `docs/plans/agent-runtimes-unification-redesign.md` §2.4. The
shared `AgentRuntime` loop already accumulates `SourceItem[]` from tool results and
passes them to `sendMessage`, but the enclave's terminal action destructured only
`{ content }`, so researched E2E answers rendered with zero citations. The fix makes
`sources` a **required** field on the commit payload (omission no longer compiles),
threads them through the sealed reply — inside the ciphertext, never a cleartext
column or wire field — and renders them under the decrypted reply.

## What Was Built

### Required-sources commit payload (shared loop)

`AgentRuntimeConfig.sendMessage` now takes `sources: SourceItem[]` (required; empty
array means "none"), so a host can no longer silently narrow the contract. The
runtime always passes the accumulated array at commit.

**Files:**

- `packages/agent-runtime/src/runtime/agent-runtime.ts` — `sendMessage` input field made required; `commitMessage` passes the array unconditionally
- `packages/agent-runtime/src/runtime/agent-runtime.test.ts` — the §2.8 q4 spike test: a turn whose tool results carried sources commits non-empty sources; a sourceless turn commits `[]`, not `undefined`
- `apps/backend/src/features/agents/persona-agent.ts` — companion `doSendMessage` signature tightened to match; stub-mode call passes `sources: []`

### Sealed sources in the E2E payload (crypto)

`E2eSealedPayload` gains an optional `sources` field carried inside the SSK
ciphertext. `serializeSealedPayload` takes sources as a third argument (the JSON
wrapper appears only when refs or sources exist — a sourceless reply stays a bare
markdown string, byte-identical to every E2E message already written).
`parseSealedPayload` returns validated sources (malformed elements dropped, same
defence as `isAttachmentRef`).

**Files:**

- `packages/crypto/src/sealed-payload.ts` — `SealedSourceItem` (structural twin of `SourceItem`; crypto stays dependency-free), `serializeSealedPayload(content, refs?, sources?)`, `parseSealedPayload` → `{ contentMarkdown, attachmentRefs, sources }`, `isSealedSourceItem`
- `packages/crypto/src/index.ts` — exports

### Enclave reply path

The enclave's `sendMessage` now destructures `{ content, sources }` and seals
`serializeSealedPayload(content, undefined, sources)` — sources travel inside the
ciphertext. The backend callback (`enclave-runtimes/session-handlers.ts`) needs no
change: it stores opaque ciphertext, which is the point.

**Files:**

- `apps/enclave/src/agent/run-turn.ts` — the E2EE-9 fix (was: `sendMessage: async ({ content })`)
- `apps/enclave/src/agent/run-turn.test.ts` — integration test: a turn whose web_search result carried a source seals non-empty sources inside the reply payload; a sourceless turn seals the bare string

### Sealed-type rename (§2.6 rule 1)

`EnclaveSealedReply` → `SealedReply`: sealed wire types are a shared vocabulary, not
enclave-owned (the enclave is one producer; a BIK-granted external harness is a
future one). Renamed with no deprecated alias (INV-49).

**Files:**

- `packages/types/src/api.ts`, `packages/types/src/index.ts` — rename + doc comment stating the shared-vocabulary rule and the sources-inside-ciphertext constraint
- `apps/enclave/src/agent/run-turn.ts`, `backend-callbacks.ts`, `run-turn.test.ts`, `sessions.test.ts` — usage updates

### Rendering (frontend)

The decrypt path surfaces sealed sources and the message bubble renders them: the
sealed payload is the only place E2E reply sources can exist, so the decrypted
bubble is the surface that has them (plaintext replies surface sources via the
trace dialog's `SourceList`; sealed *trace-step* sources are Phase 0.2 / E2EE-14).

**Files:**

- `apps/frontend/src/lib/crypto/message-envelope.ts` — `DecryptedMessageContent.sources`, populated from `parseSealedPayload`
- `apps/frontend/src/hooks/use-decrypted-message-content.ts` — `decrypted` variant carries `sources`
- `apps/frontend/src/components/timeline/message-sources.tsx` — new `MessageSourceList` (collapsed "Sources (n)" → linked citations), styled after the trace dialog's `SourceList`
- `apps/frontend/src/components/timeline/message-event.tsx` — threads `decrypted.sources` → `SentMessageEvent` → `MessageLayout`, rendered after attachments
- `apps/frontend/src/components/timeline/message-sources.test.tsx`, `apps/frontend/src/lib/crypto/__tests__/message-envelope.test.ts` — tests

## Design Decisions

### Sources ride inside the ciphertext

**Chose:** extend the sealed payload wrapper (`E2eSealedPayload`), not `SealedReply`
or the messages-callback schema.
**Why:** sources reveal what was researched — the audit's design constraint (E2EE-9)
forbids a cleartext column or plaintext wire field. The backend handler is untouched
by design.

### Crypto-local `SealedSourceItem` instead of importing `@threa/types`

**Chose:** mirror the `SourceItem` shape in `packages/crypto`.
**Why:** `@threa/crypto` is dependency-free (only `@hpke/core`); same precedent as
`EnclaveStreamEnvelope` mirroring `StreamEnvelope` in the other direction. Bridged
by structural typing.

### Rename now, with 0.1

**Chose:** `EnclaveSealedReply` → `SealedReply` in this PR.
**Why:** §2.6 rule 1 binds the rename to the first PR that touches the type.
`EnclaveSealedStep` is renamed in 0.2 when it is touched.

### Bubble rendering for sealed sources

**Chose:** render decrypted sources under the reply bubble (`MessageSourceList`).
**Why:** for E2E the message payload is the only carrier of reply sources, and the
bubble is where that payload renders. The trace dialog's `message_sent` step gets
its own sealed sources in 0.2 (E2EE-14).

## Schema Changes

None. No migrations; the sealed payload is versioned JSON inside existing ciphertext
columns, and old clients/messages parse unchanged (unknown `sources` ignored by old
parsers; absent `sources` defaults to `[]` in the new one).

## What's NOT Included

- Sealed sources on trace steps (`EnclaveSealedStep` → `SealedStep`) — Phase 0.2 (E2EE-14)
- Enclave `/fail` callback — Phase 0.3; usage recording — 0.4; bot claim bounding — 0.5; mention entities — 0.6; turn digests — 0.7
- Bot `/complete` sources (N-5) — Phase 2.3
- A sources UI on *plaintext* reply bubbles — plaintext replies keep their existing surfaces (inline markdown citations + trace dialog `SourceList`)

## Status

- [x] Required `sources` on the runtime commit payload + spike test (§2.8 q4)
- [x] Sealed payload carries sources (crypto + enclave + tests)
- [x] `SealedReply` rename (§2.6 rule 1)
- [x] Frontend decrypt + rendering + tests
- [x] Full verification: typecheck, lint, agent-runtime (143), crypto (33), enclave (57), frontend (2331), backend unit (1621), backend e2e (308) — all green
