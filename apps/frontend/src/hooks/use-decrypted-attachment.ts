import { useEffect, useState, useSyncExternalStore } from "react"
import { attachmentsApi } from "@/api"
import { decryptAttachmentBytes, type AttachmentRef } from "@/lib/crypto/attachment-crypto"
import {
  getCachedAttachmentBytes,
  requestAttachmentBytes,
  subscribeToAttachmentBytes,
  type AttachmentBytesEntry,
} from "@/lib/crypto/attachment-cache"

/**
 * Render-time read of an E2E attachment's decrypted bytes, mirroring
 * `useDecryptedMessageContent`: the heavy fetch + decrypt runs once and the
 * resulting `Blob` is held in the shared {@link requestAttachmentBytes} cache, so
 * re-mounting a previously-decrypted attachment (scroll, tab switch) is free
 * instead of refetching + redecrypting every time.
 *
 *  - `pending`  — bytes not yet decrypted (cache miss / decrypt in flight).
 *  - `ready`    — decrypted; render from the `url` (a fresh object URL this hook owns).
 *  - `failed`   — fetch or decrypt failed; the caller falls back to a download chip.
 *
 * The object URL is created here (not cached) and revoked on unmount or when the
 * underlying blob changes, so plaintext bytes can't outlive the component — the
 * cache itself drops the blob on lock via `clearAllDecrypted`.
 */
export type DecryptedAttachment = { status: "pending" } | { status: "ready"; url: string } | { status: "failed" }

/** Fetch an E2E attachment's opaque ciphertext and decrypt it with the ref's key/iv. */
export async function fetchAndDecryptAttachment(workspaceId: string, ref: AttachmentRef): Promise<Blob> {
  const url = await attachmentsApi.getDownloadUrl(workspaceId, ref.attachmentId, { variant: "raw" })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Attachment fetch failed (${res.status})`)
  const ciphertext = new Uint8Array(await res.arrayBuffer())
  const plaintext = await decryptAttachmentBytes({ ciphertext, key: ref.key, iv: ref.iv })
  return new Blob([plaintext], { type: ref.mimeType })
}

export function useDecryptedAttachment(workspaceId: string, ref: AttachmentRef): DecryptedAttachment {
  const attachmentId = ref.attachmentId

  const cached = useSyncExternalStore<AttachmentBytesEntry | undefined>(
    (listener) => subscribeToAttachmentBytes(attachmentId, listener),
    () => getCachedAttachmentBytes(attachmentId),
    () => undefined
  )

  const status = cached?.status
  useEffect(() => {
    if (status === undefined || status === "pending") {
      void requestAttachmentBytes(attachmentId, () => fetchAndDecryptAttachment(workspaceId, ref))
    }
    // A given attachment id's ref content is immutable, so the ref object's identity
    // is not a dep — `status` re-fires the request only when it could need one.
  }, [attachmentId, workspaceId, status, ref])

  const blob = cached?.status === "decrypted" ? cached.value : null
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])

  if (cached?.status === "failed") return { status: "failed" }
  if (blob && url) return { status: "ready", url }
  return { status: "pending" }
}
