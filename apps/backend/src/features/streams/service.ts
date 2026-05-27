import { z } from "zod"
import { Pool } from "pg"
import { withClient, withTransaction, type Querier } from "../../db"
import { StreamRepository, Stream, StreamWithPreview, LastMessagePreview, type DmPeer } from "./repository"
import { StreamMemberRepository, StreamMember } from "./member-repository"
import { StreamEventRepository, type StreamEvent } from "./event-repository"
import { MessageRepository } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { streamId, eventId } from "../../lib/id"
import { logger } from "../../lib/logger"
import {
  DuplicateSlugError,
  HttpError,
  StreamNotFoundError,
  MessageNotFoundError,
  isUniqueViolation,
} from "../../lib/errors"
import { formatParticipantNames } from "./display-name"
import { checkStreamAccess } from "./access"
import { UserRepository } from "../workspaces"
import { BotChannelAccessRepository } from "../api-keys"
import {
  StreamTypes,
  Visibilities,
  CompanionModes,
  E2eInvitedAgentKinds,
  type StreamType,
  type Visibility,
  type CompanionMode,
  type NotificationLevel,
  type ThreadSummary,
  type ContextBag,
} from "@threa/types"
import { ContextBagRepository, ARIADNE_AGENT_ID, getBuiltInAgentConfig } from "../agents"
import { E2eStreamsRepository } from "../e2e-streams"
import { streamTypeSchema, visibilitySchema, companionModeSchema } from "../../lib/schemas"
import { isAllowedLevel } from "./notification-config"

const DM_UNIQUENESS_KEY_PREFIX = "dm"

const createScratchpadParamsSchema = z.object({
  workspaceId: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  createdBy: z.string(),
  companionMode: companionModeSchema.optional(),
  companionPersonaId: z.string().optional(),
})

export type CreateScratchpadParams = z.infer<typeof createScratchpadParamsSchema> & {
  /** Optional context-bag to attach to the new scratchpad. */
  contextBag?: ContextBag
  /**
   * Optional E2E activation. When present, the scratchpad row is inserted
   * into `e2e_streams` in the same transaction so plaintext consumers
   * cannot race a window where the stream exists but its E2E flag does not.
   * Phase 1: `invitedAgentKind` is always "none" — only the owner can decrypt.
   */
  e2e?: { ownerKeyId: string }
}

const createChannelParamsSchema = z.object({
  workspaceId: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  visibility: visibilitySchema.optional(),
  createdBy: z.string(),
  memberIds: z.array(z.string()).optional(),
})

export type CreateChannelParams = z.infer<typeof createChannelParamsSchema>

const createThreadParamsSchema = z.object({
  workspaceId: z.string(),
  parentStreamId: z.string(),
  parentMessageId: z.string(),
  createdBy: z.string(),
})

export type CreateThreadParams = z.infer<typeof createThreadParamsSchema>

const createStreamParamsSchema = z.object({
  workspaceId: z.string(),
  type: streamTypeSchema,
  slug: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  visibility: visibilitySchema.optional(),
  companionMode: companionModeSchema.optional(),
  companionPersonaId: z.string().optional(),
  parentStreamId: z.string().optional(),
  parentMessageId: z.string().optional(),
  memberIds: z.array(z.string()).optional(),
  createdBy: z.string(),
})

export type CreateStreamParams = z.infer<typeof createStreamParamsSchema>

interface FindOrCreateDmParams {
  workspaceId: string
  userOneId: string
  userTwoId: string
}

interface ResolveWritableMessageStreamParams {
  workspaceId: string
  userId: string
  target: { streamId: string } | { dmUserId: string }
}

function normalizeDmUserPair(userOneId: string, userTwoId: string): { userAId: string; userBId: string } {
  return userOneId < userTwoId ? { userAId: userOneId, userBId: userTwoId } : { userAId: userTwoId, userBId: userOneId }
}

function buildDmUniquenessKey(userOneId: string, userTwoId: string): string {
  const { userAId, userBId } = normalizeDmUserPair(userOneId, userTwoId)
  return `${DM_UNIQUENESS_KEY_PREFIX}:${userAId}:${userBId}`
}

export class StreamService {
  constructor(private pool: Pool) {}

  async getStreamById(id: string): Promise<Stream | null> {
    return StreamRepository.findById(this.pool, id)
  }

  async validateStreamAccess(streamId: string, workspaceId: string, userId: string): Promise<Stream> {
    const stream = await this.checkAccess(streamId, workspaceId, userId)
    if (!stream) throw new StreamNotFoundError()
    return stream
  }

  /** Check if user has access to a stream without throwing. Returns the stream or null. */
  async tryAccess(streamId: string, workspaceId: string, userId: string): Promise<Stream | null> {
    return this.checkAccess(streamId, workspaceId, userId)
  }

  private async checkAccess(streamId: string, workspaceId: string, userId: string): Promise<Stream | null> {
    return withClient(this.pool, async (client) => checkStreamAccess(client, streamId, workspaceId, userId))
  }

  async getScratchpadsByUser(workspaceId: string, userId: string): Promise<Stream[]> {
    return withClient(this.pool, async (client) => {
      const memberships = await StreamMemberRepository.list(client, { memberId: userId })
      const streamIds = memberships.map((m) => m.streamId)

      if (streamIds.length === 0) return []

      const streams = await StreamRepository.list(client, workspaceId, {
        types: [StreamTypes.SCRATCHPAD],
      })
      return streams.filter((s) => streamIds.includes(s.id))
    })
  }

  async getStreamsByWorkspace(workspaceId: string): Promise<Stream[]> {
    return StreamRepository.list(this.pool, workspaceId)
  }

  async list(
    workspaceId: string,
    userId: string,
    filters?: { types?: StreamType[]; archiveStatus?: ("active" | "archived")[] }
  ): Promise<Stream[]> {
    return withClient(this.pool, async (client) => {
      const memberships = await StreamMemberRepository.list(client, { memberId: userId })
      const memberStreamIds = memberships.map((m) => m.streamId)

      return StreamRepository.list(client, workspaceId, {
        types: filters?.types,
        archiveStatus: filters?.archiveStatus,
        userMembershipStreamIds: memberStreamIds,
      })
    })
  }

  /**
   * List streams with last message preview for sidebar display.
   * Ordered by most recent activity (last message or stream creation).
   */
  async listWithPreviews(
    workspaceId: string,
    userId: string,
    filters?: { types?: StreamType[]; archiveStatus?: ("active" | "archived")[] }
  ): Promise<StreamWithPreview[]> {
    return withClient(this.pool, async (client) => {
      const memberships = await StreamMemberRepository.list(client, { memberId: userId })
      const memberStreamIds = memberships.map((m) => m.streamId)

      return StreamRepository.listWithPreviews(client, workspaceId, {
        types: filters?.types,
        archiveStatus: filters?.archiveStatus,
        userMembershipStreamIds: memberStreamIds,
      })
    })
  }

  /**
   * Resolve DM display names for bootstrap. DMs have null displayName in the DB
   * because the name is viewer-dependent ("Max" vs "Sam" depending on who's looking).
   * This populates displayName with formatted participant names for the viewing member.
   */
  async resolveDmDisplayNames(
    streams: StreamWithPreview[],
    workspaceUsers: { id: string; name: string }[],
    viewingUserId: string
  ): Promise<StreamWithPreview[]> {
    const dmStreams = streams.filter((s) => s.type === "dm")
    if (dmStreams.length === 0) return streams

    const dmStreamIds = dmStreams.map((s) => s.id)
    const allDmMembers = await StreamMemberRepository.list(this.pool, { streamIds: dmStreamIds })

    const userNameMap = new Map(workspaceUsers.map((u) => [u.id, u.name]))

    const membersByStream = new Map<string, { id: string; name: string }[]>()
    for (const sm of allDmMembers) {
      const name = userNameMap.get(sm.memberId)
      if (!name) continue
      const list = membersByStream.get(sm.streamId) ?? []
      list.push({ id: sm.memberId, name })
      membersByStream.set(sm.streamId, list)
    }

    const dmNameMap = new Map<string, string>()
    for (const dm of dmStreams) {
      const participants = membersByStream.get(dm.id) ?? []
      dmNameMap.set(dm.id, formatParticipantNames(participants, viewingUserId))
    }

    return streams.map((s) => (dmNameMap.has(s.id) ? { ...s, displayName: dmNameMap.get(s.id)! } : s))
  }

  async listDmPeers(workspaceId: string, userId: string): Promise<DmPeer[]> {
    return StreamRepository.listDmPeersForMember(this.pool, workspaceId, userId)
  }

  async resolveWritableMessageStream(params: ResolveWritableMessageStreamParams): Promise<Stream> {
    if ("dmUserId" in params.target) {
      const stream = await this.findOrCreateDm({
        workspaceId: params.workspaceId,
        userOneId: params.userId,
        userTwoId: params.target.dmUserId,
      })

      if (stream.workspaceId !== params.workspaceId) {
        throw new StreamNotFoundError()
      }

      if (stream.archivedAt) {
        throw new HttpError("Cannot send messages to an archived stream", { status: 403 })
      }

      return stream
    }

    const stream = await this.getStreamById(params.target.streamId)

    if (!stream || stream.workspaceId !== params.workspaceId) {
      throw new StreamNotFoundError()
    }

    if (stream.archivedAt) {
      throw new HttpError("Cannot send messages to an archived stream", { status: 403 })
    }

    const isMember = await this.isMember(stream.id, params.userId)
    if (!isMember) {
      throw new HttpError("Not a member of this stream", { status: 403 })
    }

    return stream
  }

  async findOrCreateDm(params: FindOrCreateDmParams): Promise<Stream> {
    if (params.userOneId === params.userTwoId) {
      throw new HttpError("Cannot create a DM with yourself", { status: 400, code: "DM_SELF_NOT_ALLOWED" })
    }

    const { userAId, userBId } = normalizeDmUserPair(params.userOneId, params.userTwoId)
    const uniquenessKey = buildDmUniquenessKey(userAId, userBId)

    return withTransaction(this.pool, async (client) => {
      const users = await UserRepository.findByIds(client, params.workspaceId, [userAId, userBId])
      const workspaceUserIds = new Set(
        users.filter((user) => user.workspaceId === params.workspaceId).map((user) => user.id)
      )
      if (!workspaceUserIds.has(userAId) || !workspaceUserIds.has(userBId)) {
        throw new HttpError("Both users must belong to this workspace", {
          status: 404,
          code: "MEMBER_NOT_FOUND",
        })
      }

      const { stream, created } = await StreamRepository.insertOrFindByUniquenessKey(client, {
        id: streamId(),
        workspaceId: params.workspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        uniquenessKey,
        createdBy: params.userOneId,
      })

      if (stream.type !== StreamTypes.DM) {
        throw new Error(`Uniqueness key ${uniquenessKey} is already used by non-DM stream ${stream.id}`)
      }

      if (created) {
        await StreamMemberRepository.insertMany(client, stream.id, [userAId, userBId])
        await OutboxRepository.insert(client, "stream:created", {
          workspaceId: params.workspaceId,
          streamId: stream.id,
          stream,
          dmUserIds: [userAId, userBId],
        })
      }

      return stream
    })
  }

  async create(
    params: CreateStreamParams & { contextBag?: ContextBag; e2e?: { ownerKeyId: string } }
  ): Promise<Stream> {
    switch (params.type) {
      case StreamTypes.SCRATCHPAD:
        return this.createScratchpad({
          workspaceId: params.workspaceId,
          displayName: params.displayName,
          description: params.description,
          companionMode: params.companionMode,
          companionPersonaId: params.companionPersonaId,
          createdBy: params.createdBy,
          contextBag: params.contextBag,
          e2e: params.e2e,
        })
      case StreamTypes.CHANNEL:
        if (!params.slug) {
          throw new Error("Slug is required for channels")
        }
        return this.createChannel({
          workspaceId: params.workspaceId,
          slug: params.slug,
          description: params.description,
          visibility: params.visibility,
          createdBy: params.createdBy,
          memberIds: params.memberIds,
        })
      case StreamTypes.THREAD:
        if (!params.parentStreamId || !params.parentMessageId) {
          throw new Error("parentStreamId and parentMessageId are required for threads")
        }
        return this.createThread({
          workspaceId: params.workspaceId,
          parentStreamId: params.parentStreamId,
          parentMessageId: params.parentMessageId,
          createdBy: params.createdBy,
        })
      default:
        throw new Error(`Unsupported stream type for create: ${params.type}`)
    }
  }

  async createScratchpad(params: CreateScratchpadParams): Promise<Stream> {
    return withTransaction(this.pool, async (client) => {
      const id = streamId()

      const stream = await StreamRepository.insert(client, {
        id,
        workspaceId: params.workspaceId,
        type: StreamTypes.SCRATCHPAD,
        displayName: params.displayName,
        description: params.description,
        visibility: Visibilities.PRIVATE,
        companionMode: params.companionMode ?? CompanionModes.OFF,
        companionPersonaId: params.companionPersonaId,
        createdBy: params.createdBy,
      })

      // Add creator as member
      await StreamMemberRepository.insert(client, id, params.createdBy)

      // Attach optional context bag in the same transaction as the stream +
      // outbox event so the pre-compute handler (which fires on stream:created)
      // always sees a fully-wired bag by the time it processes the event. INV-7.
      if (params.contextBag) {
        await ContextBagRepository.insert(client, {
          workspaceId: params.workspaceId,
          streamId: stream.id,
          intent: params.contextBag.intent,
          refs: params.contextBag.refs,
          createdBy: params.createdBy,
        })
      }

      // INV-E1: the E2E flag must be visible the instant the stream is, or
      // a plaintext writer could squeeze a message in between the stream
      // insert and the flag insert. Same transaction guarantees there is no
      // such window. We annotate the returned stream so the create handler
      // can hand the encryption metadata back to the client without a
      // second round-trip.
      if (params.e2e) {
        await E2eStreamsRepository.markStreamE2e(client, {
          streamId: stream.id,
          workspaceId: params.workspaceId,
          ownerUserId: params.createdBy,
          ownerUserKeyId: params.e2e.ownerKeyId,
          invitedAgentKind: "none",
          invitedAgentKeyId: null,
        })
        stream.e2eEnabled = true
        stream.e2eOwnerKeyId = params.e2e.ownerKeyId
      }

      // Publish to outbox for real-time delivery
      await OutboxRepository.insert(client, "stream:created", {
        workspaceId: params.workspaceId,
        streamId: stream.id,
        stream,
      })

      return stream
    })
  }

  async createChannel(params: CreateChannelParams): Promise<Stream> {
    return withTransaction(this.pool, async (client) => {
      const id = streamId()

      // Check if slug already exists
      const slugExists = await StreamRepository.slugExistsInWorkspace(client, params.workspaceId, params.slug)
      if (slugExists) {
        throw new DuplicateSlugError(params.slug)
      }

      const stream = await StreamRepository.insert(client, {
        id,
        workspaceId: params.workspaceId,
        type: StreamTypes.CHANNEL,
        // Channels use slug as display name, no separate displayName field
        slug: params.slug,
        description: params.description,
        visibility: params.visibility ?? Visibilities.PUBLIC,
        createdBy: params.createdBy,
      })

      // Add creator as member
      await StreamMemberRepository.insert(client, id, params.createdBy)

      // Publish to outbox for real-time delivery
      await OutboxRepository.insert(client, "stream:created", {
        workspaceId: params.workspaceId,
        streamId: stream.id,
        stream,
      })

      // Add initial members (excluding the creator who was already added)
      const additionalMemberIds = (params.memberIds ?? []).filter((mid) => mid !== params.createdBy)
      if (additionalMemberIds.length > 0) {
        // Validate members belong to this workspace (INV-20: batch lookup)
        const members = await UserRepository.findByIds(client, params.workspaceId, additionalMemberIds)
        const validMemberIds = members.filter((m) => m.workspaceId === params.workspaceId).map((m) => m.id)

        // INV-11: warn on invalid member IDs rather than silently dropping
        const invalidCount = additionalMemberIds.length - validMemberIds.length
        if (invalidCount > 0) {
          logger.warn(
            "createChannel: dropped %d invalid member IDs not in workspace %s",
            invalidCount,
            params.workspaceId
          )
        }

        if (validMemberIds.length > 0) {
          // INV-56: batch insert members, events, and outbox entries
          await StreamMemberRepository.insertMany(client, stream.id, validMemberIds)

          const eventParams = validMemberIds.map((memberId) => ({
            id: eventId(),
            streamId: stream.id,
            eventType: "member_added" as const,
            payload: { addedBy: params.createdBy },
            actorId: memberId,
            actorType: "user" as const,
          }))
          const events = await StreamEventRepository.insertMany(client, eventParams)

          await OutboxRepository.insertMany(
            client,
            events.map((event) => ({
              eventType: "stream:member_added" as const,
              payload: {
                workspaceId: stream.workspaceId,
                streamId: stream.id,
                memberId: event.actorId!,
                stream,
                event,
              },
            }))
          )

          // Set lastReadEventId so initial members don't see creation events as unread
          const lastEvent = events[events.length - 1]
          await StreamMemberRepository.setLastReadEventIdForMembers(client, stream.id, validMemberIds, lastEvent.id)
        }
      }

      return stream
    })
  }

  async createThread(params: CreateThreadParams): Promise<Stream> {
    return withTransaction(this.pool, async (client) => {
      // Get parent stream to determine root (needed for insert)
      const parentStream = await StreamRepository.findById(client, params.parentStreamId)
      if (!parentStream || parentStream.workspaceId !== params.workspaceId) {
        throw new StreamNotFoundError()
      }

      // Validate that parentMessageId exists in the parent stream
      const parentMessage = await MessageRepository.findById(client, params.parentMessageId)
      if (!parentMessage || parentMessage.streamId !== params.parentStreamId) {
        throw new MessageNotFoundError()
      }

      // Root is either the parent's root (if parent is a thread) or the parent itself
      const rootStreamId = parentStream.rootStreamId ?? parentStream.id

      const id = streamId()

      // Atomically insert or find existing thread
      // Uses ON CONFLICT DO NOTHING to handle race conditions
      // Inherit visibility from the root stream — threads in public channels
      // are public, threads in private DMs/scratchpads stay private.
      const rootStream =
        rootStreamId === parentStream.id ? parentStream : await StreamRepository.findById(client, rootStreamId)
      const inheritedVisibility = rootStream?.visibility ?? Visibilities.PRIVATE
      const inheritedCompanionMode =
        rootStream?.type === StreamTypes.SCRATCHPAD ? rootStream.companionMode : CompanionModes.OFF
      const inheritedCompanionPersonaId =
        rootStream?.type === StreamTypes.SCRATCHPAD ? (rootStream.companionPersonaId ?? undefined) : undefined

      const { stream, created } = await StreamRepository.insertThreadOrFind(client, {
        id,
        workspaceId: params.workspaceId,
        type: StreamTypes.THREAD,
        parentStreamId: params.parentStreamId,
        parentMessageId: params.parentMessageId,
        rootStreamId,
        visibility: inheritedVisibility,
        companionMode: inheritedCompanionMode,
        companionPersonaId: inheritedCompanionPersonaId,
        createdBy: params.createdBy,
      })

      // Add creator as member (idempotent - handles existing membership)
      const isMember = await StreamMemberRepository.isMember(client, stream.id, params.createdBy)
      if (!isMember) {
        await StreamMemberRepository.insert(client, stream.id, params.createdBy)
      }

      // Add parent message author as member and emit stream:member_added so they
      // discover the thread in real-time (the stream:created event only surfaces
      // private streams for the creator, not for other members).
      if (parentMessage.authorType === "user" && parentMessage.authorId !== params.createdBy) {
        await this.addToStream(client, stream, parentMessage.authorId, params.createdBy)
      }

      // Only broadcast if we created a new thread
      if (created) {
        // Broadcast stream:created to PARENT stream's room (not the new thread's room)
        // This lets watchers of the parent see the thread indicator appear
        await OutboxRepository.insert(client, "stream:created", {
          workspaceId: params.workspaceId,
          streamId: params.parentStreamId,
          stream,
        })
      }

      return stream
    })
  }

  async updateCompanionMode(
    streamId: string,
    companionMode: CompanionMode,
    companionPersonaId?: string | null
  ): Promise<Stream> {
    return withTransaction(this.pool, async (client) => {
      const stream = await StreamRepository.update(client, streamId, {
        companionMode,
        companionPersonaId,
      })
      if (!stream) {
        throw new Error("Stream not found")
      }
      await OutboxRepository.insert(client, "stream:updated", {
        workspaceId: stream.workspaceId,
        streamId: stream.id,
        stream,
      })
      return stream
    })
  }

  /**
   * Mark an E2E scratchpad as enclave-invited. Only the stream's e2e owner
   * may invite; the persona is hardcoded to Ariadne in 5a (the only built-in
   * with `e2eCapable: true`). Per-instance EIK pinning is intentionally not
   * recorded on the stream — recipients are recomputed per message from the
   * live EIK set so the fleet can scale and churn without re-inviting.
   */
  async inviteEnclave(workspaceId: string, streamId: string, userId: string): Promise<Stream> {
    const persona = getBuiltInAgentConfig(ARIADNE_AGENT_ID)
    if (!persona?.e2eCapable) {
      throw new HttpError("Built-in persona is not enclave-capable", {
        status: 500,
        code: "PERSONA_NOT_E2E_CAPABLE",
      })
    }

    return withTransaction(this.pool, async (client) => {
      const e2eRow = await E2eStreamsRepository.getByStreamId(client, workspaceId, streamId)
      if (!e2eRow) {
        throw new HttpError("Stream is not E2E", { status: 400, code: "STREAM_NOT_E2E" })
      }
      if (e2eRow.ownerUserId !== userId) {
        throw new HttpError("Only the stream owner can invite the enclave", {
          status: 403,
          code: "NOT_STREAM_OWNER",
        })
      }

      await E2eStreamsRepository.setInvitedAgent(client, workspaceId, streamId, E2eInvitedAgentKinds.ENCLAVE, null)

      const stream = await StreamRepository.findByIdForWorkspace(client, streamId, workspaceId)
      if (!stream) {
        throw new StreamNotFoundError()
      }

      await OutboxRepository.insert(client, "stream:updated", {
        workspaceId: stream.workspaceId,
        streamId: stream.id,
        stream,
      })

      return stream
    })
  }

  async archiveStream(streamId: string, archivedBy: string): Promise<Stream | null> {
    return withTransaction(this.pool, async (client) => {
      const stream = await StreamRepository.update(client, streamId, { archivedAt: new Date() })
      if (stream) {
        // Emit stream_archived event to the timeline
        const evtId = eventId()
        await StreamEventRepository.insert(client, {
          id: evtId,
          streamId: stream.id,
          eventType: "stream_archived",
          payload: {
            archivedAt: stream.archivedAt,
          },
          actorId: archivedBy,
          actorType: "user",
        })

        // Notify real-time subscribers
        await OutboxRepository.insert(client, "stream:archived", {
          workspaceId: stream.workspaceId,
          streamId: stream.id,
          stream,
        })
      }
      return stream
    })
  }

  async unarchiveStream(streamId: string, unarchivedBy: string): Promise<Stream | null> {
    return withTransaction(this.pool, async (client) => {
      const stream = await StreamRepository.update(client, streamId, { archivedAt: null })
      if (stream) {
        // Emit stream_unarchived event to the timeline
        const evtId = eventId()
        await StreamEventRepository.insert(client, {
          id: evtId,
          streamId: stream.id,
          eventType: "stream_unarchived",
          payload: {},
          actorId: unarchivedBy,
          actorType: "user",
        })

        // Notify real-time subscribers
        await OutboxRepository.insert(client, "stream:unarchived", {
          workspaceId: stream.workspaceId,
          streamId: stream.id,
          stream,
        })
      }
      return stream
    })
  }

  async updateStream(
    streamId: string,
    data: { displayName?: string; slug?: string; description?: string; visibility?: Visibility }
  ): Promise<Stream | null> {
    try {
      return await withTransaction(this.pool, async (client) => {
        // Slug uniqueness check (exclude current stream)
        if (data.slug) {
          const current = await StreamRepository.findById(client, streamId)
          if (current && data.slug !== current.slug) {
            const slugExists = await StreamRepository.slugExistsInWorkspace(client, current.workspaceId, data.slug)
            if (slugExists) {
              throw new DuplicateSlugError(data.slug)
            }
          }
        }

        const stream = await StreamRepository.update(client, streamId, data)
        if (stream) {
          await OutboxRepository.insert(client, "stream:updated", {
            workspaceId: stream.workspaceId,
            streamId: stream.id,
            stream,
          })
        }
        return stream
      })
    } catch (error) {
      // DB unique constraint catches races the application check misses
      if (data.slug && isUniqueViolation(error, "streams_workspace_id_slug_key")) {
        throw new DuplicateSlugError(data.slug)
      }
      throw error
    }
  }

  async checkSlugAvailable(workspaceId: string, slug: string, excludeStreamId?: string): Promise<boolean> {
    return withClient(this.pool, async (client) => {
      if (excludeStreamId) {
        const current = await StreamRepository.findById(client, excludeStreamId)
        if (current && current.slug === slug) return true
      }
      const exists = await StreamRepository.slugExistsInWorkspace(client, workspaceId, slug)
      return !exists
    })
  }

  async updateDisplayName(
    streamId: string,
    displayName: string,
    markAsGenerated: boolean = false
  ): Promise<Stream | null> {
    return StreamRepository.update(this.pool, streamId, {
      displayName,
      displayNameGeneratedAt: markAsGenerated ? new Date() : undefined,
    })
  }

  async joinPublicChannel(streamId: string, workspaceId: string, memberId: string): Promise<StreamMember> {
    return withTransaction(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)

      if (!stream || stream.workspaceId !== workspaceId) {
        throw new StreamNotFoundError()
      }

      if (stream.type !== StreamTypes.CHANNEL || stream.visibility !== Visibilities.PUBLIC) {
        throw new HttpError("Can only join public channels", { status: 403, code: "NOT_PUBLIC_CHANNEL" })
      }

      const membership = await StreamMemberRepository.insert(client, streamId, memberId)

      const evtId = eventId()
      const event = await StreamEventRepository.insert(client, {
        id: evtId,
        streamId,
        eventType: "member_joined",
        payload: {},
        actorId: memberId,
        actorType: "user",
      })

      await OutboxRepository.insert(client, "stream:member_joined", {
        workspaceId,
        streamId,
        event,
      })

      return membership
    })
  }

  // Member operations

  private async addToStream(client: Querier, stream: Stream, memberId: string, actorId: string): Promise<StreamMember> {
    // Check if already a member to avoid spurious events on duplicate calls
    const existing = await StreamMemberRepository.findByStreamAndMember(client, stream.id, memberId)
    if (existing) return existing

    const membership = await StreamMemberRepository.insert(client, stream.id, memberId)

    // Create timeline event so "X was added" appears in the stream
    const evtId = eventId()
    const event = await StreamEventRepository.insert(client, {
      id: evtId,
      streamId: stream.id,
      eventType: "member_added",
      payload: { addedBy: actorId },
      actorId: memberId,
      actorType: "user",
    })

    // Set read cursor *after* inserting the member_added event so it's not shown as unread
    await StreamMemberRepository.update(client, stream.id, memberId, { lastReadEventId: evtId })

    await OutboxRepository.insert(client, "stream:member_added", {
      workspaceId: stream.workspaceId,
      streamId: stream.id,
      memberId,
      stream,
      event,
    })

    return membership
  }

  async addMember(streamId: string, memberId: string, workspaceId: string, actorId: string): Promise<StreamMember> {
    return withTransaction(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        throw new StreamNotFoundError()
      }

      if (stream.type === StreamTypes.DM) {
        throw new HttpError("Cannot add members to direct messages", {
          status: 400,
          code: "DM_MEMBERS_IMMUTABLE",
        })
      }

      // Verify the target member belongs to this workspace
      const member = await UserRepository.findById(client, workspaceId, memberId)
      if (!member) {
        throw new HttpError("Member not found in this workspace", { status: 404, code: "MEMBER_NOT_FOUND" })
      }

      if (stream.rootStreamId) {
        const isRootMember = await StreamMemberRepository.isMember(client, stream.rootStreamId, memberId)
        if (!isRootMember) {
          const rootStream = await StreamRepository.findById(client, stream.rootStreamId)
          if (rootStream) await this.addToStream(client, rootStream, memberId, actorId)
        }
      }

      return this.addToStream(client, stream, memberId, actorId)
    })
  }

  /**
   * Resolve the stream that holds bot grants for `target`. Bot access is
   * channel-scoped: a thread redirects to its root channel, so grants and
   * `member_added`/`member_left` events always land on the channel. Threads
   * inherit mentionability from the channel and do not carry their own
   * `bot_channel_access` rows.
   */
  private async resolveBotGrantStream(client: Querier, target: Stream): Promise<Stream> {
    if (target.type === StreamTypes.THREAD && target.rootStreamId) {
      const root = await StreamRepository.findById(client, target.rootStreamId)
      if (root) return root
    }
    return target
  }

  /**
   * Grant a bot access to a stream. Idempotent and race-safe: emits
   * `member_added` only when a new grant was created. Threads are redirected
   * to the root channel (see `resolveBotGrantStream`).
   */
  async addBotToStream(targetStreamId: string, botId: string, workspaceId: string, actorId: string): Promise<void> {
    return withTransaction(this.pool, (client) =>
      this.addBotToStreamOn(client, targetStreamId, botId, workspaceId, actorId)
    )
  }

  /**
   * Same as {@link addBotToStream} but runs inside a caller-owned transaction.
   * Use when the caller needs additional locks or checks (e.g. owner-membership
   * verification for personal bots) atomic with the grant.
   */
  async addBotToStreamOn(
    client: Querier,
    targetStreamId: string,
    botId: string,
    workspaceId: string,
    actorId: string
  ): Promise<void> {
    const target = await StreamRepository.findById(client, targetStreamId)
    if (!target) throw new StreamNotFoundError()
    if (target.workspaceId !== workspaceId) {
      throw new HttpError("Stream does not belong to this workspace", { status: 403, code: "WRONG_WORKSPACE" })
    }
    if (target.type === StreamTypes.DM) {
      throw new HttpError("Cannot add bots to direct messages", { status: 400, code: "DM_MEMBERS_IMMUTABLE" })
    }

    const grantStream = await this.resolveBotGrantStream(client, target)
    const inserted = await BotChannelAccessRepository.grantAccess(client, {
      id: streamId(),
      workspaceId,
      botId,
      streamId: grantStream.id,
      grantedBy: actorId,
    })
    if (!inserted) return

    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: grantStream.id,
      eventType: "member_added",
      payload: { addedBy: actorId },
      actorId: botId,
      actorType: "bot",
    })

    await OutboxRepository.insert(client, "stream:member_added", {
      workspaceId: grantStream.workspaceId,
      streamId: grantStream.id,
      memberId: botId,
      stream: grantStream,
      event,
    })
  }

  private async removeFromStream(
    client: Querier,
    stream: Stream,
    memberId: string,
    actorType: "user" | "bot" = "user"
  ): Promise<StreamEvent | null> {
    const deleted = await StreamMemberRepository.delete(client, stream.id, memberId)
    if (!deleted) return null

    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: stream.id,
      eventType: "member_left",
      payload: {},
      actorId: memberId,
      actorType,
    })

    await OutboxRepository.insert(client, "stream:member_removed", {
      workspaceId: stream.workspaceId,
      streamId: stream.id,
      memberId,
      event,
    })

    return event
  }

  async removeMember(streamId: string, memberId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        throw new StreamNotFoundError()
      }

      if (stream.type === StreamTypes.DM) {
        throw new HttpError("Cannot remove members from direct messages", {
          status: 400,
          code: "DM_MEMBERS_IMMUTABLE",
        })
      }

      // Lock member rows and check count atomically to prevent racing removals
      // from leaving a stream with zero members
      const memberCount = await StreamMemberRepository.countByStreamForUpdate(client, streamId)
      if (memberCount <= 1) {
        throw new HttpError("Cannot remove the only member", { status: 400, code: "LAST_MEMBER" })
      }

      const event = await this.removeFromStream(client, stream, memberId)

      if (event) {
        // Batch-remove from all descendant threads the member is in (single recursive CTE)
        const removedStreamIds = await StreamMemberRepository.deleteByMemberInDescendants(client, memberId, streamId)
        for (const removedStreamId of removedStreamIds) {
          const threadEvent = await StreamEventRepository.insert(client, {
            id: eventId(),
            streamId: removedStreamId,
            eventType: "member_left",
            payload: {},
            actorId: memberId,
            actorType: "user",
          })
          await OutboxRepository.insert(client, "stream:member_removed", {
            workspaceId: stream.workspaceId,
            streamId: removedStreamId,
            memberId,
            event: threadEvent,
          })
        }
      }

      return event !== null
    })
  }

  /**
   * Revoke a bot's access. Idempotent and race-safe: emits `member_left` only
   * when a grant was actually deleted. Mirrors `addBotToStream` — threads are
   * redirected to the root channel.
   */
  async removeBotFromStream(targetStreamId: string, botId: string, workspaceId: string): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      const target = await StreamRepository.findById(client, targetStreamId)
      if (!target) throw new StreamNotFoundError()
      if (target.workspaceId !== workspaceId) {
        throw new HttpError("Stream does not belong to this workspace", { status: 403, code: "WRONG_WORKSPACE" })
      }

      const grantStream = await this.resolveBotGrantStream(client, target)
      const deleted = await BotChannelAccessRepository.revokeAccess(client, workspaceId, botId, grantStream.id)
      if (!deleted) return

      const event = await StreamEventRepository.insert(client, {
        id: eventId(),
        streamId: grantStream.id,
        eventType: "member_left",
        payload: {},
        actorId: botId,
        actorType: "bot",
      })

      await OutboxRepository.insert(client, "stream:member_removed", {
        workspaceId: grantStream.workspaceId,
        streamId: grantStream.id,
        memberId: botId,
        event,
      })
    })
  }

  async getMembers(streamId: string): Promise<StreamMember[]> {
    return StreamMemberRepository.list(this.pool, { streamId })
  }

  async getBotMemberIds(workspaceId: string, streamId: string): Promise<string[]> {
    return BotChannelAccessRepository.getGrantedBotIds(this.pool, workspaceId, streamId)
  }

  async getMembership(streamId: string, memberId: string): Promise<StreamMember | null> {
    return StreamMemberRepository.findByStreamAndMember(this.pool, streamId, memberId)
  }

  async getMembershipsBatch(streamIds: string[], memberId: string): Promise<StreamMember[]> {
    return StreamMemberRepository.findByStreamsAndMember(this.pool, streamIds, memberId)
  }

  // TODO: This is a permission check masquerading as a membership check. "isMember" is
  // misleading because for threads we actually check root stream membership, not direct
  // membership. Should be broken out into a proper authz module (e.g., canParticipate,
  // canRead, canWrite) that encapsulates the permission model cleanly.
  async isMember(streamId: string, memberId: string): Promise<boolean> {
    return withClient(this.pool, (client) => this.isMemberOn(client, streamId, memberId))
  }

  /**
   * Variant of {@link isMember} that runs on a caller-provided querier so the
   * check can compose into an outer transaction.
   */
  async isMemberOn(db: Querier, streamId: string, memberId: string): Promise<boolean> {
    return this.isMemberOnWith(db, streamId, memberId, StreamMemberRepository.isMember)
  }

  /**
   * Transaction-only membership check that locks the matching stream_members row.
   * Use when a caller must keep membership stable until its surrounding write commits.
   */
  async isMemberOnForUpdate(db: Querier, streamId: string, memberId: string): Promise<boolean> {
    return this.isMemberOnWith(db, streamId, memberId, StreamMemberRepository.isMemberForUpdate)
  }

  private async isMemberOnWith(
    db: Querier,
    streamId: string,
    memberId: string,
    checkMembership: (db: Querier, streamId: string, memberId: string) => Promise<boolean>
  ): Promise<boolean> {
    const directMember = await checkMembership(db, streamId, memberId)
    if (directMember) {
      return true
    }

    // Threads inherit participation rights from root stream
    const stream = await StreamRepository.findById(db, streamId)
    if (stream?.rootStreamId) {
      return checkMembership(db, stream.rootStreamId, memberId)
    }

    return false
  }

  async pinStream(streamId: string, memberId: string, pinned: boolean): Promise<StreamMember | null> {
    return withTransaction(this.pool, (client) => StreamMemberRepository.update(client, streamId, memberId, { pinned }))
  }

  async setNotificationLevel(
    streamId: string,
    memberId: string,
    level: NotificationLevel | null
  ): Promise<StreamMember | null> {
    return withTransaction(this.pool, async (client) => {
      if (level !== null) {
        const stream = await StreamRepository.findById(client, streamId)
        if (!stream) throw new StreamNotFoundError()
        if (!isAllowedLevel(stream.type, level)) {
          throw new HttpError(`Notification level '${level}' is not allowed for ${stream.type} streams`, {
            status: 400,
            code: "INVALID_NOTIFICATION_LEVEL",
          })
        }
      }
      return StreamMemberRepository.update(client, streamId, memberId, { notificationLevel: level })
    })
  }

  async markAsRead(
    workspaceId: string,
    streamId: string,
    memberId: string,
    eventId: string
  ): Promise<StreamMember | null> {
    return withTransaction(this.pool, async (client) => {
      const membership = await StreamMemberRepository.update(client, streamId, memberId, { lastReadEventId: eventId })
      if (membership) {
        await OutboxRepository.insert(client, "stream:read", {
          workspaceId,
          authorId: memberId,
          streamId,
          lastReadEventId: eventId,
        })
      }
      return membership
    })
  }

  async markAllAsRead(workspaceId: string, memberId: string): Promise<string[]> {
    return withTransaction(this.pool, async (client) => {
      // Get all memberships for this member in this workspace
      const memberships = await StreamMemberRepository.list(client, { memberId })

      // Get all streams in this workspace to filter memberships
      const streams = await StreamRepository.list(client, workspaceId)
      const workspaceStreamIds = new Set(streams.map((s) => s.id))

      // Filter to only memberships in this workspace
      const workspaceMemberships = memberships.filter((m) => workspaceStreamIds.has(m.streamId))
      if (workspaceMemberships.length === 0) return []

      const streamIds = workspaceMemberships.map((m) => m.streamId)

      // Get latest event ID for each stream
      const latestEventIds = await StreamEventRepository.getLatestEventIdByStreamBatch(client, streamIds)

      // Build batch update map for streams that need updating
      const updatesToApply = new Map<string, string>()
      for (const [streamId, latestEventId] of latestEventIds.entries()) {
        const membership = workspaceMemberships.find((m) => m.streamId === streamId)
        if (membership && membership.lastReadEventId !== latestEventId) {
          updatesToApply.set(streamId, latestEventId)
        }
      }

      // Batch update all memberships in a single query
      if (updatesToApply.size > 0) {
        await StreamMemberRepository.batchUpdateLastReadEventId(client, memberId, updatesToApply)
      }

      const updatedStreamIds = Array.from(updatesToApply.keys())

      if (updatedStreamIds.length > 0) {
        await OutboxRepository.insert(client, "stream:read_all", {
          workspaceId,
          authorId: memberId,
          streamIds: updatedStreamIds,
        })
      }

      return updatedStreamIds
    })
  }

  async getUnreadCounts(
    memberships: Array<{ streamId: string; lastReadEventId: string | null }>
  ): Promise<Map<string, number>> {
    return StreamEventRepository.countUnreadByStreamBatch(this.pool, memberships)
  }

  async getUnreadCount(streamId: string, lastReadEventId: string | null): Promise<number> {
    const unreadCounts = await this.getUnreadCounts([{ streamId, lastReadEventId }])
    return unreadCounts.get(streamId) ?? 0
  }

  /**
   * Get a map of messageId -> threadStreamId for all messages in a stream that have threads
   */
  async getThreadsForMessages(streamId: string): Promise<Map<string, string>> {
    return StreamRepository.findThreadsForMessages(this.pool, streamId)
  }

  /**
   * Get a map of messageId -> { threadId, replyCount } for all messages in a stream that have threads.
   * This is an optimized version that fetches threads and counts in a single query.
   */
  async getThreadsWithReplyCounts(streamId: string): Promise<Map<string, { threadId: string; replyCount: number }>> {
    return StreamRepository.findThreadsWithReplyCounts(this.pool, streamId)
  }

  /**
   * Get a map of parent messageId -> ThreadSummary for all messages in a stream
   * whose thread has at least one non-deleted reply. See
   * {@link StreamRepository.findThreadSummaries}.
   *
   * The single-parent counterpart (`findThreadSummaryByParentMessage`) is
   * called directly from `event-service.ts` inside the reply-count-update
   * transaction; wrapping it in a service method would force that caller to
   * either break out of its existing `client` transaction or duplicate the
   * pool accessor, so it stays as a repository call.
   */
  async getThreadSummaries(streamId: string): Promise<Map<string, ThreadSummary>> {
    return StreamRepository.findThreadSummaries(this.pool, streamId)
  }
}
