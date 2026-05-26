import { useCallback, useEffect, useMemo } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { db, sequenceToNum, type CachedStream } from "@/db"
import { useStreamService, useMessageService, usePendingMessages } from "@/contexts"
import { useUser } from "@/auth"
import { getE2eSessionState } from "@/stores/e2e-session-store"
import { encryptMessage } from "@/lib/crypto/message-envelope"
import { useStreamBootstrap, streamKeys } from "./use-streams"
import { workspaceKeys } from "./use-workspaces"
import { useDraftScratchpads } from "./use-draft-scratchpads"
import { useQueueDraftMessage } from "./use-queue-draft-message"
import { useWorkspaceUsers, useWorkspaceStreams, useWorkspaceDmPeers } from "@/stores/workspace-store"
import { useSyncEngine } from "@/sync/sync-engine"
import { deleteDraftMessageFromCache, hasSeededDraftCache, upsertDraftMessageInCache } from "@/stores/draft-store"
import { type AttachmentSummary } from "./create-optimistic-bootstrap"
import { resolveDmDisplayName } from "@/lib/streams"
import { serializeToMarkdown } from "@threa/prosemirror"
import { onDraftPromoted } from "@/lib/draft-promotions"
import type {
  Stream,
  StreamMember,
  StreamType,
  CompanionMode,
  StreamEvent,
  JSONContent,
  WorkspaceBootstrap,
  StreamWithPreview,
} from "@threa/types"
import { StreamTypes, Visibilities, CompanionModes } from "@threa/types"

const DM_DRAFT_PREFIX = "draft_dm_"

export function generateClientId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `temp_${timestamp}${random}`
}

export function isDraftId(id: string): boolean {
  return id.startsWith("draft_")
}

export function createDmDraftId(userId: string): string {
  return `${DM_DRAFT_PREFIX}${userId}`
}

export function isDmDraftId(id: string): boolean {
  return id.startsWith(DM_DRAFT_PREFIX)
}

export function getDmDraftUserId(id: string): string | null {
  if (!isDmDraftId(id)) return null
  const userId = id.slice(DM_DRAFT_PREFIX.length)
  return userId.length > 0 ? userId : null
}

function resolveRealDmDisplayName(
  streamId: string,
  streamDisplayName: string | null,
  idbStreams: Array<{ id: string; displayName: string | null }>,
  idbUsers: Array<{ id: string; name: string }>,
  idbDmPeers: Array<{ streamId: string; userId: string }>
): string | null {
  // Try resolving from the DM peer user first (most reliable for DMs).
  const peerName = resolveDmDisplayName(streamId, idbUsers, idbDmPeers)
  if (peerName) return peerName

  // Fall back to workspace-level cached displayName.
  const workspaceName = idbStreams.find((stream) => stream.id === streamId)?.displayName
  if (workspaceName) return workspaceName

  return streamDisplayName
}

function toCachedStream(stream: Stream, previous: CachedStream | undefined): CachedStream {
  return {
    ...previous,
    ...stream,
    lastMessagePreview: previous?.lastMessagePreview ?? null,
    pinned: previous?.pinned,
    notificationLevel: previous?.notificationLevel ?? null,
    lastReadEventId: previous?.lastReadEventId ?? null,
    _cachedAt: Date.now(),
  }
}

export interface VirtualStream {
  id: string
  workspaceId: string
  type: StreamType
  slug?: string | null
  displayName: string | null
  companionMode: CompanionMode
  isDraft: boolean
  parentStreamId: string | null
  parentMessageId: string | null
  rootStreamId: string | null
  archivedAt: string | null
}

export interface SendMessageInput {
  contentJson: JSONContent
  attachmentIds?: string[]
  /** Full attachment info for optimistic UI - required when attachmentIds is provided */
  attachments?: AttachmentSummary[]
}

export interface UseStreamOrDraftReturn {
  stream: VirtualStream | undefined
  isLoading: boolean
  isDraft: boolean
  error: Error | null

  rename: (newName: string) => Promise<void>
  archive: () => Promise<void>
  unarchive?: () => Promise<void>
  sendMessage: (input: SendMessageInput) => Promise<{ navigateTo?: string; replace?: boolean }>
}

/**
 * Implementation for draft streams (stored in IndexedDB).
 */
function useDraftStream(workspaceId: string, streamId: string, enabled: boolean): UseStreamOrDraftReturn {
  const navigate = useNavigate()
  const { queueDraftMessage, currentUserId } = useQueueDraftMessage(workspaceId)
  const { getDraft, updateDraft, deleteDraft } = useDraftScratchpads(workspaceId)
  const draft = enabled ? getDraft(streamId) : undefined

  const stream: VirtualStream | undefined = draft
    ? {
        id: draft.id,
        workspaceId: draft.workspaceId,
        type: StreamTypes.SCRATCHPAD,
        displayName: draft.displayName,
        companionMode: draft.companionMode,
        isDraft: true,
        parentStreamId: null,
        parentMessageId: null,
        rootStreamId: null,
        archivedAt: null,
      }
    : undefined

  const rename = useCallback(
    async (newName: string) => {
      await updateDraft(streamId, { displayName: newName })
    },
    [streamId, updateDraft]
  )

  const archive = useCallback(async () => {
    await deleteDraft(streamId)
    navigate(`/w/${workspaceId}`)
  }, [deleteDraft, streamId, workspaceId, navigate])

  // Listen for draft promotion and navigate to the real stream
  useEffect(() => {
    return onDraftPromoted((promotion) => {
      if (promotion.draftId === streamId && promotion.workspaceId === workspaceId) {
        navigate(`/w/${workspaceId}/s/${promotion.realStreamId}`, { replace: true })
      }
    })
  }, [streamId, workspaceId, navigate])

  const sendMessage = useCallback(
    async (input: SendMessageInput): Promise<{ navigateTo?: string; replace?: boolean }> => {
      if (!currentUserId) {
        throw new Error("Cannot send message: user identity not resolved yet")
      }

      const draftData = await db.draftScratchpads.get(streamId)
      const companionMode = draftData?.companionMode ?? "on"

      await queueDraftMessage(input, {
        workspaceId,
        streamId,
        streamCreation: {
          type: StreamTypes.SCRATCHPAD,
          displayName: draftData?.displayName ?? undefined,
          companionMode,
        },
        draftId: streamId,
      })

      // Navigation is handled by the promotion listener above
      return {}
    },
    [streamId, workspaceId, currentUserId, queueDraftMessage]
  )

  return {
    stream,
    isLoading: enabled && draft === undefined && !hasSeededDraftCache(workspaceId),
    isDraft: true,
    error: null,
    rename,
    archive,
    sendMessage,
  }
}

/**
 * Implementation for virtual DM drafts.
 * The stream is created lazily on first message via backend find-or-create.
 */
function useDraftDmStream(workspaceId: string, streamId: string, enabled: boolean): UseStreamOrDraftReturn {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const messageService = useMessageService()
  const syncEngine = useSyncEngine()
  const user = useUser()
  const idbUsers = useWorkspaceUsers(workspaceId)
  const idbDmPeers = useWorkspaceDmPeers(workspaceId)

  const targetUserId = getDmDraftUserId(streamId)
  const targetUser = idbUsers.find((u) => u.id === targetUserId) ?? null
  const targetUserName = targetUser?.name ?? null
  const currentUserId = idbUsers.find((u) => u.workosUserId === user?.id)?.id ?? null
  const existingDmStreamId =
    targetUserId && currentUserId ? idbDmPeers.find((peer) => peer.userId === targetUserId)?.streamId : null

  useEffect(() => {
    if (!enabled || !existingDmStreamId) return
    let cancelled = false
    const draftKey = `stream:${streamId}`
    const realStreamKey = `stream:${existingDmStreamId}`

    const migrateDraftAndNavigate = async () => {
      if (draftKey !== realStreamKey) {
        const draft = await db.draftMessages.get(draftKey)
        if (draft) {
          const existingDraft = await db.draftMessages.get(realStreamKey)
          if (!existingDraft || existingDraft.updatedAt < draft.updatedAt) {
            const migratedDraft = { ...draft, id: realStreamKey }
            await db.draftMessages.put(migratedDraft)
            upsertDraftMessageInCache(workspaceId, migratedDraft)
          }
          await db.draftMessages.delete(draftKey)
          deleteDraftMessageFromCache(workspaceId, draftKey)
        }
      }

      if (!cancelled) {
        navigate(`/w/${workspaceId}/s/${existingDmStreamId}`, { replace: true })
      }
    }

    void migrateDraftAndNavigate()

    return () => {
      cancelled = true
    }
  }, [enabled, existingDmStreamId, navigate, streamId, workspaceId])

  const stream: VirtualStream | undefined =
    enabled && targetUserId
      ? {
          id: streamId,
          workspaceId,
          type: StreamTypes.DM,
          displayName: targetUser?.name ?? "Direct message",
          companionMode: "off",
          isDraft: true,
          parentStreamId: null,
          parentMessageId: null,
          rootStreamId: null,
          archivedAt: null,
        }
      : undefined

  const rename = useCallback(async () => {}, [])

  const archive = useCallback(async () => {
    await db.draftMessages.delete(`stream:${streamId}`)
    deleteDraftMessageFromCache(workspaceId, `stream:${streamId}`)
    navigate(`/w/${workspaceId}`)
  }, [streamId, workspaceId, navigate])

  const sendMessage = useCallback(
    async (input: SendMessageInput): Promise<{ navigateTo?: string; replace?: boolean }> => {
      if (!targetUserId) {
        throw new Error("Invalid DM draft target")
      }

      const contentMarkdown = serializeToMarkdown(input.contentJson)
      const message = await messageService.createDm(workspaceId, targetUserId, {
        dmUserId: targetUserId,
        contentJson: input.contentJson,
        contentMarkdown,
        attachmentIds: input.attachmentIds,
      })

      const now = Date.now()
      const optimisticStream: CachedStream = {
        id: message.streamId,
        workspaceId,
        type: StreamTypes.DM,
        displayName: targetUserName ?? "Direct message",
        slug: null,
        description: null,
        visibility: Visibilities.PRIVATE,
        parentStreamId: null,
        parentMessageId: null,
        rootStreamId: null,
        companionMode: CompanionModes.OFF,
        companionPersonaId: null,
        createdBy: message.authorId,
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
        archivedAt: null,
        lastMessagePreview: {
          authorId: message.authorId,
          authorType: message.authorType,
          content: message.contentMarkdown,
          createdAt: message.createdAt,
        },
        _cachedAt: now,
      }

      await db.transaction("rw", [db.streams, db.streamMemberships, db.dmPeers], async () => {
        await db.streams.put(optimisticStream)

        if (currentUserId) {
          await db.streamMemberships.put({
            id: `${workspaceId}:${message.streamId}`,
            workspaceId,
            streamId: message.streamId,
            memberId: currentUserId,
            pinned: false,
            pinnedAt: null,
            notificationLevel: null,
            lastReadEventId: null,
            lastReadAt: null,
            joinedAt: message.createdAt,
            _cachedAt: now,
          })
        }

        await db.dmPeers.put({
          id: `${workspaceId}:${message.streamId}`,
          workspaceId,
          userId: targetUserId,
          streamId: message.streamId,
          _cachedAt: now,
        })
      })

      void syncEngine.subscribeStream(message.streamId)

      // Keep sidebar state consistent immediately on sender side:
      // remove virtual DM draft and set viewer-specific DM name as soon as streamId is known.
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old

        const optimisticBootstrapStream: StreamWithPreview = {
          ...optimisticStream,
          lastMessagePreview: optimisticStream.lastMessagePreview ?? null,
        }

        const optimisticMembership: StreamMember | null = currentUserId
          ? {
              streamId: message.streamId,
              memberId: currentUserId,
              pinned: false,
              pinnedAt: null,
              notificationLevel: null,
              lastReadEventId: null,
              lastReadAt: null,
              joinedAt: message.createdAt,
            }
          : null

        const hasPeer = old.dmPeers.some((peer) => peer.userId === targetUserId && peer.streamId === message.streamId)

        const streamExists = old.streams.some((stream) => stream.id === message.streamId)
        const streams = streamExists ? old.streams : [...old.streams, optimisticBootstrapStream]

        const membershipExists = old.streamMemberships.some((m) => m.streamId === message.streamId)

        return {
          ...old,
          dmPeers: hasPeer ? old.dmPeers : [...old.dmPeers, { userId: targetUserId, streamId: message.streamId }],
          streams: streams.map((stream) =>
            stream.id === message.streamId && stream.type === StreamTypes.DM
              ? { ...stream, displayName: targetUserName ?? stream.displayName }
              : stream
          ),
          streamMemberships:
            !membershipExists && optimisticMembership
              ? [...old.streamMemberships, optimisticMembership]
              : old.streamMemberships,
        }
      })

      return { navigateTo: `/w/${workspaceId}/s/${message.streamId}`, replace: true }
    },
    [targetUserId, workspaceId, messageService, queryClient, targetUserName, currentUserId, syncEngine]
  )

  return {
    stream,
    isLoading: false,
    isDraft: true,
    error: null,
    rename,
    archive,
    sendMessage,
  }
}

/**
 * Implementation for real streams (stored on server).
 */
function useRealStream(workspaceId: string, streamId: string, enabled: boolean): UseStreamOrDraftReturn {
  const queryClient = useQueryClient()
  const streamService = useStreamService()
  const { markPending, notifyQueue } = usePendingMessages()
  const user = useUser()
  const idbUsers = useWorkspaceUsers(workspaceId)
  const idbStreams = useWorkspaceStreams(workspaceId)
  const idbDmPeers = useWorkspaceDmPeers(workspaceId)
  const currentUserId = idbUsers.find((u) => u.workosUserId === user?.id)?.id ?? null
  const idbStream = useMemo(() => idbStreams.find((stream) => stream.id === streamId), [idbStreams, streamId])

  const {
    data: bootstrap,
    isLoading: isBootstrapLoading,
    error,
  } = useStreamBootstrap(workspaceId, streamId, {
    enabled: enabled && !idbStream,
  })
  const baseStream = idbStream ?? bootstrap?.stream
  const displayName =
    baseStream?.type === StreamTypes.DM
      ? resolveRealDmDisplayName(baseStream.id, baseStream.displayName, idbStreams, idbUsers, idbDmPeers)
      : (baseStream?.displayName ?? null)

  const stream: VirtualStream | undefined = baseStream
    ? {
        id: baseStream.id,
        workspaceId: baseStream.workspaceId,
        type: baseStream.type,
        slug: baseStream.slug,
        displayName,
        companionMode: baseStream.companionMode,
        isDraft: false,
        parentStreamId: baseStream.parentStreamId,
        parentMessageId: baseStream.parentMessageId,
        rootStreamId: baseStream.rootStreamId,
        archivedAt: baseStream.archivedAt,
      }
    : undefined

  const rename = useCallback(
    async (newName: string) => {
      const updatedStream = await streamService.update(workspaceId, streamId, {
        displayName: newName,
      })
      await db.streams.put(toCachedStream(updatedStream, idbStream))

      queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        return { ...old, stream: updatedStream }
      })

      queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        const wsBootstrap = old as { streams?: Array<{ id: string }> }
        if (!wsBootstrap.streams) return old
        return {
          ...wsBootstrap,
          streams: wsBootstrap.streams.map((s) => (s.id === streamId ? { ...s, ...updatedStream } : s)),
        }
      })
    },
    [streamId, workspaceId, streamService, queryClient, idbStream]
  )

  const archive = useCallback(async () => {
    await streamService.archive(workspaceId, streamId)
    const archivedAt = new Date().toISOString()

    // Update IDB (not delete) so useLiveQuery reactively picks up archivedAt.
    // The sidebar filters out streams with archivedAt set.
    await db.streams.update(streamId, { archivedAt })

    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      return {
        ...old,
        stream: {
          ...(old as { stream?: Stream }).stream,
          archivedAt,
        },
      }
    })
  }, [streamId, workspaceId, streamService, queryClient])

  const unarchive = useCallback(async () => {
    await streamService.unarchive(workspaceId, streamId)
    const restoredStream = bootstrap?.stream ?? idbStream
    if (restoredStream) {
      await db.streams.put(toCachedStream({ ...restoredStream, archivedAt: null }, idbStream))
    }

    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      return {
        ...old,
        stream: {
          ...(old as { stream?: Stream }).stream,
          archivedAt: null,
        },
      }
    })

    // Add back to workspace sidebar
    queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
  }, [streamId, workspaceId, streamService, queryClient, bootstrap?.stream, idbStream])

  const sendMessage = useCallback(
    async (input: SendMessageInput): Promise<{ navigateTo?: string }> => {
      if (!currentUserId) {
        throw new Error("Cannot send message: user identity not resolved yet")
      }

      const clientId = generateClientId()
      const now = new Date().toISOString()

      const contentMarkdown = serializeToMarkdown(input.contentJson)

      // Use timestamp as sequence to ensure optimistic events sort after real events
      // Real events have low sequence numbers (1, 2, 3...), timestamps are ~13 digits
      const optimisticSequence = Date.now().toString()

      const optimisticEvent: StreamEvent = {
        id: clientId,
        streamId,
        sequence: optimisticSequence,
        eventType: "message_created",
        payload: {
          messageId: clientId,
          contentMarkdown,
          contentJson: input.contentJson,
          ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        },
        actorId: currentUserId,
        actorType: "user",
        createdAt: now,
      }

      // If the destination is an E2E scratchpad, encrypt the markdown body
      // to the owner's UIK and stash the ciphertext on the pending row. The
      // drain loop is identity-agnostic — encryption happens here, while the
      // unwrapped private key (and the matching pubkey) live in this scope.
      // Read e2e flags off `baseStream` (which already prefers `idbStream` and
      // falls back to the server-resolved row), so a first-load send that
      // arrives before the per-stream IDB row mirrors the workspace-bootstrap
      // row still encrypts instead of writing plaintext that INV-E1 rejects.
      const e2eEnabled = baseStream?.e2eEnabled === true
      const e2eOwnerKeyId = baseStream?.e2eOwnerKeyId
      let e2eFields:
        | Pick<NonNullable<Awaited<ReturnType<typeof encryptMessage>>>, "ciphertext" | "envelope" | "e2eVersion">
        | undefined
      if (e2eEnabled && e2eOwnerKeyId) {
        if (input.attachmentIds && input.attachmentIds.length > 0) {
          // Phase-1 MVP doesn't support encrypted attachments. Fail loud at
          // enqueue rather than silently dropping the ids in the drain loop
          // (which would show the optimistic chip and then never deliver).
          throw new Error("Attachments aren't supported in encrypted scratchpads yet")
        }
        const session = getE2eSessionState(workspaceId, currentUserId)
        if (session.status !== "unlocked" || !session.publicKey) {
          throw new Error("Unlock encrypted scratchpads before sending")
        }
        if (session.keyId !== e2eOwnerKeyId) {
          // The owner of the scratchpad isn't the viewer (or the viewer's UIK
          // rotated past the one the scratchpad was created with). Phase-1
          // MVP encrypts owner-to-self only; a rotation/sharing flow is a
          // follow-up — fail loud rather than write a ciphertext nobody can
          // decrypt.
          throw new Error("Encrypted scratchpad is addressed to a key you no longer hold")
        }
        e2eFields = await encryptMessage({
          contentMarkdown,
          streamId,
          messageId: clientId,
          senderId: currentUserId,
          recipientKeyId: e2eOwnerKeyId,
          recipientPublicKey: session.publicKey,
        })
      }

      markPending(clientId)

      // Persist to IndexedDB — this is the durable enqueue step.
      // The background message queue (useMessageQueue) will pick it up and send it.
      await db.pendingMessages.add({
        clientId,
        workspaceId,
        streamId,
        content: contentMarkdown,
        contentFormat: "markdown",
        contentJson: input.contentJson,
        attachmentIds: input.attachmentIds,
        createdAt: Date.now(),
        retryCount: 0,
        ...(e2eFields ?? {}),
      })

      await db.events.add({
        ...optimisticEvent,
        workspaceId,
        _sequenceNum: sequenceToNum(optimisticEvent.sequence),
        _clientId: clientId,
        _status: "pending",
        _cachedAt: Date.now(),
      })

      // Kick the background queue to start sending
      notifyQueue()

      return {}
    },
    [streamId, workspaceId, queryClient, markPending, notifyQueue, currentUserId, baseStream]
  )

  return {
    stream,
    isLoading: enabled && !stream && isBootstrapLoading,
    isDraft: false,
    error: stream ? null : (error ?? null),
    rename,
    archive,
    unarchive,
    sendMessage,
  }
}

/**
 * Unified hook for working with both draft and real streams.
 *
 * Provides a consistent interface regardless of whether the stream
 * is a local draft (IndexedDB) or a persisted stream (server).
 */
export function useStreamOrDraft(workspaceId: string, streamId: string): UseStreamOrDraftReturn {
  const isDraft = isDraftId(streamId)
  const isDmDraft = isDmDraftId(streamId)
  const isScratchpadDraft = isDraft && !isDmDraft

  // Call both implementations (React hook rules require consistent hook calls)
  // Each implementation no-ops when not enabled
  const draftResult = useDraftStream(workspaceId, streamId, isScratchpadDraft)
  const draftDmResult = useDraftDmStream(workspaceId, streamId, isDmDraft)
  const realResult = useRealStream(workspaceId, streamId, !isDraft)

  if (isDmDraft) return draftDmResult
  if (isScratchpadDraft) return draftResult
  return realResult
}
