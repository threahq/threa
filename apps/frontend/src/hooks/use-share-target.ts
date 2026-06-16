import { useCallback } from "react"
import { db } from "@/db"
import type { DraftAttachment } from "@/db/database"
import type { JSONContent } from "@threa/types"
import { generateDraftId } from "@/hooks/use-draft-scratchpads"
import { getDraftMessageKey, upsertLoadedDraft } from "@/hooks/use-draft-message"
import { attachmentsApi } from "@/api/attachments"
import { upsertDraftScratchpadInCache } from "@/stores/draft-store"
import { SHARE_TARGET_CACHE } from "@/lib/sw-messages"

/** Data stashed by the service worker from a Web Share Target POST. */
export interface ShareData {
  title: string | null
  text: string | null
  url: string | null
  files: File[]
}

/** Lightweight metadata passed via navigation state (no binary blobs). */
export interface ShareMeta {
  title: string | null
  text: string | null
  url: string | null
  hasFiles: boolean
}

/**
 * Read only the text metadata from the share cache.
 * Safe to pass via `history.state` — no binary blobs.
 */
export async function readShareTargetMeta(): Promise<ShareMeta | null> {
  try {
    const cache = await caches.open(SHARE_TARGET_CACHE)
    const metaResponse = await cache.match("/_share/meta")
    if (!metaResponse) return null

    const meta = (await metaResponse.json()) as {
      title: string | null
      text: string | null
      url: string | null
      fileCount: number
    }

    return { title: meta.title, text: meta.text, url: meta.url, hasFiles: meta.fileCount > 0 }
  } catch {
    return null
  }
}

/**
 * Read file blobs from the share cache. Call separately from
 * {@link readShareTargetMeta} — files must NOT go through `history.state`
 * because browsers enforce serialization size limits (~640 KB in Firefox).
 */
export async function readShareTargetFiles(): Promise<File[]> {
  try {
    const cache = await caches.open(SHARE_TARGET_CACHE)
    const metaResponse = await cache.match("/_share/meta")
    if (!metaResponse) return []

    const meta = (await metaResponse.json()) as { fileCount: number }
    const files: File[] = []
    for (let i = 0; i < meta.fileCount; i++) {
      const fileResponse = await cache.match(`/_share/file/${i}`)
      if (fileResponse) {
        const blob = await fileResponse.blob()
        const rawFilename = fileResponse.headers.get("X-Filename")
        const filename = rawFilename ? decodeURIComponent(rawFilename) : `file-${i}`
        files.push(new File([blob], filename, { type: blob.type }))
      }
    }
    return files
  } catch {
    return []
  }
}

/** Remove stashed share data from the Cache API after it has been consumed. */
export async function clearShareTargetCache(): Promise<void> {
  try {
    await caches.delete(SHARE_TARGET_CACHE)
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Build a ProseMirror document from the shared title, text, and URL.
 * Formats the content as paragraphs with the URL as a clickable link.
 */
function buildSharedContent(title: string | null, text: string | null, url: string | null): JSONContent {
  const nodes: JSONContent[] = []

  if (title && title !== text) {
    nodes.push({
      type: "paragraph",
      content: [{ type: "text", text: title, marks: [{ type: "bold" }] }],
    })
  }

  if (text) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (trimmed) {
        nodes.push({
          type: "paragraph",
          content: [{ type: "text", text: trimmed }],
        })
      } else {
        nodes.push({ type: "paragraph" })
      }
    }
  }

  if (url) {
    nodes.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: url,
          marks: [{ type: "link", attrs: { href: url, target: "_blank" } }],
        },
      ],
    })
  }

  if (nodes.length === 0) {
    nodes.push({ type: "paragraph" })
  }

  return { type: "doc", content: nodes }
}

/**
 * Upload shared files and return DraftAttachment entries.
 * Best-effort: failed uploads are skipped so text content is still saved.
 */
async function uploadSharedFiles(workspaceId: string, files: File[]): Promise<DraftAttachment[]> {
  const settled = await Promise.allSettled(
    files.map(async (file) => {
      const attachment = await attachmentsApi.upload(workspaceId, file)
      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      } satisfies DraftAttachment
    })
  )
  return settled
    .filter((r): r is PromiseFulfilledResult<DraftAttachment> => r.status === "fulfilled")
    .map((r) => r.value)
}

export function useShareTarget() {
  const createShareDraft = useCallback(
    async (workspaceId: string, shared: ShareData): Promise<{ draftId: string; path: string }> => {
      const draftId = generateDraftId()
      const content = buildSharedContent(shared.title, shared.text, shared.url)
      const attachments = shared.files.length > 0 ? await uploadSharedFiles(workspaceId, shared.files) : undefined
      const createdAt = Date.now()
      const scratchpad = {
        id: draftId,
        workspaceId,
        displayName: shared.title || null,
        companionMode: "on" as const,
        createdAt,
      }

      await db.draftScratchpads.add(scratchpad)
      upsertDraftScratchpadInCache(workspaceId, scratchpad)

      // The shared content becomes the scratchpad's loaded draft so the
      // composer shows it when the user lands on the freshly-created scratchpad.
      await upsertLoadedDraft(workspaceId, getDraftMessageKey({ type: "stream", streamId: draftId }), {
        contentJson: content,
        attachments: attachments ?? [],
      })

      return { draftId, path: `/w/${workspaceId}/s/${draftId}` }
    },
    []
  )

  const saveShareContent = useCallback(
    async (workspaceId: string, streamId: string, shared: ShareData): Promise<void> => {
      const content = buildSharedContent(shared.title, shared.text, shared.url)
      const uploadedAttachments = shared.files.length > 0 ? await uploadSharedFiles(workspaceId, shared.files) : []

      // Merge the shared files into the scope's loaded draft (or mint one).
      const scope = getDraftMessageKey({ type: "stream", streamId })
      const loadedId = (await db.composerLoaded.get(scope))?.draftId ?? null
      const existing = loadedId ? await db.drafts.get(loadedId) : undefined
      const mergedAttachments = [...(existing?.attachments ?? []), ...uploadedAttachments]
      await upsertLoadedDraft(workspaceId, scope, {
        contentJson: content,
        attachments: mergedAttachments,
        contextRefs: existing?.contextRefs,
      })
    },
    []
  )

  return { createShareDraft, saveShareContent }
}
