import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import type { AttachmentRef } from "@threa/crypto"
import type { CachedDraft, DraftAttachment } from "@/db"
import { getCachedDecryption, requestDecryption, type DecryptCacheEntry } from "@/lib/crypto/decrypt-cache"
import { isSessionUnlocked } from "@/lib/crypto/decrypt-context"
import { rememberAttachmentRef } from "@/lib/crypto/attachment-crypto"
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
  /**
   * The draft's attachments (Stage 4d): a plaintext draft's `attachments` as-is,
   * or — for a sealed draft — the display metadata recovered from the decrypted
   * `attachmentRefs`. Empty while none/locked/pending/failed, so the composer
   * shows attachment chips only once the body is readable (E2EE-4: the real
   * filename rides sealed, never at rest).
   */
  attachments: DraftAttachment[]
}

/** Project a decrypted attachment ref onto the composer's display shape. */
function attachmentFromRef(ref: AttachmentRef): DraftAttachment {
  return { id: ref.attachmentId, filename: ref.filename, mimeType: ref.mimeType, sizeBytes: ref.sizeBytes }
}

/** A session that can actually open sealed content (unlocked, keys present). */
export function isE2eUnlocked(session: E2eSession): boolean {
  return isSessionUnlocked(session)
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
  if (!draft) return { status: "none", contentJson: null, attachments: [] }
  if (draft.ciphertext == null)
    return { status: "plaintext", contentJson: draft.contentJson ?? null, attachments: draft.attachments }
  if (!unlocked) return { status: "locked", contentJson: null, attachments: [] }
  if (cached?.status === "decrypted" && cached.value)
    return {
      status: "decrypted",
      contentJson: cached.value.contentJson,
      attachments: (cached.value.attachmentRefs ?? []).map(attachmentFromRef),
    }
  if (cached?.status === "failed") return { status: "failed", contentJson: null, attachments: [] }
  return { status: "pending", contentJson: null, attachments: [] }
}

/**
 * Fire a decrypt for a sealed draft when possible and not already cached/in-flight
 * — a no-op otherwise (so callers can invoke it unconditionally). The plaintext
 * only ever lands in the in-memory cache (E2EE-4).
 *
 * Stage 4d: when the decrypt lands, re-register the recovered `attachmentRefs`
 * in the in-memory ref cache (`rememberAttachmentRef`). On a fresh device the
 * per-file key/iv were minted on the authoring device, so without this a roamed
 * draft could neither decrypt its attachments for view nor re-seal them on send
 * (the seal path resolves refs by id). Idempotent — a re-seal of the same id
 * overwrites with identical material.
 */
export function requestDraftDecryption(
  draft: CachedDraft,
  keys: { privateKey: CryptoKey | null; recipientKeyId: string | null },
  workspaceId: string,
  rootStreamId: string | null | undefined
): void {
  if (draft.ciphertext == null || !rootStreamId || !keys.privateKey || !keys.recipientKeyId) return
  const cached = getCachedDecryption(draft.id)
  if (cached && cached.status !== "pending") {
    if (cached.status === "decrypted") rememberDecryptedRefs(cached)
    return
  }
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
  ).then((entry) => {
    if (entry.status === "decrypted") rememberDecryptedRefs(entry)
  })
}

/** Re-register a decrypted entry's attachment refs so a roamed draft is sendable. */
function rememberDecryptedRefs(entry: DecryptCacheEntry): void {
  for (const ref of entry.value?.attachmentRefs ?? []) rememberAttachmentRef(ref)
}

/**
 * The decrypted body currently cached for a sealed draft id, or null when it
 * isn't decrypted. The in-memory cache is the plaintext authority for a sealed
 * draft (E2EE-4: the row at rest holds only the empty placeholder), so the write
 * path reads the body back from it to re-seal across an attachment change.
 */
export function cachedDraftBody(draftId: string): JSONContent | null {
  const cached = getCachedDecryption(draftId)
  if (cached?.status !== "decrypted") return null
  return cached.value?.contentJson ?? null
}

/**
 * The decrypted attachments currently cached for a sealed draft id (Stage 4d),
 * or [] when it isn't decrypted. Same rationale as `cachedDraftBody`: a
 * content-only re-seal must preserve the attachments that were sealed alongside
 * the body, and those live only in the in-memory decrypt cache.
 */
export function cachedDraftAttachments(draftId: string): DraftAttachment[] {
  const cached = getCachedDecryption(draftId)
  if (cached?.status !== "decrypted") return []
  return (cached.value?.attachmentRefs ?? []).map(attachmentFromRef)
}

// --- List-preview presentation (stash picker, /drafts explorer) ---

export type DraftPreviewStatus = "ready" | "decrypting" | "locked" | "failed"

export interface DraftPreview {
  /** Inline, markdown-stripped body text; "" when empty or unavailable. */
  text: string
  /**
   * The full markdown body — what a copy action puts on the clipboard; "" when
   * empty or unavailable. Kept beside `text` (rather than re-serialized per
   * surface) so a sealed draft's copyability is decided by the same decrypt
   * state that decides its preview.
   */
  markdown: string
  status: DraftPreviewStatus
}

/** Inline, markdown-stripped text from a draft body; "" when empty. */
export function draftInlineText(contentJson: JSONContent | null | undefined): string {
  if (!contentJson || isEmptyContent(contentJson)) return ""
  return stripMarkdownToInline(serializeToMarkdown(contentJson)).trim()
}

/** Full markdown for a draft body; "" when empty. */
export function draftMarkdown(contentJson: JSONContent | null | undefined): string {
  if (!contentJson || isEmptyContent(contentJson)) return ""
  return serializeToMarkdown(contentJson).trim()
}

/** Project a decrypt state onto the list-preview shape. */
export function draftDecryptionToPreview(decryption: DraftDecryption): DraftPreview {
  if (decryption.status === "plaintext" || decryption.status === "decrypted") {
    return {
      text: draftInlineText(decryption.contentJson),
      markdown: draftMarkdown(decryption.contentJson),
      status: "ready",
    }
  }
  if (decryption.status === "failed") return { text: "", markdown: "", status: "failed" }
  if (decryption.status === "locked") return { text: "", markdown: "", status: "locked" }
  return { text: "", markdown: "", status: "decrypting" } // pending / none
}

/**
 * Label for a draft row whose body renders no text. An attachment-only draft is
 * real, unsent payload — naming its files is the only truthful thing to show, so
 * every draft-listing surface (composer stash pile, drafts explorer) reads it
 * from here rather than each deciding what "no text" means.
 */
export function draftEmptyBodyLabel(attachmentCount: number): string {
  if (attachmentCount > 0) return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
  return "Empty draft"
}

/** User-facing label for a non-ready preview status. */
export function draftPreviewStatusLabel(status: Exclude<DraftPreviewStatus, "ready">): string {
  if (status === "decrypting") return "Decrypting…"
  if (status === "failed") return "Couldn't decrypt"
  return "Encrypted draft" // locked
}
