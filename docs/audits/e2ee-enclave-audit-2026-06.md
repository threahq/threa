# E2EE Scratchpads + Enclave Audit — June 2026

- **Date:** 2026-06-05
- **Code state:** `origin/main` @ `dce35288`, plus branch `e2e-enclave-attachment-delivery` @ `e717a5bf` (PR #778) for attachment-path findings.
- **Method:** multi-agent audit — 6 dimension finders (sources, lifecycle, attachments, bot-api, frontend-states, server-features) → dedup → adversarial verification (2 independent refuters for high/critical findings, refute-by-default) → orthogonal completeness critic with its own verified leads. 48 agents total. Every confirmed finding survived at least one adversarial verifier that independently re-read the cited code.
- **Scope:** Part I — security, state integrity, and missing states. **Part II (below)** — UX parity: does encrypted Ariadne *feel* like normal Ariadne?
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

---

# Part II — UX parity audit

- **Date:** 2026-06-05
- **Code state:** `origin/main` @ `04932986` (the working tree was branch `e2ee-plaintext-leak-closures`; none of these findings touch the Part I fixes).
- **Method:** same harness as Part I, 71 agents. 6 UX dimension finders (Ariadne conversation parity, unlock/lock friction, composer+attachments, app-shell integration, perceived performance, copy+errors) → dedup (with the 13 confirmed Part I findings fed in as "do not re-report") → adversarial verification (2 lenses for high) → orthogonal completeness critic (mobile, a11y, onboarding, settings, cross-device).
- **The bar (Kris's words):** *"it's crucial it feels good to use, nearly identical to how it is to use normal Ariadne."* Every finding is anchored to a concrete plaintext baseline: normal streams do X, e2e does Y, the user feels Z.

Reference findings as `UX-<n>`.

## Summary

39 confirmed findings: **0 critical, 11 high, 18 medium, 10 low**; 2 contested, 6 refuted. No UX-critical means nothing makes the feature feel outright *broken* — but the friction is broad, and it clusters in three places.

The recurring shape: **normal Ariadne is instant and local; encrypted Ariadne is gated on network round-trips and main-thread crypto, and the UI does little to mask the difference.** The three clusters:

1. **Key & device lifecycle is under-built (5 of the 11 highs).** A fully-implemented, tested `rotatePassphrase()` is wired to zero UI; key management is buried at the bottom of the "AI" settings tab; there's no trusted-device list and the only revoke nukes every device; a second device always pays the full passphrase tax with no handoff. This is the biggest gap between "we shipped crypto" and "it feels like a product."
2. **Decrypt-on-render isn't masked.** Argon2id freezes the main thread on unlock; images fetch+decrypt whole files with no thumbnail/cache; the timeline gates first paint on a wrap fetch and flashes skeletons; your own sent message and Ariadne's replies both flash a decrypt skeleton instead of appearing instantly.
3. **The shell treats e2e streams as second-class.** No auto-title (placeholder name forever), no activity-feed row or push when Ariadne answers (nothing pulls you back), static "🔒 Encrypted message" previews even when unlocked.

### Suggested UX fix order

| Tier | Findings | Why |
| --- | --- | --- |
| **Quick wins** (code mostly exists) | UX-8 wire `rotatePassphrase` to UI · UX-30 gate biometric on `isUserVerifyingPlatformAuthenticatorAvailable()` · UX-7 system-prompt clause for Ariadne's e2e limits · UX-9 surface key mgmt under a Security tab · UX-27 drop "and sources" label (or ride E2EE-9) | High felt value, hours not days |
| **Decrypt masking** | UX-2 Argon2 in a Web Worker · UX-22 optimistic send echo · UX-13/24 pre-warm wrap + decrypt before commit · UX-25 styled locked/failed states · UX-26 transient-vs-real decrypt failure (pairs with E2EE-15 framing) | Kills the "feels slow/janky" perception |
| **Media** | UX-3 lightbox/gallery/copy/save for e2e images · UX-4 thumbnail tier + cross-remount blob cache · UX-17/18 reserve image box + download progress | Encrypted images currently feel like dead thumbnails |
| **Shell first-classing** | UX-5 client-side auto-title · UX-6 out-of-stream signal (generic activity row + push) · UX-19/20 unlocked previews + name consistency | Makes e2e streams scannable and "alive" |
| **Device story** | UX-10 trusted-device list + per-device revoke · UX-11 cross-device handoff · UX-14 cross-tab unlock · UX-15 lighter session-resume tier · UX-33 optional auto-lock | The anxiety-and-friction cluster around "my other device / my lost device" |

## A. Conversation parity (does the turn feel the same)

- **UX-12 (medium) — Mid-turn interjection is gone.** Plaintext Ariadne folds a message sent mid-turn into the running turn (a visible "Reconsidering…" step); enclave Ariadne ignores it and only catches up with a *new* turn afterward (`persona-agent.ts:640-755` / `agent-runtime.ts:286-303` vs `run-turn.ts:178-230`). Steering feels queued, not immediate. (This is the documented "mid-turn adaptation still missing" boundary — filed here as the felt cost.)
- **UX-13 (medium) — Every reply flashes a gray decrypt-skeleton on arrival** where plaintext lands fully rendered (`stream-sync.ts:543-556` commits the sealed row, then the client decrypts). Decrypt before committing the row, or pre-warm, so the text is present on first paint.
- **UX-31 (low) — The enclave loop awaits each reply's HTTP callback before continuing** (`run-turn.ts:214-226`, `backend-callbacks.ts:55-63`), so a multi-message turn stalls between bubbles.

## B. Unlock / lock / device lifecycle

- **UX-2 (high) — Argon2id KEK derivation runs on the main thread**, freezing the tab (and the unlock spinner can't even animate) on every unlock/setup (`passphrase.ts:40-62`, m=64MiB t=3; called inline at `e2e-session-store.ts:572,479`). Move to a Web Worker.
- **UX-11 (high) — A second device always demands the full passphrase**, with no QR/device-link handoff and no "new device" UI (`e2e-session-store.ts:368-451`); compounded by UX-2's freeze. Plaintext Ariadne is identical on every device the instant you log in — that's the bar.
- **UX-14 (medium) — Unlock in one tab doesn't unlock other tabs** (no BroadcastChannel/storage-event sync; `e2e-unlock-provider.tsx:66-68`).
- **UX-15 (medium) — Without "Keep me unlocked," every reload and new tab re-prompts** for the full passphrase — no session-scoped middle tier.
- **UX-16 (medium) — First-run setup is one long modal** (passphrase, confirm, mandatory acknowledgement, trust toggle, optional PIN/biometric) before the first message (`passphrase-setup-modal.tsx:97-290`). Progressive-disclose PIN/biometric *after* the scratchpad exists.
- **UX-32 (low) — Abandoning the setup/unlock modal silently drops the create** the user asked for (`sidebar.tsx:363-368`) — no scratchpad, no acknowledgement.
- **UX-33 (low) — No idle auto-lock, no lock-on-tab-hide, no quick per-stream relock** despite the security framing (`encrypted-scratchpads-section.tsx:147`, `e2e-session-store.ts:879-903`).

## C. Composer & attachments

- **UX-3 (high) — E2E images can't be opened, zoomed, copied, or saved.** Plaintext images open the `MediaGallery` lightbox with prev/next + mobile Save/Copy drawer (`attachment-list.tsx:175-177,251-259,817-824`); the encrypted `<img>` has no click handler at all (`e2e-attachment-list.tsx:66-73`). Wire the same lightbox off the already-decrypted blob.
- **UX-4 (high) — Encrypted images fetch + decrypt the whole ciphertext before any pixels paint, no thumbnail tier, no cross-remount cache** (`e2e-attachment-list.tsx:21-28,40-65`) — so in a virtualized timeline, scrolling an image out and back re-downloads and re-decrypts the full file. Plaintext loads a thumbnail variant and caches URLs (`attachment-list.tsx:153,483-485`).
- **UX-17 (medium) — Inline images shift layout on decrypt** (no reserved box — INV-21). **UX-18 (medium) — Encrypted download is a blocking two-step decrypt-on-click with no progress.** **UX-34 (low) — uploads surface no size limit and no per-file encrypt progress.**

## D. App-shell integration

- **UX-5 (high) — E2E scratchpads never get auto-titled.** Server auto-naming is short-circuited for e2e (`naming-outbox-handler.ts:120-125`) and no client replacement exists, so they read "New scratchpad" forever while plaintext scratchpads get an LLM title. Derive a title client-side from decrypted content.
- **UX-6 (high) — Ariadne answering in an e2e scratchpad produces zero out-of-stream signal** — the activity handler returns `[]` for e2e (`activity/outbox-handler.ts:142`), so no activity row and no push. Navigate away and nothing brings you back. Emit a generic "New message in <stream>" activity/push (no content).
- **UX-19 (medium) — Sidebar/switcher preview is a static "🔒 Encrypted message" even when unlocked** (`stream-item.tsx:165-167`) — decrypt it locally when unlocked. **UX-20 (medium) — sidebar displayName vs header decrypted name can drift.** **UX-21 (medium) — global content search silently returns nothing** for e2e content with no explanation (pairs with E2EE-15). **UX-35 (low) — rename pre-fills the server name, not the decrypted one.**

## E. Perceived performance

- **UX-22 (medium) — E2E send withholds the optimistic echo** behind async sealing (+ possible wrap fetch) (`use-stream-or-draft.ts:631`, `stream-key-cache.ts:296-307`) — your own message doesn't appear the instant you hit Enter.
- **UX-23 (medium) — Decrypt cache is 500-entry LRU** (`decrypt-cache.ts:25`), so scroll-back in a long encrypted stream re-runs crypto where plaintext just re-renders. **UX-24 (medium) — first paint gates on a stream-key wrap fetch** (`message-envelope.ts:189-201`); prefetch at unlock/subscribe. **UX-25 (medium) — locked/failed messages render as literal placeholder strings through the markdown renderer** (`message-event.tsx:1636-1647`) instead of a styled state. **UX-36 (low) — the decrypting skeleton is a fixed single-line shape**, so resolving a multi-line message reflows (INV-21).

## F. Copy, errors, accessibility

- **UX-7 (high) — The enclave system prompt never tells Ariadne she lacks workspace memory/tools** (`enclave-system-prompt.ts:22-29,64-69`), so when asked to recall something from the workspace she hallucinates or refuses without naming the encryption limit. Add a clause so she voices the boundary gracefully.
- **UX-26 (medium) — "Decryption failed" / "Couldn't decrypt this step" is shown for missing-key and network failures**, not just real crypto failures (`stream-key-cache.ts:324`, `message-envelope.ts:188-210`) — across message bodies and trace steps. A not-yet-resolvable message should show a transient loading state and self-heal.
- **UX-27 (medium) — "Show trace and sources" is offered on enclave replies that never carry sources** (`message-actions.ts:214-218`) — resolved once E2EE-9 plumbs sources through the sealed payload, or drop the "and sources" label until then.
- **UX-28 (medium) — Repair/heal copy leaks setup-internals** ("Finish setup", "encryption wasn't finished"; `stream-encryption-affordance.tsx:221`) — self-heal silently or explain plainly.
- **UX-29 (medium) — Screen-reader users get silence while messages decrypt** — the skeleton is `aria-hidden` with no live region (`message-event.tsx:1662-1675`). **UX-30 (medium) — biometric is offered whenever the WebAuthn API merely exists**, not when a platform authenticator is actually available (`webauthn-device-key.ts:54-56`) — gate on `isUserVerifyingPlatformAuthenticatorAvailable()`.
- **UX-37 (low)** generic attachment-failure toast · **UX-38 (low)** "Keep me unlocked" never says what's stored on the device · **UX-39 (low)** the full-page gate always says "Unlock with your passphrase" even on PIN/biometric-only devices.

## G. Key-management discoverability (the settings cluster)

- **UX-8 (high) — There is no "Change passphrase" anywhere.** `rotatePassphrase()` is fully implemented and unit-tested (`e2e-session-store.ts:779-846`, `.test.ts:126,294,395`) but no component calls it; the only escape from a compromised passphrase is "Revoke key", which destroys all content. **Wire the existing action to a UI — this is the single highest value-to-effort fix in Part II.** (Note: Part I's E2EE-6 is the deeper bug — rotation as currently written *strands* all streams because it mints a new keyId without re-wrapping; UX-8 and E2EE-6 must be fixed together.)
- **UX-9 (high) — Key management is buried at the bottom of the "AI" settings tab**, under voice dictation, with no Security/Privacy tab and "encryption" named nowhere in the nav (`ai-settings.tsx:251`, `preferences.ts:150-159`).
- **UX-10 (high) — No trusted-device list and no per-device revoke** — the model tracks per-device trust (`e2e-session-store.ts:323-356`) but settings shows only the current device and a single global revoke (`encrypted-scratchpads-section.tsx:61-93,151-153`). A lost laptop forces the catastrophic all-device revoke.

## Cross-references to Part I

- **UX-21** (search empty) ⇄ **E2EE-15** (Cmd-F returns nothing) — same root, the docs promise client-side search works.
- **UX-27** (sources label) ⇄ **E2EE-9/14** — fixing the sealed-payload sources plumbing makes the label honest.
- **UX-8** (no Change-passphrase UI) ⇄ **E2EE-6** (rotation strands all streams) — do not ship the UI until the re-wrap bug is fixed, or it's a footgun.
- **UX-6** (no push/activity) is the felt-UX side of **E2EE-8** (parked-turn invisibility) — together, "Ariadne in an encrypted stream is easy to lose track of."

## Contested (judgement calls, not clear-cut)

- **UX-C1 (medium) — The message-action menu is plaintext-shaped, bolted onto e2e with no encryption awareness** (`message-actions.ts:221-225`). Partly addressed by Part I E2EE-1 (Edit now hidden); the remaining question is whether other entries (copy-link, quote) need e2e-aware variants. Verifiers split on whether this is one finding or a catch-all.
- **UX-C2 (low) — Every enclave turn pays queue-poll + backend↔enclave HTTP fan-out** the in-process path doesn't, with nothing masking the dead air. Real, but verifiers disagreed on whether the added latency is perceptible enough to be a UX finding vs an architecture note.

## Provenance (Part II)

Workflow run `wf_8f6a8a74-33a`. Same adversarial-verification discipline as Part I.
