# Detailed implementation plan — E2E encrypted scratchpads

## Context

The high-level architecture lives in [`docs/plans/e2e-encrypted-scratchpads.md`](../../docs/plans/e2e-encrypted-scratchpads.md). This file is the executable companion to it: concrete file paths, library choices, schema specifics, test plan.

**Why this work**: Pi remote tool traces today strip Arguments/Output sections for safety because they land plaintext on Threa servers. That's the wrong tradeoff for any user who needs real privacy (Kris's wife journaling against an AI; colleagues using Pi remote inside an employer's network). End-to-end encryption flips the threat model so Threa servers cannot read scratchpad content, removes the need for trace sanitization on E2E sessions, and meaningfully *improves* the trace UI as a side effect.

**Phase ordering committed**: Pi remote first (Phases 0 → 1 → 2 → 3 → 4), Ariadne enclave last (Phase 5). Phases 3 onwards are sketched at the end of this file; concrete file-level detail is for Phases 0–2.

**Decisions committed** (do not relitigate without reason):
- Passphrase + Argon2id for the user's KEK; encrypted bundle stored server-side.
- UIK is **per-workspace**, lives in the regional backend, matches INV-8/INV-50.
- Existing scratchpads can never be retro-encrypted; only new ones.
- Companion mode toggle is **disabled with explainer** on E2E scratchpads until Phase 5.
- Schema representation: **flag** (`e2e_scratchpads` table + additive columns) rather than separate stream type. Aligns with INV-17 (additive migrations) and keeps blast radius minimal.

## Library choices

| Use | Package | Notes |
| --- | --- | --- |
| HPKE (RFC 9180) | `@hpke/core` | Suite: `DHKEM(X25519, HKDF-SHA256)` + `HKDF-SHA256` + `AES-256-GCM`. Works in Bun and modern browsers without polyfills. |
| Argon2id KDF | `hash-wasm` | WASM-based, fast, single artifact across Bun + browser. Params tuned for ~250 ms on a mid-range phone. |
| AES-256-GCM, random | WebCrypto / `node:crypto` | Already in scope on both runtimes. |

No hand-rolled crypto. The backend gains these deps only for unit tests of the envelope round-trip; production paths never touch private keys on the backend.

## Phase 0 — Crypto primitives + UIK onboarding (no scratchpad changes yet)

**Goal**: a user can set up their passphrase, the encrypted UIK private bundle lands on the server, and unlocking the key on a new device works. Nothing else changes; no scratchpad UI is touched.

### Backend changes

**New feature folder** `apps/backend/src/features/user-e2e-keys/` (matches INV-51 colocation):

- `migration` (under `apps/backend/src/db/migrations/`, naming convention `YYYYMMDDHHmmss_user_e2e_keys.sql`):
  ```sql
  CREATE TABLE user_e2e_keys (
    id TEXT PRIMARY KEY,                       -- key_<ULID>
    user_id TEXT NOT NULL,                     -- workspace-scoped UserId (INV-50)
    workspace_id TEXT NOT NULL,                -- INV-8
    key_id TEXT NOT NULL,                      -- short id used as recipientKeyId in envelopes
    public_key BYTEA NOT NULL,
    encrypted_private_bundle BYTEA NOT NULL,   -- AES-GCM(KEK = Argon2id(passphrase, salt), priv)
    kdf_salt BYTEA NOT NULL,
    kdf_params JSONB NOT NULL,                 -- { m, t, p, version }
    created_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX user_e2e_keys_active_idx
    ON user_e2e_keys (workspace_id, user_id)
    WHERE revoked_at IS NULL;
  ```
- `repository.ts`: thin CRUD, `getActiveByUser`, `insert`, `revoke`. Race-safe insert via `ON CONFLICT (workspace_id, user_id) WHERE revoked_at IS NULL` (INV-20).
- `service.ts`: owns the transaction. `setUserKey`, `getUserKey`, `rotate`. Pure: never sees plaintext (the server only ever stores ciphertext + pubkey).
- `handlers.ts`:
  - `GET /api/v1/workspaces/:workspaceId/users/me/e2e-key` → `{ keyId, publicKey, encryptedPrivateBundle, kdfSalt, kdfParams }` or 404.
  - `POST /api/v1/workspaces/:workspaceId/users/me/e2e-key` → set or rotate. Body validated with Zod (INV-55).
  - `DELETE` → revoke. Hard requirement: this destroys access to existing E2E content.
- `index.ts` barrel (INV-52).

**Routes**: register in `apps/backend/src/features/user-e2e-keys/routes.ts`, mount under the workspace-scoped API router.

**Tests** (colocated, `__tests__/`):
- `repository.test.ts`: insert + getActive round-trip; unique-active index enforcement.
- `handlers.test.ts`: 401/403 cases; happy path; rotate path.
- `crypto-envelope.test.ts`: HPKE encrypt → decrypt round-trip using fixture keys. This is the only Phase 0 use of HPKE on the backend; production paths never decrypt.

### Frontend changes

**New module** `apps/frontend/src/lib/crypto/`:
- `hpke.ts`: `seal(recipientPub, payload, aad)` / `open(recipientPriv, enc, ct, aad)` wrappers around `@hpke/core`.
- `passphrase.ts`: `deriveKEK(passphrase, salt, params)` using `hash-wasm` Argon2id. Tuned default params + a `benchmark()` helper for first-time setup on the user's actual device.
- `keys.ts`: `generateUIK()`, `wrapPrivate(priv, kek)`, `unwrapPrivate(bundle, kek)`. Internal use only.
- `envelope.ts`: `encryptPayload(payload, recipients[])` and `decryptPayload(envelope, ownKey)` — these are the only symbols Phase 1 will import.
- `__tests__/`: round-trip tests using fixture passphrase + multiple recipients.

**Dexie migration to v29** (`apps/frontend/src/db/database.ts`):
- Add table `e2eKeys`:
  ```typescript
  e2eKeys!: EntityTable<CachedE2eKey, "id">
  // Schema: "id, [workspaceId+userId], createdAt"
  // Fields: id, workspaceId, userId, keyId, publicKey, encryptedPrivateBundle, kdfSalt, kdfParams, createdAt
  ```
- Add type `CachedE2eKey` in the interfaces block at the top of the file.
- Decrypted private key is **not** persisted to Dexie. It lives in an in-memory Zustand store for the session.

**New Zustand store** `apps/frontend/src/stores/e2e-session-store.ts`:
- State: `{ status: 'locked' | 'unlocked' | 'no-key', privateKey: CryptoKey | null, keyId: string | null, publicKey: Uint8Array | null }`.
- Actions: `unlock(passphrase)`, `lock()`, `setupNewKey(passphrase)`, `rotate(oldPassphrase, newPassphrase)`.
- `unlock`: pulls the bundle from Dexie (or backend if Dexie miss), derives KEK, unwraps. Errors loudly (INV-11) on KDF mismatch or auth failure.
- `lock`: clears in-memory key; called on logout, on explicit "Lock encrypted scratchpads" menu, or on session expiry.

**Settings UI**: extend `apps/frontend/src/components/settings/ai-settings.tsx` with a new "Encrypted scratchpads" section at the bottom. For first-time setup, the section renders a "Set up encryption" CTA that opens the passphrase modal; for already-set-up users, it shows the UIK fingerprint and a "Reset E2E keys" button with a strong `AlertDialog` confirmation.

**Passphrase modal** (new component `apps/frontend/src/components/encryption/passphrase-setup-modal.tsx` and `passphrase-unlock-modal.tsx`):
- Setup: two-field set+confirm with strength meter; mandatory "I understand this cannot be recovered" checkbox before the primary CTA.
- Unlock: single-field passphrase entry with the recipient fingerprint visible so the user can verify before typing.

### Verification (Phase 0)

- Backend integration tests round-trip the GET/POST/DELETE endpoints.
- Unit tests prove HPKE + Argon2id round-trip is correct using fixture passphrases.
- Manual: in two browser tabs of the same account, set up a passphrase, refresh, unlock with the passphrase. Expected: the in-memory key is gone after refresh and reappears after unlock; the network panel shows ciphertext bundles only.
- DB check: `SELECT * FROM user_e2e_keys` shows only ciphertext, salts, params — no plaintext key material.

## Phase 1 — E2E scratchpad MVP (loopback, no agent yet)

**Goal**: a user creates an encrypted scratchpad via the Quickswitcher, messages themselves across two browser tabs, sees the lock indicators in sidebar + header + composer, runs keyword search over the result, and is blocked from cross-stream sharing of the encrypted content. Backend stores ciphertext only.

### Backend changes

**Migration** `YYYYMMDDHHmmss_e2e_scratchpads.sql`:
```sql
CREATE TABLE e2e_scratchpads (
  stream_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL,
  owner_user_key_id TEXT NOT NULL,
  invited_agent_kind TEXT NOT NULL,            -- 'bot' | 'enclave' | 'none'
  invited_agent_key_id TEXT
);

ALTER TABLE messages
  ADD COLUMN ciphertext BYTEA,
  ADD COLUMN envelope JSONB,
  ADD COLUMN e2e_version SMALLINT;
-- Repository-layer assertion (INV-E1):
--   E2E stream rows have ciphertext NOT NULL and content_json/content_markdown NULL.
--   Non-E2E rows keep content_* set and ciphertext NULL.
-- DB check constraint deliberately omitted — repository enforcement is cleaner
-- given the cross-table dependency on e2e_scratchpads.
```

**New feature folder** `apps/backend/src/features/e2e-scratchpads/`:
- `repository.ts`: `isE2eStream(querier, streamId)`, `getE2eScratchpad(querier, streamId)`, `markStreamE2e(client, { streamId, workspaceId, ownerKeyId, invitedAgent })`.
- `service.ts`: thin; mostly wraps the repository for outbox handlers to consume.
- `index.ts` barrel.

**Messaging changes** (`apps/backend/src/features/messaging/`):
- `handlers.ts`: extend `createMessageSchema` (line ~66) with a discriminated union — `{ kind: 'plaintext', contentJson, contentMarkdown }` vs `{ kind: 'e2e', ciphertext, envelope, e2eVersion }`. Reject mismatches loudly (INV-11): plaintext on E2E stream → 400; ciphertext on non-E2E stream → 400.
- `repository.ts`: extend `InsertMessageParams` (line ~6) with optional `ciphertext`, `envelope`, `e2eVersion`. The insert path enforces INV-E1: E2E rows have content columns NULL, non-E2E rows have ciphertext NULL.
- `event-service.ts`: outbox event for `message:created` carries the same shape on the wire — the discriminator + content fields OR ciphertext fields. Existing consumers see a `kind` field they can branch on.

**Streams changes** (`apps/backend/src/features/streams/handlers.ts`):
- Extend the create-scratchpad endpoint to accept `e2eEnabled: boolean` and `ownerKeyId: string`.
- When `e2eEnabled` is true, in the same transaction as the stream insert:
  1. Verify `ownerKeyId` matches an active row in `user_e2e_keys` for `(workspaceId, userId)`.
  2. Force `companionMode = "off"` (companion can't run server-side here).
  3. INSERT into `e2e_scratchpads`.
- Reject any later attempt to flip `e2eEnabled` (the column is set at create time only).

**Outbox handler audit** — add `if (await isE2eStream(querier, event.streamId)) { mark seen and continue }` to all twelve handlers identified during exploration:

```text
apps/backend/src/features/activity/outbox-handler.ts
apps/backend/src/features/agents/companion-outbox-handler.ts
apps/backend/src/features/agents/mention-invoke-outbox-handler.ts
apps/backend/src/features/agents/message-mutation-outbox-handler.ts
apps/backend/src/features/bot-runtimes/invocation-outbox-handler.ts   ← exception, see Phase 2
apps/backend/src/features/conversations/boundary-extraction-outbox-handler.ts
apps/backend/src/features/emoji/usage-outbox-handler.ts
apps/backend/src/features/link-previews/outbox-handler.ts
apps/backend/src/features/memos/accumulator-outbox-handler.ts
apps/backend/src/features/memos/embedding-outbox-handler.ts
apps/backend/src/features/messaging/sharing/outbox-handler.ts
apps/backend/src/features/streams/naming-outbox-handler.ts
```

Pattern (single helper, twelve insertion sites): pull `isE2eStream` from the new `e2e-scratchpads` feature barrel. The bot-runtimes invocation handler is the exception — it still fires invocations on E2E streams (the bot is supposed to be invoked!) but the invocation payload references the message id only, not its content; Phase 2 wires the bot's decryption.

**Sharing block** (`apps/backend/src/features/messaging/sharing/handlers.ts` and its outbox handler): reject share requests where the source message lives in an E2E stream. Response is a 400 with a structured error code so the frontend renders the "Copy as plaintext" alternative.

**Search** (`apps/backend/src/features/search/repository.ts`): server-side search excludes messages from E2E streams. The repository already filters by accessible stream ids; add an `AND streams.id NOT IN (SELECT stream_id FROM e2e_scratchpads)` clause. Returns a separate `excludedE2eStreamCount` field so the frontend can render the "X encrypted scratchpads excluded" banner.

**Tests**:
- `e2e-scratchpads/__tests__/repository.test.ts`: `isE2eStream` correctness, `markStreamE2e` write path.
- `messaging/__tests__/handlers.test.ts`: extend with E2E-vs-plaintext rejection cases on both stream types.
- `streams/__tests__/handlers.test.ts`: create-E2E-scratchpad happy path; companion-mode-forced-off; unknown ownerKeyId rejection.
- One audit test per outbox handler asserting it short-circuits on E2E streams. Pattern: build a fixture E2E stream + message, run handler, assert no AI calls / no DB writes outside the "mark seen" cursor advance.
- `sharing/__tests__/handlers.test.ts`: cross-stream share from E2E source returns the structured error.

### Frontend changes

**Stream cache** (`apps/frontend/src/db/database.ts`):
- Extend `CachedStream` interface with `e2eEnabled?: boolean`, `e2eKeyId?: string | null`, `invitedAgentKind?: 'bot' | 'enclave' | 'none'`, `invitedAgentKeyId?: string | null`.
- Dexie v29 schema bump to add `e2eSearchIndex` table:
  ```typescript
  e2eSearchIndex!: EntityTable<CachedE2eSearchEntry, "id">
  // Schema: "id, [streamId+token], streamId, messageId"
  ```
- Bootstrap sync (`apps/frontend/src/sync/stream-sync.ts`): map the backend's `e2e` fields into the cache via `applyStreamBootstrap`.

**Quickswitcher** (`apps/frontend/src/components/quick-switcher/commands.ts`):
- Insert `new-encrypted-scratchpad` directly after the existing `new-scratchpad` command (line ~46), padlock icon (`Lock` from lucide-react), label "New encrypted scratchpad", keywords `["encrypted", "private", "secure", "e2e"]`.
- Add `createDraftEncryptedScratchpad: () => Promise<string>` to `CommandContext` in `quick-switcher.tsx` (line 18–28). Wired the same way `createDraftScratchpad` is, but passing `e2eEnabled: true` and forcing `companionMode: "off"`.
- First-time-per-account selection routes through the passphrase setup modal before the scratchpad is created.

**Draft scratchpad** (`apps/frontend/src/hooks/use-draft-scratchpads.ts` and `apps/frontend/src/stores/draft-store.ts`):
- Extend `DraftScratchpad` interface (`db/database.ts` line ~258) with `e2eEnabled: boolean`.
- `createDraft` accepts the flag and carries it through to the promote-to-stream API call.

**Sidebar indicator** (`apps/frontend/src/components/layout/sidebar/stream-item.tsx`):
- The `Lock` icon is already imported (line 2) and used for private channels at line 321–323. Add an analogous block: when `stream.e2eEnabled` is true, render a tinted-accent padlock in the same slot. Tooltip on hover: "End-to-end encrypted. Threa servers cannot read this scratchpad."
- For scratchpads specifically: `scratchpad-item.tsx` delegates rendering, so the indicator propagates without extra work.

**Stream header chip + recipients popover** (`apps/frontend/src/components/timeline/stream-content.tsx`):
- New component `apps/frontend/src/components/timeline/e2e-header-chip.tsx`: `🔒 Encrypted` chip with a Popover surfacing the recipient list.
- New component `apps/frontend/src/components/timeline/e2e-recipients-popover.tsx`: lists "Encrypted to:" with each recipient's display name + truncated pubkey fingerprint (`formatFingerprint(publicKey)` → groups of four). Phase 1 only ever shows the user's UIK; bot fingerprints land in Phase 2.

**Composer placeholder** (`apps/frontend/src/components/timeline/message-input.tsx`):
- Pass conditional `placeholder` to the underlying `<MessageComposer>`: `stream.e2eEnabled ? "Encrypted message…" : <default>`.
- Padlock glyph in the send button when E2E.

**Message list tint** (`apps/frontend/src/components/timeline/stream-content.tsx`): wrap `EventList` in a div with `className={cn(stream.e2eEnabled && "bg-accent/5")}`. Low-saturation accent, only on the message list area, not on header or sidebar.

**Locked-state placeholder**:
- When `useE2eSessionStore().status === 'locked'` and the user is viewing an E2E stream, the message list renders an "Unlock encrypted scratchpad" centred card with the recipient fingerprint visible above the unlock button.
- Sidebar entries gain a muted `(locked)` suffix when the session is locked.

**Send path** (`apps/frontend/src/api/messaging.ts` or wherever `sendMessage` lives):
- Before POST, if `stream.e2eEnabled`: build payload from `contentJson` + `contentMarkdown` + attachment refs, call `encryptPayload(payload, [ownUIK])` (no bot recipient yet in Phase 1), POST `{ kind: 'e2e', ciphertext, envelope, e2eVersion: 1 }`.

**Receive path** (the message-cache layer that handles `message:created` socket events):
- Branch on `kind`. For `'e2e'`, look up the recipient entry matching the user's current `keyId`, call `decryptPayload(envelope, ownPrivateKey)`, then merge the decrypted `{ contentJson, contentMarkdown }` into the cache row in memory only — they never get persisted to Dexie in plaintext, only the ciphertext + envelope land in the message cache.
- If locked, store ciphertext only; render the locked-state placeholder.

**Sidebar previews + activity previews** (`apps/frontend/src/components/layout/sidebar/stream-item.tsx`, `apps/frontend/src/components/timeline/event-list.tsx`):
- For E2E streams, the preview hook decrypts the cached ciphertext locally to compute the snippet. When locked or decryption fails, render the existing "Encrypted scratchpad" placeholder.
- INV-60 (`stripMarkdownToInline`) still applies after decrypt — the existing `StreamItemPreview` and `ActivityPreview` are the right path for this.

**Sharing UI** (wherever the message-share button is rendered, likely under `apps/frontend/src/components/timeline/`):
- When the source message is E2E, replace the share action with a "Copy as plaintext" button. Click confirms with "This will copy the decrypted content to your clipboard, which leaves the encrypted scratchpad's protection."

**Client-side search**:
- New module `apps/frontend/src/lib/search/e2e-index.ts`: tokenize decrypted message content into the `e2eSearchIndex` Dexie table, build an inverted index keyed by `[streamId, token]`. Lowercase-only, no stemming for v1.
- New hook `apps/frontend/src/hooks/use-e2e-search.ts`: queries the index for a token list.
- Search merge (`apps/frontend/src/hooks/use-search.ts`): run `searchMessages` (server) and `useE2eSearch` (client) in parallel, merge results into a single ranked list. If the backend response includes `excludedE2eStreamCount > 0` and the user hasn't unlocked all E2E streams, render a banner above the results.
- On unlock, kick off an indexer pass over all E2E streams the user owns. Index size monitored (a chatty user generates ~hundreds of KB of index — well within Dexie's quotas, but we surface a "build index" progress for the first run).

### Verification (Phase 1)

- Backend integration tests cover the full request matrix (E2E and plaintext × scratchpad and DM × correct and incorrect content fields).
- Backend audit tests prove all twelve outbox handlers short-circuit on E2E streams.
- Loopback test: open the same E2E scratchpad in two browser tabs of the same user, send a message in tab A, see it appear in tab B with the lock indicators visible. Inspect `SELECT * FROM messages WHERE stream_id = ...`: ciphertext + envelope populated, `content_json` and `content_markdown` NULL.
- Search test: send several E2E messages with distinct keywords, search the workspace, confirm results come back from the client-side index and the "0 encrypted scratchpads excluded" path is correct. Lock the session, search again, confirm the "X encrypted scratchpads excluded" banner appears.
- Sharing test: try to cross-stream-share an E2E message; expect the "Copy as plaintext" UI.
- Refresh test: refresh the page, see the locked state, unlock, see content rendered.

## Phase 2 — Pi remote + traces

**Goal**: Pi remote works inside an E2E scratchpad. Messages, claims, trace steps, and completions are all encrypted end-to-end. Threa servers see only ciphertext. The trace UI renders the **full** Arguments/Output sections because the server-side sanitizer is bypassed for E2E sessions.

### Backend changes

**Migration** `YYYYMMDDHHmmss_bot_runtime_keys.sql`:
```sql
CREATE TABLE bot_runtime_keys (
  id TEXT PRIMARY KEY,                         -- bkey_<ULID>
  instance_id TEXT NOT NULL,                   -- bot_runtime_instances.id
  workspace_id TEXT NOT NULL,
  key_id TEXT NOT NULL,                        -- short id used as recipientKeyId
  public_key BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX bot_runtime_keys_active_idx
  ON bot_runtime_keys (instance_id)
  WHERE rotated_at IS NULL;

ALTER TABLE agent_session_steps
  ADD COLUMN ciphertext BYTEA,
  ADD COLUMN envelope JSONB,
  ADD COLUMN e2e_version SMALLINT;
```

**Sibling table over a column on `bot_runtime_instances`** because (a) keys rotate per session while the instance row is long-lived, (b) we want historical keys to remain available for decrypting in-flight invocations after rotation.

**Bot-runtimes feature** (`apps/backend/src/features/bot-runtimes/`):
- `repository.ts`: extend `BotRuntimeInstance` (line ~30) with helpers `getActiveKey(querier, instanceId)`, `insertKey(client, { instanceId, workspaceId, keyId, publicKey })`, `rotateKey(client, instanceId)`.
- `service.ts`: `upsertPresenceFromBotKey` (line ~varies) accepts an optional `publicKey` field; when present, rotates the previous active key in the same transaction.

**Public API schemas** (`apps/backend/src/features/public-api/schemas.ts`):
- Extend the presence schema to accept `publicKey: Uint8Array` (base64-encoded on the wire).
- Extend `recordInvocationStepSchema` (line 119) into a discriminated union: `{ kind: 'plaintext', content, statusText }` vs `{ kind: 'e2e', ciphertext, envelope, e2eVersion }`.
- Extend the `complete` schema with the same discriminated union for the final message body.

**Public API handlers** (`apps/backend/src/features/public-api/handlers.ts`):
- `recordBotInvocationStep` (line 910):
  1. Resolve the session, check `isE2eStream(responseStreamId)`.
  2. If E2E: require the `'e2e'` body shape; **bypass** the `sanitizeInvocationStepContent` call (line ~435–454); persist via `appendStep` (`session-repository.ts:508`) with ciphertext + envelope.
  3. If not E2E: existing path unchanged.
  4. Broadcast the socket event verbatim — `serializeTraceStep` (line ~456) passes the ciphertext blob through; no plaintext for the server to leak.
- `completeBotInvocation` (line ~980): mirror the same branching on the final message payload.

**Invocation creation** (`apps/backend/src/features/bot-runtimes/invocation-outbox-handler.ts`): pulls the message's ciphertext + envelope when E2E and includes them in the invocation payload returned by the claim endpoint. The bot decrypts client-side.

**Stream member → recipient list**: when a user creates an E2E scratchpad and invites a bot (this UI ships in Phase 2), the backend looks up the bot's current active key from `bot_runtime_keys`, persists the (instanceId, keyId) on `e2e_scratchpads.invited_agent_*`, and the frontend's send path includes that pubkey as a second recipient in every envelope.

**Tests**:
- `bot-runtimes/__tests__/repository.test.ts`: key rotation + active-key uniqueness.
- `public-api/__tests__/handlers.test.ts`: extend the existing `recordBotInvocationStep` tests with E2E branch; verify sanitizer is **not** called on E2E sessions (spy on `sanitizeInvocationStepContent`).
- Round-trip integration test: simulated bot runtime claims an E2E invocation, posts ciphertext steps, completes with ciphertext; verify the steps row has NULL `content`/`sources` and populated `ciphertext`/`envelope`.

### Pi remote adapter changes

The adapter lives outside this repo (`~/.pi/agent/extensions/threa-remote.ts`) and is updated via the `update-pi-remote-plugin` skill. Concretely:

- Generate a fresh X25519 keypair on `/remote-control` session start using `@hpke/core`.
- Include the public key in the presence heartbeat (`POST /bot-runtime/presence`).
- On claim, decrypt the inbound message envelope using the session's BIK private key.
- On every trace step: build the `pi_tool_trace` structure with **full** `Arguments` and `Output` sections (no client-side truncation needed — the server can't read them and the user wants the full output), HPKE-seal to `[UIK, BIK]`, POST as the `'e2e'` body shape.
- On completion: same encryption applied to the final message body.

### Frontend changes

**Recipients popover** (`apps/frontend/src/components/timeline/e2e-recipients-popover.tsx`): now lists user UIK fingerprint **and** invited bot BIK fingerprint with display name. Out-of-band verification surface.

**Send path** (extends Phase 1 work in `apps/frontend/src/api/messaging.ts`): when the stream has an `invitedAgentKeyId`, the envelope's recipient list becomes `[ownUIK, invitedBotKey]`. The bot's pubkey is hydrated from the stream cache.

**Trace step renderer** (`apps/frontend/src/components/trace/trace-step.tsx`):
- For E2E sessions, the `content` field arrives as ciphertext + envelope. Decrypt locally, then feed the resulting `pi_tool_trace` JSON to the existing `parseStructuredContent` (line ~161). The rest of the renderer (collapsible `Arguments`, `Output`, `Error output`, `Details`) is unchanged because the decrypted payload has the same shape.
- If locked, render the "Unlock to see this trace" placeholder.

**"Invite Pi to this scratchpad" UI** (likely a new menu item in the stream header, or in the existing bot-runtime presence component): lists currently-online bots; selecting one passes the bot's instance id to the backend, which persists the recipient binding on `e2e_scratchpads`.

### Verification (Phase 2)

- Integration test with a simulated Pi runtime in `apps/backend/src/features/bot-runtimes/__tests__/e2e-flow.test.ts`: end-to-end claim → step × N → complete, all ciphertext, decrypts correctly client-side.
- Manual: real Pi runtime against a local backend with the adapter changes. Run a tool call that produces nontrivial Arguments and Output; confirm the trace UI shows full content (no "omitted for safety" placeholders) and the DB shows only ciphertext.
- Sanitizer-bypass test: spy on `sanitizeInvocationStepContent` during an E2E invocation; assert it is never called.

## Phases 3–5 (sketched)

These get their own detailed plans when their turn comes. Captured here only so the Phase 0–2 work doesn't paint into a corner.

- **Phase 3 — Attachments E2E**: per-attachment random key generated client-side, AES-GCM-encrypt before upload, key wrapped into the message envelope, server processors flagged `e2e_only` and skipped. Reuses the envelope code from Phase 1.
- **Phase 4 — Multi-device polish**: friendly device-add UX, optional WebAuthn-bound KEK as a faster unlock on the same device, devices page with pubkey fingerprints.
- **Phase 5 — Ariadne enclave**: TEE selection (AWS Nitro / Azure CVM / GCP Confidential Space), attested service that decrypts → calls LLM provider → encrypts back, client-side attestation verification, persona declaration that gates E2E-capable companion mode.

## Risk areas

- **`@hpke/core` in Bun**: verify it loads cleanly on the backend (we only need it for tests). If it doesn't, fall back to `@hpke/dhkem-x25519` + `@hpke/chacha20poly1305` siblings; the algorithm choice is portable.
- **Argon2id timing**: 250 ms is the target; needs benchmarking on a real mid-range phone before shipping. If too slow, drop `t` (iterations) first, then `m` (memory).
- **Outbox-handler audit completeness**: the twelve identified handlers are today's list. Any new handler added between now and ship date needs to consult `isE2eStream`. Add a lint rule or grep-based CI check that every file matching `*-outbox-handler.ts` imports the `e2e-scratchpads` barrel.
- **INV-E1 enforcement**: the repository-layer assertion is the only thing standing between us and a bug that writes plaintext into an E2E stream. Write a property-based test that fuzzes the message-insert path and asserts the invariant holds.
- **Dexie storage growth**: the client-side search index can grow unboundedly for chatty users. Add a per-stream cap (`max_index_messages = 10_000`) and a "rebuild index" action in the settings page.
- **Lost passphrase**: the destruction is intentional but the UI needs to make this very loud. Reset flow must require typing "RESET" in confirmation, not just clicking through.

## Verification at the project level

End-to-end smoke run before merging Phase 1 and Phase 2 PRs:

1. `bun run test` — unit + integration suite passes.
2. `bun run test:e2e` — Playwright tests including a new `e2e-encrypted-scratchpads.spec.ts` covering loopback (Phase 1) and Pi-bot (Phase 2) flows.
3. Manual smoke: create encrypted scratchpad via Quickswitcher, send messages across two tabs, search results merge correctly, share button shows "Copy as plaintext", trace from Pi shows full Arguments + Output, DB query confirms zero plaintext rows.
4. `psql` audit on the dev database: `SELECT count(*) FROM messages m JOIN e2e_scratchpads e ON m.stream_id = e.stream_id WHERE m.content_json IS NOT NULL OR m.content_markdown IS NOT NULL;` must return 0.
5. Same audit for `agent_session_steps`: every step whose session's response stream is E2E has NULL `content` and `sources`, populated `ciphertext` and `envelope`.

## Critical file index

For quick navigation during implementation.

**Backend, new**:
- `apps/backend/src/features/user-e2e-keys/{repository,service,handlers,routes,index}.ts`
- `apps/backend/src/features/e2e-scratchpads/{repository,service,index}.ts`
- `apps/backend/src/db/migrations/YYYYMMDDHHmmss_user_e2e_keys.sql`
- `apps/backend/src/db/migrations/YYYYMMDDHHmmss_e2e_scratchpads.sql`
- `apps/backend/src/db/migrations/YYYYMMDDHHmmss_bot_runtime_keys.sql`

**Backend, modified**:
- `apps/backend/src/features/messaging/{handlers,repository,event-service}.ts`
- `apps/backend/src/features/streams/handlers.ts`
- `apps/backend/src/features/search/repository.ts`
- `apps/backend/src/features/messaging/sharing/{handlers,outbox-handler}.ts`
- `apps/backend/src/features/bot-runtimes/{repository,service}.ts`
- `apps/backend/src/features/bot-runtimes/invocation-outbox-handler.ts`
- `apps/backend/src/features/public-api/{schemas,handlers}.ts` (around line 910 + line 119)
- `apps/backend/src/features/agents/session-repository.ts` (around `appendStep`, line 508)
- All twelve outbox handlers listed under the Phase 1 audit.

**Frontend, new**:
- `apps/frontend/src/lib/crypto/{hpke,passphrase,keys,envelope}.ts`
- `apps/frontend/src/lib/search/e2e-index.ts`
- `apps/frontend/src/stores/e2e-session-store.ts`
- `apps/frontend/src/hooks/use-e2e-search.ts`
- `apps/frontend/src/components/encryption/{passphrase-setup-modal,passphrase-unlock-modal}.tsx`
- `apps/frontend/src/components/timeline/{e2e-header-chip,e2e-recipients-popover}.tsx`

**Frontend, modified**:
- `apps/frontend/src/db/database.ts` (Dexie v29: new tables, extended `CachedStream`)
- `apps/frontend/src/components/quick-switcher/{commands,quick-switcher}.tsx`
- `apps/frontend/src/components/layout/sidebar/{stream-item,scratchpad-item}.tsx`
- `apps/frontend/src/components/timeline/{stream-content,message-input,event-list,trace-step}.tsx`
- `apps/frontend/src/components/settings/ai-settings.tsx`
- `apps/frontend/src/api/{messaging,search}.ts`
- `apps/frontend/src/hooks/{use-search,use-draft-scratchpads,use-streams}.ts`
- `apps/frontend/src/stores/draft-store.ts`
- `apps/frontend/src/sync/stream-sync.ts`
