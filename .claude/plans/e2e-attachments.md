# E2E-encrypted attachments (Phase 3)

## Why

Attachments in an E2E scratchpad must be as opaque to Threa-as-operator as the
messages are. The file bytes are AES-GCM-encrypted **client-side** under a
fresh per-attachment key; only ciphertext reaches S3. The per-attachment key +
IV + the real filename/mime/size ride **inside the SSK-sealed message payload**
(`attachmentRefs`), so the server never holds key material or true metadata —
only opaque bytes, a flag, and routing columns.

## Non-negotiable (threat model)

- **No key material on the server. Ever.** No `key`/`iv` column, no key table.
  The per-attachment key lives only inside the encrypted message payload. (This
  rules out the "store key BYTEA server-side" shortcut — it would collapse the
  entire model.)
- **Minimize plaintext metadata.** E2E attachment rows store *placeholder*
  filename (`"encrypted"`) and mime (`application/octet-stream`); `size_bytes` is
  the ciphertext length (unavoidable — it's the S3 object size). The real
  filename/mime/size travel encrypted in `attachmentRefs` and are revealed only
  client-side.
- **Server can't scan ciphertext, and says so.** E2E uploads skip the malware
  scan and all processors; `safety_status = 'e2e_unscanned'` is an honest new
  status (not a faked `clean`).

## attachmentRefs (the payload contract, set by Slice B)

Inside the SSK-sealed message `payload` JSON (already carries contentJson /
contentMarkdown):

```json
"attachmentRefs": [
  { "attachmentId": "attach_…", "key": "base64-32B", "iv": "base64-12B",
    "filename": "Q3.xlsx", "mimeType": "application/…", "sizeBytes": 12345 }
]
```

`key`/`iv` decrypt the S3 ciphertext; `filename`/`mimeType`/`sizeBytes` are the
real values the placeholder row hides. The server stores this blob as opaque
ciphertext, exactly as it stores message content.

---

## Slice A — backend foundation (this slice)

Pure backend; defaults keep every existing (non-E2E) upload byte-identical.

### `packages/types`
- `ATTACHMENT_SAFETY_STATUSES` += `"e2e_unscanned"`; add
  `AttachmentSafetyStatuses.E2E_UNSCANNED`.
- `Attachment` domain type += `e2eOnly: boolean`.

### Migration (`…_attachment_e2e_only.sql`, additive INV-17)
```sql
ALTER TABLE attachments
  ADD COLUMN e2e_only BOOLEAN NOT NULL DEFAULT FALSE;
```
No key/iv columns — by design.

### Safety policy (`upload-safety-policy.ts`)
- `isAttachmentSafeForSharing`: also true for `e2e_unscanned` (download allowed —
  the bytes are the owner's own ciphertext).
- `safetyStatusBlockReason`: add the `e2e_unscanned` case → `""` (no block). The
  exhaustive switch forces us to handle it (good).

### Service / handler (`service.ts`, `handlers.ts`, `repository.ts`, public API)
- **Both upload entry points carry E2E** — the first-party `/attachments`
  handler AND the public-api `POST /api/v1/workspaces/:id/attachments` (the path
  the Pi remote and CLI agents like claws use). They share one chokepoint:
  - `parseE2eUploadFlag(req.body)` reads the multipart `e2e` flag (string).
  - `buildUploadParams(file, e2e)` is the single place the threat-model rule
    "E2E ⇒ the server keeps no real filename/mime" lives, so the two handlers
    can't drift. A security property must not be copy-pasted.
  - The public-API OpenAPI multipart body documents the optional `e2e` field
    (regenerated spec, checked in CI).
- When `e2e` is set:
  - **Server forces placeholders** — `filename = "encrypted"`,
    `mimeType = "application/octet-stream"` (don't trust/keep the client's real
    name even if sent; minimize by construction).
  - `create` takes `e2e: boolean`. The E2E branch:
    - skips `malwareScanner.scan` entirely,
    - inserts `e2e_only = true`, `safety_status = 'e2e_unscanned'`,
      `processing_status = 'skipped'`,
    - emits **no** `attachment:uploaded` outbox event (no caption / pdf / excel /
      word / video / text / embedding work — all would choke on ciphertext).
  - Non-E2E path is untouched (same scan → clean → emit flow).
- `AttachmentRepository.insert` += `e2eOnly` param; `mapRow` reads the column.

### Why client-asserted `e2e` at upload is safe
Attachments are workspace-level at upload (no stream yet), so there's nothing to
validate against. A client lying `e2e=true` on a plaintext file only gets an
unscanned, unprocessed, placeholder-named attachment — strictly worse for them,
not an escalation. (Solo/owner-only scratchpads today mean no cross-user serving
of an unscanned blob; if multi-reader E2E ships, harden by refusing cross-user
download of `e2e_unscanned`. Noted, not built — INV-36.)

### Send-path gate (`messaging/event-service.ts`)
Creating/editing a message validates each attachment is shareable. Both gates
now call `isAttachmentSafeForSharing` (clean ∪ e2e_unscanned) instead of an
inline `=== CLEAN`, so an E2E attachment can bind to its message.

### Tests
- safety-policy: `e2e_unscanned` is shareable + no block reason.
- service: E2E upload skips scan, emits no outbox event, persists
  `e2e_only/processing=skipped/safety=e2e_unscanned`, stores placeholder
  filename/mime; non-E2E unchanged (scan runs, event emitted).
- `buildUploadParams` / `parseE2eUploadFlag`: the shared chokepoint forces
  placeholders for E2E and keeps real metadata otherwise (one proof covers both
  the first-party and public-API handlers).
- repository: `e2e_only` round-trips snake↔camel.

---

## Slice B — frontend crypto + viewer (next slice, NOT here)
- `packages/crypto`: `encryptBytes`/`decryptBytes` (raw-bytes AES-GCM, distinct
  from message AAD binding) if `sealMessage` isn't a clean fit for file bytes.
- Upload: in an E2E stream, gen key+iv, encrypt bytes, PUT ciphertext via the
  existing presigned flow with `e2e=true`; stash `{key,iv,filename,mime,size}`
  for the send.
- Send: serialize `attachmentRefs` into the SSK-sealed payload.
- Viewer (`attachment-list.tsx`): for `e2e_only` attachments, read the ref from
  the decrypted message, fetch ciphertext, decrypt in-browser, render (images,
  pdf.js, text; video plays raw). Previews/sidebar/notifications show the
  "Encrypted" placeholder (INV-60 strip already covers text).

## Slice C — Pi-remote-with-files (later)
Enclave/Pi produces/consumes `attachmentRefs` so an agent can attach or read an
encrypted file. Out of scope until A+B land.
