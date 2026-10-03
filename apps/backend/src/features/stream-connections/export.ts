import type { Pool, PoolClient } from "pg"
import { UnknownNodeTypeError } from "@threahq/prosemirror"
import {
  StreamConnectionErrorCodes,
  StreamConnectionStates,
  type BridgeChange,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeMessage,
  type BridgeStream,
  type EventType,
  type JSONContent,
} from "@threahq/types"
import { withClient } from "../../db"
import { HttpError } from "../../lib/errors"
import { AttachmentRepository, type Attachment } from "../attachments"
import type { FeatureFlagService } from "../feature-flags"
import { MessageRepository, deriveContentMarkdown, type Message } from "../messaging"
import { StreamEventRepository, StreamRepository, normalizeStreamDescription, type Stream } from "../streams"
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

type NodeRule = "keep" | "messageRef" | "channelLink" | "inAppLink" | "attachmentReference" | "memoEmbed"

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
  ["agentBlock", "keep"],
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
  ["mention", "keep"],
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

const BRIDGE_MARKS: ReadonlySet<string> = new Set(["bold", "italic", "strike", "code", "link"])

const EMPTY_DOC: JSONContent = { type: "doc", content: [] }

interface BridgeCaller {
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
}

interface Dependencies {
  pool: Pool
  featureFlagService: FeatureFlagService
}

/** Serves a shared channel's tree to a partner's region: what is shared, and each stream's changes. */
export class StreamConnectionExportService {
  private readonly pool: Pool
  private readonly featureFlagService: FeatureFlagService

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.featureFlagService = deps.featureFlagService
  }

  async getManifest(caller: BridgeCaller): Promise<BridgeManifest> {
    return withClient(this.pool, async (client) => {
      const tree = await this.loadSharedTree(client, caller)
      const treeIds = new Set(tree.map((stream) => stream.id))
      const heads = await StreamEventRepository.listHeadSequences(client, [...treeIds])
      const descriptions = tree.flatMap((stream) => (stream.descriptionJson ? [stream.descriptionJson] : []))
      const scope = await loadContentScope(client, caller.workspaceId, treeIds, descriptions)
      return { streams: tree.map((stream) => toBridgeStream(stream, heads.get(stream.id) ?? 0n, scope)) }
    })
  }

  async listEvents(caller: BridgeCaller & { streamId: string; after: bigint; limit: number }): Promise<BridgeEvents> {
    return withClient(this.pool, async (client) => {
      const tree = await this.loadSharedTree(client, caller)
      const treeIds = new Set(tree.map((stream) => stream.id))
      if (!treeIds.has(caller.streamId)) throw connectionNotFound()

      // The head is read before the events, so every event at or below it has
      // committed: a writer holds the stream's sequence row from allocation
      // until its transaction commits. A short page can then move the cursor
      // to the head, past sequences that hold nothing for this stream (events
      // moved away with their messages, events the host keeps to itself).
      const heads = await StreamEventRepository.listHeadSequences(client, [caller.streamId])
      const head = heads.get(caller.streamId) ?? 0n
      const events = await StreamEventRepository.list(client, caller.streamId, {
        afterSequence: caller.after,
        beforeSequence: head + 1n,
        limit: caller.limit,
      })
      const hasMore = events.length === caller.limit
      const caughtUp = caller.after > head ? caller.after : head
      const cursor = hasMore ? events[events.length - 1].sequence : caughtUp

      const messageIds = [...new Set(events.flatMap((event) => changedMessageIds(event.eventType, event.payload)))]
      const messages = await MessageRepository.findByIdsInWorkspace(client, caller.workspaceId, messageIds)
      const shared = messageIds.flatMap((id) => {
        const message = messages.get(id)
        if (!message) throw new Error(`Message ${id} named by an event of stream ${caller.streamId} does not exist`)
        return treeIds.has(message.streamId) && !message.deletedAt ? [message] : []
      })
      const attachments = await AttachmentRepository.findByMessageIds(
        client,
        shared.map((message) => message.id)
      )
      const scope = await loadContentScope(
        client,
        caller.workspaceId,
        treeIds,
        shared.map((message) => message.contentJson)
      )

      const changes = messageIds.map((id): BridgeChange => {
        const message = messages.get(id)!
        return treeIds.has(message.streamId)
          ? { kind: "message", message: toBridgeMessage(message, attachments.get(id) ?? [], scope) }
          : { kind: "message_removed", messageId: id }
      })
      return { changes, cursor: cursor.toString(), hasMore }
    })
  }

  /**
   * The shared channel and the threads under it that hang off one of its
   * messages, at any depth. Every refusal is the same 404, so a caller learns
   * nothing about connections that are not its own.
   */
  private async loadSharedTree(client: PoolClient, caller: BridgeCaller): Promise<Stream[]> {
    const connection = await StreamConnectionRepository.findById(client, caller.workspaceId, caller.connectionId)
    const shared =
      connection?.role === "host" &&
      connection.state === StreamConnectionStates.ACTIVE &&
      connection.remoteWorkspaceId === caller.callerWorkspaceId
    if (!shared || !(await this.isEnabled(caller.workspaceId))) throw connectionNotFound()

    const root = await StreamRepository.findByIdForWorkspace(client, connection.streamId, caller.workspaceId)
    if (!root) throw new Error(`Shared channel ${connection.streamId} is missing from ${caller.workspaceId}`)

    const threadsByParent = new Map<string, Stream[]>()
    for (const thread of await StreamRepository.listThreadsByRoot(client, caller.workspaceId, root.id)) {
      if (!thread.parentStreamId || !thread.parentAnchorId?.startsWith("msg_")) continue
      threadsByParent.set(thread.parentStreamId, [...(threadsByParent.get(thread.parentStreamId) ?? []), thread])
    }
    const tree = [root]
    for (let i = 0; i < tree.length; i++) tree.push(...(threadsByParent.get(tree[i].id) ?? []))
    return tree
  }

  private async isEnabled(workspaceId: string): Promise<boolean> {
    return (await this.featureFlagService.getWorkspaceFlag(workspaceId, "streamConnections")) === "on"
  }
}

function connectionNotFound(): HttpError {
  return new HttpError("Connection not found", { status: 404, code: StreamConnectionErrorCodes.NOT_FOUND })
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
    displayName: stream.displayName,
    description: description?.description ?? null,
    descriptionJson: description?.descriptionJson ?? null,
    archivedAt: stream.archivedAt?.toISOString() ?? null,
    head: head.toString(),
  }
}

function toBridgeMessage(message: Message, attachments: Attachment[], scope: ContentScope): BridgeMessage {
  if (message.ciphertext) throw new Error(`Message ${message.id} is end-to-end encrypted and cannot be shared`)
  const deleted = message.deletedAt !== null
  const contentJson = deleted ? EMPTY_DOC : exportDoc(message.contentJson, scope)
  return {
    id: message.id,
    streamId: message.streamId,
    authorId: message.authorId,
    authorType: message.authorType,
    contentJson,
    contentMarkdown: deleted ? "" : deriveContentMarkdown(contentJson),
    reactions: deleted ? {} : message.reactions,
    revision: message.revision,
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    attachments: deleted
      ? []
      : attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          safetyStatus: attachment.safetyStatus,
        })),
  }
}

/** Resolves every pointer the given documents hold, in one query per kind. */
async function loadContentScope(
  client: PoolClient,
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

  const messages = await MessageRepository.findByIdsInWorkspace(client, workspaceId, [...messageIds])
  const reachable = await AttachmentRepository.listReachableFromStreams(
    client,
    workspaceId,
    [...attachmentIds],
    [...tree]
  )
  return { tree, messages, attachmentIds: reachable }
}

function exportDoc(doc: JSONContent, scope: ContentScope): JSONContent {
  if (doc.type !== "doc") throw new Error(`A document's root is ${doc.type}, not doc`)
  return exportNode(doc, scope)!
}

function exportNode(node: JSONContent, scope: ContentScope): JSONContent | null {
  const rule = BRIDGE_NODE_RULES.get(node.type ?? "")
  if (!rule) throw new UnknownNodeTypeError(node.type ?? "")
  for (const mark of node.marks ?? []) {
    if (!BRIDGE_MARKS.has(mark.type)) throw new Error(`Unknown mark type ${mark.type}`)
  }

  switch (rule) {
    case "keep":
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
