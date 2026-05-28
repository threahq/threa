import { useLiveQuery } from "dexie-react-hooks"
import { useCallback, useMemo } from "react"
import { db, type CachedStream } from "@/db"
import {
  deleteDraftMessageFromCache,
  deleteDraftScratchpadFromCache,
  useDraftMessagesFromStore,
  useDraftScratchpadsFromStore,
} from "@/stores/draft-store"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { isDraftId } from "./use-draft-scratchpads"
import { deleteStashedDraftById } from "./use-stashed-drafts"
import { serializeToMarkdown } from "@threa/prosemirror"
import type { CompanionMode, JSONContent } from "@threa/types"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { stripMarkdownToInline } from "@/lib/markdown"
import { getStreamName, streamFallbackLabel, streamLabel } from "@/lib/streams"

/**
 * Defensive ceiling on the workspace-wide stash scan that powers the /drafts
 * explorer. `useLiveQuery` re-fires on every Dexie change in the table, so we
 * want to avoid re-materialising an unbounded number of rows into React state
 * on each write. 500 is well above any realistic user's stash pile; if the
 * explorer ever needs more, switch to cursor-based pagination instead of
 * raising this number.
 */
const WORKSPACE_STASH_SCAN_LIMIT = 500

export type DraftType = "scratchpad" | "channel" | "dm" | "thread"

const VALID_DRAFT_TYPES: readonly DraftType[] = ["scratchpad", "channel", "dm", "thread"] as const

function isValidDraftType(type: string): type is DraftType {
  return VALID_DRAFT_TYPES.includes(type as DraftType)
}

function isStashId(id: string): boolean {
  return id.startsWith("stash_")
}

export interface UnifiedDraft {
  /** Original draft ID (e.g., "draft_xxx" / "stream:xxx" / "thread:xxx" / "stash_xxx") */
  id: string
  /** Type of stream/draft */
  type: DraftType
  /** Stream ID for navigation (null for threads without cached parent) */
  streamId: string | null
  /** Display name for the draft location */
  displayName: string
  /** Preview of the draft content (truncated) */
  preview: string
  /** Number of attachments */
  attachmentCount: number
  /** Last updated timestamp for sorting */
  updatedAt: number
  /** Navigation href (for use with Link component) */
  href: string | null
  /**
   * Label used to cluster rows in the drafts page (one section per
   * stream/thread). Rows with the same label render under the same header —
   * e.g. the ambient auto-save and all stashed siblings for the same stream
   * end up in one group.
   */
  groupLabel: string
  /**
   * True when this row represents an explicit stashed-save (Cmd+S), false
   * when it's the ambient auto-saved draft. Lets the UI render them
   * slightly differently (e.g. an "Editing" hint vs. a saved indicator).
   */
  isStashed: boolean
  /**
   * Scratchpad-only: the companion mode the draft was created with (locked at
   * Quick Switcher choice). Lets the drafts explorer distinguish "Quick Note"
   * (off) from "Scratchpad" (on) at a glance.
   */
  companionMode?: CompanionMode
}

/**
 * Parse a draft message key to extract stream/thread ID and type.
 * Key formats:
 * - "stream:{streamId}" for messages in streams
 * - "thread:{parentMessageId}" for thread replies
 */
function parseDraftMessageKey(key: string): { type: "stream" | "thread"; id: string } | null {
  if (key.startsWith("stream:")) {
    return { type: "stream", id: key.slice(7) }
  }
  if (key.startsWith("thread:")) {
    return { type: "thread", id: key.slice(7) }
  }
  return null
}

/**
 * Truncate content for preview, preserving word boundaries.
 */
function truncatePreview(content: string, maxLength: number = 80): string {
  const trimmed = content.trim().replace(/\s+/g, " ")
  if (trimmed.length <= maxLength) return trimmed
  const truncated = trimmed.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(" ")
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "…"
}

/**
 * Get a display-safe inline preview from JSONContent. Markdown is stripped
 * here (not at the render site) because every current consumer renders the
 * value as plain inline text — keeping that guarantee at the source
 * satisfies INV-60 without requiring every caller to remember the strip.
 */
function getContentPreview(contentJson: JSONContent | undefined): string {
  if (!contentJson || isEmptyContent(contentJson)) return ""
  return stripMarkdownToInline(serializeToMarkdown(contentJson))
}

interface ResolvedDraftLocation {
  draftType: DraftType
  streamId: string | null
  displayName: string
  href: string | null
  groupLabel: string
}

/**
 * Shared location resolution used by both DraftMessage and StashedDraft rows
 * so their rendering stays in sync (same display name, same href, same
 * group clustering). For thread-scope rows we resolve the parent stream via
 * cached events; if the parent isn't in cache yet we degrade to a generic
 * label with a null href.
 */
function resolveDraftLocation(
  parsed: { type: "stream" | "thread"; id: string },
  workspaceId: string,
  streamMap: Map<string, CachedStream>,
  messageToStreamMap: Map<string, { streamId: string; parentMessageId: string }>
): ResolvedDraftLocation {
  if (parsed.type === "thread") {
    const messageInfo = messageToStreamMap.get(parsed.id)
    const parentStream = messageInfo ? streamMap.get(messageInfo.streamId) : null
    if (parentStream) {
      const streamName = streamLabel(parentStream, "sidebar")
      const displayName = `Thread in ${streamName}`
      return {
        draftType: "thread",
        streamId: parentStream.id,
        displayName,
        href: `/w/${workspaceId}/s/${parentStream.id}?draft=${parentStream.id}:${parsed.id}`,
        groupLabel: displayName,
      }
    }
    return {
      draftType: "thread",
      streamId: null,
      displayName: "Thread reply",
      href: null,
      groupLabel: "Thread reply",
    }
  }

  const stream = streamMap.get(parsed.id)
  if (stream) {
    const displayName =
      getStreamName(stream) ?? streamFallbackLabel(isValidDraftType(stream.type) ? stream.type : "channel", "sidebar")
    return {
      draftType: isValidDraftType(stream.type) ? stream.type : "channel",
      streamId: parsed.id,
      displayName,
      href: `/w/${workspaceId}/s/${parsed.id}`,
      groupLabel: displayName,
    }
  }
  return {
    draftType: "channel",
    streamId: parsed.id,
    displayName: "Message",
    href: `/w/${workspaceId}/s/${parsed.id}`,
    groupLabel: "Message",
  }
}

/**
 * Hook to get all drafts (scratchpads + messages + stashed snapshots) for a
 * workspace. Returns a unified list sorted by recency; rows carry a
 * `groupLabel` so the drafts page can cluster them per stream/thread.
 */
export function useAllDrafts(workspaceId: string) {
  const draftScratchpads = useDraftScratchpadsFromStore(workspaceId)
  const draftMessages = useDraftMessagesFromStore(workspaceId)
  const cachedStreams = useWorkspaceStreams(workspaceId)

  // Stashed drafts live in a sibling pile (see `useStashedDrafts`). The
  // workspace-wide query powers the /drafts explorer — the per-scope picker
  // in the composer uses its own scoped query. `.reverse().limit(…)` takes
  // the newest rows in the (ULID-based) primary-key order: ULIDs sort
  // chronologically, so reversing the index iteration and taking N
  // truncates from the old end, not the new one. Without `.reverse()` a
  // power user past the cap would silently lose recently-stashed drafts
  // from /drafts.
  const stashedDrafts =
    useLiveQuery(
      () => {
        if (!workspaceId) return []
        return db.stashedDrafts
          .where("workspaceId")
          .equals(workspaceId)
          .reverse()
          .limit(WORKSPACE_STASH_SCAN_LIMIT)
          .toArray()
      },
      [workspaceId],
      []
    ) ?? []

  // `useLiveQuery` returns a fresh array reference on every Dexie re-fire,
  // even when the row set is unchanged. Deriving a stable signature from the
  // set of scopes present turns identity-based churn into value-based
  // invalidation for downstream memos (`hasThreadDrafts` →
  // `cachedEvents` subscription → rebuild), so an unrelated stash write
  // doesn't force event re-fetch.
  const stashedScopesSignature = useMemo(() => {
    const scopes = new Set<string>()
    for (const row of stashedDrafts) scopes.add(row.scope)
    return [...scopes].sort().join("|")
  }, [stashedDrafts])

  // Check if we have any thread drafts that need parent message resolution.
  // Includes stashed drafts because a thread's parent-message resolution path
  // is identical regardless of whether the row is auto-saved or stashed.
  // Splitting on `|` and prefix-checking each segment avoids false positives
  // on any scope that contained the literal substring `thread:` in a
  // non-prefix position — cheap since the signature is capped by the scan
  // limit above.
  const hasThreadDrafts = useMemo(
    () =>
      (draftMessages ?? []).some((m) => m.id.startsWith("thread:")) ||
      stashedScopesSignature.split("|").some((scope) => scope.startsWith("thread:")),
    [draftMessages, stashedScopesSignature]
  )

  // Stable stream ID key — only changes when the set of IDs changes, not on
  // every useLiveQuery re-fire of cachedStreams (which returns a new array ref
  // even when the same streams are present).
  const streamIdKey = useMemo(
    () =>
      (cachedStreams ?? [])
        .map((s) => s.id)
        .sort()
        .join(","),
    [cachedStreams]
  )

  // Get cached events for looking up parent messages (for thread drafts)
  // Only query events if we have thread drafts to avoid expensive query for common case
  const cachedEvents = useLiveQuery(
    () => {
      if (!hasThreadDrafts || !streamIdKey) return []
      return db.events.where("streamId").anyOf(streamIdKey.split(",")).toArray()
    },
    [streamIdKey, hasThreadDrafts],
    []
  )

  // Build a map of stream ID -> stream for quick lookup
  const streamMap = useMemo(() => {
    const map = new Map<string, CachedStream>()
    for (const stream of cachedStreams ?? []) {
      map.set(stream.id, stream)
    }
    return map
  }, [cachedStreams])

  // Build a map of messageId -> streamId for looking up parent messages
  // Thread drafts use payload.messageId as key, not event.id
  const messageToStreamMap = useMemo(() => {
    const map = new Map<string, { streamId: string; parentMessageId: string }>()
    for (const event of cachedEvents ?? []) {
      if (event.eventType === "message_created") {
        const payload = event.payload as { messageId?: string }
        if (payload.messageId) {
          map.set(payload.messageId, { streamId: event.streamId, parentMessageId: payload.messageId })
        }
      }
    }
    return map
  }, [cachedEvents])

  // Combine and transform drafts
  const drafts = useMemo((): UnifiedDraft[] => {
    const result: UnifiedDraft[] = []

    // Add draft scratchpads (these are scratchpads that haven't been created on server yet)
    for (const draft of draftScratchpads ?? []) {
      // Check if there's a corresponding draft message with content
      const draftMessageKey = `stream:${draft.id}`
      const draftMessage = (draftMessages ?? []).find((m) => m.id === draftMessageKey)

      // Only include if there's content or attachments
      const hasContent = !isEmptyContent(draftMessage?.contentJson)
      const hasAttachments = (draftMessage?.attachments?.length ?? 0) > 0

      if (hasContent || hasAttachments) {
        const displayName = draft.displayName ?? streamFallbackLabel("scratchpad", "sidebar")
        result.push({
          id: draft.id,
          type: "scratchpad",
          streamId: draft.id,
          displayName,
          preview: truncatePreview(getContentPreview(draftMessage?.contentJson)),
          attachmentCount: draftMessage?.attachments?.length ?? 0,
          updatedAt: draftMessage?.updatedAt ?? draft.createdAt,
          href: `/w/${workspaceId}/s/${draft.id}`,
          groupLabel: displayName,
          isStashed: false,
          companionMode: draft.companionMode,
        })
      }
    }

    // Add draft messages for existing streams (channels, DMs, threads)
    for (const draftMessage of draftMessages ?? []) {
      const parsed = parseDraftMessageKey(draftMessage.id)
      if (!parsed) continue

      // Skip if this is for a draft scratchpad (already handled above)
      if (parsed.type === "stream" && isDraftId(parsed.id)) continue

      // Only include if there's content or attachments
      const hasContent = !isEmptyContent(draftMessage.contentJson)
      const hasAttachments = (draftMessage.attachments?.length ?? 0) > 0
      if (!hasContent && !hasAttachments) continue

      const resolved = resolveDraftLocation(parsed, workspaceId, streamMap, messageToStreamMap)

      result.push({
        id: draftMessage.id,
        type: resolved.draftType,
        streamId: resolved.streamId,
        displayName: resolved.displayName,
        preview: truncatePreview(getContentPreview(draftMessage.contentJson)),
        attachmentCount: draftMessage.attachments?.length ?? 0,
        updatedAt: draftMessage.updatedAt,
        href: resolved.href,
        groupLabel: resolved.groupLabel,
        isStashed: false,
      })
    }

    // Stashed drafts: one row per saved snapshot. Clicking the row navigates
    // to the stream with `?stash=<id>`; `MessageInput` / `StreamPanel` picks
    // up that param on mount and restores into the composer (stashing any
    // current content first, mirroring the picker's swap behavior).
    for (const stashed of stashedDrafts) {
      const parsed = parseDraftMessageKey(stashed.scope)
      if (!parsed) continue
      if (parsed.type === "stream" && isDraftId(parsed.id)) {
        // Scratchpad-scoped stashes are rare but conceptually valid; skip in
        // the /drafts explorer until the scratchpad flow itself supports them.
        continue
      }

      const resolved = resolveDraftLocation(parsed, workspaceId, streamMap, messageToStreamMap)
      const href = resolved.href
        ? resolved.href + (resolved.href.includes("?") ? "&" : "?") + `stash=${encodeURIComponent(stashed.id)}`
        : null

      result.push({
        id: stashed.id,
        type: resolved.draftType,
        streamId: resolved.streamId,
        displayName: resolved.displayName,
        preview: truncatePreview(getContentPreview(stashed.contentJson)),
        attachmentCount: stashed.attachments?.length ?? 0,
        updatedAt: stashed.createdAt,
        href,
        groupLabel: resolved.groupLabel,
        isStashed: true,
      })
    }

    // Sort by recency (most recent first). The drafts-page renderer groups
    // by `groupLabel` post-sort, so the first appearance of each label wins
    // its section position — streams with recent activity float to the top.
    result.sort((a, b) => b.updatedAt - a.updatedAt)

    return result
  }, [draftScratchpads, draftMessages, stashedDrafts, streamMap, messageToStreamMap, workspaceId])

  // Delete a draft by id — dispatches to the correct table by id prefix.
  // Handles three shapes: "stash_xxx" (stashed pile), "draft_xxx" (scratchpad
  // + its ambient draft message), and "stream:..." / "thread:..." (ambient
  // draft message).
  const deleteDraft = useCallback(
    async (draftId: string) => {
      if (isStashId(draftId)) {
        await deleteStashedDraftById(draftId)
        return
      }

      if (isDraftId(draftId)) {
        await db.draftScratchpads.delete(draftId)
        await db.draftMessages.delete(`stream:${draftId}`)
        deleteDraftScratchpadFromCache(workspaceId, draftId)
        deleteDraftMessageFromCache(workspaceId, `stream:${draftId}`)
        return
      }

      await db.draftMessages.delete(draftId)
      deleteDraftMessageFromCache(workspaceId, draftId)
    },
    [workspaceId]
  )

  return {
    drafts,
    draftCount: drafts.length,
    deleteDraft,
  }
}
