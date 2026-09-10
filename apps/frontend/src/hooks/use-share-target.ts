import { useCallback } from "react"
import { getActiveDb, type AccountWriteContext } from "@/db"
import { getAccountGeneration } from "@/db/event-writes"
import type { DraftAttachment } from "@/db/database"
import type { JSONContent } from "@threahq/types"
import { generateDraftId } from "@/hooks/use-draft-scratchpads"
import { getDraftMessageKey, upsertLoadedDraft } from "@/hooks/use-draft-message"
import { attachmentsApi } from "@/api/attachments"
import { upsertDraftScratchpadInCache } from "@/stores/draft-store"

export type { ShareMeta, ShareTargetRead } from "@/lib/share-target-storage"

/** Data stashed by the service worker from a Web Share Target POST. */
export interface ShareData {
  title: string | null
  text: string | null
  url: string | null
  files: File[]
}

/**
 * The account that received the share is no longer the active one, so the
 * upload and the draft would land in somebody else's storage. Callers stop —
 * the shared content stays stashed for the account it was addressed to.
 */
export class ShareAccountChangedError extends Error {
  constructor() {
    super("The account this content was shared to is no longer active")
    this.name = "ShareAccountChangedError"
  }
}

/** The account this share is being placed under, captured before the first await. */
function captureAccount(): AccountWriteContext {
  return { generation: getAccountGeneration(), database: getActiveDb() }
}

function assertSameAccount(account: AccountWriteContext): void {
  if (getAccountGeneration() !== account.generation) throw new ShareAccountChangedError()
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
      // The upload is the long await here, and the `db` proxy moves under it on
      // an account switch. Name the database and generation this share belongs
      // to first, then refuse to write anything once they no longer match.
      const account = captureAccount()
      const draftId = generateDraftId()
      const content = buildSharedContent(shared.title, shared.text, shared.url)
      const attachments = shared.files.length > 0 ? await uploadSharedFiles(workspaceId, shared.files) : undefined
      assertSameAccount(account)

      const scratchpad = {
        id: draftId,
        workspaceId,
        displayName: shared.title || null,
        companionMode: "on" as const,
        createdAt: Date.now(),
      }

      await account.database.draftScratchpads.add(scratchpad)
      assertSameAccount(account)
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
      const account = captureAccount()
      const content = buildSharedContent(shared.title, shared.text, shared.url)
      const uploadedAttachments = shared.files.length > 0 ? await uploadSharedFiles(workspaceId, shared.files) : []
      assertSameAccount(account)

      // Merge the shared files into the scope's loaded draft (or mint one).
      const scope = getDraftMessageKey({ type: "stream", streamId })
      const loadedId = (await account.database.composerLoaded.get(scope))?.draftId ?? null
      const existing = loadedId ? await account.database.drafts.get(loadedId) : undefined
      assertSameAccount(account)
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
