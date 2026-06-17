import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { JSONContent, StreamEvent } from "@threa/types"
import {
  getCachedDecryption,
  requestDecryption,
  subscribeToDecryption,
  type DecryptCacheEntry,
} from "@/lib/crypto/decrypt-cache"
import { resolveDecryptContext } from "@/lib/crypto/decrypt-context"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useStreamFromStore } from "@/stores/stream-store"
import type { AttachmentRef } from "@/lib/crypto/attachment-crypto"
import type { SealedSourceItem } from "@threa/crypto"

/**
 * Render-time decryption hook for E2E `message_created` events.
 *
 * Phase 3.5 keeps ciphertext + envelope on `db.events.payload` and decrypts
 * only in memory. This hook is the single read path: callers get back the
 * effective content to render, plus a status discriminator so locked /
 * decrypting / failed states can show distinct UI.
 *
 *  - `plaintext`  — event has no envelope; payload is plaintext on the wire.
 *  - `locked`     — payload has an envelope but the session isn't unlocked.
 *  - `pending`    — unlocked, decrypt in flight (cache miss on first paint).
 *  - `decrypted`  — unlocked, decrypt succeeded; render the returned content.
 *  - `failed`     — decrypt threw (wrong recipient, tampered AAD, etc.).
 *
 * Subscribes to both the per-event cache entry and the workspace-scoped
 * session state, so the component re-renders when a decrypt resolves or the
 * user unlocks.
 */

export type DecryptedMessageContent =
  | { status: "plaintext"; contentMarkdown: string; contentJson: JSONContent | undefined }
  | { status: "locked" }
  | { status: "pending" }
  | {
      status: "decrypted"
      contentMarkdown: string
      contentJson: JSONContent
      attachmentRefs: AttachmentRef[]
      /** Citation sources sealed in the payload (agent replies) — E2EE-9. */
      sources: SealedSourceItem[]
    }
  | { status: "failed" }

interface EnvelopePayload {
  ciphertext: string
  envelope: unknown
  contentMarkdown?: string
  contentJson?: JSONContent
}

function readEnvelopePayload(event: StreamEvent): EnvelopePayload | null {
  if (event.eventType !== "message_created") return null
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.ciphertext !== "string" || !payload.envelope) return null
  return {
    ciphertext: payload.ciphertext,
    envelope: payload.envelope,
    contentMarkdown: typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : undefined,
    contentJson: payload.contentJson as JSONContent | undefined,
  }
}

export function useDecryptedMessageContent(
  event: StreamEvent,
  workspaceId: string,
  userId: string | null
): DecryptedMessageContent {
  const session = useE2eSession(workspaceId, userId ?? "")
  const eventId = event.id
  // The session + root-SSK resolution and the "hold until the stream row hydrates"
  // guard (a doomed thread-id decrypt poisons the cache forever) live in
  // `resolveDecryptContext` — see it for why an unhydrated row must hold.
  const stream = useStreamFromStore(event.streamId)
  const ctx = resolveDecryptContext(workspaceId, event.streamId, session, stream)
  const opts = ctx.ready ? ctx.opts : null

  const cached = useSyncExternalStore<DecryptCacheEntry | undefined>(
    (listener) => subscribeToDecryption(eventId, listener),
    () => getCachedDecryption(eventId),
    () => undefined
  )

  // Memoize so useEffect deps don't churn on every render — a fresh wrapper
  // object every render would re-fire the effect even though nothing changed.
  const envelopePayload = useMemo(() => readEnvelopePayload(event), [event])
  const needsDecrypt = !!envelopePayload && opts !== null && (cached === undefined || cached.status === "pending")

  useEffect(() => {
    if (!needsDecrypt || !envelopePayload || !opts) return
    void requestDecryption(
      eventId,
      {
        contentMarkdown: envelopePayload.contentMarkdown ?? "",
        envelope: envelopePayload.envelope,
        ciphertext: envelopePayload.ciphertext,
      },
      opts
    )
    // Depend on the opts fields (primitives) rather than the per-render opts object
    // so an unrelated stream-row update doesn't re-fire a settled decrypt.
  }, [
    needsDecrypt,
    envelopePayload,
    opts?.privateKey,
    opts?.recipientKeyId,
    opts?.workspaceId,
    opts?.streamId,
    opts?.rootStreamId,
    eventId,
  ])

  if (!envelopePayload) {
    const payload = event.payload as { contentMarkdown?: unknown; contentJson?: unknown } | undefined
    return {
      status: "plaintext",
      contentMarkdown: typeof payload?.contentMarkdown === "string" ? payload.contentMarkdown : "",
      contentJson: payload?.contentJson as JSONContent | undefined,
    }
  }

  // `locked` is specifically "session not unlocked". When the session is
  // unlocked but the stream row hasn't hydrated (root still unknown), fall
  // through to `pending` — the decrypt fires once the row lands and `rootStreamId`
  // is trustworthy, never against the bare thread id.
  if (!ctx.ready && ctx.reason === "locked") return { status: "locked" }
  if (cached?.status === "decrypted" && cached.content) {
    return {
      status: "decrypted",
      contentMarkdown: cached.content.contentMarkdown,
      contentJson: cached.content.contentJson,
      attachmentRefs: cached.content.attachmentRefs ?? [],
      sources: cached.content.sources ?? [],
    }
  }
  if (cached?.status === "failed") return { status: "failed" }
  return { status: "pending" }
}
