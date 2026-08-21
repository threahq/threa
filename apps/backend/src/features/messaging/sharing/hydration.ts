import type { Querier } from "../../../db"
import {
  type AttachmentSummary,
  type ContentRange,
  type JSONContent,
  type SharedMessageRef,
  type StreamType,
  type Visibility,
  StreamTypes,
  sharedMessageSlotKey,
} from "@threa/types"
import { MessageRepository, type Message } from "../repository"
import { MessageVersionRepository, messageVersionKey, type MessageVersionKey } from "../version-repository"
import { sliceReferenceContent } from "../references/slice"
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
 * - `ok`: viewer has access; the pinned source content is inlined.
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
       * resolver above, so no privacy gap. A RANGED reference carries none:
       * the sharer picked a span of text, not the message's files.
       */
      attachments: AttachmentSummary[]
      /** The source revision this content came from. */
      version: number
      /** The source's revision right now; greater than `version` = edited since. */
      currentRevision: number
      /** The span of `version` rendered here; `null` = the whole message. */
      range: ContentRange | null
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
  version?: number | null
  range?: ContentRange | null
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
 * Exported for callers that only need the set of source messages (agent
 * context building); hydration keys off {@link collectSharedMessageRefs}
 * instead, because two pointers at the same message can name different
 * revisions or spans.
 */
export function collectSharedMessageIds(node: JSONContent | undefined, into: Set<string>): void {
  walkSharedMessageNodes(node, (attrs) => {
    if (attrs.messageId) into.add(attrs.messageId)
  })
}

/**
 * Collect every `sharedMessage` node as the reference hydration resolves:
 * message, pinned revision, span. Keyed by slot key so the same source at two
 * different pins stays two entries. `version`/`range` are absent on legacy
 * nodes written before the server pinned references — those hydrate at the
 * source's current revision under the bare `shared:<id>` key.
 */
export function collectSharedMessageRefs(node: JSONContent | undefined, into: Map<string, SharedMessageRef>): void {
  walkSharedMessageNodes(node, (attrs) => {
    if (!attrs.messageId) return
    const ref: SharedMessageRef = {
      messageId: attrs.messageId,
      version: attrs.version ?? null,
      range: attrs.range ?? null,
    }
    into.set(sharedMessageSlotKey(ref.messageId, ref.version, ref.range), ref)
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

/** An accessible, live source resolved down to the body its reference pins. */
interface ResolvedOkRef {
  ref: SharedMessageRef
  source: Message
  version: number
  contentJson: JSONContent
  contentMarkdown: string
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
 * lookup, one share-grant lookup, and one `findByMessageVersions` for the
 * pins that name an older revision. Author names and the private-placeholder
 * source-stream lookup are batched once at the end.
 *
 * Recursion follows the PINNED body: a nested pointer that only exists in the
 * source's current revision is not reachable from a reference pinned to an
 * older one, which is the point of pinning.
 *
 * Pointers collected at level `MAX_HYDRATION_DEPTH` are emitted as
 * `truncated` using the source's current streamId — the cached `streamId` on
 * the node attrs goes stale when the source is moved.
 */
async function hydrateSharedMessageRefsWithResolvers(
  db: Querier,
  workspaceId: string,
  refs: Iterable<SharedMessageRef>,
  resolvers: AccessResolvers
): Promise<Record<string, HydratedSharedMessage>> {
  const seeds = new Map<string, SharedMessageRef>()
  for (const ref of refs) {
    seeds.set(sharedMessageSlotKey(ref.messageId, ref.version, ref.range), ref)
  }
  if (seeds.size === 0) return {}

  const result: Record<string, HydratedSharedMessage> = {}
  const visited = new Set<string>()
  const okRefs = new Map<string, ResolvedOkRef>()
  const privateBuckets = new Map<string, { messageId: string; streamId: string }>()

  let frontier = seeds
  let depth = 0

  while (frontier.size > 0 && depth < MAX_HYDRATION_DEPTH) {
    const level = [...frontier].filter(([key]) => !visited.has(key))
    if (level.length === 0) break
    for (const [key] of level) visited.add(key)

    const ids = [...new Set(level.map(([, ref]) => ref.messageId))]
    const byId = await MessageRepository.findByIdsInWorkspace(db, workspaceId, ids)
    const fetchedStreamIds = [...byId.values()].map((m) => m.streamId)
    const [accessibleStreams, grantedSources] = await Promise.all([
      resolvers.accessibleStreams(db, workspaceId, fetchedStreamIds),
      resolvers.grantedSources(db, workspaceId, ids),
    ])

    const live: Array<{ key: string; ref: SharedMessageRef; source: Message; version: number }> = []
    const versionKeys: MessageVersionKey[] = []
    for (const [key, ref] of level) {
      const source = byId.get(ref.messageId)
      if (!source) {
        result[key] = { type: "sharedMessage", state: "missing", messageId: ref.messageId }
        continue
      }
      const hasAccess = accessibleStreams.has(source.streamId) || grantedSources.has(ref.messageId)
      if (!hasAccess) {
        privateBuckets.set(key, { messageId: ref.messageId, streamId: source.streamId })
        continue
      }
      if (source.deletedAt) {
        result[key] = { type: "sharedMessage", state: "deleted", messageId: ref.messageId, deletedAt: source.deletedAt }
        continue
      }
      const version = ref.version ?? source.revision
      live.push({ key, ref, source, version })
      if (version !== source.revision) versionKeys.push({ messageId: ref.messageId, versionNumber: version })
    }

    const versionRows = await MessageVersionRepository.findByMessageVersions(db, versionKeys)

    const nextFrontier = new Map<string, SharedMessageRef>()
    for (const { key, ref, source, version } of live) {
      const pinned =
        version === source.revision
          ? source.contentJson
          : versionRows.get(messageVersionKey(ref.messageId, version))?.contentJson
      if (!pinned) {
        result[key] = { type: "sharedMessage", state: "missing", messageId: ref.messageId }
        continue
      }
      const content = sliceReferenceContent(pinned, ref.range)
      okRefs.set(key, { ref, source, version, ...content })
      collectSharedMessageRefs(content.contentJson, nextFrontier)
    }

    frontier = nextFrontier
    depth++
  }

  // Anything still in frontier was collected from depth=MAX-1's accessible
  // content but we won't recurse into it.
  //
  // Mirror the BFS access check so this branch can't surface a streamId the
  // viewer can't read (post-move, the source might live in a private thread
  // the viewer was never a member of) or a `deleted` tombstone for an
  // inaccessible source. Inaccessible entries route into the existing
  // privateBuckets path so the wire shape stays uniform.
  const truncated = [...frontier].filter(([key]) => !visited.has(key) && !result[key])
  if (truncated.length > 0) {
    const truncatedIds = [...new Set(truncated.map(([, ref]) => ref.messageId))]
    const truncatedMessages = await MessageRepository.findByIdsInWorkspace(db, workspaceId, truncatedIds)
    const fetchedStreamIds = [...truncatedMessages.values()].map((m) => m.streamId)
    const [accessibleStreams, grantedSources] = await Promise.all([
      resolvers.accessibleStreams(db, workspaceId, fetchedStreamIds),
      resolvers.grantedSources(db, workspaceId, truncatedIds),
    ])
    for (const [key, ref] of truncated) {
      const msg = truncatedMessages.get(ref.messageId)
      if (!msg) {
        result[key] = { type: "sharedMessage", state: "missing", messageId: ref.messageId }
        continue
      }
      const hasAccess = accessibleStreams.has(msg.streamId) || grantedSources.has(ref.messageId)
      if (!hasAccess) {
        privateBuckets.set(key, { messageId: ref.messageId, streamId: msg.streamId })
        continue
      }
      if (msg.deletedAt) {
        result[key] = { type: "sharedMessage", state: "deleted", messageId: ref.messageId, deletedAt: msg.deletedAt }
        continue
      }
      result[key] = { type: "sharedMessage", state: "truncated", messageId: ref.messageId, streamId: msg.streamId }
    }
  }

  if (privateBuckets.size > 0) {
    const directIds = [...new Set([...privateBuckets.values()].map((entry) => entry.streamId))]
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
    for (const [key, { messageId, streamId }] of privateBuckets) {
      const source = byStreamId.get(streamId)
      if (!source) {
        result[key] = { type: "sharedMessage", state: "missing", messageId }
        continue
      }
      const { kind, visibility } = resolveSourceForPrivatePlaceholder(source, byStreamId)
      result[key] = {
        type: "sharedMessage",
        state: "private",
        messageId,
        sourceStreamKind: kind,
        sourceVisibility: visibility,
      }
    }
  }

  if (okRefs.size > 0) {
    const actorIds = new Set<string>()
    // Only an UNRANGED reference carries the source's attachments — a ranged
    // one points at a span of text, so its card shows no files.
    const attachmentMessageIds = new Set<string>()
    for (const entry of okRefs.values()) {
      actorIds.add(entry.source.authorId)
      if (entry.ref.range === null) attachmentMessageIds.add(entry.source.id)
    }
    // One round-trip for author names and one for attachments across every
    // ok-state message, regardless of chain depth (INV-56). Mirrors
    // `event-service.ts`'s `attachmentSummaries` shape so the wire payload
    // for a shared message matches what `message_created` would have
    // emitted on the source stream.
    const [authorNames, attachmentsByMessageId] = await Promise.all([
      resolveActorNames(db, workspaceId, actorIds),
      AttachmentRepository.findByMessageIds(db, [...attachmentMessageIds]),
    ])
    const uploadStatuses = await fetchUploadStatuses(db, workspaceId, [...attachmentsByMessageId.values()].flat())
    for (const [key, entry] of okRefs) {
      const { source, ref } = entry
      const attachments =
        ref.range === null
          ? (attachmentsByMessageId.get(source.id) ?? []).map((a) => toAttachmentSummary(a, uploadStatuses.get(a.id)))
          : []
      result[key] = {
        type: "sharedMessage",
        state: "ok",
        messageId: source.id,
        streamId: source.streamId,
        authorId: source.authorId,
        authorType: source.authorType,
        authorName: authorNames.get(source.authorId) ?? null,
        contentJson: entry.contentJson,
        contentMarkdown: entry.contentMarkdown,
        editedAt: source.editedAt,
        createdAt: source.createdAt,
        attachments,
        version: entry.version,
        currentRevision: source.revision,
        range: ref.range,
      }
    }
  }

  // Defensive backfill — every requested ref should have a result by now;
  // anything left over (e.g. a seed that hit no path above) is missing.
  for (const [key, ref] of seeds) {
    if (!result[key]) result[key] = { type: "sharedMessage", state: "missing", messageId: ref.messageId }
  }

  return result
}

export function hydrateSharedMessageRefs(
  db: Querier,
  workspaceId: string,
  viewerId: string,
  refs: Iterable<SharedMessageRef>
): Promise<Record<string, HydratedSharedMessage>> {
  return hydrateSharedMessageRefsWithResolvers(db, workspaceId, refs, {
    accessibleStreams: (querier, ws, ids) => listAccessibleStreamIds(querier, ws, viewerId, ids),
    grantedSources: (querier, ws, ids) =>
      SharedMessageRepository.listSourcesGrantedToViewer(querier, ws, viewerId, ids),
  })
}

export function hydrateSharedMessageRefsForRoom(
  db: Querier,
  workspaceId: string,
  targetStreamId: string,
  refs: Iterable<SharedMessageRef>
): Promise<Record<string, HydratedSharedMessage>> {
  return hydrateSharedMessageRefsWithResolvers(db, workspaceId, refs, {
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
export function hydrateSharedMessageRefsForAccessibleSet(
  db: Querier,
  workspaceId: string,
  accessibleStreamIds: ReadonlySet<string>,
  refs: Iterable<SharedMessageRef>
): Promise<Record<string, HydratedSharedMessage>> {
  return hydrateSharedMessageRefsWithResolvers(db, workspaceId, refs, {
    accessibleStreams: async (_querier, _ws, ids) => new Set(ids.filter((id) => accessibleStreamIds.has(id))),
    grantedSources: (querier, ws, ids) =>
      SharedMessageRepository.listSourcesGrantedToAnyStream(querier, ws, accessibleStreamIds, ids),
  })
}

/**
 * The dual-publish envelope: one hydration result expressed as both the
 * canonical namespaced map (pin-carrying `shared:<id>[@v[:from-to]]` keys) and
 * the temporary legacy bare-key map. Both derive from the single hydration
 * result (no duplicate query path).
 */
export interface DualSlotMaps {
  slots: Record<string, HydratedSharedMessage>
  sharedMessages: Record<string, HydratedSharedMessage>
}

/**
 * How well a slot stands in for "the whole current message" — the thing a
 * pre-pin client asks for when it looks a source up by bare id. Unranged beats
 * ranged, and a newer revision beats an older one.
 */
function legacyKeyPreference(slot: HydratedSharedMessage): number {
  if (slot.state !== "ok") return -1
  return (slot.range === null ? 1_000_000 : 0) + slot.version
}

export function toDualSlotMaps(hydrated: Record<string, HydratedSharedMessage>): DualSlotMaps {
  const sharedMessages: Record<string, HydratedSharedMessage> = {}
  for (const slot of Object.values(hydrated)) {
    const existing = sharedMessages[slot.messageId]
    if (!existing || legacyKeyPreference(slot) > legacyKeyPreference(existing)) {
      sharedMessages[slot.messageId] = slot
    }
  }
  return { slots: { ...hydrated }, sharedMessages }
}

/**
 * Convenience: hydrate from a list of already-loaded messages. Scans each
 * message's `contentJson` for share-node references then delegates to
 * `hydrateSharedMessageRefs`.
 */
export async function hydrateSharedMessages(
  db: Querier,
  workspaceId: string,
  viewerId: string,
  messages: readonly Message[]
): Promise<Record<string, HydratedSharedMessage>> {
  const refs = new Map<string, SharedMessageRef>()
  for (const msg of messages) {
    collectSharedMessageRefs(msg.contentJson, refs)
  }
  return hydrateSharedMessageRefs(db, workspaceId, viewerId, refs.values())
}
