import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { JSONContent, StreamEvent } from "@threa/types"
import {
  getCachedDecryption,
  requestDecryption,
  subscribeToDecryption,
  type DecryptCacheEntry,
} from "@/lib/crypto/decrypt-cache"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useStreamFromStore } from "@/stores/stream-store"
import type { AttachmentRef } from "@/lib/crypto/attachment-crypto"

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
  | { status: "decrypted"; contentMarkdown: string; contentJson: JSONContent; attachmentRefs: AttachmentRef[] }
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
  // A thread shares its root scratchpad's SSK and carries no wraps of its own,
  // so the key must be resolved against the root (the wrap AAD is bound to the
  // root id). The thread row is in IDB once it's been opened; null root means a
  // top-level stream, which is its own root.
  const rootStreamId = useStreamFromStore(event.streamId)?.rootStreamId ?? undefined

  const cached = useSyncExternalStore<DecryptCacheEntry | undefined>(
    (listener) => subscribeToDecryption(eventId, listener),
    () => getCachedDecryption(eventId),
    () => undefined
  )

  // Memoize so useEffect deps don't churn on every render — a fresh wrapper
  // object every render would re-fire the effect even though nothing changed.
  const envelopePayload = useMemo(() => readEnvelopePayload(event), [event])
  const canDecrypt = !!envelopePayload && session.status === "unlocked" && !!session.privateKey && !!session.keyId
  const needsDecrypt = canDecrypt && (cached === undefined || cached.status === "pending")

  useEffect(() => {
    if (!needsDecrypt || !envelopePayload || !session.privateKey || !session.keyId) return
    void requestDecryption(
      eventId,
      {
        contentMarkdown: envelopePayload.contentMarkdown ?? "",
        envelope: envelopePayload.envelope,
        ciphertext: envelopePayload.ciphertext,
      },
      {
        privateKey: session.privateKey,
        recipientKeyId: session.keyId,
        workspaceId,
        streamId: event.streamId,
        rootStreamId,
      }
    )
  }, [
    needsDecrypt,
    envelopePayload,
    session.privateKey,
    session.keyId,
    eventId,
    workspaceId,
    event.streamId,
    rootStreamId,
  ])

  if (!envelopePayload) {
    const payload = event.payload as { contentMarkdown?: unknown; contentJson?: unknown } | undefined
    return {
      status: "plaintext",
      contentMarkdown: typeof payload?.contentMarkdown === "string" ? payload.contentMarkdown : "",
      contentJson: payload?.contentJson as JSONContent | undefined,
    }
  }

  if (!canDecrypt) return { status: "locked" }
  if (cached?.status === "decrypted" && cached.content) {
    return {
      status: "decrypted",
      contentMarkdown: cached.content.contentMarkdown,
      contentJson: cached.content.contentJson,
      attachmentRefs: cached.content.attachmentRefs ?? [],
    }
  }
  if (cached?.status === "failed") return { status: "failed" }
  return { status: "pending" }
}
