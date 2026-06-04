---
title: End-to-End Encrypted Scratchpads
status: building
audience: public
since: 2026-05
surfaces: [scratchpads, sidebar, stream-header, composer, timeline, ai-trace]
public_site: false
summary: >
  Personal scratchpads where message content and the AI's working trace are
  readable only on your unlocked devices — the server stores ciphertext it
  cannot decrypt, and the Ariadne assistant runs in a separate enclave that
  decrypts only in memory.
related: [architecture/e2e-enclave.md]
---

## What it does

An end-to-end encrypted (E2E) scratchpad is a normal scratchpad whose message
**content** is encrypted on your device before it reaches the server. The server
persists and relays ciphertext it cannot read; plaintext exists only inside an
unlocked browser tab and, when you invoke the AI, briefly inside an isolated
**enclave** process that holds no database credentials and never logs payloads.

Encryption is **opt-in per scratchpad**. You create one from the sidebar's New
menu ("Encrypted Scratchpad"). Existing plaintext streams and other users are
completely unaffected — there is no workspace-wide switch, and the encrypted and
unencrypted paths share the same stream UI.

The key model, in plain terms:

- A per-user **identity key** is generated once and protected by a passphrase
  (Argon2id derives a key-encryption key; the wrapped private key is stored
  server-side, useless without the passphrase).
- Each encrypted stream has a **per-stream symmetric key (SSK)** that actually
  seals the messages. The SSK is HPKE-wrapped to each participant's identity key,
  so only invited identities can open it. Inviting or removing a participant
  rolls the key generation forward; history stays sealed under the old generation.
- The built-in **Ariadne** assistant participates as its own encrypted recipient:
  when invited, the SSK is wrapped to the enclave's **instance key** (a fresh
  keypair each enclave boot, private half memory-only); the enclave unwraps it in
  memory, runs the same agent loop the rest of the app uses, and seals each reply
  (and each AI trace step) back under the SSK. When the enclave restarts (every
  deploy), its new instance key has no wrap yet — the turn **parks** on the
  queue's retry backoff instead of dropping, and the owner's unlocked client
  silently re-wraps the current SSK to the new key (on viewing the stream and on
  every send), at which point the parked turn proceeds. No prompt, no dialog —
  the heal is invisible.

## How a user experiences it

- **Creating one.** Sidebar → New → "Encrypted Scratchpad". The first time, you
  set a passphrase (the setup modal); after that, new encrypted scratchpads reuse
  your identity key.
- **The lock is the signal.** Encrypted scratchpads carry a lock badge in the
  sidebar and an **"Encrypted"** pill in the stream header (where a normal
  scratchpad shows its companion-mode toggle). Companion mode is locked off for
  encrypted streams — the enclave path replaces it.
- **Locked vs. unlocked.** On a fresh device or after locking, the stream is
  _locked_: the timeline and composer are replaced by a single full-page unlock
  view (with the header keeping its inline **Unlock** affordance too), so you never
  scroll a wall of locked placeholders. Unlocking is in-place — a passphrase modal,
  no detour through Settings. "Keep me unlocked on this device" persists a
  non-extractable key locally so you skip the passphrase on the next load on that
  device.
- **Talking to Ariadne.** Once unlocked, you chat exactly as in a normal
  scratchpad. Ariadne's replies stream in, and its **AI trace** (context, tool
  calls, research substeps) is visible in the trace modal — all of it decrypted
  client-side from ciphertext the server only relayed. Ariadne can do web research
  and read URLs; you can press **Stop research** to end a long research step early
  and still get a reply from partial findings.

## Boundaries

This feature is `building`. What it deliberately does **not** do yet — the
known-missing tally, kept current as gaps close:

- **Stream names keep a server-visible plaintext copy.** Renaming an encrypted
  scratchpad now also seals the name under the stream key (a tamper-evident copy
  the app prefers once unlocked), but a plaintext `displayName` is still stored so
  the name shows everywhere even while locked — which means the server can still
  see titles. This is a deliberate trade for display continuity, not full title
  privacy. Server-side AI name polish stays disabled for encrypted streams.
- **PIN is a device convenience, not a recovery method.** You can set a 6-digit
  quick-unlock PIN per trusted device (Signal / Messenger style) to reopen without
  retyping the full passphrase; the PIN never leaves the device and only guards the
  locally-stored key, with a lockout that falls back to the passphrase after a few
  wrong tries. The passphrase remains the only recovery root — there's no PIN-based
  account recovery, by design.
- **Biometric unlock is bound to the device authenticator.** You can set up
  fingerprint/face unlock (WebAuthn PRF): the local key is wrapped under a secret
  only your device's authenticator can reproduce, so a reload prompts for the
  biometric. It needs a PRF-capable passkey/authenticator; where that's
  unavailable the passphrase (and PIN) paths still work, and the passphrase
  remains the recovery root.
- **Attachments are end-to-end encrypted both ways.** When you attach a file in an
  encrypted scratchpad it's encrypted on your device before upload — the server
  stores opaque bytes and a placeholder row, and the per-attachment key + real
  filename/mime/size ride sealed inside the message payload. The timeline decrypts
  on view: images preview inline and other files decrypt on click, using the
  per-file key recovered from the message — never the server's placeholder row.
  **Ariadne reads them too:** the backend relays the opaque ciphertext to the
  enclave (which can't reach S3), the enclave decrypts in memory with the sealed
  per-file key, and feeds images/PDFs straight to the (vision-capable) model — so
  asking Ariadne about an attached PDF or screenshot works, the same as a plaintext
  scratchpad. Today this covers the attachments on the message you send (not files
  shared several turns earlier). Server-side processing (image captioning, PDF text,
  transcoding) stays off by design — the *server* still can't read the content.
- **Interjections are picked up after the current turn, not folded into it.** If you
  send a message while Ariadne is mid-turn, it isn't ignored: when the running turn
  finishes, a follow-up turn automatically runs for the message(s) that arrived
  during it — the same finish-then-catch-up behavior the non-encrypted Ariadne uses.
  What's still missing is *mid-turn* adaptation (folding the new message into the
  in-flight turn) and edit-to-reconsider. The mid-turn control today is the graceful
  "Stop research" abort.
- **Ariadne is web-only in the enclave.** Inside an encrypted stream, Ariadne has
  web research and URL reading; it cannot reach workspace tools (GAM memory,
  reading other streams) because that would require plaintext egress from the
  enclave.
- **Content-reading server features are off by design.** Semantic search, GAM
  memo extraction, notification/preview snippets, and dictation polish do not run
  for encrypted streams — the server can't read the content. Client-side keyword
  search over already-decrypted content still works.

## Related

- [E2E Enclave](../architecture/e2e-enclave.md) — how the enclave, dispatch, trace
  mirroring, and deploy shape actually work.
