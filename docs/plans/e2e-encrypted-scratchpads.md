# End-to-end encrypted scratchpads (with agent invocations)

## Goal

Let a user mark a scratchpad as **E2E**. From that point on:

1. The message contents, attachments, **and agent trace data** (tool calls, intermediate output, progress text, sources) are readable only by:
   - the user (on any of their logged-in devices), and
   - the agent the user has invited into that scratchpad.
2. Threa as an operator — DB, S3, application logs, sysadmins, Threa personnel — sees only opaque ciphertext and routing metadata.
3. For **external agents** (Pi remote and future BYO runtimes), "the agent" is the user's own runtime, so the LLM provider question is the user's problem.
4. For **first-party agents** (Ariadne / managed personas), "the agent" is a remote enclave that calls the LLM provider on the user's behalf. The LLM provider sees plaintext, but Threa servers do not.

This is what makes the product safe enough for Kris's wife (private journaling against Ariadne) and for colleagues using Pi-remote from inside their employer's network.

**Trace data is the motivating use case.** Today the `/bot-invocations/:id/steps` endpoint deliberately strips `Arguments` and `Output` sections from Pi tool traces (`apps/backend/src/features/public-api/handlers.ts:415-420`) because the content lives plaintext on Threa servers. Once traces are encrypted end-to-end, that scrubbing can be lifted for E2E sessions and the user gets the full tool I/O streamed into their UI — meaningfully better than today, and the privacy win comes along for free.

## Decisions taken (2026-05-25)

- **Phase order**: Pi remote first (Phases 0 → 1 → 2 → 3 → 4), Ariadne enclave (Phase 5) after the envelope shape has been validated in production.
- **User key protection**: passphrase + Argon2id; encrypted bundle stored server-side. WebAuthn deferred to Phase 4 polish.
- **Enclave platform**: deferred. Pick at the start of Phase 5. Envelope shape is portable across Nitro / Confidential VMs / Confidential Space.
- **Migration**: no in-place conversion. Existing scratchpads stay plaintext; users create a new scratchpad for E2E.

## Non-goals (be loud about these)

- **Defending against the LLM provider.** The provider that runs the inference necessarily sees the prompt. We narrow trust to that one party and prefer zero-retention enterprise tiers, but we do not pretend the LLM provider is blind.
- **Hiding metadata.** Threa still sees: which user owns the scratchpad, when messages were sent, how big they are, who the invited agent is, whether an invocation succeeded. Reducing this is a v2+ problem (padding, cover traffic).
- **Group / multi-user E2E.** Scratchpads are 1-to-1 (user ↔ agent). Channels and DMs are out of scope for v1.
- **Post-compromise security.** v1 uses per-message random keys wrapped to long-lived identity keys (good forward secrecy, no PCS). A Signal-style ratchet is a later phase.
- **Recovery without the user's passphrase.** Lose the passphrase, lose the scratchpad. v1 accepts that. (Social / hardware recovery is a future addition.)

## Threat model

| Adversary                                                           | Defense in v1                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Threa DB / S3 read access (insider, leaked backup, lawful order)    | Ciphertext only. Server has no key material.                                                                                               |
| Threa application server, including outbox handlers and AI features | Ciphertext only. E2E-flagged streams skip all server-side AI.                                                                              |
| Threa sysadmin running ad-hoc queries                               | Same as DB read.                                                                                                                           |
| Network observer                                                    | TLS + E2E ciphertext.                                                                                                                      |
| Compromised user device                                             | Game over for that user's scratchpads (standard E2E limitation). Rotate device keys to bound blast radius.                                 |
| Compromised Pi runtime                                              | Game over for scratchpads invited to that bot. Bot key rotation per runtime session bounds blast radius.                                   |
| Compromised Ariadne enclave                                         | Requires hypervisor or attestation compromise. Mitigated by published source, reproducible builds, and on-device attestation verification. |
| LLM provider                                                        | Out of scope. Trust them or don't use Ariadne E2E.                                                                                         |

## Feature impact at a glance

The goal is that **as much of Threa as possible keeps working on E2E scratchpads, just at reduced capacity** where the server can no longer participate. See § User experience for the full per-surface breakdown, the visual treatment, locked-state UX, sharing rules, and the opt-in flow.

Short version: every feature whose value comes from arrangement of metadata (real-time delivery, reactions, threads, presence, read receipts, edits, deletes, cross-region migration, mentions-as-annotations) stays at full capacity. Every feature whose value comes from the server reading content (semantic search, companion mode, GAM memo extraction, stream naming polish, dictation polish, server-side attachment processing, sidebar/notification preview snippets) is off or replaced. **Keyword search still works**, run client-side over the decrypted content the user has access to.

## Cryptographic design

### Primitives

- **HPKE (RFC 9180)** for "encrypt to public key" wrapping. Use `@hpke/core` (works in Bun and the browser, audited, modern). Suite: `DHKEM(X25519, HKDF-SHA256)` + `HKDF-SHA256` + `AES-256-GCM`.
- **Argon2id** for passphrase-derived key derivation (`argon2-browser` or `hash-wasm`). Parameters tuned for ~250 ms on a mid-range phone.
- **WebCrypto** for symmetric AES-GCM and random.
- **No hand-rolled crypto.** Every primitive comes from a maintained library.

### Identity keys

Three actor types, each with an X25519 keypair:

| Key                            | Owner                          | Private key lives                                                                                                     | Public key registered                                         |
| ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **UIK** — User Identity Key    | The user                       | Browser/Dexie, encrypted with Argon2id(passphrase) → AES-GCM. Encrypted bundle stored on Threa for multi-device sync. | `user_e2e_keys.public_key`                                    |
| **BIK** — Bot Identity Key     | The external runtime (Pi, BYO) | The runtime device (Pi, laptop). Never leaves.                                                                        | `bot_runtime_instances.public_key` (rotated per session)      |
| **EIK** — Enclave Identity Key | The Ariadne enclave            | Inside the TEE. Generated at boot, never persisted.                                                                   | Served alongside an attestation document the client verifies. |

Key rotation:

- **UIK** rotates when the user explicitly rotates (re-encrypts bundle); old key kept for read-only decryption of historical messages.
- **BIK** rotates per runtime session. When a Pi runtime starts, it generates a fresh keypair and registers the pubkey. Old keys are kept long enough for in-flight invocations to complete.
- **EIK** rotates per enclave instance (boot). Clients re-fetch + re-verify attestation on rotation.

### Per-message envelope

```text
EncryptedMessage {
  ciphertext:   bytes,                          // AES-256-GCM(messageKey, payload)
  nonce:        bytes,                          // 12-byte
  recipients: [
    { recipientId, recipientKeyId, enc, ct },   // HPKE encap(recipientPub) -> messageKey
    ...
  ],
  aad:          bytes                           // streamId || messageId || senderId (binds envelope to message)
}
```

`payload` is the canonical JSON:

```json
{
  "contentJson": {
    /* ProseMirror tree */
  },
  "contentMarkdown": "…",
  "attachmentRefs": [{ "attachmentId": "…", "key": "base64", "iv": "base64" }],
  "clientMentions": ["ariadne", "kris"],
  "version": 1
}
```

`recipients` is the list of everyone who can read this message — for a scratchpad that is normally `[UIK, agent-key]`. The same envelope shape covers user-to-user E2E if we ever ship it.

### Storage

New columns on `messages`:

```sql
-- additive only (INV-17)
ALTER TABLE messages
  ADD COLUMN ciphertext BYTEA,
  ADD COLUMN envelope JSONB,           -- recipients + AAD metadata
  ADD COLUMN e2e_version SMALLINT;     -- protocol version for forward compat
```

For E2E messages, `content_json` and `content_markdown` are `NULL`. Server enforces "if `e2e_scratchpads.stream_id = streamId`, then content columns must be NULL and ciphertext must be present", and vice versa.

New tables:

```sql
CREATE TABLE user_e2e_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  key_id TEXT NOT NULL,                -- short id used as recipientKeyId
  public_key BYTEA NOT NULL,
  encrypted_private_bundle BYTEA NOT NULL,    -- AES-GCM(KEK = Argon2id(passphrase, salt), priv)
  kdf_salt BYTEA NOT NULL,
  kdf_params JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE bot_runtime_keys (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,           -- bot_runtime_instances.id
  workspace_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ
);

ALTER TABLE agent_session_steps
  ADD COLUMN ciphertext BYTEA,
  ADD COLUMN envelope JSONB,
  ADD COLUMN e2e_version SMALLINT;
-- For E2E sessions, `content` and `sources` are NULL and the encrypted blob carries both.

CREATE TABLE e2e_scratchpads (
  stream_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL,
  -- denormalized for fast checks in outbox handlers
  owner_user_key_id TEXT NOT NULL,
  invited_agent_kind TEXT NOT NULL,    -- 'bot' | 'enclave' | 'none'
  invited_agent_key_id TEXT
);
```

(Real ID prefixes per INV-2.)

### Server invariants

- **INV-E1**: For any stream in `e2e_scratchpads`, every persisted `messages` row has `ciphertext IS NOT NULL` and `content_json IS NULL` and `content_markdown IS NULL`. Enforced at the repository layer + a check constraint.
- **INV-E2**: Outbox handlers (companion, boundary, memo, naming, search-indexer, mention extractor) short-circuit when the stream is E2E. We add a single helper `isE2eStream(streamId)` they all consult.
- **INV-E3**: The Pi remote / bot runtime endpoints never decrypt. They forward the envelope verbatim. **This includes `/bot-invocations/:id/steps`** — the server-side `pi_tool_trace` sanitizer (`apps/backend/src/features/public-api/handlers.ts:415-420`) does not run for E2E sessions because there is no plaintext to scrub.
- **INV-E4**: Sidebar previews and push payloads carry no content for E2E streams. Server returns `"hasContent": true` only; client renders the preview by decrypting locally if it has the key cached.
- **INV-E5**: Edit/delete operations on E2E messages re-encrypt; we never store a plaintext "edit history" diff.
- **INV-E6**: For trace steps belonging to an E2E session, `agent_session_steps.content` and `agent_session_steps.sources` are `NULL`; ciphertext + envelope live in new sibling columns. `step_type`, `started_at`, `completed_at`, `tokens_used` stay plaintext (they are routing/UX metadata, not content).

## Flows

### Flow A — User sends a message in an E2E scratchpad

```text
User types                                                  (browser)
  ↓
Compose envelope:
  messageKey = randomBytes(32)
  ciphertext = AES-GCM(messageKey, payload, aad)
  for each recipient in [self-UIK, agent-key]:
    (enc, ct) = HPKE.seal(recipientPub, messageKey)
  ↓
POST /api/v1/streams/:id/messages
  body: { ciphertext, envelope, e2eVersion: 1 }
  ↓
Server validates schema, writes message row, fires outbox event:
  message:created { id, streamId, ciphertext, envelope, ... }
  (no content fields, AI handlers skip via INV-E2)
  ↓
Socket fanout to user's other devices (they decrypt with their UIK)
  ↓
If invocation is needed: BotInvocation created as today,
  but the invocation payload references the message id only; bot fetches and decrypts.
```

### Flow B — Pi remote (external runtime) responds

```text
Pi runtime claims invocation               (existing endpoint, unchanged)
  ↓
Pi fetches the message by id                (existing endpoint)
  → returns { ciphertext, envelope }
  ↓
Pi finds its recipient entry (recipientId == own BIK key_id),
  HPKE.open with BIK private → messageKey,
  AES-GCM open → payload (contentMarkdown + contentJson + attachments).
  ↓
Pi runs the user-side workload (Claude Code etc.).
LLM provider sees plaintext. This is the user's own trust call.
  ↓
While running, Pi streams trace steps:
  for each step (thinking / tool_call / workspace_search / ...):
    payload = { format: "pi_tool_trace", headline, sections: [...full tool I/O...], statusText, sources }
    encrypt under fresh stepKey, wrap to [UIK, BIK]
    POST /api/v1/.../bot-invocations/:id/steps
      body: { stepType, ciphertext, envelope, e2eVersion }
  Server writes the row + broadcasts `agent_session:step:completed` carrying the opaque blob.
  Server-side pi_tool_trace sanitizer is bypassed because the stream is E2E.
  ↓
Pi composes reply envelope:
  recipients = [self-UIK, BIK]  -- so the user's other devices and this bot
                                   can both read it back
  ↓
POST /api/v1/.../bot-invocations/:id/complete
  body: { ciphertext, envelope }
  ↓
Server writes message row + completes invocation.
```

The protocol surface barely changes — we add `ciphertext` + `envelope` fields and the agreement that for E2E streams `contentMarkdown` is absent. Everything else (claim, presence, trace events) is unaffected.

### Flow C — Ariadne via enclave (later phase)

```text
Enclave boots in AWS Nitro Enclave (separate AWS account, attested image).
Generates EIK, exposes attestation doc signed by Nitro hypervisor.

User's first message in an Ariadne E2E scratchpad:
  Client fetches enclave's attestation doc + EIK pub
  Verifies measurement against published hash in app code/docs
  Pins (key_id, pubkey) for that scratchpad
  ↓
Send is identical to Flow A, recipient list = [UIK, EIK].
  ↓
Threa backend recognizes "this invocation targets Ariadne" and forwards
  the envelope to the enclave endpoint (hosted in a separate AWS account
  with separate IAM; Threa sysadmins cannot exec into it).
  ↓
Enclave: HPKE.open → plaintext → OpenRouter call (zero-retention header).
  Compose reply envelope, recipients = [UIK, EIK], POST back to Threa.
  ↓
Threa stores ciphertext + fans out.
```

The enclave is the "trusted third party" in Kris's framing. We make trust verifiable in three ways:

1. Source code public + reproducible build (so the measurement hash is auditable).
2. Attestation verified client-side per session.
3. Hosted in an AWS account separate from Threa's main infra, with IAM that even Threa admins cannot exec into without triggering CloudTrail alerts.

If Kris later wants to use an external party's enclave (Anthropic-hosted, AWS-hosted, etc.), the same client-side attestation pattern just points at their endpoint.

### Flow D — New device login

```text
User signs into Threa on new device
  ↓
Client fetches user_e2e_keys.encrypted_private_bundle
  ↓
Prompt: "Enter your scratchpad passphrase"
  ↓
KEK = Argon2id(passphrase, kdf_salt, kdf_params)
priv = AES-GCM.open(KEK, encrypted_private_bundle)
  ↓
Cache priv in Dexie under a session lock (cleared on logout).
```

If we want to avoid the passphrase prompt on every device, we add WebAuthn-derived KEK in a later phase.

## Attachments

Same envelope shape, but the payload's `attachmentRefs` carry the per-attachment AES-GCM key that decrypts the bytes sitting in S3:

```text
Client side:
  attachmentKey = randomBytes(32); iv = randomBytes(12)
  encrypted = AES-GCM(attachmentKey, fileBytes, iv)
  Upload encrypted to S3 via existing presigned URL flow.
  Put { attachmentId, key: attachmentKey, iv } in the envelope payload.

Recipient side:
  Read envelope → attachmentRefs → fetch ciphertext from S3 → AES-GCM.open.
```

Server-side processors (image captioning, PDF extract, video transcode) are **disabled** for E2E attachments. The attachment row gets a `e2e_only = true` flag so workers know to skip.

## Agent trace data

The reason this plan exists. Today the Pi remote streams `pi_tool_trace` steps to `POST /api/v1/workspaces/:workspaceId/bot-invocations/:invocationId/steps` with a structured body containing `headline`, `sections` (Arguments, Output, Error output, Details), `statusText`, and `sources`. Because that content lands in `agent_session_steps.content` as plaintext JSONB visible to Threa servers, the handler hard-overwrites the Arguments and Output section bodies with "Tool arguments omitted for safety." and "Tool output omitted for safety." That sanitization is the right call given today's threat model, and it also makes the trace much less useful than it could be.

Under E2E, that scrubbing is no longer necessary on E2E streams: the server cannot read the trace anyway, so there is nothing to redact, and the Pi can send the full tool I/O straight to the user's screen.

### What gets encrypted vs left plaintext on a trace step

Encrypted (inside the envelope payload):

- `headline`
- `sections[]` — including full `Arguments` and `Output` bodies
- `statusText`
- `sources[]` — URLs and titles in source citations can be sensitive (internal links, repo paths)
- any structured discriminator like `format: "pi_tool_trace"`

Plaintext (server-visible metadata):

- `step_type` (enum: `thinking`, `tool_call`, `workspace_search`, ...) — needed for cross-stream "current step" display and for the inline timeline card on the stream surface
- `step_number`, `started_at`, `completed_at`, `tokens_used`
- `session_id`, `invocation_id`, `instance_id`
- `current_step_type` denormalized on `agent_sessions` (it's the same enum, server-routed)

This split matches the messages case: the server still routes and broadcasts; only the content blob is opaque.

### Wire shape

The existing `recordInvocationStepSchema` gains optional `ciphertext` + `envelope` + `e2eVersion` fields. For E2E sessions the server requires those and rejects a plaintext `content`. For non-E2E sessions the existing schema is unchanged.

```text
POST /api/v1/workspaces/:workspaceId/bot-invocations/:invocationId/steps
Body (E2E session):
{
  instanceId, claimToken,
  stepType,                    -- plaintext, routing metadata
  ciphertext, envelope, e2eVersion,
  -- content + statusText fields absent
}
```

### Broadcast

`agent_session:step:completed` and `agent_session:progress` socket events carry the opaque ciphertext + envelope. The frontend decrypts and renders, exactly the same code path that handles E2E message envelopes.

### Sanitizer bypass

The existing `redactPiToolTrace`-style sanitizer (currently lines 405-455 of `apps/backend/src/features/public-api/handlers.ts`) is wrapped in `if (!isE2eSession(invocation)) { /* run sanitizer */ }`. For E2E sessions, the server never sees the structured object, so there is no field to redact and no truncation to apply.

### Reusing message envelope code

Trace step envelopes use the **same** HPKE wrapping, recipient list, and key resolution as message envelopes. The bot already holds the recipient list from the inbound message; it reuses it. This keeps the implementation small — most of the trace work is wiring, not new crypto.

## User experience

### Per-surface behaviour

| Surface                             | Non-E2E behaviour                           | E2E behaviour                                                                                                                               | Notes                                                                          |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Send / receive a message            | Plaintext server-side                       | Encrypted client-side, ciphertext on server, decrypt on render                                                                              | Same composer UI with a small padlock indicator                                |
| Sidebar stream preview              | Server-built snippet                        | Client decrypts last message locally to render snippet; falls back to "Encrypted scratchpad" placeholder when locked                        | INV-60 stripping still applies after decrypt                                   |
| Notification body                   | Plaintext snippet in push payload           | Push body says "New message in [stream]"; full content fills in when device unlocks                                                         | Reduces push usefulness for users who triage from the lock screen              |
| **Keyword search (in-stream)**      | Server full-text on `content_markdown`      | **Client-side full-text on decrypted local index**                                                                                          | Works fully. Case-insensitive substring, prefix, exact-phrase all supported.   |
| **Keyword search (workspace-wide)** | Server full-text across all streams         | Server full-text on non-E2E streams + client-side index merged in for E2E streams the device has unlocked                                   | Reduced when device has not unlocked the relevant scratchpad yet               |
| Cmd-F / find in stream              | Client-side over loaded messages            | Same                                                                                                                                        | Identical UX                                                                   |
| Semantic / vector search            | Server vector search                        | **Off** for E2E streams; UI shows "Semantic search isn't available in encrypted scratchpads" inline next to results                         | Embeddings need server-side plaintext                                          |
| Companion mode (server persona)     | Server-side persona auto-reply              | **Off** in Phases 0–4; restored via enclave path in Phase 5                                                                                 | Companion toggle disabled with explainer tooltip                               |
| Memo extraction (GAM)               | Server-side outbox handler                  | **Off**                                                                                                                                     | Possible future: client-side extractor; not in this plan                       |
| Stream naming polish                | Server AI rewrites the auto-name            | **Off**; fallback is first ~40 chars of first message stripped of markdown                                                                  | Acceptable for personal scratchpads                                            |
| Mentions (`@ariadne`, `@kris`)      | Server regex extraction for routing         | Stored as a **structured `clientMentions` field inside the encrypted payload**; autocomplete UI unchanged                                   | The bot resolves mention targets after decrypting                              |
| Reactions                           | Server-stored emoji + user id               | Same — no content involved                                                                                                                  |                                                                                |
| Read receipts, typing, presence     | Metadata                                    | Same                                                                                                                                        |                                                                                |
| Edits                               | Server stores new content + edit history    | Client re-encrypts and replaces; no plaintext edit-history diff stored (INV-E5)                                                             | Edit UI unchanged                                                              |
| Deletes                             | Soft delete on row                          | Ciphertext + envelope cleared, tombstone retained                                                                                           | Stronger than soft delete (no "recover from backup" path)                      |
| Quote / reply context               | Server provides quoted text                 | Client decrypts source and embeds the quoted snippet inside the new message's encrypted payload                                             | Same UX                                                                        |
| Threads                             | Server-projected                            | Threads inherit parent's E2E flag; each reply encrypted independently                                                                       |                                                                                |
| **Message sharing across streams**  | Server forwards into shared-messages stream | **Blocked** for E2E source content; UI offers "Copy as plaintext" instead, with a clear "this leaves the encrypted scratchpad" confirmation | Honest about the boundary; user can still opt out by hand                      |
| Permalinks to a message             | Resolves to message in stream               | Same; the URL is metadata, the content is decrypted on landing                                                                              |                                                                                |
| Attachments                         | S3 SSE, server processors run               | Client-side AES-GCM before upload (Phase 3); server processors **off**                                                                      | Image captioning, PDF text extraction, video transcoding for previews all skip |
| Attachment thumbnail / preview      | Server pre-renders                          | Client renders if format allows (images, PDFs in pdf.js, text); video plays raw without transcoded variants                                 | Reduced for video, full for images and PDFs                                    |
| Voice dictation (raw transcript)    | Browser STT                                 | Same                                                                                                                                        | Works                                                                          |
| Voice dictation polish              | Server-side AI rewrite                      | **Off**; raw transcript only                                                                                                                | Recent feature so worth calling out                                            |
| Pi tool trace UI                    | Sanitized Arguments / Output                | **Full Arguments + Output sections** rendered                                                                                               | Better than non-E2E (see § Agent trace data)                                   |
| Cross-region migration              | Server moves rows                           | Same — ciphertext travels just fine                                                                                                         |                                                                                |
| Saved messages                      | Server-stored reference                     | Same — saved is a pointer, content stays encrypted                                                                                          | Saved-view rendering decrypts on demand                                        |
| Activity feed snippets              | Server-built                                | Client decrypts locally for E2E entries                                                                                                     | Placeholder when locked                                                        |

### Visual treatment — making E2E obvious

E2E status must be visible everywhere the scratchpad surfaces. The bar to clear: a user glancing at the sidebar must not need to click in to know which scratchpads are encrypted.

- **Padlock icon next to the stream name in the sidebar** — same icon used by the privacy indicator elsewhere in the app, but in the active accent colour, not muted. Tooltip: "End-to-end encrypted. Threa servers cannot read this scratchpad."
- **Stream header padlock + label**: `🔒 Encrypted` chip next to the stream name in the header. Click opens the recipients popover.
- **Recipients popover** (off the header chip): lists "Encrypted to:" with each recipient's display name and a 4-group truncated pubkey fingerprint (e.g. `abc1 2345 6789 def0`). The user's own UIK is shown first, then each bot/enclave. This is the surface for out-of-band verification.
- **Subtle background tint on the message list area** — a low-saturation accent (the same family as the unread indicator) on the message list container, just enough that the eye registers it as "different mode" without screaming. No tint on the sidebar or topbar.
- **Composer placeholder text**: `Encrypted message…` instead of the default placeholder. Tiny padlock icon in the composer's send button.
- **Inline "encryption changed" system event** when a bot is added or removed from the recipient list, so the audit trail of who could read what is visible in the stream itself.
- **Locked-state empty placeholder**: if the user has not entered their passphrase this session, the message list shows a centred "Unlock encrypted scratchpad" card with the recipient fingerprint visible (so they can verify before entering the passphrase). Sidebar still shows the lock icon plus a muted "(locked)" suffix.

What we deliberately do **not** do:

- No per-message padlock icon on every bubble. It's the wrong scale; the stream-level chip is enough.
- No colour-shift on the sender's name — that surface already carries semantic meaning (persona vs user vs bot).
- No "secure" word in the UI — vague and overpromising. The word we use is "encrypted".

### Opt-in flow

E2E is opt-in per scratchpad, irreversible once enabled. Two equally fast entry points:

- **Quickswitcher**: a dedicated `New encrypted scratchpad` command sitting next to the existing `New scratchpad` action, with a padlock glyph and a keyboard shortcut. Selecting it creates the scratchpad with the E2E flag already set, opens it focused, and prompts for unlock if the device session is locked. First-time-per-account selection runs the onboarding modal before the scratchpad opens.
- **From an empty scratchpad**: a "Make this end-to-end encrypted" link in the header (only visible while the scratchpad has zero messages).

The Quickswitcher path is the primary one — fast, keyboard-driven, and signals that E2E is a first-class scratchpad mode rather than a hidden toggle.

The flow once an entry point is chosen:

1. First-time-per-account selection → onboarding modal:
   - One paragraph explaining what changes and what doesn't, with the per-surface table linked.
   - Passphrase setup (set + confirm), with the framing "different from your Threa login password" and "if you forget this, the content is unrecoverable, even by us — that is the point".
   - "Got it, enable encryption" primary CTA; cancel button.
2. After setup, the Quickswitcher entry creates straight through with no extra confirm — the explicit command name is itself the confirmation. The header-link path on an empty scratchpad shows a short "Encrypt this scratchpad? This cannot be undone." dialog.
3. Once the first message is sent, the header link disappears.
4. **Existing scratchpads with messages cannot be encrypted.** The header link is only present on empty scratchpads; the Quickswitcher command only ever creates new scratchpads. (Decision pinned at the top of this doc.)

### Locked / unlocked session model

The user's UIK private key is cached in Dexie under a session lock. "Unlocked" means the private key is decrypted and held in memory for this device session.

- **First load on a device**: locked. User clicks any E2E scratchpad → passphrase modal → enter → unlocked for the rest of the session.
- **Re-lock conditions**: user signs out, user explicitly hits "Lock encrypted scratchpads" in the privacy settings, or the device session expires (matches login session lifetime, no extra timer).
- **Browser refresh**: re-prompt for passphrase (Dexie persists the encrypted bundle, not the unwrapped key).
- **Background tab / locked screen**: not re-locked. The session lock is coarse, not paranoid; users who want a paranoid lock can use the explicit menu item.
- **Per-scratchpad re-prompt**: never. Once unlocked, all E2E scratchpads the user owns are readable.

### Sharing and quoting

Sharing is the surface where the E2E boundary is most likely to leak by accident, so the UI is explicit about it.

- **Quote a message inside the same scratchpad**: works normally. The quoted text travels inside the new message's encrypted payload, encrypted to the same recipients.
- **Cross-stream sharing** (the `message-sharing-streams` feature): blocked from E2E source streams. The share button on an E2E message shows "Encrypted messages can't be shared — copy the text manually if you want to share it" with a Copy-as-plaintext button right there. This makes the boundary cross a deliberate user action, not a silent server forward.
- **Permalinks** to an E2E message work; opening the permalink resolves the stream and prompts to unlock if needed.
- **Saved messages**: works — `saved_messages` is just a pointer table, not a content copy. The Saved view decrypts on render.
- **Pinning** in a stream: works — pin is a pointer.

### Search detail

Worth its own subsection because Kris called it out specifically.

- **Keyword search runs client-side for E2E streams.** When the user unlocks an E2E scratchpad, the client decrypts the stream's messages once and builds an inverted index in Dexie keyed by `stream_id`. The index is rebuilt incrementally on new-message events.
- The existing global keyword search UI is extended to **merge** two result sources: server results for non-E2E streams + client-index results for E2E streams the device has unlocked. The merge is transparent to the user; results from both look the same in the result list.
- Streams the user has not yet unlocked are surfaced as a single banner above the results: "3 encrypted scratchpads excluded from this search. Unlock to include." Click → passphrase prompt → rebuild index → re-run search.
- **Semantic / embedding-based search** stays off for E2E. The search input shows a small inline hint when the user toggles "semantic" mode: "Semantic search is not available for encrypted scratchpads. Keyword results from your encrypted scratchpads are still included below."
- Index size: the client-side index is a small text-only index keyed by message id. Even for chatty users this stays in the low MB range and is well within Dexie's quotas.

### Onboarding and education

The hardest UX bit is calibrating expectations: users will lose the passphrase or assume Threa can recover it. The plan:

- One-time setup modal makes "unrecoverable" the loudest sentence.
- A dedicated settings page section ("Encrypted scratchpads") lists the user's UIK fingerprint, all bot recipients across all scratchpads, and a "Reset E2E keys" button with a strong confirmation.
- The Reset action invalidates the user's UIK and is documented as "this makes every existing encrypted scratchpad permanently unreadable on this account."

## Phased delivery

A small phase that ships is much better than a perfect phase that doesn't. Each phase below is independently mergeable and produces user-visible behaviour.

### Phase 0 — Crypto primitives + user key onboarding (no scratchpad changes yet)

- Pick the HPKE library, add to `apps/frontend` and to `apps/backend` (server only needs primitives for tests; the production path never touches private keys server-side).
- Build the **passphrase set-up flow**: a one-time modal "Set up encrypted scratchpads" that generates UIK, derives KEK with Argon2id, stores the encrypted bundle, caches private key in Dexie.
- Backend: `user_e2e_keys` table, `POST /api/v1/users/me/e2e-keys` to store the bundle, `GET` to fetch it.
- Add a Settings page section under AI/Privacy for "Encrypted scratchpads" with the passphrase prompt and a "Reset (destroys access to existing E2E content)" button.

Deliverable: a user can set up keys. Nothing else changes yet.

### Phase 1 — E2E flag + envelope plumbing on a scratchpad (no agent yet)

- `e2e_scratchpads` table, `messages.ciphertext` + `messages.envelope` columns (additive, INV-17).
- New endpoint or extension: `POST /api/v1/streams/:id/messages` accepts `{ ciphertext, envelope, e2eVersion }` when the stream is E2E. Server rejects content fields on E2E streams.
- **Opt-in UI**: `New encrypted scratchpad` command in the Quickswitcher (primary entry point); "Make this end-to-end encrypted" link on empty scratchpads as a secondary path; first-time-per-account onboarding modal; one-click confirm dialog thereafter on the header-link path.
- **Visual treatment**: padlock chip in stream header, padlock + tooltip in sidebar, subtle background tint on the message list area, "Encrypted message…" placeholder in composer, recipients popover (will show just the user's UIK fingerprint until Phase 2).
- **Locked-state empty placeholder** in the message list with "Unlock encrypted scratchpad" CTA + recipient fingerprint visible.
- Sidebar / activity-feed previews fall back to "Encrypted scratchpad" when locked, or decrypt last message client-side when unlocked.
- **Client-side keyword search** for E2E streams: build Dexie-backed inverted index on unlock, merge with server search results in the global search UI, "X encrypted scratchpads excluded" banner for not-yet-unlocked streams. Semantic search hint inline.
- **Cross-stream message sharing** blocked on E2E source messages; UI replaces the share action with "Copy as plaintext".
- INV-E1 enforced at repository layer.
- Outbox handlers updated to skip E2E (INV-E2) — add a helper, audit each handler.
- Frontend can send + receive E2E messages from the **same user across devices** (loopback). Useful for testing without a bot.

Deliverable: I can encrypt a scratchpad, message myself across two browser tabs, keyword-search the result, see the lock indicators everywhere they need to appear, and bounce off the sharing block. Nothing visible to backend except ciphertext.

### Phase 2 — Pi remote integration (messages + traces)

- Extend `bot_runtime_instances` presence: runtime registers a fresh BIK pubkey on each session (already has `runtimeSessionId`).
- Update the Pi remote adapter (`~/.pi/agent/extensions/threa-remote.ts` or its successor in this repo) to:
  - generate BIK on session start, register on presence heartbeat,
  - HPKE.open inbound messages,
  - HPKE.seal outbound responses to `[UIK, BIK]`,
  - HPKE.seal each trace step (full `pi_tool_trace` payload including Arguments + Output sections) to `[UIK, BIK]` and POST as `{ stepType, ciphertext, envelope }` to `/bot-invocations/:id/steps`.
- Backend `recordInvocationStepSchema`: accept the new ciphertext fields, enforce E2E-vs-plaintext exclusivity based on the session's stream flag, bypass `pi_tool_trace` sanitizer when E2E.
- Add `agent_session_steps.ciphertext` + `envelope` + `e2e_version` columns (additive, INV-17).
- UI: when inviting a Pi runtime into a scratchpad, the client adds that bot's BIK pubkey to the scratchpad's recipient list. The scratchpad UI shows "encrypted to you and Pi (key abc12…)". Trace step renderer decrypts envelope before parsing `pi_tool_trace` structure — same code path as today after decrypt.
- Bot key revocation: when a user removes a bot from a scratchpad, future messages no longer include that BIK; historical messages remain decryptable by the bot that still holds the old key (this is the standard E2E reality and we document it).

Deliverable: Pi remote works inside an E2E scratchpad. Threa servers never see prompts, replies, or tool I/O. Full Arguments and Output sections are restored in the trace UI for E2E sessions. The colleague-at-work use case ships and is more useful than the non-E2E version.

### Phase 3 — Attachments E2E

- Client-side encrypt + decrypt around the existing S3 upload/download flow.
- `attachments.e2e_only = true` flag; processors skip.
- Frontend attachment viewer decrypts on the fly.
- Attachment previews in sidebar / notifications show the same "Encrypted" placeholder.

Deliverable: attachments in E2E scratchpads. The Pi-remote-with-files workflow becomes private.

### Phase 4 — Multi-device polish

- Device-add UX: passphrase prompt on new device with friendly framing.
- Optional WebAuthn-bound KEK as a faster alternative to passphrase entry on the same device.
- "Devices" page listing pubkey fingerprints so a paranoid user can verify out-of-band.

### Phase 5 — Ariadne enclave

This is the biggest phase and the one Kris cares about for his wife's use case.

- **First step in Phase 5**: pick the TEE platform. Candidates with rough trade-offs:
  - **AWS Nitro Enclaves** — same cloud as the rest of Threa, mature attestation, separate-AWS-account isolation pattern. AWS-only.
  - **Azure Confidential VMs** — whole-VM confidentiality, simpler mental model. Adds a second cloud.
  - **GCP Confidential Space** — purpose-built for attested workloads talking to external parties. Cleanest "third-party hosted enclave" story if we ever want to step out of AWS.
  - The envelope shape in this plan is portable across all three; the decision drives ops + attestation tooling, not the protocol.
- Build the enclave service:
  - Boot generates EIK.
  - Exposes `GET /attestation` returning Nitro attestation document.
  - `POST /invoke` body = HPKE envelope. Decrypts, calls OpenRouter (or Anthropic API directly) with zero-retention headers, encrypts response back to UIK+EIK, returns.
  - No persistence. No logs of plaintext. Network egress allow-list = LLM providers only.
- Reproducible build pipeline producing an EIF (Enclave Image File) with a known measurement (PCR0/PCR1/PCR2).
- Client verifies attestation document on first contact per session, pins the measurement against a list embedded in the app build.
- Backend forwarder: a thin handler that recognizes Ariadne-targeted invocations and proxies the envelope to the enclave's endpoint. Adds nothing to it; signs nothing.
- Persona declaration: Ariadne (or any persona) carries an `e2e_capable: true` flag; E2E scratchpads can only invite E2E-capable personas.

Deliverable: Ariadne works inside an E2E scratchpad. The "private journaling against an AI" use case ships.

### Phase 6 — Hardening (out of v1)

- Double-ratchet for forward + post-compromise security.
- Padding scheme to flatten message-size leak.
- Social recovery (M-of-N trusted contacts) or hardware-key recovery.
- Group E2E for shared channels / DMs.

## Open questions still to resolve

The big architectural forks are decided above ("Decisions taken"). These remain:

1. **E2E representation in the schema.** Per-scratchpad flag in `e2e_scratchpads` + additive message columns (current default), versus a separate stream type `e2e_scratchpad`. Flag is easier to roll out and lets us share UI surfaces; separate type makes it impossible for a server-side code path to accidentally treat E2E content as plaintext. Decide before Phase 1 lands.
2. **LLM provider for Ariadne E2E.** Keep OpenRouter (default) but restrict to providers offering zero-retention enterprise tiers, versus go direct to Anthropic (simpler attestation story, narrower model selection). Decide at Phase 5 kickoff alongside enclave platform.
3. **Forward secrecy posture.** v1 plan uses per-message random keys wrapped to long-lived identity keys (good FS for content, no PCS). A Signal-style double-ratchet adds PCS but is multiple-PR work and isn't on the Phase 0–5 critical path. Revisit at Phase 6 unless an early adopter explicitly asks for it.
