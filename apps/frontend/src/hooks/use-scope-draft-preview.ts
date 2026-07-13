import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedDraft } from "@/db"
import { draftInlineText } from "@/lib/drafts/decryption"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"

export interface ScopeDraftPreview {
  draftId: string
  /** One-line plain text of the draft body; "" for an attachment-only draft. */
  preview: string
  attachmentCount: number
  /**
   * True when the row is checked out into this device's composer (the ambient
   * auto-save) — opening the composer hydrates it by itself. False for a
   * stashed or roamed row (the loaded pointer is device-local), where the
   * opener must restore the row explicitly for the advertised draft to appear.
   */
  isCheckedOut: boolean
}

function hasPayload(draft: CachedDraft): boolean {
  return draft.ciphertext != null || !isEmptyContent(draft.contentJson) || (draft.attachments?.length ?? 0) > 0
}

function toPreview(best: CachedDraft, loadedDraftId: string | null): ScopeDraftPreview {
  return {
    draftId: best.id,
    preview: draftInlineText(best.contentJson),
    attachmentCount: best.attachments?.length ?? 0,
    isCheckedOut: best.id === loadedDraftId,
  }
}

/** The checked-out row when there is one, else the newest — what a resting
 *  affordance should advertise. */
function bestRow(rows: CachedDraft[], loadedDraftId: string | null): CachedDraft | null {
  const withPayload = rows.filter(hasPayload)
  if (withPayload.length === 0) return null
  return (
    withPayload.find((row) => row.id === loadedDraftId) ??
    withPayload.reduce((a, b) => (b.clientUpdatedAt > a.clientUpdatedAt ? b : a))
  )
}

/**
 * The draft a collapsed composer affordance for `scope` should advertise —
 * the same "your unsent text, one line" presentation the mobile composer's
 * collapsed bar uses. A Dexie range query on the `[workspaceId+scope]` index
 * (plus the scope's loaded pointer), so it re-fires only on this scope's own
 * rows — cheap enough per board card. Null when the scope holds nothing worth
 * showing.
 */
export function useScopeDraftPreview(workspaceId: string, scope: string): ScopeDraftPreview | null {
  const result = useLiveQuery(
    async () => {
      const [rows, loaded] = await Promise.all([
        db.drafts.where("[workspaceId+scope]").equals([workspaceId, scope]).toArray(),
        db.composerLoaded.get(scope),
      ])
      const best = bestRow(rows, loaded?.draftId ?? null)
      return best ? toPreview(best, loaded?.draftId ?? null) : null
    },
    [workspaceId, scope],
    null
  )
  return result
}

export interface SubtopicDraftEntry extends ScopeDraftPreview {
  scope: string
  streamId: string
  messageId: string
}

/**
 * Every new-sub-topic draft in the workspace, keyed by its fork message id —
 * so a conversation surface can mark the message rows that carry an unsent
 * sub-topic draft while the gesture's composer is unmounted. One range query
 * over the `board:subtopic:` scope prefix per surface (the rows are few and
 * only change on draft edits under that prefix).
 */
export function useBoardSubtopicDraftIndex(workspaceId: string): Map<string, SubtopicDraftEntry> {
  const result = useLiveQuery(
    async () => {
      const rows = await db.drafts
        .where("[workspaceId+scope]")
        .between([workspaceId, "board:subtopic:"], [workspaceId, "board:subtopic:\uffff"])
        .toArray()
      if (rows.length === 0) return new Map<string, SubtopicDraftEntry>()

      const byScope = new Map<string, CachedDraft[]>()
      for (const row of rows) {
        const list = byScope.get(row.scope)
        if (list) list.push(row)
        else byScope.set(row.scope, [row])
      }
      const loadedRows = await db.composerLoaded.bulkGet([...byScope.keys()])
      const loadedByScope = new Map([...byScope.keys()].map((scope, i) => [scope, loadedRows[i]?.draftId ?? null]))

      const map = new Map<string, SubtopicDraftEntry>()
      for (const [scope, scopeRows] of byScope) {
        const parsed = parseBoardDraftKey(scope)
        if (parsed?.kind !== "subtopic") continue
        const best = bestRow(scopeRows, loadedByScope.get(scope) ?? null)
        if (!best) continue
        map.set(parsed.messageId, {
          ...toPreview(best, loadedByScope.get(scope) ?? null),
          scope,
          streamId: parsed.streamId,
          messageId: parsed.messageId,
        })
      }
      return map
    },
    [workspaceId],
    undefined
  )
  return result ?? new Map<string, SubtopicDraftEntry>()
}
