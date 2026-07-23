import { useLiveQuery } from "dexie-react-hooks"
import { useCallback, useMemo } from "react"
import { db, type CachedBoardPost, type CachedDraft, type CachedStream } from "@/db"
import { createConversationPanelId } from "@/contexts"
import { parseBoardDraftKey, type ParsedBoardDraftKey } from "@/lib/board/draft-keys"
import { THREAD_ANCHORABLE_EVENT_TYPES, type CompanionMode } from "@threa/types"
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
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { getStreamName, streamFallbackLabel, streamLabel } from "@/lib/streams"
import { draftInlineText, draftPreviewStatusLabel } from "@/lib/drafts/decryption"
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
 * - "thread:{anchorId}" for thread replies (anchor is a message or card canonical id)
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
 * A draft carries real, unsent payload: a non-empty body, an attachment, or a
 * sealed E2E body (whose plaintext `contentJson` is the empty placeholder at
 * rest, so it counts on the strength of its ciphertext). The single
 * qualification predicate shared by the explorer build and the sidebar summary
 * so a draft counts identically in both — the badge can't drift from the list.
 */
function draftHasPayload(draft: CachedDraft): boolean {
  return draft.ciphertext != null || !isEmptyContent(draft.contentJson) || (draft.attachments?.length ?? 0) > 0
}

/**
 * The explorer preview for a draft row. Plaintext rows read `contentJson`
 * directly; E2E rows (ciphertext at rest) read the decrypted body from the shared
 * cache via `previewMap`, falling back to a status label so a sealed draft still
 * shows up identifiably instead of as a blank/empty row (the bug this fixes).
 */
function draftPreviewLabel(draft: CachedDraft, previewMap: Map<string, DraftPreview>): string {
  if (draft.ciphertext == null) return truncatePreview(draftInlineText(draft.contentJson))
  const preview = previewMap.get(draft.id)
  if (!preview) return "Encrypted draft"
  if (preview.status !== "ready") return draftPreviewStatusLabel(preview.status)
  return truncatePreview(preview.text) || "Encrypted draft"
}

/** The encrypted root whose SSK seals a draft's body, for decrypt-on-read previews. */
function resolveRootStreamId(
  parsed: { type: "stream" | "thread"; id: string },
  streamMap: Map<string, CachedStream>,
  messageToStreamMap: Map<string, { streamId: string; anchorId: string }>
): string | null {
  if (parsed.type === "thread") {
    const info = messageToStreamMap.get(parsed.id)
    if (!info) return null
    return streamMap.get(info.streamId)?.rootStreamId ?? info.streamId
  }
  return streamMap.get(parsed.id)?.rootStreamId ?? parsed.id
}

/**
 * Whether a stream is archived — directly, or because it descends from an
 * archived root. Archiving marks only the root row (a thread stays "active" and
 * inherits archival via `rootStreamId`), so a thread at any depth under an
 * archived root resolves as archived here; this mirrors the sidebar's
 * `isSidebarStreamVisible` archived rule. Callers pass a draft's resolved host
 * stream id (channel/DM/thread-parent/board-anchor). An unresolved id (`null`,
 * or a stream not in cache) is treated as not-archived, so a draft is never
 * hidden on missing data.
 */
function isStreamArchived(
  streamId: string | null,
  streamMap: Map<string, CachedStream>,
  archivedStreamIds: ReadonlySet<string>
): boolean {
  if (!streamId) return false
  const stream = streamMap.get(streamId)
  if (!stream) return false
  if (stream.archivedAt) return true
  return stream.rootStreamId != null && archivedStreamIds.has(stream.rootStreamId)
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
  messageToStreamMap: Map<string, { streamId: string; anchorId: string }>
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

/** A board draft's host stream type, for the explorer's type-driven rendering. */
function streamDraftType(stream: CachedStream | undefined): DraftType {
  return stream && isValidDraftType(stream.type) ? stream.type : "channel"
}

/**
 * Location resolution for `board:*` draft scopes (the board's inline reply
 * composers). Every kind deep-links to the conversation panel that HOSTS the
 * draft's composer — a reply to its own conversation, a branch reply to the
 * branch's parent, a sub-topic to the conversation containing the fork message
 * — so the `?stash=` restore always lands where a consumer can auto-open the
 * form. A conversation not yet in the local cache (a roamed draft on a fresh
 * device) keeps a generic label but still links via the board route, whose
 * panel fetches the post by id, so cross-device pickup never dead-ends.
 * `supportsStashRestore` is false only where no consumer surface is known (a
 * branch whose parent isn't resolvable, a fork message in no cached
 * conversation) — those rows navigate plainly for manual pickup.
 */
function resolveBoardDraftLocation(
  parsed: ParsedBoardDraftKey,
  workspaceId: string,
  streamMap: Map<string, CachedStream>,
  boardPostMap: Map<string, CachedBoardPost>,
  subtopicHostByMessageId: Map<string, CachedBoardPost>,
  parentPostByBranchConversationId: Map<string, CachedBoardPost>
): ResolvedDraftLocation & { supportsStashRestore: boolean } {
  const panelHref = (conversationId: string, anchorStreamId: string | null) => {
    const panelParam = `panel=${encodeURIComponent(createConversationPanelId(conversationId))}`
    return anchorStreamId
      ? `/w/${workspaceId}/s/${anchorStreamId}?${panelParam}`
      : `/w/${workspaceId}/board?${panelParam}`
  }

  if (parsed.kind === "subtopic") {
    const host = subtopicHostByMessageId.get(parsed.messageId)
    const stream = streamMap.get(parsed.streamId)
    const context = host?.conversation.topicSummary ?? (stream ? streamLabel(stream, "sidebar") : null)
    const displayName = context ? `New sub-topic in ${context}` : "New sub-topic"
    return {
      draftType: streamDraftType(stream),
      streamId: parsed.streamId,
      displayName,
      href: host
        ? panelHref(host.id, host.conversation.streamId)
        : `/w/${workspaceId}/s/${parsed.streamId}?m=${parsed.messageId}`,
      groupLabel: displayName,
      supportsStashRestore: host !== undefined,
    }
  }

  const post = boardPostMap.get(parsed.conversationId)
  const anchorStreamId = post?.conversation.streamId ?? null
  const stream = anchorStreamId ? streamMap.get(anchorStreamId) : undefined
  const target = post?.conversation.topicSummary ?? (stream ? streamLabel(stream, "sidebar") : null)
  const displayName = target ? `Reply in ${target}` : "Conversation reply"
  const shared = { draftType: streamDraftType(stream), streamId: anchorStreamId, displayName, groupLabel: displayName }

  if (parsed.kind === "branch-reply") {
    // The branch-tail composer lives on the parent conversation's surface —
    // derived structurally (anchor thread's parent message → its conversation).
    const parent = parentPostByBranchConversationId.get(parsed.conversationId)
    if (parent) {
      return { ...shared, href: panelHref(parent.id, parent.conversation.streamId), supportsStashRestore: true }
    }
    // Parent unresolvable (branch or its thread not cached): the branch's own
    // panel at least shows the conversation for manual pickup.
    return { ...shared, href: panelHref(parsed.conversationId, anchorStreamId), supportsStashRestore: false }
  }

  return { ...shared, href: panelHref(parsed.conversationId, anchorStreamId), supportsStashRestore: true }
}

/**
 * Stream ids whose composer holds a *loaded* (checked-in, non-stashed) draft,
 * derived from {@link useAllDrafts} output. A stashed draft holds no composer
 * pointer for its scope, so it is excluded — the sidebar hint marks only streams
 * the user stepped away from without stashing. Thread replies and scratchpads are
 * excluded too: a thread draft is not the stream's own composer draft, and a
 * scratchpad is itself a draft. Empty drafts are already dropped upstream, so a
 * row here is real, unsent content.
 */
export function streamIdsWithLoadedDraft(drafts: UnifiedDraft[]): Set<string> {
  const ids = new Set<string>()
  for (const draft of drafts) {
    if (draft.isStashed || !draft.streamId) continue
    if (draft.type === "thread" || draft.type === "scratchpad") continue
    ids.add(draft.streamId)
  }
  return ids
}

/**
 * Map of a thread draft's parent message id → its host stream, built from cached
 * `message_created` events. Shared by the explorer ({@link useAllDrafts}) and the
 * sidebar badge ({@link useDraftSummary}) so both resolve a
 * `thread:{parentMessageId}` draft's host stream — and therefore its archival —
 * the same way. The events read is gated on a thread-scoped draft existing: with
 * none it returns an empty map without subscribing to `db.events`, so the
 * always-mounted sidebar pays nothing in the common case. A parent not yet in
 * cache resolves to no entry (the draft counts, degrading to visible rather than
 * being hidden on missing data).
 */
function useDraftThreadStreamMap(
  allDrafts: CachedDraft[],
  cachedStreams: CachedStream[] | undefined
): Map<string, { streamId: string; anchorId: string }> {
  // Prefix-checking each `|`-split scope avoids false positives on a scope that
  // merely contains the substring `thread:` in a non-prefix spot.
  const hasThreadDrafts = useMemo(() => allDrafts.some((draft) => draft.scope.startsWith("thread:")), [allDrafts])

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

  // Only query events when there are thread drafts, to avoid the expensive scan
  // in the common case.
  const cachedEvents = useLiveQuery(
    () => {
      if (!hasThreadDrafts || !streamIdKey) return []
      return db.events.where("streamId").anyOf(streamIdKey.split(",")).toArray()
    },
    [streamIdKey, hasThreadDrafts],
    []
  )

  // A thread draft keys on its anchor's canonical id: a message anchor is
  // `payload.messageId`; a threadable card anchor is the event's own stable id.
  return useMemo(() => {
    const map = new Map<string, { streamId: string; anchorId: string }>()
    for (const event of cachedEvents ?? []) {
      if (event.eventType === "message_created") {
        const payload = event.payload as { messageId?: string }
        if (payload.messageId) {
          map.set(payload.messageId, { streamId: event.streamId, anchorId: payload.messageId })
        }
      } else if (THREAD_ANCHORABLE_EVENT_TYPES.includes(event.eventType)) {
        map.set(event.id, { streamId: event.streamId, anchorId: event.id })
      }
    }
    return map
  }, [cachedEvents])
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

  // Stable signature over the set of draft scopes so the board-context queries
  // below (gated on the board-scoped ids they reference) don't re-fire on every
  // unrelated draft write — `useDraftsFromStore` hands back a fresh array
  // reference each time.
  const scopesSignature = useMemo(() => {
    const scopes = new Set<string>()
    for (const draft of allDrafts) scopes.add(draft.scope)
    return [...scopes].sort().join("|")
  }, [allDrafts])

  // Build a map of stream ID -> stream for quick lookup
  const streamMap = useMemo(() => {
    const map = new Map<string, CachedStream>()
    for (const stream of cachedStreams ?? []) {
      map.set(stream.id, stream)
    }
    return map
  }, [cachedStreams])

  // Ids of directly-archived streams; a thread inherits archival via its root
  // (see `isStreamArchived`). Drives the archived-draft filter in the loop below.
  const archivedStreamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const stream of cachedStreams ?? []) if (stream.archivedAt) ids.add(stream.id)
    return ids
  }, [cachedStreams])

  // Conversations referenced by board-scoped drafts (`board:reply:` /
  // `board:branch-reply:`), for location resolution. Keyed on the id set (not
  // the drafts array) so a body keystroke doesn't re-fire the query.
  const boardConversationIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const scope of scopesSignature.split("|")) {
      const parsed = parseBoardDraftKey(scope)
      if (parsed && parsed.kind !== "subtopic") ids.add(parsed.conversationId)
    }
    return [...ids].sort().join(",")
  }, [scopesSignature])

  const boardBranchConversationIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const scope of scopesSignature.split("|")) {
      const parsed = parseBoardDraftKey(scope)
      if (parsed?.kind === "branch-reply") ids.add(parsed.conversationId)
    }
    return [...ids].sort().join(",")
  }, [scopesSignature])

  // Sub-topic drafts name only their fork message; branch drafts name a child
  // conversation whose parent must be derived structurally (its anchor thread's
  // parent message → the conversation holding it — sub-topic conversations
  // carry no `parentConversationId`). Both resolve to the HOSTING conversation
  // the explorer deep-links to, since that surface hosts the draft's composer.
  const subtopicMessageIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const scope of scopesSignature.split("|")) {
      const parsed = parseBoardDraftKey(scope)
      if (parsed?.kind === "subtopic") ids.add(parsed.messageId)
    }
    return [...ids].sort().join(",")
  }, [scopesSignature])

  const emptyBoardContext = useMemo(
    () => ({
      posts: [] as CachedBoardPost[],
      hostPostByMessageId: new Map<string, CachedBoardPost>(),
      parentPostByBranchConversationId: new Map<string, CachedBoardPost>(),
    }),
    []
  )

  const boardDraftContext = useLiveQuery(
    async () => {
      if (!boardConversationIdKey && !subtopicMessageIdKey) return emptyBoardContext
      const convIds = boardConversationIdKey ? boardConversationIdKey.split(",") : []
      const branchIds = new Set(boardBranchConversationIdKey ? boardBranchConversationIdKey.split(",") : [])
      const referencedRows = convIds.length > 0 ? await db.conversations.bulkGet(convIds) : []
      const referenced = referencedRows.filter(
        (row): row is CachedBoardPost => row !== undefined && row.workspaceId === workspaceId
      )

      const forkMessageIds = new Set(subtopicMessageIdKey ? subtopicMessageIdKey.split(",") : [])
      const branchPosts = referenced.filter((row) => branchIds.has(row.id))
      const threadRows =
        branchPosts.length > 0 ? await db.streams.bulkGet(branchPosts.map((row) => row.conversation.streamId)) : []
      const forkByBranchConversationId = new Map<string, string>()
      branchPosts.forEach((row, i) => {
        const parentMessageId = threadRows[i]?.parentMessageId
        if (parentMessageId) {
          forkByBranchConversationId.set(row.id, parentMessageId)
          forkMessageIds.add(parentMessageId)
        }
      })

      const hostPostByMessageId = new Map<string, CachedBoardPost>()
      let hostRows: CachedBoardPost[] = []
      if (forkMessageIds.size > 0) {
        const rows = await db.conversations.where("workspaceId").equals(workspaceId).toArray()
        hostRows = rows.filter((row) => row.conversation.messageIds?.some((id: string) => forkMessageIds.has(id)))
        for (const post of hostRows) {
          for (const id of post.conversation.messageIds ?? []) {
            if (forkMessageIds.has(id)) hostPostByMessageId.set(id, post)
          }
        }
      }
      const parentPostByBranchConversationId = new Map<string, CachedBoardPost>()
      for (const [branchId, forkId] of forkByBranchConversationId) {
        const host = hostPostByMessageId.get(forkId)
        if (host) parentPostByBranchConversationId.set(branchId, host)
      }
      return { posts: [...referenced, ...hostRows], hostPostByMessageId, parentPostByBranchConversationId }
    },
    [boardConversationIdKey, boardBranchConversationIdKey, subtopicMessageIdKey, workspaceId, emptyBoardContext],
    emptyBoardContext
  )

  const cachedBoardPosts = boardDraftContext.posts
  const subtopicHostByMessageId = boardDraftContext.hostPostByMessageId
  const parentPostByBranchConversationId = boardDraftContext.parentPostByBranchConversationId

  const boardPostMap = useMemo(() => {
    const map = new Map<string, CachedBoardPost>()
    for (const post of cachedBoardPosts ?? []) map.set(post.id, post)
    return map
  }, [cachedBoardPosts])

  // Parent-message → host-stream map for thread drafts (shared with the sidebar
  // badge so both resolve thread-draft location/archival identically).
  const messageToStreamMap = useDraftThreadStreamMap(allDrafts, cachedStreams)

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

      if (loadedDraft && draftHasPayload(loadedDraft)) {
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

    // Every other draft — channels, DMs, threads, board replies — loaded
    // (ambient) or stashed.
    for (const draft of allDrafts) {
      const parsed = parseDraftMessageKey(draft.scope)
      const board = parsed ? null : parseBoardDraftKey(draft.scope)
      if (!parsed && !board) continue

      // Scratchpad-scoped drafts: the loaded one is handled above; any stash
      // siblings are skipped in the explorer until the scratchpad flow itself
      // supports them.
      if (parsed && parsed.type === "stream" && isDraftId(parsed.id)) continue

      if (!draftHasPayload(draft)) continue

      const boardResolved = board
        ? resolveBoardDraftLocation(
            board,
            workspaceId,
            streamMap,
            boardPostMap,
            subtopicHostByMessageId,
            parentPostByBranchConversationId
          )
        : null
      const resolved = parsed
        ? resolveDraftLocation(parsed, workspaceId, streamMap, messageToStreamMap)
        : boardResolved!

      // Hide drafts whose host stream is archived — a channel/DM directly, a
      // thread or board reply via its resolved parent/anchor stream, and any
      // nested thread through the root check inside `isStreamArchived`.
      if (isStreamArchived(resolved.streamId, streamMap, archivedStreamIds)) continue

      const isStashed = (loadedByScope.get(draft.scope) ?? null) !== draft.id

      // A stashed row deep-links via `?stash=<draftId>` so the composer host
      // pops + restores it on arrival; the loaded (ambient) row navigates
      // plainly since its content is already checked out. Board rows carry the
      // param only when a consumer surface was resolved (see
      // `resolveBoardDraftLocation`).
      const supportsStashRestore = parsed !== null || boardResolved!.supportsStashRestore
      const href =
        isStashed && resolved.href && supportsStashRestore
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
  }, [
    draftScratchpads,
    allDrafts,
    draftsById,
    loadedByScope,
    streamMap,
    archivedStreamIds,
    messageToStreamMap,
    boardPostMap,
    subtopicHostByMessageId,
    parentPostByBranchConversationId,
    previewMap,
    workspaceId,
  ])

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

export interface DraftSummary {
  /** Total unsent drafts for the workspace (matches the drafts-explorer row count). */
  draftCount: number
  /**
   * Comma-joined, sorted stream ids whose composer holds an unsent loaded
   * (non-stashed) draft. A string, not a Set, so a consumer can memoize on it
   * by value: it changes only when the *set* of streams-with-a-draft changes,
   * not when a draft's body changes — keeping the sidebar's per-row map stable
   * across keystrokes.
   */
  loadedDraftStreamIdSignature: string
}

/**
 * Lightweight draft rollup for the sidebar — the badge count plus which streams
 * carry an unsent loaded draft. Derived straight from the raw draft store with
 * NO preview building, sealed-body decryption, location resolution, or sort, so
 * a keystroke's debounced draft save doesn't rebuild the full {@link useAllDrafts}
 * explorer model (which it does on every change) just to read two values off it.
 * Shares {@link draftHasPayload}, {@link isStreamArchived}, and
 * {@link useDraftThreadStreamMap} with the explorer, so archived channel/DM AND
 * thread-reply drafts (including nested threads under an archived root) are hidden
 * from the badge and the list alike. The shared thread map reads `db.events` only
 * when a thread draft exists, so the always-mounted sidebar stays cheap otherwise.
 * Board drafts still resolve their host stream only in the explorer (that needs
 * the conversation lookups), so the badge can over-count a board reply under an
 * archived root — rare, and the explorer still hides it.
 */
export function useDraftSummary(workspaceId: string): DraftSummary {
  const draftScratchpads = useDraftScratchpadsFromStore(workspaceId)
  const allDrafts = useDraftsFromStore(workspaceId)
  const composerLoaded = useComposerLoadedFromStore(workspaceId)
  const cachedStreams = useWorkspaceStreams(workspaceId)

  const loadedByScope = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const row of composerLoaded) map.set(row.scope, row.draftId)
    return map
  }, [composerLoaded])

  const draftsById = useMemo(() => {
    const map = new Map<string, CachedDraft>()
    for (const draft of allDrafts) map.set(draft.id, draft)
    return map
  }, [allDrafts])

  // Stream map + archived-id set from the already-loaded workspace streams
  // (cheap; no events/conversation queries), so the badge filters archived
  // channel/DM drafts in step with the explorer.
  const streamMap = useMemo(() => {
    const map = new Map<string, CachedStream>()
    for (const stream of cachedStreams ?? []) map.set(stream.id, stream)
    return map
  }, [cachedStreams])

  const archivedStreamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const stream of cachedStreams ?? []) if (stream.archivedAt) ids.add(stream.id)
    return ids
  }, [cachedStreams])

  // Parent-message → host-stream map for thread drafts, so the badge hides a
  // thread reply under an archived root in step with the explorer. Gated on a
  // thread draft existing (see `useDraftThreadStreamMap`), so the always-mounted
  // sidebar reads no events until the user actually has one.
  const messageToStreamMap = useDraftThreadStreamMap(allDrafts, cachedStreams)

  return useMemo(() => {
    let draftCount = 0
    const loadedDraftStreamIds = new Set<string>()

    // Scratchpads count via their loaded draft (the `stream:{scratchpadId}` scope).
    for (const scratchpad of draftScratchpads ?? []) {
      const loadedId = loadedByScope.get(`stream:${scratchpad.id}`) ?? null
      const loadedDraft = loadedId ? draftsById.get(loadedId) : undefined
      if (loadedDraft && draftHasPayload(loadedDraft)) draftCount++
    }

    for (const draft of allDrafts) {
      const parsed = parseDraftMessageKey(draft.scope)
      if (!parsed) {
        // Board-composer drafts count toward the badge like any other (the
        // explorer lists them), but carry no per-stream sidebar hint — the
        // draft belongs to a conversation composer, not the stream's own.
        if (parseBoardDraftKey(draft.scope) && draftHasPayload(draft)) draftCount++
        continue
      }
      // Scratchpad-scoped rows are counted above; skip them and their siblings.
      if (parsed.type === "stream" && isDraftId(parsed.id)) continue
      if (!draftHasPayload(draft)) continue
      // Hide archived drafts: a channel/DM directly (`parsed.id` is the stream),
      // a thread reply via its parent message's host stream (nested threads
      // caught by the root check inside `isStreamArchived`). Board drafts still
      // aren't resolved here, so one under an archived root stays counted — the
      // explorer still hides it.
      const hostStreamId = parsed.type === "thread" ? (messageToStreamMap.get(parsed.id)?.streamId ?? null) : parsed.id
      if (isStreamArchived(hostStreamId, streamMap, archivedStreamIds)) continue
      draftCount++
      // A non-thread stream draft that is the loaded (not stashed) one for its
      // scope surfaces as the per-row "unsent draft" hint — mirrors
      // `streamIdsWithLoadedDraft` over the built explorer list.
      if (parsed.type === "stream" && loadedByScope.get(draft.scope) === draft.id) {
        loadedDraftStreamIds.add(parsed.id)
      }
    }

    return { draftCount, loadedDraftStreamIdSignature: [...loadedDraftStreamIds].sort().join(",") }
  }, [draftScratchpads, allDrafts, loadedByScope, draftsById, streamMap, archivedStreamIds, messageToStreamMap])
}
