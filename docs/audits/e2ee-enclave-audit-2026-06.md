# E2EE Scratchpads + Enclave Audit — June 2026

- **Date:** 2026-06-05
- **Code state:** `origin/main` @ `dce35288`, plus branch `e2e-enclave-attachment-delivery` @ `e717a5bf` (PR #778) for attachment-path findings.
- **Method:** multi-agent audit — 6 dimension finders (sources, lifecycle, attachments, bot-api, frontend-states, server-features) → dedup → adversarial verification (2 independent refuters for high/critical findings, refute-by-default) → orthogonal completeness critic with its own verified leads. 48 agents total. Every confirmed finding survived at least one adversarial verifier that independently re-read the cited code.
- **Scope:** Part I — security, state integrity, and missing states. A companion UX-parity audit is running and will be added as Part II (or a sibling doc) when complete.
- **Line numbers** are as of the audited commits and will drift; treat them as starting points, the file paths and symbol names as the durable reference.

Reference findings as `E2EE-<n>` in PRs and review notes.

## Summary

26 confirmed findings: 6 critical, 6 high, 11 medium, 3 low (two lows folded into one entry). 2 findings were refuted in verification (kept at the bottom — the refutations themselves are informative).

The two big themes:

1. **The plaintext-into-sealed-stream invariant is enforced only at some HTTP handlers, not at the sink.** `EventService.createMessage/editMessage` accepts plaintext for any stream, and four reachable paths exploit that — one from the normal product UI (E2EE-1..5).
2. **Key lifecycle has unrecoverable dead ends.** Passphrase rotation strands every existing stream; a parked turn under an old key generation can never be revived (E2EE-6, E2EE-7).

### Suggested fix order

| Group | Findings | Theme |
| --- | --- | --- |
| 1 | E2EE-1, 2, 3, 4, 5 | Sink-level E2E guard in EventService + close the four plaintext leaks |
| 2 | E2EE-6, 7 | Stranded-data criticals: rotation re-wrap, old-generation revive |
| 3 | E2EE-8, 12, 13, 25 | "Ariadne looks dead": parked-turn visibility, DLQ hook, crash re-dispatch, fail callback |
| 4 | E2EE-9, 14 | Sources through the sealed payload (replies + trace steps) |
| 5 | E2EE-10, 11, 17, 18, 26b | Public bot API read gates + invocation short-circuit |
| 6 | rest | Frontend states, push, trust-boundary hardening |

---

## A. Plaintext leaks into sealed streams (critical)

All four leaks share one root cause, filed as its own finding (E2EE-5): the gate lives only in *some* HTTP handlers; the shared write sink does not enforce the invariant.

### E2EE-1 (critical) — Editing an E2E message leaks plaintext, reachable from the normal UI

The first-party message edit handler accepts plaintext `contentJson`/`contentMarkdown` with no E2E check; the frontend offers Edit on encrypted messages and submits plaintext. An edit overwrites the projection with plaintext, snapshots a plaintext version row, and broadcasts plaintext over `message:edited`.

- `apps/backend/src/features/messaging/handlers.ts:403-458` — update handler: no `isE2eStream`/gate, unlike the create handler at `:288-300` which enforces the `e2eEnabled`-vs-ciphertext match.
- `apps/backend/src/features/messaging/event-service.ts:649-744` — `editMessage` writes plaintext payload, version snapshot, projection, and outbox with no e2e awareness.
- `apps/backend/src/features/public-api/handlers.ts:1739` — the public API *does* call `assertNotE2eStream` before its edit: proof the codebase knows edits must be blocked.
- `apps/frontend/src/components/timeline/message-edit-form.tsx:89`, `message-event.tsx:1042` — UI submits plaintext edits for any message; Edit is offered on encrypted messages.

**Fix:** reject plaintext edits on E2E streams loudly (mirror the create handler), or build a sealed-edit path (ciphertext + envelope). Frontend must gate the Edit affordance either way.

### E2EE-2 (critical) — `completeBotInvocation` writes a plaintext bot reply into an E2E stream

`assertNotE2eStream` guards public-API send (`handlers.ts:1659`) and update (`:1739`) but not invocation completion (`apps/backend/src/features/public-api/handlers.ts:1107-1118`), which writes plaintext via `eventService.createMessageInTransaction` into `claim.responseStreamId`. Reachable end-to-end: `inviteActor` supports `kind:"bot"` into an E2E stream (`apps/backend/src/features/streams/service.ts:763-789`, explicitly no e2eCapable gate), `message:created` outbox fires for E2E messages, and the bot-invocation outbox handler creates invocations with `responseStreamId` = the E2E stream (see E2EE-11). The completion schema (`public-api/schemas.ts:113-123`) only accepts plaintext markdown.

**Fix:** run the E2E gate in `completeBotInvocation` before the insert; see also E2EE-5 (sink) and E2EE-11 (don't create the invocation in the first place).

### E2EE-3 (critical) — Scheduled messages fire as server-authored plaintext into E2E streams

`ensureStreamWriteAccess` checks archived/visibility/membership but never E2E (`apps/backend/src/features/scheduled-messages/service.ts:631-666`); at fire time `finalizeSendInTx` (`:510-532`) calls `createMessage` with stored plaintext. The server holds no SSK, so there is *no correct fire-time behavior* — scheduling into an E2E stream must be refused at schedule time.

**Fix:** loud schedule-time rejection + frontend affordance gating for E2E streams.

### E2EE-4 (critical) — Composer drafts persist plaintext to IndexedDB and survive lock

Every keystroke in an E2E scratchpad composer debounce-writes plaintext `contentJson` to `db.draftMessages` (`apps/frontend/src/hooks/use-draft-composer.ts:202-208`, `use-draft-message.ts:55-64`, `db/database.ts:317`). `lock()` clears only in-memory caches (`apps/frontend/src/stores/e2e-session-store.ts:879-886`) — its comment falsely asserts the in-memory cache is the only plaintext surface. Drafts survive lock, logout, and reload, contradicting the documented lock model.

**Fix:** for E2E streams, keep drafts in memory only (or seal them under the SSK before persisting) and clear them on lock.

### E2EE-5 (high) — EventService has no E2E enforcement; the guarantee lives in scattered handler checks

`EventService.createMessage/editMessage` accepts plaintext + optional ciphertext for any stream; its own doc comment (`event-service.ts:159-168`) says the *caller* must verify. E2EE-1/2/3 are the existing exploits; any future caller that forgets is the next one.

**Fix:** enforce at the sink — plaintext write to an E2E stream throws, ciphertext write to a non-E2E stream throws. Handler-level gates stay for better error semantics; the sink is the backstop.

---

## B. Stuck and lost states

### E2EE-6 (critical) — Passphrase rotation permanently locks every existing E2E scratchpad

`rotatePassphrase` re-uploads the same keypair but the server mints a fresh `keyId` on every set (`apps/backend/src/features/user-e2e-keys/service.ts:42-69`, `apps/frontend/src/stores/e2e-session-store.ts:779-846`). Stream key resolution matches strictly on `recipientKeyId` and AAD-binds to it (`apps/frontend/src/lib/crypto/stream-key-cache.ts:323,330`). Nothing re-wraps existing stream SSKs or updates `e2e_streams.ownerUserKeyId` — no such endpoint exists. After rotation, every previously encrypted stream is silently, permanently undecryptable.

**Fix:** keep the `keyId` stable across rotation (only the KEK wrap changes), or transactionally re-wrap all owned streams to the new key. At minimum refuse/warn loudly.

### E2EE-7 (critical) — Parked turn under an old key generation parks forever

Dispatch requires the live EIK to hold wraps for both the current *and* the trigger generation (`apps/backend/src/features/enclave-runtimes/dispatch/request-builder.ts:71-79`); revive only ever re-wraps the *current* generation (`apps/backend/src/features/streams/service.ts:1035-1040` rejects non-current with `E2E_STALE_GENERATION`; frontend computes "missing" only against current — `stream-encryption-affordance.tsx:137-139`). Enclave restart + key roll before revive ⇒ the parked turn DLQs with no API able to mint the old-generation wrap.

**Fix:** revive should re-wrap every generation the owner can open (or at least any parked trigger's generation).

### E2EE-8 (high) — Parked turns are invisible and DLQ exhaustion is silent

No session row exists while parked, so no "Ariadne is working…" indicator for the entire backoff (~4 min over 10 retries); `ENCLAVE_INVOKE` is registered **without** an `onDLQ` hook (`apps/backend/src/server.ts:741-750`; contrast `:834,:862,:886,:900,:914`), so exhaustion is a `logger.error` and permanent user-facing silence. Contradicts the feature doc's "visible, never a silent no-reply."

**Fix:** surface a pending/queued state at park time; add an `onDLQ` hook that emits a user-visible failure event with a retry affordance.

### E2EE-12 (high) — Mid-turn enclave crash is terminal: orphan cleanup marks FAILED, never re-dispatches

Asymmetric with the park path (which retries until a wrap appears): once RUNNING, a dead enclave means `failSessionWithLifecycle` and nothing else (`apps/backend/src/features/agents/orphan-session-cleanup.ts:108-128`); catch-up re-enqueue exists only on the *complete* path (`session-handlers.ts:467-478`).

**Fix:** re-dispatch liveness-failed sessions for a live EIK instead of terminal failure.

### E2EE-25 (medium) — No fail callback from the enclave; failures spin until orphan cleanup (~2 min, not the commented 60s)

`runEnclaveSession` swallows every turn error into a log line (`apps/enclave/src/agent/session-runner.ts:70-80`); no `/fail` route exists. Sessions stay RUNNING with a spinning card until `ENCLAVE_RUNTIME_STALENESS_MS` (2 min — `enclave-runtimes/service.ts:11`) lets cleanup reclaim them.

**Fix:** explicit fail callback so failures terminate promptly; correct the stale comment.

### E2EE-13 (medium) — Orphan cleanup can race a live-but-partitioned enclave and discard its finished work

Cleanup flips RUNNING→FAILED on stale heartbeat without confirming the enclave is gone (`orphan-session-cleanup.ts:39-44`); every later callback 409s (`session-handlers.ts:110-115`) and the enclave's client throws (`backend-callbacks.ts:55-63`). Replies generated after the reclaim are lost and the user sees a false failure.

**Fix:** reconcile late completions idempotently (grace re-open) or verify EIK liveness before reclaiming.

---

## C. Sources (citation) parity

### E2EE-9 (high) — Enclave replies drop all citation sources

The enclave's web tools *do* return `SourceItem[]` and the shared runtime accumulates them and passes them to `sendMessage` (`packages/agent-runtime/src/runtime/agent-runtime.ts:335,396-401,719-726`) — but `run-turn.ts:214` destructures only `{ content }`. No sources field exists on `EnclaveSealedReply` (`packages/types/src/api.ts:484-488`), on `E2eSealedPayload` (`packages/crypto/src/sealed-payload.ts:14-30`), or in the backend's sealed-reply `createMessage` call (`enclave-runtimes/session-handlers.ts:177-196`). Researched E2E answers render with zero citations.

**Design constraint:** sources reveal *what was researched* — they must ride **inside the sealed payload**, never the cleartext `sources` column or a plaintext wire field.

### E2EE-14 (medium) — Enclave trace steps drop sources too

`EnclaveTraceObserver` seals step content but discards `trace.sources` (`apps/enclave/src/agent/trace-observer.ts:116-127,160-171`); `EnclaveSealedStep` has no field; backend step writes never set the column. The E2E trace dialog shows research steps with no `SourceList`. Same sealing constraint as E2EE-9.

---

## D. Public bot API × E2E streams

Pattern: **writes are mostly gated, reads are not** — reads degrade silently instead of failing loudly.

### E2EE-10 (high) — `listMessages` returns zero-width-space placeholders for E2E streams

No E2E handling on the read path (`public-api/handlers.ts:1542-1591`); `serializeMessage` (`:120-155`) maps `content = contentMarkdown` — for E2E rows that is `E2E_PLACEHOLDER_CONTENT_MARKDOWN` (U+200B, `packages/types/src/constants.ts:807`) — and the wire schema has no ciphertext field. 200 OK with lying content and no signal.

**Fix:** loud `E2E_STREAM_PLAINTEXT_UNSUPPORTED`-style refusal on reads (or expose ciphertext+envelope deliberately — a design decision).

### E2EE-11 (high) — Bot invocations fire on E2E streams with placeholder prompts; @-mentions silently never fire

`invocation-outbox-handler.ts:82-189` has no `isE2eStream` short-circuit (contrast `agents/companion-outbox-handler.ts:114-116`). Mentions ride in ciphertext so `extractMentionSlugs` sees the placeholder ⇒ mention bots never fire (silent). Active-scratchpad bots *do* fire with a U+200B prompt, dispatching meaningless turns whose plaintext replies flow back through E2EE-2.

**Fix:** `isE2eStream` short-circuit in the bot-invocation outbox handler.

### E2EE-17 (medium) — `findMessagesByMetadata` mixes placeholder E2E rows into results

Metadata is plaintext alongside ciphertext, so E2E rows match and serialize with placeholder content (`public-api/handlers.ts:1601-1635`). Exclude E2E streams from scope (the search service already does, via `excludedE2eStreamCount`).

### E2EE-18 (medium) — Attachment endpoints serve E2E ciphertext bytes with placeholder metadata

`getAttachment`/`getAttachmentDownloadUrl` (`public-api/handlers.ts:1384-1404`) hand back placeholder filename/mime and a signed URL to undecryptable bytes with no E2E flag — while upload correctly refuses with `E2E_UPLOAD_UNSUPPORTED` (`:713-718`). Mirror that refusal on reads.

### E2EE-26b (low) — Public search drops `excludedE2eStreamCount`

The search service returns it (`search/service.ts:55,100-115`) and the first-party handler forwards it (`search/handlers.ts:102-113`), but the public-API handler destructures only `{ results }` (`public-api/handlers.ts:1243-1269`). Automation can't tell encrypted streams were skipped.

---

## E. Frontend and notification states

### E2EE-15 (high) — In-stream search (Cmd-F) over an unlocked E2E scratchpad silently returns zero matches

Both local IDB filtering and the server ILIKE phase match the stored placeholder, never the decrypt cache (`apps/frontend/src/hooks/use-stream-search.ts:74-99,152-155`). The feature doc explicitly promises client-side keyword search works (`docs/features/public/e2e-encrypted-scratchpads.md:125`).

**Fix:** search the decrypted content for unlocked streams, or show an honest "unavailable for encrypted streams" state. (Doc and code must agree.)

### E2EE-16 (medium) — Saved messages from E2E streams render blank previews

`resolvePreview` strips the placeholder (`apps/frontend/src/components/saved/saved-item.tsx:192-196`); the backend view ships no ciphertext (`saved-messages/view.ts:122`). The sidebar's "Encrypted message" treatment (`stream-item.tsx:165-167`) is the pattern to copy — or block saving with a reason, or ship ciphertext for client decrypt.

### E2EE-19 (medium) — Saved-reminder push fires with a U+200B preview for E2E messages

The activity handler deliberately suppresses E2E (`activity/outbox-handler.ts:227-230`) but the push handler consumes `saved_reminder:fired` directly with no guard (`push/outbox-handler.ts:150-157`, `push/service.ts:325-365`) — a blank notification. Render a generic "Reminder for an encrypted message" instead.

### E2EE-20 (medium) — Post-key-roll history attachments vanish without a note (enclave)

`run-turn.ts:128-139` skips unopenable-generation history with `continue` *before* registering `attachmentRefs` or emitting `[Attached: …]` notes, while the backend still ships those bytes (`enclave-invoke-worker.ts:250-251` has no generation filter). The model gets neither content nor a hint; the bytes are wasted. Violates the no-silent-cap discipline used everywhere else in that path.

### E2EE-24 (low) — Image decrypt/network/404 failures collapse into one misleading download card

Single `catch → setFailed(true)` (`apps/frontend/src/components/timeline/e2e-attachment-list.tsx:43-58`); clicking the card re-errors with a fixed "Couldn't decrypt" toast regardless of true cause; no retry for transient failures.

### E2EE-26a (low) — Assign-failure flashes failed-then-started

A retryable `assignSession` throw emits a terminal failed card, then the retry emits a fresh started card (`enclave-invoke-worker.ts:210-230,82-85,180-207`) — transient hiccups read as flaky. Hold the terminal card until retries are exhausted.

---

## F. Trust boundary (completeness-critic finds)

### E2EE-21 (medium) — Session callbacks aren't bound to the owning EIK and don't validate reply generation

All callbacks are gated only by the shared `INTERNAL_API_KEY` (`apps/backend/src/routes.ts:284-289`); `/messages`/`/steps` never check `session.serverId` against the caller nor that the reply envelope's `keyGeneration` is sane (`session-handlers.ts:164-198,210-279`). Any internal-key holder can inject sealed steps into any running session; a wrong-generation seal persists as a permanently undecryptable reply instead of failing loudly.

### E2EE-22 (medium) — `/attestation` is decorative: registration is shared-key-only, and every "live" EIK gets SSK wraps

`register.ts:13-26` carries no attestation; no backend caller verifies `/attestation` (`apps/enclave/src/index.ts:38-41`); the owner's client wraps to every live EIK (`streams/service.ts:856-865`). Any internal-key holder (e.g. the bot-runtime, which holds the same key) can register a key and become an SSK recipient. Either verify attestation at registration or document explicitly that enclave identity rests on `INTERNAL_API_KEY` secrecy.

### E2EE-23 (medium) — Sealed history has no byte budget against the enclave's 48MB body cap

Attachments are budgeted (16MB/file, 32MB base64 total, 64 files — `enclave-invoke-worker.ts:40-44`) but the 30 prior sealed messages + trigger are added unconditionally (`request-builder.ts:87-93,100-102`). An oversize assignment hard-fails at `express.json({limit:"48mb"})` (`apps/enclave/src/index.ts:58`) with the failure attributed to the wrong cause. Fold history into the same total budget, dropping oldest loudly.

---

## Refuted findings (and why the refutations matter)

- **"Non-owner triggering Ariadne after enclave restart parks forever."** Refuted: the cited code is accurate (revive is owner-only at client and server), but E2E streams are owner-only by design at every layer — the harmful state is unreachable. *Becomes real if E2E streams ever gain non-owner participants.*
- **"No operational signal for failing enclave turns."** Refuted: queue-manager-level metrics/instrumentation cover `enclave.invoke` like any queue — the finder's grep stopped at the feature folder. Ops visibility exists; *user* visibility does not (that's E2EE-8).

## Provenance

Full machine-readable findings (with per-finding adversarial verdicts) are in the workflow run `wf_64d57f98-2ee` output; this document is the durable summary. Verification discipline: every finding above was independently re-derived from the code by at least one adversarial verifier instructed to refute it.
