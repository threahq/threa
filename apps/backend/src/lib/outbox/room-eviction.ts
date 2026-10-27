import type { Pool } from "pg"
import type { Server } from "socket.io"
import type { MainSocketData } from "../../socket"
import { docReadersGroup, groupToRoom, streamGroup, userGroup } from "./delivery-groups"
import { isOutboxEventType, type OutboxEvent } from "./repository"
import { logger } from "../logger"
import { AgentSessionRepository } from "../../features/agents"
import { SharedDocRepository } from "../../features/messaging/sharing"
import { UserRepository, findUserIdsWithoutBrowse } from "../../features/workspaces"
import { listAccessibleStreamIds, StreamRepository } from "../../features/streams"

/** A node that does not answer in time must not hold up every workspace's realtime delivery. */
const FETCH_SOCKETS_TIMEOUT_MS = 2000

function roomPattern(workspaceId: string) {
  const prefix = `ws:${workspaceId}:`
  const idAfter = (room: string, kind: string) =>
    room.startsWith(`${prefix}${kind}:`) ? room.slice(prefix.length + kind.length + 1) : null
  return {
    stream: (room: string) => idAfter(room, "stream"),
    docReaders: (room: string) => idAfter(room, "doc-readers"),
    agentSession: (room: string) => idAfter(room, "agent_session"),
    inWorkspace: (room: string) => room === `ws:${workspaceId}` || room.startsWith(prefix),
  }
}

function docReadersRoom(workspaceId: string, docId: string): string {
  return groupToRoom(workspaceId, docReadersGroup(docId))
}

/**
 * Awaited: the adapter's NOTIFY then commits before the next event's broadcast does, so no
 * node delivers that event to a socket on its way out.
 */
async function moveSocket(io: Server, socketId: string, join: string[], leave: string[]): Promise<void> {
  const { adapter } = io.of("/")
  const target = { rooms: new Set([socketId]) }
  if (join.length > 0) await adapter.addSockets(target, join)
  if (leave.length > 0) await adapter.delSockets(target, leave)
}

/**
 * Rechecks the sockets in `from` and takes each out of the rooms its user can no longer
 * read. A join checks access once; without this, a removed member or a reader whose share
 * was withdrawn keeps receiving the stream's events until they reconnect. `rooms` names
 * the rooms to recheck, or "all" for every room the socket holds in the workspace; agent
 * session rooms are always rechecked, since they follow their stream. The user is resolved
 * from the socket's login, not its user room: a grant-only reader may hold a doc-reader
 * room without ever joining the workspace room.
 */
async function evictUnreadableRooms(
  io: Server,
  db: Pool,
  workspaceId: string,
  scope: { from: string[]; rooms: Set<string> | "all"; login?: string }
): Promise<void> {
  if (scope.from.length === 0) return
  const pattern = roomPattern(workspaceId)
  const checked = (room: string) =>
    scope.rooms === "all" ? pattern.inWorkspace(room) : scope.rooms.has(room) || pattern.agentSession(room) !== null
  const byLogin = new Map<string, Awaited<ReturnType<Server["fetchSockets"]>>>()
  for (const socket of await io.in(scope.from).timeout(FETCH_SOCKETS_TIMEOUT_MS).fetchSockets()) {
    const { workosUserId } = socket.data as MainSocketData
    if (scope.login !== undefined && workosUserId !== scope.login) continue
    byLogin.set(workosUserId, [...(byLogin.get(workosUserId) ?? []), socket])
  }
  // One user at a time: a recheck of a big room must not take the pool from live requests.
  for (const [workosUserId, sockets] of byLogin) {
    const held = [...new Set(sockets.flatMap((socket) => [...socket.rooms].filter(checked)))]
    if (held.length === 0) continue
    const ids = (parse: (room: string) => string | null) => held.map(parse).filter((id) => id !== null)
    const streamIds = ids(pattern.stream)
    const sessionStreams = new Map<string, string | null>()
    for (const sessionId of ids(pattern.agentSession)) {
      sessionStreams.set(
        sessionId,
        (await AgentSessionRepository.findById(db, workspaceId, sessionId))?.streamId ?? null
      )
    }
    const user = await UserRepository.findByWorkosUserIdInWorkspace(db, workspaceId, workosUserId)
    const joinable = user
      ? await listAccessibleStreamIds(db, workspaceId, user.id, streamIds, { docGrants: false })
      : new Set<string>()
    // A grant reaches docs only, so a stream readable here but not joinable is a doc read through a share.
    const readable = user
      ? await listAccessibleStreamIds(db, workspaceId, user.id, [
          ...streamIds.filter((id) => !joinable.has(id)),
          ...ids(pattern.docReaders),
          ...[...sessionStreams.values()].filter((id) => id !== null),
        ])
      : new Set<string>()
    for (const socket of sockets) {
      const join: string[] = []
      const leave: string[] = []
      for (const room of [...socket.rooms].filter(checked)) {
        const streamId = pattern.stream(room)
        const docId = pattern.docReaders(room)
        const sessionId = pattern.agentSession(room)
        if (streamId !== null && !joinable.has(streamId)) {
          leave.push(room)
          // Where the join would have seated a grant-only reader: the host's thread events stay out of reach.
          if (readable.has(streamId)) join.push(docReadersRoom(workspaceId, streamId))
        } else if (docId !== null && !readable.has(docId)) {
          leave.push(room)
        } else if (sessionId !== null) {
          const sessionStream = sessionStreams.get(sessionId)
          if (!sessionStream || (!joinable.has(sessionStream) && !readable.has(sessionStream))) leave.push(room)
        }
      }
      await moveSocket(io, socket.id, join, leave)
    }
  }
}

/** A grant rides an undeleted message in a stream the reader can read; deleting or moving it can end the grant. */
async function evictGrantReaders(io: Server, db: Pool, workspaceId: string, messageIds: string[]): Promise<void> {
  const docIds = await SharedDocRepository.listDocIdsByShareMessageIds(db, workspaceId, messageIds)
  const from = docIds.map((docId) => docReadersRoom(workspaceId, docId))
  await evictUnreadableRooms(io, db, workspaceId, { from, rooms: new Set(from) })
}

/** Access to a stream decides access to its threads and docs, and to the grants of chips shared inside. */
async function subtreeRooms(db: Pool, workspaceId: string, streamId: string): Promise<string[]> {
  const streamIds = await StreamRepository.listSelfAndDescendantIds(db, workspaceId, streamId)
  const docIds = await SharedDocRepository.listDocIdsSharedInStreams(db, workspaceId, streamIds)
  return [
    ...streamIds.map((id) => groupToRoom(workspaceId, streamGroup(id))),
    ...docIds.map((docId) => docReadersRoom(workspaceId, docId)),
  ]
}

/** A user removed from the workspace leaves every room of it, the user room included. */
async function leaveWorkspaceRooms(io: Server, workspaceId: string, userId: string): Promise<void> {
  const pattern = roomPattern(workspaceId)
  const userRoom = groupToRoom(workspaceId, userGroup(userId))
  for (const socket of await io.in(userRoom).timeout(FETCH_SOCKETS_TIMEOUT_MS).fetchSockets()) {
    await moveSocket(io, socket.id, [], [...socket.rooms].filter(pattern.inWorkspace))
  }
}

/** Only a user who cannot browse loses rooms on a profile or role change: the public roots. */
async function evictDemotedUser(io: Server, db: Pool, workspaceId: string, userId: string): Promise<void> {
  const user = await UserRepository.findById(db, workspaceId, userId)
  if (!user?.workosUserId || !(await findUserIdsWithoutBrowse(db, workspaceId, [userId])).has(userId)) return
  const from = [groupToRoom(workspaceId, userGroup(userId))]
  await evictUnreadableRooms(io, db, workspaceId, { from, rooms: "all", login: user.workosUserId })
}

/**
 * Only the removed member's sockets lose anything; a bot's ride the `/bot` namespace and
 * resolve to no user. The user room finds a socket watching a session without its stream's room.
 */
async function evictRemovedMember(
  io: Server,
  db: Pool,
  workspaceId: string,
  streamId: string,
  memberId: string
): Promise<void> {
  const user = await UserRepository.findById(db, workspaceId, memberId)
  if (!user?.workosUserId) return
  const rooms = await subtreeRooms(db, workspaceId, streamId)
  const from = [groupToRoom(workspaceId, userGroup(memberId)), ...rooms]
  await evictUnreadableRooms(io, db, workspaceId, { from, rooms: new Set(rooms), login: user.workosUserId })
}

/**
 * Runs after the event's broadcast, so the departing reader still receives the event
 * that removed them. A failure is logged, not thrown: rethrowing would replay the
 * whole outbox batch to every client.
 */
export async function evictRevokedRoomsForEvent(event: OutboxEvent, db: Pool, io: Server): Promise<void> {
  const { workspaceId } = event.payload as { workspaceId: string }
  try {
    if (isOutboxEventType(event, "workspace_user:removed")) {
      await leaveWorkspaceRooms(io, workspaceId, event.payload.removedUserId)
    } else if (isOutboxEventType(event, "workspace_user:updated")) {
      await evictDemotedUser(io, db, workspaceId, event.payload.user.id)
    } else if (isOutboxEventType(event, "stream:member_removed")) {
      await evictRemovedMember(io, db, workspaceId, event.payload.streamId, event.payload.memberId)
    } else if (isOutboxEventType(event, "access:narrowed")) {
      const { payload } = event
      const from =
        "docIds" in payload
          ? payload.docIds.map((docId) => docReadersRoom(workspaceId, docId))
          : await subtreeRooms(db, workspaceId, payload.streamId)
      await evictUnreadableRooms(io, db, workspaceId, { from, rooms: new Set(from) })
    } else if (isOutboxEventType(event, "message:deleted")) {
      await evictGrantReaders(io, db, workspaceId, [event.payload.messageId])
    } else if (isOutboxEventType(event, "messages:moved")) {
      await evictGrantReaders(io, db, workspaceId, event.payload.movedMessageIds)
    }
  } catch (error) {
    logger.error({ error, workspaceId, eventType: event.eventType }, "Failed to evict sockets from revoked rooms")
  }
}
