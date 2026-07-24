import type { Querier } from "../../../db"
import {
  type AttachmentSummary,
  type JSONContent,
  type StreamType,
  type Visibility,
  StreamTypes,
  sharedMessageSlotKey,
} from "@threa/types"
import { MessageRepository, type Message } from "../repository"
import { resolveActorNames } from "../../agents"
import { listAccessibleStreamIds, listRoomReadableStreamIds, StreamRepository, type Stream } from "../../streams"
import { AttachmentRepository, toAttachmentSummary, fetchUploadStatuses } from "../../attachments"

import { SharedMessageRepository } from "./repository"

/**
 * Hard cap on how many nested pointer levels we'll resolve in one read.
 * Realistically chains rarely exceed 1–2 hops; the cap protects against
 * pathological data. Pointers beyond the cap render as a `truncated`
 * placeholder linking to the source stream.
 */
export const MAX_HYDRATION_DEPTH = 3

/**
 * Hydrated payload for a single shared-message reference. The frontend
 * overlays this data onto the inline `sharedMessage` node at render time.
 *
 * Variants:
 * - `ok`: viewer has access; current source content is inlined.
 * - `deleted`: source row exists but is tombstoned.
 * - `missing`: source row never existed (defended for; shouldn't normally
 *   happen because shares are recorded against existing source ids).
 * - `private`: viewer has no read path to the source — reveals only the
 *   source stream's `kind` + `visibility`, never content/author/name. Used
 *   for re-share chains where a downstream viewer can see the outer
 *   pointer but not an inner one.
 * - `truncated`: hydration stopped at `MAX_HYDRATION_DEPTH` for an
 *   accessible chain; viewer can navigate to `streamId` to keep reading.
 */
export type HydratedSharedMessage =
  | {
      type: "sharedMessage"
      state: "ok"
      messageId: string
      streamId: string
      authorId: string
      authorType: string
      authorName: string | null
      contentJson: JSONContent
      contentMarkdown: string
      editedAt: Date | null
      createdAt: Date
      /**
       * Attachments on the source message. Always present (possibly empty)
       * so the wire shape is uniform; rides only on `ok` payloads where
       * viewer access to the source is already established by the access
       * resolver above, so no privacy gap.
       */
      attachments: AttachmentSummary[]
    }
  | { type: "sharedMessage"; state: "deleted"; messageId: string; deletedAt: Date }
  | { type: "sharedMessage"; state: "missing"; messageId: string }
  | {
      type: "sharedMessage"
      state: "private"
      messageId: string
      sourceStreamKind: StreamType
      sourceVisibility: Visibility
    }
  | { type: "sharedMessage"; state: "truncated"; messageId: string; streamId: string }

type AccessResolvers = {
  accessibleStreams(db: Querier, workspaceId: string, streamIds: string[]): Promise<Set<string>>
  grantedSources(db: Querier, workspaceId: string, sourceMessageIds: string[]): Promise<Set<string>>
}

interface SharedMessageNodeAttrs {
  messageId?: string
  streamId?: string
}

/**
 * Walk a ProseMirror content tree and invoke `visit` for every
 * `sharedMessage` node's `attrs`. The two `collect*` helpers below are
 * thin specialisations around this single walker so the recursion stays
 * defined in one place.
 */
function walkSharedMessageNodes(node: JSONContent | undefined, visit: (attrs: SharedMessageNodeAttrs) => void): void {
  if (!node) return
  if (node.type === "sharedMessage") {
    visit((node.attrs ?? {}) as SharedMessageNodeAttrs)
  }
  if (node.content) {
    for (const child of node.content) {
      walkSharedMessageNodes(child, visit)
    }
  }
}

/**
 * Collect every `sharedMessage` node's `messageId` from a content tree.
 * Exported so stream event projections can scan `message_created` /
 * `message_edited` payload content alongside direct Message[] inputs.
 */
export function collectSharedMessageIds(node: JSONContent | undefined, into: Set<string>): void {
  walkSharedMessageNodes(node, (attrs) => {
    if (attrs.messageId) into.add(attrs.messageId)
  })
}

/**
 * Like {@link collectSharedMessageIds} but also captures each ref's cached
 * `streamId` from the node attrs. Used during recursive hydration so a
 * pointer past the depth cap can render a "Open in source stream" link
 * without a per-ref DB lookup.
 */
function collectSharedMessageRefs(node: JSONContent | undefined, into: Map<string, string>): void {
  walkSharedMessageNodes(node, (attrs) => {
    if (attrs.messageId && attrs.streamId) into.set(attrs.messageId, attrs.streamId)
  })
}

/**
 * Resolve the (kind, visibility) the `private` placeholder should report.
 * For thread sources we surface the parent's kind/visibility so the
 * placeholder vocabulary stays in {channel, dm, scratchpad} —
 * "thread" by itself wouldn't tell the viewer what kind of stream sits
 * behind the wall.
 */
function resolveSourceForPrivatePlaceholder(
  source: Stream,
  byStreamId: ReadonlyMap<string, Stream>
): { kind: StreamType; visibility: Visibility } {
  if (source.type === StreamTypes.THREAD && source.rootStreamId) {
    const root = byStreamId.get(source.rootStreamId)
    if (root) return { kind: root.type, visibility: root.visibility }
  }
  return { kind: source.type, visibility: source.visibility }
}

/**
 * Per-viewer recursive pointer hydration. Walks each pointer chain
 * level-by-level up to {@link MAX_HYDRATION_DEPTH}; at every level the
 * viewer's access is resolved via {@link listAccessibleStreamIds} (direct
 * member, public visibility, or thread inheriting from root) plus the
 * share-grant lookup (the viewer can also read a source iff a share with
 * that source exists in a target stream the viewer can read).
 *
 * Each level performs a fixed handful of batched queries (no per-ref DB
 * loops, INV-56): one `findByIdsInWorkspace`, one accessible-streams
 * lookup, one share-grant lookup. Author names and the private-placeholder
 * source-stream lookup are batched once at the end.
 *
 * Pointers collected at level `MAX_HYDRATION_DEPTH` are emitted as
 * `truncated` using the cached `streamId` from the parent's node attrs —
 * no extra DB hit. If the viewer doesn't have access there, clicking
 * through will 403 like any other deep link, which is fine; the cap is a
 * pathological-data guard, not a privacy guard.
 */
async function hydrateSharedMessageIdsWithResolvers(
  db: Querier,
  workspaceId: string,
  sourceMessageIds: Iterable<string>,
  resolvers: AccessResolvers
): Promise<Record<string, HydratedSharedMessage>> {
  const seedIds = Array.from(new Set(sourceMessageIds))
  if (seedIds.length === 0) return {}

  const result: Record<string, HydratedSharedMessage> = {}
  const visited = new Set<string>()
  const okMessages = new Map<string, Message>()
  const privateBuckets = new Map<string, string>()

  // Seed level has no attrs streamId since the seeds came in as bare ids;
  // nested levels populate it via `collectSharedMessageRefs` so truncated
  // entries past the cap can link to the right stream without an extra
  // DB hit.
  let frontier = new Map<string, string>(seedIds.map((id) => [id, ""]))
  let depth = 0

  while (frontier.size > 0 && depth < MAX_HYDRATION_DEPTH) {
    const ids = [...frontier.keys()].filter((id) => !visited.has(id))
    if (ids.length === 0) break
    for (const id of ids) visited.add(id)

    const byId = await MessageRepository.findByIdsInWorkspace(db, workspaceId, ids)
    const fetchedStreamIds = [...byId.values()].map((m) => m.streamId)
    const [accessibleStreams, grantedSources] = await Promise.all([
      resolvers.accessibleStreams(db, workspaceId, fetchedStreamIds),
      resolvers.grantedSources(db, workspaceId, ids),
    ])

    const nextFrontier = new Map<string, string>()
    for (const id of ids) {
      const source = byId.get(id)
      if (!source) {
        result[id] = { type: "sharedMessage", state: "missing", messageId: id }
        continue
      }
      const hasAccess = accessibleStreams.has(source.streamId) || grantedSources.has(id)
      if (!hasAccess) {
        privateBuckets.set(id, source.streamId)
        continue
      }
      if (source.deletedAt) {
        result[id] = { type: "sharedMessage", state: "deleted", messageId: id, deletedAt: source.deletedAt }
        continue
      }
      okMessages.set(id, source)
      collectSharedMessageRefs(source.contentJson, nextFrontier)
    }

    frontier = nextFrontier
    depth++
  }

  // Anything still in frontier has been collected from depth=MAX-1's
  // accessible content but we won't recurse into it. The cached `streamId`
  // from the share-node attrs goes stale when the source message gets moved
  // (batch move-to-thread doesn't rewrite cached attrs), so resolve the
  // current streamId from the live row.
  //
  // Mirror the BFS access check so this branch can't surface a streamId the
  // viewer can't read (post-move, the source might live in a private thread
  // the viewer was never a member of) or a `deleted` tombstone for an
  // inaccessible source. Inaccessible entries route into the existing
  // privateBuckets path so the wire shape stays uniform.
  const truncatedIds = [...frontier.keys()].filter((id) => !visited.has(id) && !result[id])
  if (truncatedIds.length > 0) {
    const truncatedMessages = await MessageRepository.findByIdsInWorkspace(db, workspaceId, truncatedIds)
    const fetchedStreamIds = [...truncatedMessages.values()].map((m) => m.streamId)
    const [accessibleStreams, grantedSources] = await Promise.all([
      resolvers.accessibleStreams(db, workspaceId, fetchedStreamIds),
      resolvers.grantedSources(db, workspaceId, truncatedIds),
    ])
    for (const id of truncatedIds) {
      const msg = truncatedMessages.get(id)
      if (!msg) {
        result[id] = { type: "sharedMessage", state: "missing", messageId: id }
        continue
      }
      const hasAccess = accessibleStreams.has(msg.streamId) || grantedSources.has(id)
      if (!hasAccess) {
        privateBuckets.set(id, msg.streamId)
        continue
      }
      if (msg.deletedAt) {
        result[id] = { type: "sharedMessage", state: "deleted", messageId: id, deletedAt: msg.deletedAt }
        continue
      }
      result[id] = { type: "sharedMessage", state: "truncated", messageId: id, streamId: msg.streamId }
    }
  }

  if (privateBuckets.size > 0) {
    const directIds = [...new Set(privateBuckets.values())]
    const streams = await StreamRepository.findByIds(db, directIds)
    const byStreamId = new Map(streams.map((s) => [s.id, s]))
    const rootIds = [
      ...new Set(
        streams.flatMap((s) =>
          s.type === StreamTypes.THREAD && s.rootStreamId && !byStreamId.has(s.rootStreamId) ? [s.rootStreamId] : []
        )
      ),
    ]
    if (rootIds.length > 0) {
      const roots = await StreamRepository.findByIds(db, rootIds)
      for (const r of roots) byStreamId.set(r.id, r)
    }
    for (const [id, streamId] of privateBuckets) {
      const source = byStreamId.get(streamId)
      if (!source) {
        result[id] = { type: "sharedMessage", state: "missing", messageId: id }
        continue
      }
      const { kind, visibility } = resolveSourceForPrivatePlaceholder(source, byStreamId)
      result[id] = {
        type: "sharedMessage",
        state: "private",
        messageId: id,
        sourceStreamKind: kind,
        sourceVisibility: visibility,
      }
    }
  }

  if (okMessages.size > 0) {
    const actorIds = new Set<string>()
    for (const msg of okMessages.values()) actorIds.add(msg.authorId)
    // One round-trip for author names and one for attachments across every
    // ok-state message, regardless of chain depth (INV-56). Mirrors
    // `event-service.ts`'s `attachmentSummaries` shape so the wire payload
    // for a shared message matches what `message_created` would have
    // emitted on the source stream.
    const [authorNames, attachmentsByMessageId] = await Promise.all([
      resolveActorNames(db, workspaceId, actorIds),
      AttachmentRepository.findByMessageIds(db, [...okMessages.keys()]),
    ])
    const uploadStatuses = await fetchUploadStatuses(db, workspaceId, [...attachmentsByMessageId.values()].flat())
    for (const [id, source] of okMessages) {
      const attachments = (attachmentsByMessageId.get(source.id) ?? []).map((a) =>
        toAttachmentSummary(a, uploadStatuses.get(a.id))
      )
      result[id] = {
        type: "sharedMessage",
        state: "ok",
        messageId: source.id,
        streamId: source.streamId,
        authorId: source.authorId,
        authorType: source.authorType,
        authorName: authorNames.get(source.authorId) ?? null,
        contentJson: source.contentJson,
        contentMarkdown: source.contentMarkdown,
        editedAt: source.editedAt,
        createdAt: source.createdAt,
        attachments,
      }
    }
  }

  // Defensive backfill — every requested id should have a result by now;
  // anything left over (e.g. a seed id that hit no path above) is missing.
  for (const id of seedIds) {
    if (!result[id]) result[id] = { type: "sharedMessage", state: "missing", messageId: id }
  }

  return result
}

export function hydrateSharedMessageIds(
  db: Querier,
  workspaceId: string,
  viewerId: string,
  sourceMessageIds: Iterable<string>
): Promise<Record<string, HydratedSharedMessage>> {
  return hydrateSharedMessageIdsWithResolvers(db, workspaceId, sourceMessageIds, {
    accessibleStreams: (querier, ws, ids) => listAccessibleStreamIds(querier, ws, viewerId, ids),
    grantedSources: (querier, ws, ids) =>
      SharedMessageRepository.listSourcesGrantedToViewer(querier, ws, viewerId, ids),
  })
}

export function hydrateSharedMessagesForRoom(
  db: Querier,
  workspaceId: string,
  targetStreamId: string,
  sourceMessageIds: Iterable<string>
): Promise<Record<string, HydratedSharedMessage>> {
  return hydrateSharedMessageIdsWithResolvers(db, workspaceId, sourceMessageIds, {
    accessibleStreams: (querier, ws, ids) => listRoomReadableStreamIds(querier, ws, targetStreamId, ids),
    grantedSources: (querier, ws, ids) =>
      SharedMessageRepository.listSourcesGrantedToRoom(querier, ws, targetStreamId, ids),
  })
}

/**
 * Hydrate against a precomputed accessible-stream set instead of a viewer id.
 * Used by the public API, where the key principal's readable streams (active +
 * archived) are resolved once up front and reused across a whole page of rows
 * (INV-56): access is set-intersection, and grants resolve against any stream
 * in the set rather than a per-viewer membership query.
 */
export function hydrateSharedMessageIdsForAccessibleSet(
  db: Querier,
  workspaceId: string,
  accessibleStreamIds: ReadonlySet<string>,
  sourceMessageIds: Iterable<string>
): Promise<Record<string, HydratedSharedMessage>> {
  return hydrateSharedMessageIdsWithResolvers(db, workspaceId, sourceMessageIds, {
    accessibleStreams: async (_querier, _ws, ids) => new Set(ids.filter((id) => accessibleStreamIds.has(id))),
    grantedSources: (querier, ws, ids) =>
      SharedMessageRepository.listSourcesGrantedToAnyStream(querier, ws, accessibleStreamIds, ids),
  })
}

/**
 * The dual-publish envelope: one hydration result expressed as both the
 * canonical namespaced map (`shared:<messageId>` keys) and the temporary
 * legacy bare-key map. Values are identical — only the key scheme differs —
 * so old and new clients reading the same response see the same content.
 * Both derive from the single hydration result (no duplicate query path).
 */
export interface DualSlotMaps {
  slots: Record<string, HydratedSharedMessage>
  sharedMessages: Record<string, HydratedSharedMessage>
}

export function toDualSlotMaps(hydrated: Record<string, HydratedSharedMessage>): DualSlotMaps {
  const slots: Record<string, HydratedSharedMessage> = {}
  for (const [messageId, slot] of Object.entries(hydrated)) {
    slots[sharedMessageSlotKey(messageId)] = slot
  }
  return { slots, sharedMessages: hydrated }
}

/**
 * Convenience: hydrate from a list of already-loaded messages. Scans each
 * message's `contentJson` for share-node references then delegates to
 * `hydrateSharedMessageIds`.
 */
export async function hydrateSharedMessages(
  db: Querier,
  workspaceId: string,
  viewerId: string,
  messages: readonly Message[]
): Promise<Record<string, HydratedSharedMessage>> {
  const ids = new Set<string>()
  for (const msg of messages) {
    collectSharedMessageIds(msg.contentJson, ids)
  }
  return hydrateSharedMessageIds(db, workspaceId, viewerId, ids)
}
