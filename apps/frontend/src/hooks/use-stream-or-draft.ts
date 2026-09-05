import { useCallback, useEffect, useMemo, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { db, sequenceToNum, type CachedStream, type DraftScratchpad } from "@/db"
import { useStreamService, useMessageService, usePendingMessages } from "@/contexts"
import { useUser } from "@/auth"
import { type SealStreamMessageResult } from "@/lib/crypto/message-envelope"
import { reviveStaleActorWraps } from "@/lib/crypto/stream-key-cache"
import { sealOutgoingMessage } from "@/lib/crypto/seal-send"
import { useStreamBootstrap, streamKeys } from "./use-streams"
import { workspaceKeys } from "./use-workspaces"
import { useDraftScratchpads } from "./use-draft-scratchpads"
import { useQueueDraftMessage, conversationTag } from "./use-queue-draft-message"
import { useWorkspaceUsers, useWorkspaceStreams, useWorkspaceDmPeers } from "@/stores/workspace-store"
import { useSyncEngine } from "@/sync/sync-engine"
import { getLatestPersistedSequence } from "@/sync/stream-sync"
import { hasSeededDraftCache } from "@/stores/draft-store"
import { getDraftMessageKey, purgeScopeDrafts, upsertLoadedDraft } from "./use-draft-message"
import { type AttachmentSummary } from "./create-optimistic-bootstrap"
import { resolveDmDisplayName } from "@/lib/streams"
import { serializeToMarkdown } from "@threa/prosemirror"
import {
  getDraftPromotionStream,
  getPromotedStreamId,
  onDraftPromoted,
  waitForDraftPromotion,
} from "@/lib/draft-promotions"
import type {
  Stream,
  StreamMember,
  StreamType,
  CompanionMode,
  ComposeTrace,
  ConversationDirective,
  StreamEvent,
  JSONContent,
  WorkspaceBootstrap,
  StreamWithPreview,
  E2eActor,
  ToolPrivacyPolicy,
} from "@threa/types"
import { StreamTypes, Visibilities, CompanionModes } from "@threa/types"
import { nextOptimisticSequence } from "@/lib/optimistic-sequence"
import { useRenameStream } from "./use-rename-stream"

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
    notificationLevel: previous?.notificationLevel ?? null,
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
  parentAnchorId: string | null
  rootStreamId: string | null
  archivedAt: string | null
  /**
   * Server-persisted streams may be end-to-end encrypted. Drafts can't be
   * encrypted (encrypted scratchpads bypass the draft system and are
   * created server-side immediately), so this is always undefined/false on
   * draft virtual streams.
   */
  e2eEnabled?: boolean
  /**
   * Non-human actors the owner invited into this E2E scratchpad. Only
   * meaningful on encrypted scratchpads; undefined on drafts and plaintext
   * streams (treated as an empty set).
   */
  e2eActors?: E2eActor[]
  /**
   * Sealed display name for an E2E stream (base64 ciphertext + its
   * `StreamEnvelope` framing). Carried from the underlying stream so the
   * open-stream header can decrypt it via `useDecryptedStreamName` — the
   * workspace-store overlay covers list surfaces, this covers the single-stream
   * header including the first-open bootstrap path (before the row is in the
   * workspace cache). Null/absent on plaintext streams and drafts.
   */
  sealedNameCiphertext?: string | null
  sealedNameEnvelope?: unknown | null
  /**
   * Tool-privacy policy chosen at creation. On drafts this is the local,
   * not-yet-persisted choice (threaded into the create request on the first
   * message); on server streams it is the current policy. `undefined` =
   * unrestricted.
   */
  allowedToolCategories?: ToolPrivacyPolicy
}

export interface SendMessageInput {
  contentJson: JSONContent
  attachmentIds?: string[]
  /** Full attachment info for optimistic UI - required when attachmentIds is provided */
  attachments?: AttachmentSummary[]
  /** Persist the message first, then dispatch `/steer` in the same server transaction. */
  steer?: true
  /**
   * Files the send into a conversation synchronously ("Reply in conversation",
   * Mechanism C). Only meaningful on real streams — draft paths ignore it, since
   * a stream that doesn't exist yet has no conversations to reply into.
   */
  conversation?: ConversationDirective
  /**
   * Compose-session provenance for this send (see {@link ComposeTrace}).
   * Omitted when the workspace isn't capturing, and by every send the author
   * didn't compose live (scheduled sends, retries, slash-command dispatch).
   */
  composeTrace?: ComposeTrace
}

export interface UseStreamOrDraftReturn {
  stream: VirtualStream | undefined
  isLoading: boolean
  isDraft: boolean
  error: Error | null

  rename: (newName: string) => Promise<void>
  canRename: boolean
  renamePending: boolean
  renameError: Error | null
  archive: () => Promise<void>
  unarchive?: () => Promise<void>
  sendMessage: (input: SendMessageInput) => Promise<{ navigateTo?: string; replace?: boolean }>
  /** The viewer's workspace user id the send path stamps on optimistic rows;
   *  null until the users liveQuery delivers — `sendMessage` throws before then,
   *  so callers (and tests) that fire sends programmatically gate on this. */
  currentUserId: string | null
}

/**
 * Implementation for draft streams (stored in IndexedDB).
 */
function useDraftStream(workspaceId: string, streamId: string, enabled: boolean): UseStreamOrDraftReturn {
  const navigate = useNavigate()
  const { queueDraftMessage, currentUserId } = useQueueDraftMessage(workspaceId)
  const { getScratchpad, updateScratchpad, deleteScratchpad } = useDraftScratchpads(workspaceId)
  const promotionWaitController = useMemo(() => new AbortController(), [workspaceId, streamId])
  // Promotion deletes the draft row before the navigation to the real stream
  // commits; presenting the last-seen draft across that gap keeps the header
  // from falling back to the empty placeholder.
  const lastDraftRef = useRef<DraftScratchpad | undefined>(undefined)
  if (lastDraftRef.current?.id !== streamId) lastDraftRef.current = undefined
  const currentDraft = enabled ? getScratchpad(streamId) : undefined
  if (currentDraft) lastDraftRef.current = currentDraft
  const draft = currentDraft ?? (getPromotedStreamId(streamId) ? lastDraftRef.current : undefined)

  useEffect(() => () => promotionWaitController.abort(), [promotionWaitController])

  const stream: VirtualStream | undefined = draft
    ? {
        id: draft.id,
        workspaceId: draft.workspaceId,
        type: StreamTypes.SCRATCHPAD,
        displayName: draft.displayName,
        companionMode: draft.companionMode,
        isDraft: true,
        parentStreamId: null,
        parentAnchorId: null,
        rootStreamId: null,
        archivedAt: null,
        allowedToolCategories: draft.allowedToolCategories,
      }
    : undefined

  const rename = useCallback(
    async (newName: string) => {
      await updateScratchpad(streamId, { displayName: newName })
    },
    [streamId, updateScratchpad]
  )

  const archive = useCallback(async () => {
    await deleteScratchpad(streamId)
    navigate(`/w/${workspaceId}`)
  }, [deleteScratchpad, streamId, workspaceId, navigate])

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

      // The optimistic first message renders before promotion replaces the route.
      // A follow-up can therefore enter this stale draft callback; join the first
      // promotion instead of materializing a second scratchpad.
      const knownPromotedStreamId = getPromotedStreamId(streamId)
      const promotionPending = knownPromotedStreamId
        ? null
        : await db.pendingMessages
            .filter(
              (message) =>
                message.draftId === streamId &&
                (message.streamCreation !== undefined || message.promotedStreamId !== undefined)
            )
            .first()
      const promotedStreamId =
        knownPromotedStreamId ??
        promotionPending?.promotedStreamId ??
        (promotionPending
          ? await waitForDraftPromotion(workspaceId, streamId, { signal: promotionWaitController.signal })
          : null)

      if (promotedStreamId) {
        await queueDraftMessage(input, { workspaceId, streamId: promotedStreamId })
      } else {
        const draftData = await db.draftScratchpads.get(streamId)
        const companionMode = draftData?.companionMode ?? "on"

        await queueDraftMessage(input, {
          workspaceId,
          streamId,
          streamCreation: {
            type: StreamTypes.SCRATCHPAD,
            displayName: draftData?.displayName ?? undefined,
            companionMode,
            companionPersonaId: draftData?.companionPersonaId,
            allowedToolCategories: draftData?.allowedToolCategories,
          },
          draftId: streamId,
        })
      }

      // Navigation is handled by the promotion listener above
      return {}
    },
    [streamId, workspaceId, currentUserId, queueDraftMessage, promotionWaitController]
  )

  return {
    stream,
    isLoading: enabled && draft === undefined && !hasSeededDraftCache(workspaceId),
    isDraft: true,
    error: null,
    rename,
    canRename: true,
    renamePending: false,
    renameError: null,
    archive,
    sendMessage,
    currentUserId,
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
        // Move the virtual DM scope's loaded draft onto the real DM stream's
        // scope, keeping whichever side is newer so a draft already started in
        // the real DM isn't clobbered. The virtual scope's drafts are then
        // purged. (Stash piles on the virtual scope are rare and dropped here.)
        const fromLoadedId = (await db.composerLoaded.get(draftKey))?.draftId ?? null
        const fromDraft = fromLoadedId ? await db.drafts.get(fromLoadedId) : undefined
        if (fromDraft) {
          const toLoadedId = (await db.composerLoaded.get(realStreamKey))?.draftId ?? null
          const toDraft = toLoadedId ? await db.drafts.get(toLoadedId) : undefined
          if (!toDraft || toDraft.clientUpdatedAt < fromDraft.clientUpdatedAt) {
            await upsertLoadedDraft(workspaceId, realStreamKey, {
              contentJson: fromDraft.contentJson,
              attachments: fromDraft.attachments,
              contextRefs: fromDraft.contextRefs,
            })
          }
          await purgeScopeDrafts(workspaceId, draftKey)
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
          parentAnchorId: null,
          rootStreamId: null,
          archivedAt: null,
        }
      : undefined

  const rename = useCallback(async () => {}, [])

  const archive = useCallback(async () => {
    await purgeScopeDrafts(workspaceId, getDraftMessageKey({ type: "stream", streamId }))
    navigate(`/w/${workspaceId}`)
  }, [streamId, workspaceId, navigate])

  const sendMessage = useCallback(
    async (input: SendMessageInput): Promise<{ navigateTo?: string; replace?: boolean }> => {
      if (!currentUserId) {
        throw new Error("Cannot send message: user identity not resolved yet")
      }
      if (!targetUserId) {
        throw new Error("Invalid DM draft target")
      }

      const message = await messageService.createDm(workspaceId, targetUserId, {
        dmUserId: targetUserId,
        contentJson: input.contentJson,
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
        parentAnchorId: null,
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

        await db.streamMemberships.put({
          id: `${workspaceId}:${message.streamId}`,
          workspaceId,
          streamId: message.streamId,
          memberId: currentUserId,
          notificationLevel: null,
          joinedAt: message.createdAt,
          _cachedAt: now,
        })

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

        const optimisticMembership: StreamMember = {
          streamId: message.streamId,
          memberId: currentUserId,
          notificationLevel: null,
          joinedAt: message.createdAt,
        }

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
          streamMemberships: membershipExists
            ? old.streamMemberships
            : [...old.streamMemberships, optimisticMembership],
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
    canRename: true,
    renamePending: false,
    renameError: null,
    archive,
    sendMessage,
    currentUserId,
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
  // A just-promoted stream is in IDB but not yet in the workspace store's
  // resolved live query; the promotion's own copy covers that tick so the
  // header keeps the name the draft was showing.
  const baseStream = idbStream ?? bootstrap?.stream ?? getDraftPromotionStream(streamId) ?? undefined
  const renameStream = useRenameStream(workspaceId, streamId, baseStream)
  const { rename } = renameStream
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
        parentAnchorId: baseStream.parentAnchorId ?? idbStream?.parentMessageId ?? null,
        rootStreamId: baseStream.rootStreamId,
        archivedAt: baseStream.archivedAt,
        e2eEnabled: baseStream.e2eEnabled,
        e2eActors: baseStream.e2eActors,
        sealedNameCiphertext: baseStream.sealedNameCiphertext ?? null,
        sealedNameEnvelope: baseStream.sealedNameEnvelope ?? null,
      }
    : undefined

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

      const optimisticEvent: StreamEvent = {
        id: clientId,
        streamId,
        sequence: "0",
        eventType: "message_created",
        payload: {
          messageId: clientId,
          contentMarkdown,
          contentJson: input.contentJson,
          // Same conversation keys the server stamps on the real payload, so the
          // sender's provenance chip renders on the optimistic row and survives
          // the echo swap (see conversationTag).
          ...conversationTag(input.conversation),
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
      let e2eFields: SealStreamMessageResult | undefined
      if (e2eEnabled) {
        // A thread shares its root scratchpad's SSK and carries no wraps of its
        // own; seal (and heal) against the root, whose wraps hold the key.
        const e2eStreamId = baseStream?.rootStreamId ?? streamId
        const sealed = await sealOutgoingMessage({
          workspaceId,
          senderId: currentUserId,
          streamId: e2eStreamId,
          messageId: clientId,
          contentMarkdown,
          attachmentIds: input.attachmentIds,
        })
        e2eFields = sealed.e2eFields
        // Heal-on-send: if an invited actor's key went stale (an enclave
        // restart mints a fresh EIK), this turn parks server-side on the
        // missing wrap. Fire the revive now — fire-and-forget, de-duped
        // in-flight — so the re-wrap lands within the queue's retry window
        // and the parked turn proceeds. No-ops when nothing is missing.
        if ((baseStream?.e2eActors?.length ?? 0) > 0) {
          void reviveStaleActorWraps({
            workspaceId,
            streamId: e2eStreamId,
            userId: currentUserId,
            ownerKeyId: sealed.owner.keyId,
            ownerPrivateKey: sealed.owner.privateKey,
          }).catch((err) => console.error("Failed to revive stale actor key wraps on send", err))
        }
        // Carry the refs on the optimistic payload so the server echo's
        // decrypt-cache seed (stream-sync) can render the sender's own
        // attachments via `<E2eAttachmentList>` immediately — otherwise the
        // seeded "decrypted" entry suppresses the real decrypt that would
        // surface the refs, and the row falls through to the opaque server
        // placeholder.
        if (sealed.attachmentRefs && sealed.attachmentRefs.length > 0) {
          ;(optimisticEvent.payload as Record<string, unknown>).attachmentRefs = sealed.attachmentRefs
        }
      }

      markPending(clientId)

      // The durable send and its optimistic row appear together. A steered
      // message stays one queue item so replay cannot dispatch the command
      // before the message reaches the server.
      await db.transaction("rw", [db.pendingMessages, db.events], async () => {
        const [anchorSequence, allocatedSequence] = await Promise.all([
          getLatestPersistedSequence(streamId),
          nextOptimisticSequence(streamId),
        ])
        await db.pendingMessages.add({
          clientId,
          workspaceId,
          streamId,
          content: contentMarkdown,
          contentFormat: "markdown",
          contentJson: input.contentJson,
          attachmentIds: input.attachmentIds,
          conversation: input.conversation,
          composeTrace: input.composeTrace,
          steer: input.steer,
          createdAt: Date.now(),
          retryCount: 0,
          ...(e2eFields ?? {}),
        })

        await db.events.add({
          ...optimisticEvent,
          workspaceId,
          sequence: allocatedSequence,
          _sequenceNum: sequenceToNum(allocatedSequence),
          ...(anchorSequence != null && { _anchorSequenceNum: sequenceToNum(anchorSequence) }),
          _clientId: clientId,
          _status: "pending",
          _cachedAt: Date.now(),
        })
      })

      notifyQueue()

      return {}
    },
    [streamId, workspaceId, markPending, notifyQueue, currentUserId, baseStream]
  )

  return {
    stream,
    isLoading: enabled && !stream && isBootstrapLoading,
    isDraft: false,
    error: stream ? null : (error ?? null),
    rename,
    canRename: renameStream.canRename,
    renamePending: renameStream.isPending,
    renameError: renameStream.error,
    archive,
    unarchive,
    sendMessage,
    currentUserId,
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
