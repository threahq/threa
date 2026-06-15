import { useEffect, useMemo, useSyncExternalStore } from "react"
import { getCachedDecryption, getDecryptCacheVersion, subscribeDecryptCacheVersion } from "@/lib/crypto/decrypt-cache"
import { useE2eSession } from "@/stores/e2e-session-store"
import type { CachedDraft } from "@/db"
import {
  draftDecryptionToPreview,
  isE2eUnlocked,
  requestDraftDecryption,
  resolveDraftDecryption,
  type DraftPreview,
} from "@/lib/drafts/decryption"
import { useCurrentWorkspaceUserId } from "./use-current-workspace-user-id"

export type { DraftPreview, DraftPreviewStatus } from "@/lib/drafts/decryption"

export interface DraftPreviewInput {
  draft: CachedDraft
  /** Encrypted root whose SSK seals the body; null/undefined for a plaintext draft. */
  rootStreamId: string | null | undefined
}

/**
 * Decrypt-on-read previews for a LIST of drafts (the stash picker, the /drafts
 * explorer). Components rendering many rows can't call the per-row
 * `useDecryptedDraftContent` in a loop, so this batches: it watches the cache's
 * global version, reads each id via the shared decrypt core, and fires a decrypt
 * for any sealed row that's missing one. Plaintext lives in memory only (E2EE-4).
 */
export function useDecryptedDraftPreviews(workspaceId: string, inputs: DraftPreviewInput[]): Map<string, DraftPreview> {
  const userId = useCurrentWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const unlocked = isE2eUnlocked(session)

  // Re-render on any decrypt-cache change so previews fill in as bodies decrypt.
  const cacheVersion = useSyncExternalStore(
    subscribeDecryptCacheVersion,
    getDecryptCacheVersion,
    getDecryptCacheVersion
  )

  useEffect(() => {
    const keys = { privateKey: session.privateKey, recipientKeyId: session.keyId }
    for (const { draft, rootStreamId } of inputs) requestDraftDecryption(draft, keys, workspaceId, rootStreamId)
  }, [inputs, session.privateKey, session.keyId, workspaceId])

  return useMemo(() => {
    const map = new Map<string, DraftPreview>()
    for (const { draft } of inputs) {
      map.set(
        draft.id,
        draftDecryptionToPreview(resolveDraftDecryption(draft, unlocked, getCachedDecryption(draft.id)))
      )
    }
    return map
    // `cacheVersion` is the read-trigger: getCachedDecryption is read fresh when it bumps.
  }, [inputs, unlocked, cacheVersion])
}
