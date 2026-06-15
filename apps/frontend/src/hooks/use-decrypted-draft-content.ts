import { useEffect, useSyncExternalStore } from "react"
import type { JSONContent } from "@threa/types"
import {
  getCachedDecryption,
  requestDecryption,
  subscribeToDecryption,
  type DecryptCacheEntry,
} from "@/lib/crypto/decrypt-cache"
import { useE2eSession } from "@/stores/e2e-session-store"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import type { CachedDraft } from "@/db"
import { useCurrentWorkspaceUserId } from "./use-current-workspace-user-id"

/**
 * Decrypt-on-read for a draft, following the same path messages use
 * (`useDecryptedMessageContent`): one entity carries either plaintext
 * (`contentJson`) or the `ciphertext`/`envelope` sibling shape, and this hook
 * branches on `ciphertext` and decrypts through the shared `decrypt-cache`.
 *
 * Reusing that cache is what makes E2E drafts behave: the plaintext lives in
 * memory only (IDB holds ciphertext, treated like the backend — E2EE-4), it is
 * dropped on lock (the cache is cleared by `lock()`), and it is re-decrypted on
 * the next unlock (cache miss → re-request). A failed decrypt is a `failed`
 * status, not a permanent spinner.
 *
 * Statuses mirror the message hook:
 *  - `none`      — no draft loaded.
 *  - `plaintext` — a non-E2E draft; render `contentJson` directly.
 *  - `locked`    — E2E draft but the session isn't unlocked.
 *  - `pending`   — unlocked, decrypt in flight (or the root isn't known yet).
 *  - `decrypted` — unlocked, decrypt succeeded; render the returned content.
 *  - `failed`    — decrypt threw (wrong recipient, tampered/garbled payload).
 *
 * `rootStreamId` is the encrypted stream whose SSK wraps the body (a thread
 * passes its root). Like the message hook gating on stream hydration, decrypt
 * holds at `pending` until it is known, so we never decrypt against an unknown
 * root and poison the cache with a permanent failure.
 */
export type DecryptedDraftContent =
  | { status: "none" }
  | { status: "plaintext"; contentJson: JSONContent }
  | { status: "locked" }
  | { status: "pending" }
  | { status: "decrypted"; contentJson: JSONContent }
  | { status: "failed" }

export function useDecryptedDraftContent(
  workspaceId: string,
  draft: CachedDraft | undefined,
  rootStreamId: string | null | undefined
): DecryptedDraftContent {
  const userId = useCurrentWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")

  const draftId = draft?.id
  const ciphertext = draft?.ciphertext
  const envelope = draft?.envelope

  const cached = useSyncExternalStore<DecryptCacheEntry | undefined>(
    (listener) => (draftId ? subscribeToDecryption(draftId, listener) : () => {}),
    () => (draftId ? getCachedDecryption(draftId) : undefined),
    () => undefined
  )

  const sessionUnlocked = session.status === "unlocked" && !!session.privateKey && !!session.keyId
  const canDecrypt = !!draftId && !!ciphertext && !!rootStreamId && sessionUnlocked
  const needsDecrypt = canDecrypt && (cached === undefined || cached.status === "pending")

  useEffect(() => {
    if (!needsDecrypt || !draftId || !ciphertext || !rootStreamId || !session.privateKey || !session.keyId) return
    void requestDecryption(
      draftId,
      { contentMarkdown: "", ciphertext, envelope },
      {
        privateKey: session.privateKey,
        recipientKeyId: session.keyId,
        workspaceId,
        streamId: rootStreamId,
        rootStreamId,
      }
    )
  }, [needsDecrypt, draftId, ciphertext, envelope, rootStreamId, session.privateKey, session.keyId, workspaceId])

  if (!draft) return { status: "none" }
  if (!ciphertext) return { status: "plaintext", contentJson: draft.contentJson ?? EMPTY_DOC }
  if (!sessionUnlocked) return { status: "locked" }
  if (cached?.status === "decrypted" && cached.content) {
    return { status: "decrypted", contentJson: cached.content.contentJson }
  }
  if (cached?.status === "failed") return { status: "failed" }
  return { status: "pending" }
}
