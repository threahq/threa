import { useEffect, useSyncExternalStore } from "react"
import { getCachedDecryption, subscribeToDecryption, type DecryptCacheEntry } from "@/lib/crypto/decrypt-cache"
import { useE2eSession } from "@/stores/e2e-session-store"
import type { CachedDraft } from "@/db"
import {
  isE2eUnlocked,
  requestDraftDecryption,
  resolveDraftDecryption,
  type DraftDecryption,
} from "@/lib/drafts/decryption"
import { useCurrentWorkspaceUserId } from "./use-current-workspace-user-id"

/**
 * Decrypt-on-read for the ONE draft loaded into the composer, following the same
 * shared `decrypt-cache` messages use. Branches on `ciphertext`: a plaintext draft
 * renders `contentJson` directly; a sealed draft decrypts in memory (IDB holds only
 * ciphertext — E2EE-4), dropped on lock and re-decrypted on unlock (cache miss →
 * re-request). A failed decrypt is `failed`, not a permanent spinner.
 *
 * Subscribes per-id (not the global cache version) so the composer — a hot path —
 * only re-renders when THIS draft's body changes. `rootStreamId` is the encrypted
 * root whose SSK wraps the body (a thread passes its root); decrypt holds at
 * `pending` until it is known so we never poison the cache against an unknown root.
 */
export function useDecryptedDraftContent(
  workspaceId: string,
  draft: CachedDraft | undefined,
  rootStreamId: string | null | undefined
): DraftDecryption {
  const userId = useCurrentWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const draftId = draft?.id

  const cached = useSyncExternalStore<DecryptCacheEntry | undefined>(
    (listener) => (draftId ? subscribeToDecryption(draftId, listener) : () => {}),
    () => (draftId ? getCachedDecryption(draftId) : undefined),
    () => undefined
  )

  useEffect(() => {
    if (draft) {
      requestDraftDecryption(
        draft,
        { privateKey: session.privateKey, recipientKeyId: session.keyId },
        workspaceId,
        rootStreamId
      )
    }
  }, [draft, session.privateKey, session.keyId, workspaceId, rootStreamId])

  return resolveDraftDecryption(draft, isE2eUnlocked(session), cached)
}
