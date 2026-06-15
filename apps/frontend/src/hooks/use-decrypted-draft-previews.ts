import { useEffect, useMemo, useSyncExternalStore } from "react"
import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import {
  getCachedDecryption,
  getDecryptCacheVersion,
  requestDecryption,
  subscribeDecryptCacheVersion,
} from "@/lib/crypto/decrypt-cache"
import { useE2eSession } from "@/stores/e2e-session-store"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { stripMarkdownToInline } from "@/lib/markdown"
import type { CachedDraft } from "@/db"
import { useCurrentWorkspaceUserId } from "./use-current-workspace-user-id"

/**
 * Decrypt-on-read previews for a LIST of drafts, following the same shared
 * `decrypt-cache` the composer and message timeline use. Components that render
 * many draft rows at once (the stash picker, the /drafts explorer) can't call the
 * per-row `useDecryptedDraftContent` hook in a loop, so this hook batches: it
 * watches the cache's global version, reads each id's plaintext when present, and
 * fires a decrypt for any E2E row that's missing one (unlocked + root known).
 *
 * The plaintext never leaves memory — IDB holds only ciphertext (E2EE-4) — and a
 * locked session yields a `locked` status (no decrypt attempted), a failed
 * decrypt a `failed` status (not a permanent spinner). Plaintext drafts resolve
 * to `ready` immediately from their `contentJson`.
 */
export type DraftPreviewStatus = "ready" | "decrypting" | "locked" | "failed"

export interface DraftPreview {
  /** Inline, markdown-stripped body text; "" when the body is empty or unavailable. */
  text: string
  status: DraftPreviewStatus
}

export interface DraftPreviewInput {
  draft: CachedDraft
  /** Encrypted root whose SSK seals the body; null/undefined for a plaintext draft. */
  rootStreamId: string | null | undefined
}

function inlineText(contentJson: JSONContent | null | undefined): string {
  if (!contentJson || isEmptyContent(contentJson)) return ""
  return stripMarkdownToInline(serializeToMarkdown(contentJson)).trim()
}

export function useDecryptedDraftPreviews(workspaceId: string, inputs: DraftPreviewInput[]): Map<string, DraftPreview> {
  const userId = useCurrentWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const sessionUnlocked = session.status === "unlocked" && !!session.privateKey && !!session.keyId

  // Re-render on any decrypt-cache change so previews fill in as bodies decrypt.
  const cacheVersion = useSyncExternalStore(
    subscribeDecryptCacheVersion,
    getDecryptCacheVersion,
    getDecryptCacheVersion
  )

  // Fire a decrypt for every E2E row we can but haven't yet — cache miss, unlocked,
  // root known. Already-cached/in-flight ids short-circuit inside requestDecryption.
  useEffect(() => {
    if (!sessionUnlocked || !session.privateKey || !session.keyId) return
    for (const { draft, rootStreamId } of inputs) {
      if (!draft.ciphertext || !rootStreamId) continue
      const cached = getCachedDecryption(draft.id)
      if (cached && cached.status !== "pending") continue
      void requestDecryption(
        draft.id,
        { contentMarkdown: "", ciphertext: draft.ciphertext, envelope: draft.envelope },
        {
          privateKey: session.privateKey,
          recipientKeyId: session.keyId,
          workspaceId,
          streamId: rootStreamId,
          rootStreamId,
        }
      )
    }
  }, [inputs, sessionUnlocked, session.privateKey, session.keyId, workspaceId])

  return useMemo(() => {
    const map = new Map<string, DraftPreview>()
    for (const { draft } of inputs) {
      if (!draft.ciphertext) {
        map.set(draft.id, { text: inlineText(draft.contentJson), status: "ready" })
        continue
      }
      if (!sessionUnlocked) {
        map.set(draft.id, { text: "", status: "locked" })
        continue
      }
      const cached = getCachedDecryption(draft.id)
      if (cached?.status === "decrypted" && cached.content) {
        map.set(draft.id, { text: inlineText(cached.content.contentJson), status: "ready" })
      } else if (cached?.status === "failed") {
        map.set(draft.id, { text: "", status: "failed" })
      } else {
        map.set(draft.id, { text: "", status: "decrypting" })
      }
    }
    return map
    // `cacheVersion` is the read-trigger: getCachedDecryption is read fresh when it bumps.
  }, [inputs, sessionUnlocked, cacheVersion])
}
