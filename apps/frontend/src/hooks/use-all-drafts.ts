import { useLiveQuery } from "dexie-react-hooks"
import { useCallback, useMemo } from "react"
import { db, type CachedDraft, type CachedStream } from "@/db"
import {
  deleteDraftScratchpadFromCache,
  useComposerLoadedFromStore,
  useDraftsFromStore,
  useDraftScratchpadsFromStore,
} from "@/stores/draft-store"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { deleteDraftById } from "@/sync/draft-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { isDraftId } from "./use-draft-scratchpads"
import { purgeScopeDrafts } from "./use-draft-message"
import { serializeToMarkdown } from "@threa/prosemirror"
import type { CompanionMode, JSONContent } from "@threa/types"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { stripMarkdownToInline } from "@/lib/markdown"
import { getStreamName, streamFallbackLabel, streamLabel } from "@/lib/streams"
import { useDecryptedDraftPreviews, type DraftPreview, type DraftPreviewInput } from "./use-decrypted-draft-previews"

export type DraftType = "scratchpad" | "channel" | "dm" | "thread"

const VALID_DRAFT_TYPES: readonly DraftType[] = ["scratchpad", "channel", "dm", "thread"] as const

function isValidDraftType(type: string): type is DraftType {
  return VALID_DRAFT_TYPES.includes(type as DraftType)
}

export interface UnifiedDraft {
  /** Row id: a scratchpad id (`draft_xxx`) for scratchpad rows, otherwise the unified draft's own `draft_xxx` id. */
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

/**
 * The explorer preview for a draft row. Plaintext rows read `contentJson`
 * directly; E2E rows (ciphertext at rest) read the decrypted body from the shared
 * cache via `previewMap`, falling back to a status label so a sealed draft still
 * shows up identifiably instead of as a blank/empty row (the bug this fixes).
 */
function draftPreviewLabel(draft: CachedDraft, previewMap: Map<string, DraftPreview>): string {
  if (draft.ciphertext == null) return truncatePreview(getContentPreview(draft.contentJson))
  const preview = previewMap.get(draft.id)
  if (!preview || preview.status === "locked") return "Encrypted draft"
  if (preview.status === "decrypting") return "Decrypting…"
  if (preview.status === "failed") return "Couldn't decrypt"
  return truncatePreview(preview.text) || "Encrypted draft"
}

/** The encrypted root whose SSK seals a draft's body, for decrypt-on-read previews. */
function resolveRootStreamId(
  parsed: { type: "stream" | "thread"; id: string },
  streamMap: Map<string, CachedStream>,
  messageToStreamMap: Map<string, { streamId: string; parentMessageId: string }>
): string | null {
  if (parsed.type === "thread") {
    const info = messageToStreamMap.get(parsed.id)
    if (!info) return null
    return streamMap.get(info.streamId)?.rootStreamId ?? info.streamId
  }
  return streamMap.get(parsed.id)?.rootStreamId ?? parsed.id
}

interface ResolvedDraftLocation {
  draftType: DraftType
  streamId: string | null
  displayName: string
  href: string | null
  groupLabel: string
}

/**
 * Shared location resolution used by both loaded (ambient) and stashed draft
 * rows so their rendering stays in sync (same display name, same href, same
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
  const allDrafts = useDraftsFromStore(workspaceId)
  const composerLoaded = useComposerLoadedFromStore(workspaceId)
  const cachedStreams = useWorkspaceStreams(workspaceId)
  // Drains the offline queue so a delete enqueued below mirrors to the backend
  // promptly. Optional — outside a workspace there is no engine and the local
  // delete still stands; the op replays on the next (re)connect.
  const syncEngine = useOptionalSyncEngine()

  // scope -> loaded draft id, the device-local "checked out into the composer"
  // pointer. A draft is "stashed" (vs. ambient/loaded) when it is not the one
  // its scope points at.
  const loadedByScope = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const row of composerLoaded) map.set(row.scope, row.draftId)
    return map
  }, [composerLoaded])

  // Stable signature over the set of draft scopes so the events query below
  // (which is gated on whether any thread-scoped drafts exist) doesn't re-fire
  // on every unrelated draft write — `useDraftsFromStore` hands back a fresh
  // array reference each time.
  const scopesSignature = useMemo(() => {
    const scopes = new Set<string>()
    for (const draft of allDrafts) scopes.add(draft.scope)
    return [...scopes].sort().join("|")
  }, [allDrafts])

  // Check if we have any thread drafts that need parent message resolution, so
  // we only run the (expensive) events query when there are thread-scoped
  // drafts. Prefix-checking each `|`-split segment avoids false positives on a
  // scope that merely contains the substring `thread:` in a non-prefix spot.
  const hasThreadDrafts = useMemo(
    () => scopesSignature.split("|").some((scope) => scope.startsWith("thread:")),
    [scopesSignature]
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

  const draftsById = useMemo(() => {
    const map = new Map<string, CachedDraft>()
    for (const draft of allDrafts) map.set(draft.id, draft)
    return map
  }, [allDrafts])

  // E2E draft rows that need a decrypt-on-read preview — every sealed row (loaded
  // or stashed) plus the loaded draft of an E2E scratchpad (its own encrypted
  // root). Resolved here once and decrypted through the shared cache so the
  // explorer lists encrypted drafts with readable previews instead of dropping
  // them (their `contentJson` is the empty placeholder at rest).
  const previewInputs = useMemo((): DraftPreviewInput[] => {
    const inputs: DraftPreviewInput[] = []
    for (const scratchpad of draftScratchpads ?? []) {
      const loadedId = loadedByScope.get(`stream:${scratchpad.id}`) ?? null
      const loadedDraft = loadedId ? draftsById.get(loadedId) : undefined
      if (loadedDraft?.ciphertext != null) inputs.push({ draft: loadedDraft, rootStreamId: scratchpad.id })
    }
    for (const draft of allDrafts) {
      if (draft.ciphertext == null) continue
      const parsed = parseDraftMessageKey(draft.scope)
      if (!parsed) continue
      // Scratchpad-scoped rows are handled above (the loaded one); skip siblings.
      if (parsed.type === "stream" && isDraftId(parsed.id)) continue
      // No resolvable encrypted root (e.g. a thread whose parent isn't cached yet)
      // → don't queue a decrypt that can never fire; the row shows "Encrypted
      // draft" until the root resolves, rather than a stuck "Decrypting…".
      const rootStreamId = resolveRootStreamId(parsed, streamMap, messageToStreamMap)
      if (!rootStreamId) continue
      inputs.push({ draft, rootStreamId })
    }
    return inputs
  }, [allDrafts, draftScratchpads, loadedByScope, draftsById, streamMap, messageToStreamMap])

  const previewMap = useDecryptedDraftPreviews(workspaceId, previewInputs)

  // Combine and transform drafts
  const drafts = useMemo((): UnifiedDraft[] => {
    const result: UnifiedDraft[] = []

    // Scratchpads (streams not yet created on the server). Their content is the
    // loaded draft for the `stream:{scratchpadId}` scope.
    for (const scratchpad of draftScratchpads ?? []) {
      const scope = `stream:${scratchpad.id}`
      const loadedId = loadedByScope.get(scope) ?? null
      const loadedDraft = loadedId ? draftsById.get(loadedId) : undefined

      const isE2e = loadedDraft?.ciphertext != null
      const hasContent = !isEmptyContent(loadedDraft?.contentJson)
      const hasAttachments = (loadedDraft?.attachments?.length ?? 0) > 0

      if (loadedDraft && (hasContent || hasAttachments || isE2e)) {
        const displayName = scratchpad.displayName ?? streamFallbackLabel("scratchpad", "sidebar")
        result.push({
          id: scratchpad.id,
          type: "scratchpad",
          streamId: scratchpad.id,
          displayName,
          preview: draftPreviewLabel(loadedDraft, previewMap),
          attachmentCount: loadedDraft?.attachments?.length ?? 0,
          updatedAt: loadedDraft?.clientUpdatedAt ?? scratchpad.createdAt,
          href: `/w/${workspaceId}/s/${scratchpad.id}`,
          groupLabel: displayName,
          isStashed: false,
          companionMode: scratchpad.companionMode,
        })
      }
    }

    // Every other draft — channels, DMs, threads — loaded (ambient) or stashed.
    for (const draft of allDrafts) {
      const parsed = parseDraftMessageKey(draft.scope)
      if (!parsed) continue

      // Scratchpad-scoped drafts: the loaded one is handled above; any stash
      // siblings are skipped in the explorer until the scratchpad flow itself
      // supports them.
      if (parsed.type === "stream" && isDraftId(parsed.id)) continue

      // An E2E draft's `contentJson` is the empty placeholder (the body is sealed),
      // so it counts as content on the strength of its ciphertext — otherwise it
      // would be dropped from the explorer entirely.
      const isE2e = draft.ciphertext != null
      const hasContent = !isEmptyContent(draft.contentJson)
      const hasAttachments = (draft.attachments?.length ?? 0) > 0
      if (!isE2e && !hasContent && !hasAttachments) continue

      const resolved = resolveDraftLocation(parsed, workspaceId, streamMap, messageToStreamMap)
      const isStashed = (loadedByScope.get(draft.scope) ?? null) !== draft.id

      // A stashed row deep-links via `?stash=<draftId>` so the composer host
      // pops + restores it on mount; the loaded (ambient) row navigates plainly
      // since its content is already checked out.
      const href =
        isStashed && resolved.href
          ? resolved.href + (resolved.href.includes("?") ? "&" : "?") + `stash=${encodeURIComponent(draft.id)}`
          : resolved.href

      result.push({
        id: draft.id,
        type: resolved.draftType,
        streamId: resolved.streamId,
        displayName: resolved.displayName,
        preview: draftPreviewLabel(draft, previewMap),
        attachmentCount: draft.attachments?.length ?? 0,
        updatedAt: draft.clientUpdatedAt,
        href,
        groupLabel: resolved.groupLabel,
        isStashed,
      })
    }

    // Sort by recency (most recent first). The drafts-page renderer groups
    // by `groupLabel` post-sort, so the first appearance of each label wins
    // its section position — streams with recent activity float to the top.
    result.sort((a, b) => b.updatedAt - a.updatedAt)

    return result
  }, [draftScratchpads, allDrafts, draftsById, loadedByScope, streamMap, messageToStreamMap, previewMap, workspaceId])

  // Delete a draft by its `UnifiedDraft.id`. Scratchpad rows carry a scratchpad
  // id; every other row carries a unified draft id — both `draft_`-prefixed, so
  // we disambiguate by table lookup rather than prefix.
  const deleteDraft = useCallback(
    async (draftId: string) => {
      // A scratchpad row is an unpromoted draft STREAM (its own entity), so
      // deleting it removes the stream and purges its content drafts.
      const scratchpad = await db.draftScratchpads.get(draftId)
      if (scratchpad) {
        await db.draftScratchpads.delete(draftId)
        deleteDraftScratchpadFromCache(workspaceId, draftId)
        await purgeScopeDrafts(workspaceId, `stream:${draftId}`)
        syncEngine?.kickOperationQueue()
        return
      }

      // A draft is a draft — loaded or stashed, deletion is one path. The same
      // `deleteDraftById` the in-composer stash list uses (so the two delete
      // surfaces can't drift); it clears the loaded pointer when the row was the
      // one checked into a composer. The kick drains the queued server delete
      // now so the removal reaches the author's other devices instead of sitting
      // until the next reconnect.
      await deleteDraftById(workspaceId, draftId)
      syncEngine?.kickOperationQueue()
    },
    [workspaceId, syncEngine]
  )

  return {
    drafts,
    draftCount: drafts.length,
    deleteDraft,
  }
}
