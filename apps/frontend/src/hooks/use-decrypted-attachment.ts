import { useEffect, useMemo, useSyncExternalStore } from "react"
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
 *
 * No session gate: an `AttachmentRef` only exists once the message it rode in has
 * decrypted (its per-file key/iv are sealed in the SSK payload), so the caller —
 * `E2eAttachmentList`, rendered only while `useDecryptedMessageContent` is
 * `decrypted` — already holds an unlocked session, and a lock unmounts this hook
 * (the parent stops passing `attachmentRefs`). The decrypt here uses the ref's own
 * key, not the SSK, so it needs no `resolveDecryptContext` root/hydration gate.
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
    // Deps are the primitives that key/gate the request, not the per-render `ref`
    // object — a given attachment id's ref content (key/iv/mime) is immutable, so
    // depending on the object would only add identity churn (mirrors the
    // primitive-field deps in `useDecryptedMessageContent`).
  }, [attachmentId, workspaceId, status])

  const blob = cached?.status === "decrypted" ? cached.value : null
  // Derive the URL synchronously from the cached blob so a cache-hit re-mount
  // (scroll away and back) paints the image on the first render, rather than
  // flashing the pending spinner for the one commit a `useState` url would lag
  // the blob that arrives synchronously from `useSyncExternalStore`. The effect
  // owns revocation: its cleanup runs on unmount and whenever `url` changes (a new
  // blob, or null when the cache clears on lock), so a blob never outlives the
  // component or the lock.
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob])
  useEffect(() => {
    if (!url) return
    return () => URL.revokeObjectURL(url)
  }, [url])

  if (cached?.status === "failed") return { status: "failed" }
  if (url) return { status: "ready", url }
  return { status: "pending" }
}
