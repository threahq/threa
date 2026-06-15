import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import type { CachedDraft } from "@/db"
import { getCachedDecryption, requestDecryption, type DecryptCacheEntry } from "@/lib/crypto/decrypt-cache"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { stripMarkdownToInline } from "@/lib/markdown"
import type { useE2eSession } from "@/stores/e2e-session-store"

/**
 * The decrypt-on-read core shared by the composer (`useDecryptedDraftContent`)
 * and list previews (`useDecryptedDraftPreviews`). Both read draft bodies from
 * the same in-memory decrypt cache — plaintext never lands on disk (E2EE-4) — so
 * the status machine and the "fire a decrypt" rule live here once; the hooks only
 * differ in HOW they subscribe (per-id vs. a global cache version).
 */
type E2eSession = ReturnType<typeof useE2eSession>

export type DraftDecryptionStatus = "none" | "plaintext" | "locked" | "pending" | "decrypted" | "failed"

export interface DraftDecryption {
  status: DraftDecryptionStatus
  /** The plaintext body for plaintext/decrypted; null while none/locked/pending/failed. */
  contentJson: JSONContent | null
}

/** A session that can actually open sealed content (unlocked, keys present). */
export function isE2eUnlocked(session: E2eSession): boolean {
  return session.status === "unlocked" && !!session.privateKey && !!session.keyId
}

/**
 * Pure read of a draft's decrypt state from the session + its shared-cache entry.
 * Plaintext drafts resolve immediately; sealed drafts report locked (session
 * locked), decrypted/failed (cache result), or pending (in flight / root unknown).
 */
export function resolveDraftDecryption(
  draft: CachedDraft | undefined,
  unlocked: boolean,
  cached: DecryptCacheEntry | undefined
): DraftDecryption {
  if (!draft) return { status: "none", contentJson: null }
  if (draft.ciphertext == null) return { status: "plaintext", contentJson: draft.contentJson ?? null }
  if (!unlocked) return { status: "locked", contentJson: null }
  if (cached?.status === "decrypted" && cached.content)
    return { status: "decrypted", contentJson: cached.content.contentJson }
  if (cached?.status === "failed") return { status: "failed", contentJson: null }
  return { status: "pending", contentJson: null }
}

/**
 * Fire a decrypt for a sealed draft when possible and not already cached/in-flight
 * — a no-op otherwise (so callers can invoke it unconditionally). The plaintext
 * only ever lands in the in-memory cache (E2EE-4).
 */
export function requestDraftDecryption(
  draft: CachedDraft,
  keys: { privateKey: CryptoKey | null; recipientKeyId: string | null },
  workspaceId: string,
  rootStreamId: string | null | undefined
): void {
  if (draft.ciphertext == null || !rootStreamId || !keys.privateKey || !keys.recipientKeyId) return
  const cached = getCachedDecryption(draft.id)
  if (cached && cached.status !== "pending") return
  void requestDecryption(
    draft.id,
    { contentMarkdown: "", ciphertext: draft.ciphertext, envelope: draft.envelope },
    {
      privateKey: keys.privateKey,
      recipientKeyId: keys.recipientKeyId,
      workspaceId,
      streamId: rootStreamId,
      rootStreamId,
    }
  )
}

// --- List-preview presentation (stash picker, /drafts explorer) ---

export type DraftPreviewStatus = "ready" | "decrypting" | "locked" | "failed"

export interface DraftPreview {
  /** Inline, markdown-stripped body text; "" when empty or unavailable. */
  text: string
  status: DraftPreviewStatus
}

/** Inline, markdown-stripped text from a draft body; "" when empty. */
export function draftInlineText(contentJson: JSONContent | null | undefined): string {
  if (!contentJson || isEmptyContent(contentJson)) return ""
  return stripMarkdownToInline(serializeToMarkdown(contentJson)).trim()
}

/** Project a decrypt state onto the list-preview shape. */
export function draftDecryptionToPreview(decryption: DraftDecryption): DraftPreview {
  if (decryption.status === "plaintext" || decryption.status === "decrypted") {
    return { text: draftInlineText(decryption.contentJson), status: "ready" }
  }
  if (decryption.status === "failed") return { text: "", status: "failed" }
  if (decryption.status === "locked") return { text: "", status: "locked" }
  return { text: "", status: "decrypting" } // pending / none
}

/** User-facing label for a non-ready preview status. */
export function draftPreviewStatusLabel(status: Exclude<DraftPreviewStatus, "ready">): string {
  if (status === "decrypting") return "Decrypting…"
  if (status === "failed") return "Couldn't decrypt"
  return "Encrypted draft" // locked
}
