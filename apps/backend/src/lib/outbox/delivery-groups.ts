import type { Server } from "socket.io"
import {
  StreamTypes,
  Visibilities,
  WORKSPACE_PERMISSION_SCOPES,
  permissionsForRole,
  type WorkspacePermissionSlug,
  type WorkspaceRoleSlug,
} from "@threa/types"
import {
  isStreamScopedEvent,
  isOutboxEventType,
  isOneOfOutboxEventType,
  isAuthorScopedEvent,
  isUserScopedEvent,
  isBotScopedEvent,
  type OutboxEvent,
  type OutboxEventType,
  type StreamCreatedOutboxPayload,
  type StreamMemberAddedOutboxPayload,
  type ActivityCreatedOutboxPayload,
  type StreamDisplayNameUpdatedPayload,
  type StreamArchivedOutboxPayload,
  type StreamUnarchivedOutboxPayload,
  type AttachmentTranscodedOutboxPayload,
  type AttachmentThumbnailedOutboxPayload,
  type MessagesMovedOutboxPayload,
  type LabelUpsertedOutboxPayload,
  type LabelDeletedOutboxPayload,
  type LabelAssignedOutboxPayload,
  type LabelUnassignedOutboxPayload,
} from "./repository"

/**
 * A delivery group names the audience of a client-routed outbox event,
 * independent of any one socket connection:
 *
 *   "workspace"     — every member of the workspace
 *   "stream:<id>"   — members of one stream
 *   "user:<id>"     — one user
 *
 * Groups are the single source of truth for routing: the BroadcastHandler
 * persists them to `sync_log` and derives the Socket.io rooms from them, so
 * what the log records and what gets emitted can never drift apart.
 */
export const WORKSPACE_GROUP = "workspace"

export function streamGroup(streamId: string): string {
  return `stream:${streamId}`
}

export function userGroup(userId: string): string {
  return `user:${userId}`
}

/**
 * Delivery group for everyone who holds a workspace permission slug. Events
 * routed here (invitation lifecycle → members:write) reach only holders, not
 * the whole workspace. Sockets join the matching room on workspace join and
 * catch-up admits the group for holders — both derive the holder set from the
 * member's role, so live and replay delivery stay congruent.
 */
export function permissionGroup(slug: WorkspacePermissionSlug): string {
  return `permission:${slug}`
}

/**
 * Single source of truth for permission-scoped event routing: each permission
 * scope maps to the outbox event types delivered only to holders of that scope.
 * `resolveDeliveryGroups` routes an event by reverse-lookup here, and sockets +
 * catch-up derive room membership from the same keys (via
 * `DELIVERED_PERMISSION_SCOPES` → `permissionGroupsForRole`), so routing and
 * membership cannot drift. `satisfies` pins the keys to real permission slugs
 * and the values to real outbox event types.
 *
 * Invitation lifecycle carries invitee identity (email, link token hash), so it
 * is scoped to members:write — mirroring the bootstrap gate (workspaces/handlers
 * includes `invitations` only for members:write) and the invitation routes'
 * requireWorkspacePermission(members:write).
 */
const PERMISSION_SCOPED_EVENTS = {
  [WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE]: [
    "invitation:sent",
    "invitation:accepted",
    "invitation:revoked",
    "invitation:link-created",
    "invitation:link-claimed",
  ],
} as const satisfies Partial<Record<WorkspacePermissionSlug, readonly OutboxEventType[]>>

/** Permission scopes that get their own delivery group (keys of the routing map). */
const DELIVERED_PERMISSION_SCOPES = Object.keys(PERMISSION_SCOPED_EVENTS) as WorkspacePermissionSlug[]

/** Reverse index built once at load: outbox event type → its permission group. */
const PERMISSION_GROUP_BY_EVENT = new Map<string, string>(
  Object.entries(PERMISSION_SCOPED_EVENTS).flatMap(([scope, eventTypes]) =>
    eventTypes.map((eventType) => [eventType, permissionGroup(scope as WorkspacePermissionSlug)] as const)
  )
)

/** The permission delivery groups a member with `role` belongs to. */
export function permissionGroupsForRole(role: WorkspaceRoleSlug): string[] {
  const held = permissionsForRole(role)
  return DELIVERED_PERMISSION_SCOPES.filter((slug) => held.includes(slug)).map(permissionGroup)
}

/**
 * Socket.io room for a delivery group. Rooms are the group name prefixed with
 * the workspace scope: `ws:<wsId>`, `ws:<wsId>:stream:<id>`, `ws:<wsId>:user:<id>`.
 */
export function groupToRoom(workspaceId: string, group: string): string {
  return group === WORKSPACE_GROUP ? `ws:${workspaceId}` : `ws:${workspaceId}:${group}`
}

/**
 * Emits one event to the union of its groups' rooms. Socket.io dedupes
 * sockets present in several rooms, so an event never reaches the same
 * connection twice. The payload carries the sync id (string, like stream
 * sequences on the wire) when one is assigned, so future clients can keep a
 * sync-log cursor; current clients ignore it. Shared by the BroadcastHandler
 * (live path) and the sync-log reconciliation sweep (rescue path) so the two
 * can never drift.
 */
export function emitToGroups(
  io: Server,
  event: Pick<OutboxEvent, "eventType" | "payload">,
  groups: string[],
  syncId?: bigint
): void {
  if (groups.length === 0) {
    return
  }
  const { workspaceId } = event.payload
  const rooms = groups.map((group) => groupToRoom(workspaceId, group))
  const payload = syncId ? { ...event.payload, syncId: syncId.toString() } : event.payload
  io.to(rooms).emit(event.eventType, payload)
}

/**
 * Resolves a client-routed outbox event to its delivery groups.
 *
 * Returns `null` for bot-scoped events — they ride the `/bot` namespace and
 * stay off the sync log. Returns `[]` when an event has no resolvable
 * audience (a routing bug, logged here); such events are neither logged nor
 * emitted.
 */
export function resolveDeliveryGroups(event: OutboxEvent): string[] | null {
  if (isBotScopedEvent(event)) {
    return null
  }

  // Push-only: the web-push re-wrap nudge is consumed by the push handler, not
  // the socket broadcast. Returning null keeps it off the wire and the sync log
  // (its socket sibling `enclave:rewrap_needed` carries the live-tab signal).
  if (isOutboxEventType(event, "enclave:rewrap_nudge")) {
    return null
  }

  // User-scoped events: deliver to the target user only
  if (isUserScopedEvent(event)) {
    const { targetUserId } = event.payload as ActivityCreatedOutboxPayload
    return [userGroup(targetUserId)]
  }

  // Author-scoped events: deliver to the author only
  if (isAuthorScopedEvent(event)) {
    const { authorId } = event.payload as { authorId: string }
    return [userGroup(authorId)]
  }

  // stream:created — threads go to the parent stream's audience; DMs to the
  // two participants; private streams (scratchpads, private channels) to the
  // creator only (additional members learn via stream:member_added); public
  // streams to the whole workspace.
  if (isOutboxEventType(event, "stream:created")) {
    const payload = event.payload as StreamCreatedOutboxPayload
    if (payload.stream.parentMessageId) {
      return [streamGroup(payload.streamId)]
    }
    if (payload.stream.type === StreamTypes.DM && payload.dmUserIds?.length === 2) {
      return [...new Set(payload.dmUserIds)].map(userGroup)
    }
    if (payload.stream.visibility === Visibilities.PRIVATE) {
      return [userGroup(payload.stream.createdBy)]
    }
    return [WORKSPACE_GROUP]
  }

  // stream:member_added — existing members (stream group) AND the added user,
  // who isn't in the stream group yet.
  if (isOutboxEventType(event, "stream:member_added")) {
    const { streamId, memberId } = event.payload as StreamMemberAddedOutboxPayload
    return [streamGroup(streamId), userGroup(memberId)]
  }

  // Conversation events reach the stream + optionally its parent for
  // discoverability. `conversation:message_reassigned` has no parent dimension
  // and falls through to the generic stream-scoped branch below.
  if (
    isOneOfOutboxEventType(event, ["conversation:created", "conversation:updated", "conversation:message_assigned"])
  ) {
    const payload = event.payload as { streamId: string; parentStreamId?: string }
    const groups = [streamGroup(payload.streamId)]
    if (payload.parentStreamId) {
      groups.push(streamGroup(payload.parentStreamId))
    }
    return groups
  }

  if (isOutboxEventType(event, "messages:moved")) {
    const payload = event.payload as MessagesMovedOutboxPayload
    return [streamGroup(payload.sourceStreamId), streamGroup(payload.destinationStreamId)]
  }

  // Public stream names go workspace-wide (activity/search name resolution on
  // streams the user isn't a member of); private names stay stream-scoped to
  // avoid leaking DM/scratchpad thread names.
  if (isOutboxEventType(event, "stream:display_name_updated")) {
    const payload = event.payload as StreamDisplayNameUpdatedPayload
    return payload.visibility === "public" ? [WORKSPACE_GROUP] : [streamGroup(payload.streamId)]
  }

  // Attachment lifecycle — stream-scoped when attached to a message,
  // workspace-scoped otherwise.
  if (isOutboxEventType(event, "attachment:transcoded")) {
    const payload = event.payload as AttachmentTranscodedOutboxPayload
    return payload.streamId ? [streamGroup(payload.streamId)] : [WORKSPACE_GROUP]
  }

  if (isOutboxEventType(event, "attachment:thumbnailed")) {
    const payload = event.payload as AttachmentThumbnailedOutboxPayload
    return payload.streamId ? [streamGroup(payload.streamId)] : [WORKSPACE_GROUP]
  }

  // Labels are owner-scoped: every label event (upsert, delete, assign,
  // unassign) is delivered to the owning actor's user room only.
  if (isOneOfOutboxEventType(event, ["label:created", "label:updated"])) {
    const payload = event.payload as LabelUpsertedOutboxPayload
    return [userGroup(payload.targetUserId)]
  }

  if (isOutboxEventType(event, "label:deleted")) {
    const payload = event.payload as LabelDeletedOutboxPayload
    return [userGroup(payload.targetUserId)]
  }

  if (isOneOfOutboxEventType(event, ["label:assigned", "label:unassigned"])) {
    const payload = event.payload as LabelAssignedOutboxPayload | LabelUnassignedOutboxPayload
    return [userGroup(payload.targetUserId)]
  }

  // stream:archived / stream:unarchived — a thread inherits its lifecycle
  // from its root (INV-62), and a client viewing a thread only joins the
  // thread's room (not the root's). Route to the root's stream room AND every
  // descendant thread room (populated in the payload at archive/unarchive
  // time) so thread viewers learn the root's archived state live and the
  // composer seals/unseals without a refresh. Thread rooms share the root's
  // audience (access is inherited), so there is no cross-audience leak.
  if (isOneOfOutboxEventType(event, ["stream:archived", "stream:unarchived"])) {
    const payload = event.payload as StreamArchivedOutboxPayload | StreamUnarchivedOutboxPayload
    const groups = [streamGroup(payload.streamId)]
    for (const threadId of payload.threadStreamIds ?? []) {
      if (threadId !== payload.streamId) groups.push(streamGroup(threadId))
    }
    return groups
  }

  // Permission-scoped events (e.g. invitation lifecycle → members:write) go to
  // their scope's delivery group instead of the whole-workspace fallthrough.
  const permissionScopedGroup = PERMISSION_GROUP_BY_EVENT.get(event.eventType)
  if (permissionScopedGroup) {
    return [permissionScopedGroup]
  }

  if (isStreamScopedEvent(event)) {
    const { streamId } = event.payload
    return [streamGroup(streamId)]
  }

  return [WORKSPACE_GROUP]
}
