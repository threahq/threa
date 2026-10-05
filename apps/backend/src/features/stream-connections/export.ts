import type { Pool, PoolClient } from "pg"
import { UnknownNodeTypeError } from "@threahq/prosemirror"
import {
  AttachmentSafetyStatuses,
  AttachmentUploadStatuses,
  AuthorTypes,
  StreamConnectionStates,
  type StreamConnection,
  type BridgeActor,
  type BridgeAttachmentResponse,
  type BridgeChange,
  type BridgeConversation,
  type BridgeConversationIndex,
  type BridgeConversations,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeMemo,
  type BridgeMemoIndex,
  type BridgeMemos,
  type BridgeMessage,
  type BridgeProfiles,
  type BridgeStream,
  type BridgeUser,
  type EventType,
  type JSONContent,
  type ThreaMark,
  isBroadcastSlug,
} from "@threahq/types"
import { withClient, type Querier } from "../../db"
import type { StorageProvider } from "../../lib/storage/s3-client"
import { PersonaRepository } from "../agents"
import { AttachmentRepository, AttachmentUploadRepository, type Attachment } from "../attachments"
import { ConversationRepository, type SharedConversation } from "../conversations"
import type { FeatureFlagService } from "../feature-flags"
import { MemoRepository, type Memo } from "../memos"
import { MessageRepository, deriveContentMarkdown, type Message } from "../messaging"
import { BotRepository } from "../public-api"
import { StreamEventRepository, StreamRepository, normalizeStreamDescription, type Stream } from "../streams"
import { UserRepository, userAvatarToken } from "../workspaces"
import { connectionNotFound, writeRefused } from "./errors"
import { namedAuthors } from "./named-authors"
import { StreamConnectionRepository } from "./repository"

type EventRule = "message" | "moved" | "withheld"

/** What a partner learns from each event: only that a message changed. The rest stays with the host. */
const EVENT_RULES: Record<EventType, EventRule> = {
  message_created: "message",
  message_edited: "message",
  message_deleted: "message",
  reaction_added: "message",
  reaction_removed: "message",
  "messages:moved": "moved",
  member_joined: "withheld",
  member_added: "withheld",
  member_left: "withheld",
  description_set: "withheld",
  thread_created: "withheld",
  stream_archived: "withheld",
  stream_unarchived: "withheld",
  companion_response: "withheld",
  command_dispatched: "withheld",
  command_completed: "withheld",
  command_failed: "withheld",
  command_progress: "withheld",
  "agent_session:started": "withheld",
  "agent_session:completed": "withheld",
  "agent_session:failed": "withheld",
  "agent_session:interrupted": "withheld",
  "agent_session:deleted": "withheld",
  "memos:captured": "withheld",
  "agent:follow_up_scheduled": "withheld",
  "agent:follow_up_cancelled": "withheld",
  brief_updated: "withheld",
  "delegation:created": "withheld",
  "delegation:status_changed": "withheld",
  "subagent:created": "withheld",
  "subagent:status_changed": "withheld",
  "bot_access:requested": "withheld",
  "bot_access:status_changed": "withheld",
  "decision:requested": "withheld",
  "decision:resolved": "withheld",
  call_started: "withheld",
  call_ended: "withheld",
  "aside:anchored": "withheld",
}

type NodeRule =
  | "keep"
  | "agentBlock"
  | "mention"
  | "messageRef"
  | "channelLink"
  | "inAppLink"
  | "attachmentReference"
  | "memoEmbed"

/**
 * How each node leaves the host. A pointer survives only when it resolves
 * inside the shared tree; otherwise it drops or flattens to the text a host
 * reader sees on it. Keyed on every node the editor schema has.
 */
export const BRIDGE_NODE_RULES: ReadonlyMap<string, NodeRule> = new Map<string, NodeRule>([
  ["doc", "keep"],
  ["paragraph", "keep"],
  ["heading", "keep"],
  ["codeBlock", "keep"],
  ["blockquote", "keep"],
  ["agentBlock", "agentBlock"],
  ["bulletList", "keep"],
  ["orderedList", "keep"],
  ["listItem", "keep"],
  ["table", "keep"],
  ["tableRow", "keep"],
  ["tableHeader", "keep"],
  ["tableCell", "keep"],
  ["text", "keep"],
  ["hardBreak", "keep"],
  ["horizontalRule", "keep"],
  ["mention", "mention"],
  ["slashCommand", "keep"],
  ["command", "keep"],
  ["emoji", "keep"],
  ["math", "keep"],
  ["giphyEmbed", "keep"],
  ["sharedMessage", "messageRef"],
  ["quoteReply", "messageRef"],
  ["channelLink", "channelLink"],
  ["inAppLink", "inAppLink"],
  ["attachmentReference", "attachmentReference"],
  ["memoEmbed", "memoEmbed"],
])

// Keyed by every mark type, so a new mark fails the typecheck until it is given a rule here.
const BRIDGE_MARKS: Record<ThreaMark["type"], true> = { bold: true, italic: true, strike: true, code: true, link: true }

export interface BridgeCaller {
  workspaceId: string
  connectionId: string
  /** The partner workspace the request names itself as. */
  callerWorkspaceId: string
}

/** What a page of content may point at and still keep the pointer. */
interface ContentScope {
  tree: ReadonlySet<string>
  messages: ReadonlyMap<string, Message>
  attachmentIds: ReadonlySet<string>
  /** Set for a partner's document arriving here, null for one leaving: the mention ids that survive, every other mention flattens to text. */
  inboundMentions: ReadonlySet<string> | null
}

interface Dependencies {
  pool: Pool
  featureFlagService: FeatureFlagService
  storage: StorageProvider
}

/** Serves a shared channel's tree to a partner's region: what is shared, and each stream's changes. */
export class StreamConnectionExportService {
  private readonly pool: Pool
  private readonly featureFlagService: FeatureFlagService
  private readonly storage: StorageProvider

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.featureFlagService = deps.featureFlagService
    this.storage = deps.storage
  }

  async getManifest(caller: BridgeCaller): Promise<BridgeManifest> {
    await this.assertEnabled(caller.workspaceId)
    return withClient(this.pool, async (client) => {
      const { tree } = await loadSharedTree(client, caller)
      const treeIds = new Set(tree.map((stream) => stream.id))
      const heads = await StreamEventRepository.listHeadSequences(client, caller.workspaceId, [...treeIds])
      const descriptions = tree.flatMap((stream) => (stream.descriptionJson ? [stream.descriptionJson] : []))
      const scope = await loadContentScope(client, caller.workspaceId, treeIds, descriptions)
      return { streams: tree.map((stream) => toBridgeStream(stream, heads.get(stream.id) ?? 0n, scope)) }
    })
  }

  async listEvents(caller: BridgeCaller & { streamId: string; after: bigint; limit: number }): Promise<BridgeEvents> {
    await this.assertEnabled(caller.workspaceId)
    return withClient(this.pool, async (client) => {
      const { tree } = await loadSharedTree(client, caller)
      const treeIds = new Set(tree.map((stream) => stream.id))
      if (!treeIds.has(caller.streamId)) throw connectionNotFound()

      // The head is read before the events, so every event at or below it has
      // committed: a writer holds the stream's sequence row from allocation
      // until its transaction commits. A short page can then move the cursor
      // to the head, past sequences that hold nothing for this stream (events
      // moved away with their messages, events the host keeps to itself).
      const heads = await StreamEventRepository.listHeadSequences(client, caller.workspaceId, [caller.streamId])
      const head = heads.get(caller.streamId) ?? 0n
      const events = await StreamEventRepository.list(client, caller.workspaceId, caller.streamId, {
        afterSequence: caller.after,
        beforeSequence: head + 1n,
        limit: caller.limit,
      })
      const hasMore = events.length === caller.limit
      const caughtUp = caller.after > head ? caller.after : head
      const cursor = hasMore ? events[events.length - 1].sequence : caughtUp

      const messageIds = [...new Set(events.flatMap((event) => changedMessageIds(event.eventType, event.payload)))]
      const messages = await MessageRepository.findByIds(client, caller.workspaceId, messageIds)
      const shared = messageIds.flatMap((id) => {
        const message = messages.get(id)
        if (!message) throw new Error(`Message ${id} named by an event of stream ${caller.streamId} does not exist`)
        return isShared(message, caller.streamId) ? [message] : []
      })
      const attachments = await AttachmentRepository.findByMessageIds(
        client,
        caller.workspaceId,
        shared.map((message) => message.id)
      )
      const scope = await loadContentScope(
        client,
        caller.workspaceId,
        treeIds,
        shared.map((message) => message.contentJson)
      )

      const callerAuthors = await findCallerAuthors(client, caller, shared)
      const changes = messageIds.map((id): BridgeChange => {
        const message = messages.get(id)!
        return isShared(message, caller.streamId)
          ? { kind: "message", message: toBridgeMessage(message, attachments.get(id) ?? [], scope, callerAuthors) }
          : { kind: "message_removed", messageId: id }
      })
      const named = namedAuthors(shared)
      const users = await loadNamedUsers(client, caller, named.userIds)
      const actors = await loadNamedActors(client, caller.workspaceId, named)
      return { changes, users, actors, cursor: cursor.toString(), hasMore }
    })
  }

  /**
   * Where the other side of a connection can fetch one file from: a host serves
   * the files of its shared tree, a partner the files its members sent into
   * the copy. Only a file owned by a live message in those streams is served;
   * any other id is the same 404 as an unknown connection.
   */
  async getAttachment(caller: BridgeCaller & { attachmentId: string }): Promise<BridgeAttachmentResponse> {
    await this.assertEnabled(caller.workspaceId)
    const { attachment, upload } = await withClient(this.pool, async (client) => {
      const servedStreamIds = await loadServedStreamIds(client, caller)
      const attachment = await AttachmentRepository.findById(client, caller.workspaceId, caller.attachmentId)
      const message = attachment?.messageId
        ? await MessageRepository.findById(client, caller.workspaceId, attachment.messageId)
        : null
      if (!attachment || !message || message.deletedAt !== null || !servedStreamIds.has(message.streamId)) {
        throw connectionNotFound()
      }
      const upload = await AttachmentUploadRepository.findByAttachmentId(client, caller.workspaceId, attachment.id)
      return { attachment, upload }
    })

    switch (attachment.safetyStatus) {
      case AttachmentSafetyStatuses.CLEAN:
        return { status: "ready", url: await this.storage.getSignedDownloadUrl(attachment.storagePath) }
      case AttachmentSafetyStatuses.PENDING_UPLOAD:
      case AttachmentSafetyStatuses.PENDING_SCAN:
        return upload?.status === AttachmentUploadStatuses.FAILED ||
          upload?.status === AttachmentUploadStatuses.ABANDONED
          ? { status: "failed" }
          : { status: "pending" }
      case AttachmentSafetyStatuses.QUARANTINED:
        return { status: "blocked" }
      case AttachmentSafetyStatuses.E2E_UNSCANNED:
        return { status: "failed" }
    }
  }

  /**
   * The current name and avatar of the asked users who wrote or reacted in the
   * streams this end serves, leaving out the caller's own users. Any other id
   * is left out of the answer, not refused.
   */
  async getProfiles(caller: BridgeCaller & { userIds: string[] }): Promise<BridgeProfiles> {
    await this.assertEnabled(caller.workspaceId)
    return withClient(this.pool, async (client) => {
      const servedStreamIds = await loadServedStreamIds(client, caller)
      const users = (await UserRepository.findByIds(client, caller.workspaceId, caller.userIds)).filter(
        (user) => user.originWorkspaceId !== caller.callerWorkspaceId
      )
      const participants = await MessageRepository.filterParticipants(
        client,
        caller.workspaceId,
        [...servedStreamIds],
        users.map((user) => user.id)
      )
      return {
        users: users
          .filter((user) => participants.has(user.id))
          .map((user) => ({
            id: user.id,
            name: user.name,
            avatar: user.avatarUrl ? userAvatarToken(user.avatarUrl) : null,
          })),
      }
    })
  }

  /** The memos the host captured from the shared tree while it was shared, each with its card version. */
  async getMemoIndex(caller: BridgeCaller): Promise<BridgeMemoIndex> {
    await this.assertEnabled(caller.workspaceId)
    return withClient(this.pool, async (client) => {
      const { connection, tree } = await loadSharedTree(client, caller)
      const memos = await MemoRepository.listSharedVersions(
        client,
        caller.workspaceId,
        connection.streamId,
        tree.map((stream) => stream.id)
      )
      return { memos }
    })
  }

  /**
   * The asked memos the index lists, as the partner keeps them. Participants
   * who never wrote or reacted in the tree are left out of each.
   */
  async getMemos(caller: BridgeCaller & { memoIds: string[] }): Promise<BridgeMemos> {
    await this.assertEnabled(caller.workspaceId)
    return withClient(this.pool, async (client) => {
      const { connection, tree } = await loadSharedTree(client, caller)
      const treeIds = tree.map((stream) => stream.id)
      const rows = await MemoRepository.findSharedWithEmbeddings(
        client,
        caller.workspaceId,
        connection.streamId,
        treeIds,
        caller.memoIds
      )
      const participants = await MessageRepository.filterParticipants(client, caller.workspaceId, treeIds, [
        ...new Set(rows.flatMap(({ memo }) => memo.participantIds)),
      ])
      return { memos: rows.map((row) => toBridgeMemo(row, participants)) }
    })
  }

  /** The conversations in the shared tree, each with its version. */
  async getConversationIndex(caller: BridgeCaller): Promise<BridgeConversationIndex> {
    await this.assertEnabled(caller.workspaceId)
    return withClient(this.pool, async (client) => {
      const { tree } = await loadSharedTree(client, caller)
      const conversations = await ConversationRepository.listSharedVersions(
        client,
        caller.workspaceId,
        tree.map((stream) => stream.id)
      )
      return { conversations }
    })
  }

  /**
   * The asked conversations the index lists, as the partner keeps them. A
   * title or summary written before the share, or for another share, is left
   * out, and so are messages outside the tree and participants who never wrote
   * or reacted in it.
   */
  async getConversations(caller: BridgeCaller & { conversationIds: string[] }): Promise<BridgeConversations> {
    await this.assertEnabled(caller.workspaceId)
    return withClient(this.pool, async (client) => {
      const { connection, tree } = await loadSharedTree(client, caller)
      const treeIds = tree.map((stream) => stream.id)
      const rows = await ConversationRepository.findShared(client, caller.workspaceId, treeIds, caller.conversationIds)
      const conversations = rows.map((row) => row.conversation)
      const streamOf = await MessageRepository.findStreamIdsByIds(client, caller.workspaceId, [
        ...new Set(conversations.flatMap((c) => [...c.messageIds, ...c.secondaryMessageIds])),
      ])
      const inTree = new Set(treeIds)
      const participants = await MessageRepository.filterParticipants(client, caller.workspaceId, treeIds, [
        ...new Set(conversations.flatMap((c) => c.participantIds)),
      ])
      return {
        conversations: rows.map((row) =>
          toBridgeConversation(row, connection.streamId, (id) => inTree.has(streamOf.get(id) ?? ""), participants)
        ),
      }
    })
  }

  private async assertEnabled(workspaceId: string): Promise<void> {
    const flag = await this.featureFlagService.getWorkspaceFlag(workspaceId, "streamConnections")
    if (flag !== "on") throw connectionNotFound()
  }
}

/**
 * The shared channel and the threads under it that hang off one of its
 * messages, at any depth. Every refusal is the same 404, so a caller learns
 * nothing about connections that are not its own. `lock` holds the connection
 * row until the caller's transaction ends.
 */
export async function loadSharedTree(
  client: PoolClient,
  caller: BridgeCaller,
  { lock = false }: { lock?: boolean } = {}
): Promise<{ connection: StreamConnection; tree: Stream[] }> {
  const connection = lock
    ? await StreamConnectionRepository.findByIdForUpdate(client, caller.workspaceId, caller.connectionId)
    : await StreamConnectionRepository.findById(client, caller.workspaceId, caller.connectionId)
  const shared =
    connection?.role === "host" &&
    connection.state === StreamConnectionStates.ACTIVE &&
    connection.remoteWorkspaceId === caller.callerWorkspaceId
  if (!shared) throw connectionNotFound()

  const root = await StreamRepository.findById(client, caller.workspaceId, connection.streamId)
  if (!root) throw new Error(`Shared channel ${connection.streamId} is missing from ${caller.workspaceId}`)

  return { connection, tree: await listTree(client, caller.workspaceId, root) }
}

async function listTree(db: Querier, workspaceId: string, root: Stream): Promise<Stream[]> {
  const threadsByParent = new Map<string, Stream[]>()
  for (const thread of await StreamRepository.listThreadsByRoot(db, workspaceId, root.id)) {
    if (!thread.parentStreamId || !thread.parentAnchorId?.startsWith("msg_")) continue
    threadsByParent.set(thread.parentStreamId, [...(threadsByParent.get(thread.parentStreamId) ?? []), thread])
  }
  const tree = [root]
  for (let i = 0; i < tree.length; i++) tree.push(...(threadsByParent.get(tree[i].id) ?? []))
  return tree
}

/** The streams of a channel this workspace shares as host, while it is shared. */
export interface SharedTree {
  rootStreamId: string
  streamIds: ReadonlySet<string>
}

/** The shared tree holding this stream, or null when no active share serves it. */
export async function findSharedTree(db: Querier, workspaceId: string, streamId: string): Promise<SharedTree | null> {
  const [hosted] = await StreamConnectionRepository.listActiveHostConnectionsForStreams(db, [{ workspaceId, streamId }])
  if (!hosted) return null
  const stream = await StreamRepository.findById(db, workspaceId, streamId)
  const root = stream?.rootStreamId ? await StreamRepository.findById(db, workspaceId, stream.rootStreamId) : stream
  if (!root) throw new Error(`Shared stream ${streamId} has no root in ${workspaceId}`)
  const streamIds = new Set((await listTree(db, workspaceId, root)).map((s) => s.id))
  return streamIds.has(streamId) ? { rootStreamId: root.id, streamIds } : null
}

/**
 * The messages as the partner reads them: deleted messages and those outside
 * the tree drop, and the rest lose what points outside it, the same cut the
 * bridge serves. Without a tree (nothing shared) they come back as they are.
 */
export async function viewAsPartner(
  db: Querier,
  workspaceId: string,
  tree: SharedTree | null,
  messages: Message[]
): Promise<Message[]> {
  if (!tree) return messages
  const inTree = messages.filter(
    (message) => tree.streamIds.has(message.streamId) && isShared(message, message.streamId)
  )
  const scope = await loadContentScope(
    db,
    workspaceId,
    tree.streamIds,
    inTree.map((message) => message.contentJson)
  )
  return inTree.map((message) => {
    const contentJson = exportDoc(message.contentJson, scope)
    return { ...message, contentJson, contentMarkdown: deriveContentMarkdown(contentJson) }
  })
}

/** The streams whose files a connection serves: the host's shared tree, or the partner's copy root and the threads under it. */
async function loadServedStreamIds(client: PoolClient, caller: BridgeCaller): Promise<Set<string>> {
  const connection = await StreamConnectionRepository.findById(client, caller.workspaceId, caller.connectionId)
  if (connection?.role !== "partner") {
    const { tree } = await loadSharedTree(client, caller)
    return new Set(tree.map((stream) => stream.id))
  }
  if (connection.state !== StreamConnectionStates.ACTIVE || connection.remoteWorkspaceId !== caller.callerWorkspaceId) {
    throw connectionNotFound()
  }
  const threads = await StreamRepository.listThreadsByRoot(client, caller.workspaceId, connection.streamId)
  return new Set([connection.streamId, ...threads.map((thread) => thread.id)])
}

function changedMessageIds(eventType: string, payload: unknown): string[] {
  if (!Object.hasOwn(EVENT_RULES, eventType)) throw new Error(`Unknown stream event type ${eventType}`)
  switch (EVENT_RULES[eventType as EventType]) {
    case "message": {
      const { messageId } = payload as { messageId?: unknown }
      if (typeof messageId !== "string") throw new Error(`A ${eventType} event names no message`)
      return [messageId]
    }
    case "moved":
      return (payload as { messages: Array<{ id: string }> }).messages.map((message) => message.id)
    case "withheld":
      return []
  }
}

function toBridgeStream(stream: Stream, head: bigint, scope: ContentScope): BridgeStream {
  const description = stream.descriptionJson
    ? normalizeStreamDescription({ descriptionJson: exportDoc(stream.descriptionJson, scope) })
    : undefined
  return {
    id: stream.id,
    parentStreamId: stream.parentStreamId,
    parentAnchorId: stream.parentAnchorId,
    slug: stream.slug,
    displayName: stream.displayName,
    description: description?.description ?? null,
    descriptionJson: description?.descriptionJson ?? null,
    archivedAt: stream.archivedAt?.toISOString() ?? null,
    head: head.toString(),
  }
}

/** The profiles of the named users the host still has, except the caller's own: it knows them better than the host's copy does. */
async function loadNamedUsers(client: PoolClient, caller: BridgeCaller, ids: Set<string>): Promise<BridgeUser[]> {
  const users = await UserRepository.findByIds(client, caller.workspaceId, [...ids])
  return users
    .filter((user) => user.originWorkspaceId !== caller.callerWorkspaceId)
    .map((user) => ({ id: user.id, name: user.name, slug: user.slug }))
}

/** The authors among the messages that are the caller's own users, whose copies here it wrote. */
async function findCallerAuthors(client: PoolClient, caller: BridgeCaller, messages: Message[]): Promise<Set<string>> {
  const userAuthorIds = [
    ...new Set(
      messages.filter((message) => message.authorType === AuthorTypes.USER).map((message) => message.authorId)
    ),
  ]
  const origins = await UserRepository.findOrigins(client, caller.workspaceId, userAuthorIds)
  return new Set(userAuthorIds.filter((id) => origins.get(id) === caller.callerWorkspaceId))
}

/**
 * The host's own personas and bots the messages name as author or reactor.
 * Built-in personas resolve everywhere, so they are left out. A personal
 * persona is invisible to every host member but its owner, so its name stays
 * home too.
 */
async function loadNamedActors(
  client: PoolClient,
  workspaceId: string,
  { personaIds, botIds }: { personaIds: Set<string>; botIds: Set<string> }
): Promise<BridgeActor[]> {
  const personas = await PersonaRepository.findByIds(client, workspaceId, [...personaIds])
  const bots = await BotRepository.findByIds(client, workspaceId, [...botIds])
  const custom = personas.filter((persona) => persona.workspaceId === workspaceId && persona.managedBy !== "user")
  return [...custom, ...bots].map(({ id, name, avatarEmoji }) => ({ id, name, avatarEmoji }))
}

/**
 * Whether a page of `streamId` shares the message. A deleted message leaves the
 * partner's copy: in-app it shows as a bare placeholder, so its author and
 * times stay with the host. One moved away before the share is removed here and
 * arrives with the destination's own page.
 */
function isShared(message: Message, streamId: string): boolean {
  return message.streamId === streamId && message.deletedAt === null
}

function toBridgeMemo(
  {
    memo,
    conversationId,
    streamId,
    embedding,
  }: { memo: Memo; conversationId: string; streamId: string; embedding: number[] | null },
  participants: ReadonlySet<string>
): BridgeMemo {
  // The capture writes a memo's embedding in the transaction that inserts it.
  if (!embedding) throw new Error(`Shared memo ${memo.id} has no embedding`)
  return {
    id: memo.id,
    conversationId,
    streamId,
    title: memo.title,
    abstract: memo.abstract,
    keyPoints: memo.keyPoints,
    sourceMessageIds: memo.sourceMessageIds,
    participantIds: memo.participantIds.filter((id) => participants.has(id)),
    knowledgeType: memo.knowledgeType,
    tags: memo.tags,
    version: memo.version,
    cardVersion: memo.cardVersion,
    embedding,
    createdAt: memo.createdAt.toISOString(),
  }
}

function toBridgeConversation(
  { conversation, version, topicSummarySharedRootStreamId, summarySharedRootStreamId }: SharedConversation,
  rootStreamId: string,
  isInTree: (messageId: string) => boolean,
  participants: ReadonlySet<string>
): BridgeConversation {
  const titled = topicSummarySharedRootStreamId === rootStreamId
  return {
    id: conversation.id,
    streamId: conversation.streamId,
    topicSummary: titled ? conversation.topicSummary : null,
    topicSummarySource: titled ? (conversation.topicSummarySource ?? null) : null,
    topicSummaryRevision: conversation.topicSummaryRevision ?? 0,
    summary: summarySharedRootStreamId === rootStreamId ? conversation.summary : null,
    status: conversation.status,
    messageIds: conversation.messageIds.filter(isInTree),
    secondaryMessageIds: conversation.secondaryMessageIds.filter(isInTree),
    participantIds: conversation.participantIds.filter((id) => participants.has(id)),
    completenessScore: conversation.completenessScore,
    confidence: conversation.confidence,
    version,
    lastActivityAt: conversation.lastActivityAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
  }
}

function toBridgeMessage(
  message: Message,
  attachments: Attachment[],
  scope: ContentScope,
  callerAuthors: ReadonlySet<string>
): BridgeMessage {
  if (message.ciphertext) throw new Error(`Message ${message.id} is end-to-end encrypted and cannot be shared`)
  const contentJson = exportDoc(message.contentJson, scope)
  return {
    id: message.id,
    streamId: message.streamId,
    authorId: message.authorId,
    authorType: message.authorType,
    contentJson,
    contentMarkdown: deriveContentMarkdown(contentJson),
    reactions: message.reactions,
    revision: message.revision,
    editedAt: message.editedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      safetyStatus: attachment.safetyStatus,
      width: attachment.width,
      height: attachment.height,
    })),
    clientMessageId: callerAuthors.has(message.authorId) ? message.clientMessageId : null,
  }
}

/** Resolves every pointer the given documents hold, in one query per kind. */
async function loadContentScope(
  client: Querier,
  workspaceId: string,
  tree: ReadonlySet<string>,
  docs: JSONContent[]
): Promise<ContentScope> {
  const messageIds = new Set<string>()
  const attachmentIds = new Set<string>()
  const visit = (node: JSONContent): void => {
    const rule = BRIDGE_NODE_RULES.get(node.type ?? "")
    if (rule === "messageRef" || rule === "inAppLink") {
      const messageId = attr(node, "messageId")
      if (messageId) messageIds.add(messageId)
    } else if (rule === "attachmentReference") {
      const id = attr(node, "id")
      if (id) attachmentIds.add(id)
    }
    node.content?.forEach(visit)
  }
  docs.forEach(visit)

  const messages = await MessageRepository.findByIds(client, workspaceId, [...messageIds])
  const reachable = await AttachmentRepository.listReachableFromStreams(
    client,
    workspaceId,
    [...attachmentIds],
    [...tree]
  )
  return { tree, messages, attachmentIds: reachable, inboundMentions: null }
}

export interface ImportedContent {
  contentJson: JSONContent
  contentMarkdown: string
}

/**
 * Cleans a partner's document before the host stores it, with the markdown it
 * reads as. A mention stays only when it names a host user or a user of an
 * active partner of the tree (`partnerWorkspaceIds`, which holds the caller since
 * its own connection is active), so the partner can't point at a user, persona or
 * bot it has no standing to name. A file reference stays only for `attachmentIds`: the files the write
 * sends, or the edited message's own. Quotes, shares and other file references
 * drop: the partner's users hold no membership here to read what they point at.
 * An agent block becomes a blockquote, so it credits no agent. The caller's
 * users must already be copied here.
 */
export async function importDoc(
  client: PoolClient,
  params: {
    workspaceId: string
    partnerWorkspaceIds: string[]
    tree: Stream[]
    attachmentIds: string[]
    doc: JSONContent
  }
): Promise<ImportedContent> {
  const { workspaceId, partnerWorkspaceIds, doc } = params
  const userIds = [...new Set(collectMentionIds(doc).filter((id) => id.startsWith("usr_")))]
  const origins = await UserRepository.findOrigins(client, workspaceId, userIds)
  const allowedOrigins = new Set(partnerWorkspaceIds)
  const mentions = new Set(
    userIds.filter((id) => {
      const origin = origins.get(id)
      return origin === null || (origin !== undefined && allowedOrigins.has(origin))
    })
  )
  try {
    const contentJson = exportDoc(doc, {
      tree: new Set(params.tree.map((stream) => stream.id)),
      messages: new Map(),
      attachmentIds: new Set(params.attachmentIds),
      inboundMentions: mentions,
    })
    return { contentJson, contentMarkdown: deriveContentMarkdown(contentJson) }
  } catch (error) {
    if (error instanceof UnknownNodeTypeError || error instanceof UnknownContentError) {
      throw writeRefused("Content is not valid")
    }
    throw error
  }
}

function collectMentionIds(node: JSONContent): string[] {
  const own = BRIDGE_NODE_RULES.get(node.type ?? "") === "mention" ? [attr(node, "id") ?? ""] : []
  return [...own, ...(node.content ?? []).flatMap(collectMentionIds)]
}

/** Content naming a node or mark the bridge doesn't carry, which a partner's write is refused for. */
class UnknownContentError extends Error {}

function exportDoc(doc: JSONContent, scope: ContentScope): JSONContent {
  if (doc.type !== "doc") throw new UnknownContentError(`A document's root is ${doc.type}, not doc`)
  return exportNode(doc, scope)!
}

function exportNode(node: JSONContent, scope: ContentScope): JSONContent | null {
  const rule = BRIDGE_NODE_RULES.get(node.type ?? "")
  if (!rule) throw new UnknownNodeTypeError(node.type ?? "")
  for (const mark of node.marks ?? []) {
    if (!Object.hasOwn(BRIDGE_MARKS, mark.type)) throw new UnknownContentError(`Unknown mark type ${mark.type}`)
  }

  switch (rule) {
    case "keep":
      break
    case "agentBlock":
      if (scope.inboundMentions) return exportNode({ type: "blockquote", content: node.content }, scope)
      break
    case "mention":
      if (scope.inboundMentions) {
        const slug = attr(node, "slug")
        // Ingestion turns any mention with a broadcast slug into a broadcast, whatever its id.
        if (!scope.inboundMentions.has(attr(node, "id") ?? "") || isBroadcastSlug(slug?.toLowerCase() ?? "")) {
          return asText(node, slug ? `@${slug}` : null)
        }
      }
      break
    case "messageRef":
      if (!pointsIntoTree(attr(node, "messageId"), scope) || !scope.tree.has(attr(node, "streamId") ?? "")) return null
      break
    case "channelLink":
      if (!scope.tree.has(attr(node, "id") ?? "")) {
        const slug = attr(node, "slug")
        return asText(node, slug ? `#${slug}` : null)
      }
      break
    case "inAppLink": {
      const messageId = attr(node, "messageId")
      const inTree =
        scope.tree.has(attr(node, "streamId") ?? "") && (messageId === null || pointsIntoTree(messageId, scope))
      if (!inTree) return asText(node, attr(node, "name"))
      break
    }
    case "attachmentReference":
      if (!scope.attachmentIds.has(attr(node, "id") ?? "")) return null
      break
    case "memoEmbed":
      return asText(node, attr(node, "title"))
  }

  if (!node.content) return node
  return {
    ...node,
    content: node.content.map((child) => exportNode(child, scope)).filter((child) => child !== null),
  }
}

/** True when the message exists and currently lives in the shared tree. */
function pointsIntoTree(messageId: string | null, scope: ContentScope): boolean {
  const message = messageId ? scope.messages.get(messageId) : undefined
  return message !== undefined && scope.tree.has(message.streamId)
}

function attr(node: JSONContent, key: string): string | null {
  const value = node.attrs?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

/** The text a host reader sees on the node, keeping its marks. Nothing to show drops it. */
function asText(node: JSONContent, text: string | null): JSONContent | null {
  if (!text) return null
  return node.marks ? { type: "text", text, marks: node.marks } : { type: "text", text }
}
