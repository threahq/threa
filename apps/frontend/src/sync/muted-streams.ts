import {
  NOTIFICATION_INHERIT_DEPTH,
  NotificationLevels,
  resolveInheritedNotificationLevel,
  type InheritedNotificationLevel,
  type NotificationLevel,
  type Stream,
} from "@threahq/types"

type StreamLink = Pick<Stream, "id" | "type" | "parentStreamId" | "archivedAt">

export interface MuteSources {
  streams: ReadonlyMap<string, StreamLink>
  /** The viewer's own level on each stream they're a member of. */
  levels: ReadonlyMap<string, NotificationLevel | null>
}

export function muteSources(
  streams: Iterable<StreamLink>,
  memberships: Iterable<{ streamId: string; notificationLevel: NotificationLevel | null }>
): MuteSources {
  return {
    streams: new Map(Array.from(streams, (stream) => [stream.id, stream])),
    levels: new Map(Array.from(memberships, (membership) => [membership.streamId, membership.notificationLevel])),
  }
}

interface CachedAncestor {
  streamId: string
  level: NotificationLevel | null | undefined
}

interface CachedWalk {
  /** Nearest first, ending at the first ancestor with a level of its own. */
  ancestors: CachedAncestor[]
  /** The archived or uncached parent the walk reached before any ancestor's level decided. */
  unknownParentId: string | null
}

function walkCachedAncestors(stream: Pick<StreamLink, "parentStreamId">, sources: MuteSources): CachedWalk {
  const ancestors: CachedAncestor[] = []
  let parentId = stream.parentStreamId
  while (parentId && ancestors.length < NOTIFICATION_INHERIT_DEPTH) {
    const parent = sources.streams.get(parentId)
    // Archived parents ship without the viewer's membership, and uncached ones
    // without a row: the client can't know their level, the server can.
    if (!parent || parent.archivedAt) return { ancestors, unknownParentId: parentId }
    const level = sources.levels.get(parentId)
    ancestors.push({ streamId: parentId, level })
    if (level) break
    parentId = parent.parentStreamId
  }
  return { ancestors, unknownParentId: null }
}

/**
 * The level `stream` gets with no level of its own, from the viewer's cached
 * levels on its ancestors. When the walk reaches a parent the client can't
 * resolve, the server's muted set answers instead: it was computed from that
 * parent's real membership. With no server state to read (no set, or a stream
 * whose own level put it there) the type default applies.
 */
export function inheritedNotificationLevel(
  stream: Pick<StreamLink, "type" | "parentStreamId"> & { id?: string },
  sources: MuteSources,
  serverMutedStreamIds: ReadonlySet<string> | undefined
): InheritedNotificationLevel<{ streamId: string }> {
  const walk = walkCachedAncestors(stream, sources)
  if (!walk.unknownParentId) return resolveInheritedNotificationLevel(stream.type, walk.ancestors)
  const serverSaysMuted =
    stream.id !== undefined && sources.levels.get(stream.id) == null && serverMutedStreamIds?.has(stream.id)
  if (serverSaysMuted) return { level: NotificationLevels.MUTED, from: { streamId: walk.unknownParentId } }
  return resolveInheritedNotificationLevel(stream.type, [])
}

/**
 * Re-derives `muted` for each of `changedStreamIds` and every member stream
 * that inherits its level through one of them, by the rule push uses. Returns
 * the ids it re-derived; a stream with no cached row, or one inheriting from a
 * parent the client can't resolve, is left as it was.
 */
export function refreshMutedStreams(
  muted: Set<string>,
  changedStreamIds: Iterable<string>,
  sources: MuteSources
): string[] {
  const changed = new Set(changedStreamIds)
  const refreshed: string[] = []
  for (const streamId of new Set([...changed, ...sources.levels.keys()])) {
    const stream = sources.streams.get(streamId)
    if (!stream) continue
    const walk = walkCachedAncestors(stream, sources)
    if (!changed.has(streamId) && !walk.ancestors.some((ancestor) => changed.has(ancestor.streamId))) continue
    const ownLevel = sources.levels.get(streamId)
    // The server's mute for it, computed from the parent's real membership, stands.
    if (!ownLevel && walk.unknownParentId) continue
    const level = ownLevel ?? resolveInheritedNotificationLevel(stream.type, walk.ancestors).level
    if (level === NotificationLevels.MUTED) muted.add(streamId)
    else muted.delete(streamId)
    refreshed.push(streamId)
  }
  return refreshed
}
