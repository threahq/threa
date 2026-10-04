import type { Server } from "socket.io"
import {
  StreamTypes,
  Visibilities,
  WORKSPACE_PERMISSION_SCOPES,
  permissionsForRole,
  type WorkspacePermissionSlug,
  type WorkspaceRoleSlug,
} from "@threahq/types"
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
  type AttachmentUploadStatusChangedOutboxPayload,
  type MessagesMovedOutboxPayload,
  type ConversationCreatedOutboxPayload,
  type ConversationUpdatedOutboxPayload,
  type MemoCreatedOutboxPayload,
  type LabelUpsertedOutboxPayload,
  type LabelDeletedOutboxPayload,
  type LabelAssignedOutboxPayload,
  type LabelUnassignedOutboxPayload,
  type AgentConfigUpdatedOutboxPayload,
  type StreamCallStartedOutboxPayload,
  type StreamCallEndedOutboxPayload,
  type StreamMessageCountOutboxPayload,
  type StreamConnectionUpdatedOutboxPayload,
  type StreamUpdatedOutboxPayload,
  type WorkspaceUserAddedOutboxPayload,
  type WorkspaceUserRemovedOutboxPayload,
  type WorkspaceUserUpdatedOutboxPayload,
  type BotCreatedOutboxPayload,
  type BotUpdatedOutboxPayload,
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
 * Everyone who may browse the workspace — members and up, never guests. The
 * `workspace` group reaches guests too, so anything a guest may not see (a
 * plain `public` stream, the people directory) goes here instead.
 */
export const BROWSE_GROUP = permissionGroup(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE)

/**
 * The workspace-wide audience of an open stream's events: `guest_public` reaches
 * everyone including guests, `public` only browsers, anything else no one beyond
 * its own rooms.
 */
function openAudienceGroups(visibility: string | undefined): string[] {
  if (visibility === Visibilities.GUEST_PUBLIC) return [WORKSPACE_GROUP]
  if (visibility === Visibilities.PUBLIC) return [BROWSE_GROUP]
  return []
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
  // Open channels only: a private channel's change goes to its admin members, routed in resolveDeliveryGroups.
  [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN]: ["stream_connection:updated"],
  // Listed so members join the browse room; its events are routed by stream visibility and as the
  // fallthrough in resolveDeliveryGroups.
  [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE]: [],
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
 * Moves a member's live sockets into exactly the permission rooms `role`
 * grants, so a role change takes effect without a rejoin. `null` (removed)
 * leaves them all.
 */
export function syncPermissionRooms(
  io: Server,
  workspaceId: string,
  userId: string,
  role: WorkspaceRoleSlug | null
): void {
  const { held, stale } = permissionRoomsFor(workspaceId, role)
  const sockets = io.in(groupToRoom(workspaceId, userGroup(userId)))
  if (stale.length > 0) sockets.socketsLeave(stale)
  if (held.length > 0) sockets.socketsJoin(held)
}

/** A workspace's permission rooms, split into those `role` grants and the rest. `null` holds none. */
export function permissionRoomsFor(
  workspaceId: string,
  role: WorkspaceRoleSlug | null
): { held: string[]; stale: string[] } {
  const held = role ? permissionGroupsForRole(role) : []
  const toRoom = (group: string) => groupToRoom(workspaceId, group)
  return {
    held: held.map(toRoom),
    stale: DELIVERED_PERMISSION_SCOPES.map(permissionGroup)
      .filter((group) => !held.includes(group))
      .map(toRoom),
  }
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
  // Internal lifecycle wake-up: clients receive the resulting title projection,
  // never this scheduler request in workspace sync logs or sockets.
  if (isOutboxEventType(event, "dynamic_naming:requested")) return []
  if (isBotScopedEvent(event)) {
    return null
  }

  // Push-only: the web-push re-wrap nudge is consumed by the push handler, not
  // the socket broadcast. Returning null keeps it off the wire and the sync log
  // (its socket sibling `e2e:rewrap_needed` carries the live-tab signal).
  if (isOutboxEventType(event, "e2e:rewrap_nudge")) {
    return null
  }

  // Internal-only: CP route (un)registration is consumed by GithubRouteSyncHandler
  // and calls the control plane; no client ever receives it, so it stays off the
  // wire and the sync log.
  if (isOneOfOutboxEventType(event, ["github_route:register", "github_route:unregister"])) {
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
  // two participants; private streams (scratchpads, asides, private channels)
  // to the creator only (additional members learn via stream:member_added);
  // open streams to their audience plus the creator, who may be a guest outside
  // it. The anchored branch is thread-only: an aside is anchored too, but routing
  // it to the parent's audience would broadcast a private stream to every
  // host-stream member.
  if (isOutboxEventType(event, "stream:created")) {
    const payload = event.payload as StreamCreatedOutboxPayload
    if (payload.stream.parentAnchorId && payload.stream.type === StreamTypes.THREAD) {
      return [streamGroup(payload.stream.parentStreamId ?? payload.streamId)]
    }
    if (payload.stream.type === StreamTypes.DM && payload.dmUserIds?.length === 2) {
      return [...new Set(payload.dmUserIds)].map(userGroup)
    }
    return [...openAudienceGroups(payload.stream.visibility), userGroup(payload.stream.createdBy)]
  }

  // stream:updated — members keep learning of a visibility change workspace-wide
  // (the sidebar adds or drops the stream on it); guests learn through the stream
  // room unless the stream is a guest_public root. A thread's own visibility copy
  // goes stale when its root flips, so it never opens the workspace.
  if (isOutboxEventType(event, "stream:updated")) {
    const { streamId, stream } = event.payload as StreamUpdatedOutboxPayload
    const openToGuests = stream.visibility === Visibilities.GUEST_PUBLIC && !stream.rootStreamId
    return [openToGuests ? WORKSPACE_GROUP : BROWSE_GROUP, streamGroup(streamId)]
  }

  // stream:member_added — existing members (stream group) AND the added user,
  // who isn't in the stream group yet.
  if (isOutboxEventType(event, "stream:member_added")) {
    const { streamId, memberId } = event.payload as StreamMemberAddedOutboxPayload
    return [streamGroup(streamId), userGroup(memberId)]
  }

  // Conversation aggregate events reach the stream + optionally its parent for
  // discoverability, AND the open audience when the access-root stream is a
  // public channel — so the workspace board (which sits in the workspace room,
  // not in every stream room) sees public-channel activity live. Private/DM/
  // scratchpad conversations stay scoped to their stream's members (INV-62);
  // the board picks those up via its bootstrap/reconnect fetch.
  if (isOneOfOutboxEventType(event, ["conversation:created", "conversation:updated"])) {
    const payload = event.payload as ConversationCreatedOutboxPayload | ConversationUpdatedOutboxPayload
    const groups = [streamGroup(payload.streamId)]
    if (payload.parentStreamId) {
      groups.push(streamGroup(payload.parentStreamId))
    }
    groups.push(...openAudienceGroups(payload.streamVisibility))
    return groups
  }

  // Per-message membership (no board aggregate) — stays stream-scoped (+ parent);
  // the board doesn't consume it. `conversation:message_reassigned` has no parent
  // dimension and falls through to the generic stream-scoped branch below.
  if (isOutboxEventType(event, "conversation:message_assigned")) {
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

  // Open stream names go to their audience (activity/search name resolution on
  // streams the user isn't a member of); private names stay stream-scoped to
  // avoid leaking DM/scratchpad thread names.
  if (isOutboxEventType(event, "stream:display_name_updated")) {
    const payload = event.payload as StreamDisplayNameUpdatedPayload
    return [...openAudienceGroups(payload.visibility), streamGroup(payload.streamId)]
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

  // Only emitted for message-bound attachments, so always stream-scoped.
  if (isOutboxEventType(event, "attachment:upload_status_changed")) {
    const payload = event.payload as AttachmentUploadStatusChangedOutboxPayload
    return [streamGroup(payload.streamId)]
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

  // Persona config updates for a PERSONAL persona reach only its owner
  // (user-scoped-personas): the persona is invisible to every other member, so
  // its create/update/archive broadcast must not leak into the workspace room.
  // Built-in and workspace-custom updates carry a null `ownerUserId` and reach
  // the whole workspace (every member inherits them).
  if (isOutboxEventType(event, "agent_config:updated")) {
    const payload = event.payload as AgentConfigUpdatedOutboxPayload
    if (payload.persona.ownerUserId) {
      return [userGroup(payload.persona.ownerUserId)]
    }
    return [WORKSPACE_GROUP]
  }

  // Call lifecycle (roadmap 1.4): the timeline card lands in the host stream's
  // room (every v1 participant is a stream member), AND the sidebar live-call dot
  // must reach members NOT currently in that room: every member through their
  // user room (a guest member of a public channel is outside its audience), plus
  // an open channel's audience. A private stream name never leaks workspace-wide.
  if (isOneOfOutboxEventType(event, ["stream:call_started", "stream:call_ended"])) {
    const payload = event.payload as StreamCallStartedOutboxPayload | StreamCallEndedOutboxPayload
    return [
      streamGroup(payload.streamId),
      ...openAudienceGroups(payload.streamVisibility),
      ...payload.memberUserIds.map(userGroup),
    ]
  }

  // The Streams page shows counts for public channels the viewer never joined,
  // so an open access root fans to its audience; otherwise the stream's room
  // plus, for a thread, its root's room (members of the root see the thread).
  if (isOutboxEventType(event, "stream:message_count")) {
    const { streamId, rootStreamId, streamVisibility } = event.payload as StreamMessageCountOutboxPayload
    const groups = [streamGroup(streamId)]
    if (rootStreamId && rootStreamId !== streamId) groups.push(streamGroup(rootStreamId))
    groups.push(...openAudienceGroups(streamVisibility))
    return groups
  }

  if (
    isOneOfOutboxEventType(event, [
      "agent_session:started",
      "agent_session:completed",
      "agent_session:failed",
      "agent_session:interrupted",
      "agent_session:deleted",
    ])
  ) {
    const { streamId, rootStreamId } = event.payload as { streamId: string; rootStreamId?: string }
    return rootStreamId && rootStreamId !== streamId
      ? [streamGroup(streamId), streamGroup(rootStreamId)]
      : [streamGroup(streamId)]
  }

  // memo:created — the source stream's room, so a member of the room the memo
  // came from refreshes the explorer live. A `user`-scoped memo is private to
  // its owner even when captured in a shared stream (save_memo can file one
  // there), so it goes to the owner alone: the room must not learn that a memo
  // it will never be shown exists.
  // A row written by a pre-cutover replica has no streamId and carries the whole
  // memo; it is dropped (no audience, so neither logged nor emitted) rather than
  // routed to `stream:undefined`, which would park that content in the log.
  if (isOutboxEventType(event, "memo:created")) {
    const payload = event.payload as MemoCreatedOutboxPayload
    if (payload.scopeUserId) return [userGroup(payload.scopeUserId)]
    return payload.streamId ? [streamGroup(payload.streamId)] : []
  }

  // A private channel's connection change must not reach admins outside it, so
  // it goes to its admin members one by one; an open one falls through to the
  // admin permission group below.
  if (isOutboxEventType(event, "stream_connection:updated")) {
    const payload = event.payload as StreamConnectionUpdatedOutboxPayload
    if (payload.streamVisibility === Visibilities.PRIVATE) return payload.adminMemberUserIds.map(userGroup)
  }

  // The people directory is for browsers; the user themselves still hears of
  // their own change, which is how a guest sees their own profile.
  if (isOneOfOutboxEventType(event, ["workspace_user:added", "workspace_user:updated"])) {
    const { user } = event.payload as WorkspaceUserAddedOutboxPayload | WorkspaceUserUpdatedOutboxPayload
    return [BROWSE_GROUP, userGroup(user.id)]
  }

  if (isOutboxEventType(event, "workspace_user:removed")) {
    const { removedUserId } = event.payload as WorkspaceUserRemovedOutboxPayload
    return [BROWSE_GROUP, userGroup(removedUserId)]
  }

  // A shared bot is workspace-wide; a personal one stays with members and its owner.
  if (isOneOfOutboxEventType(event, ["bot:created", "bot:updated"])) {
    const { bot } = event.payload as BotCreatedOutboxPayload | BotUpdatedOutboxPayload
    return bot.type === "personal" ? [BROWSE_GROUP, userGroup(bot.ownerUserId)] : [WORKSPACE_GROUP]
  }

  // Safe for guests to hear: workspace settings carry no stream content.
  if (isOneOfOutboxEventType(event, ["workspace_settings:updated", "feature_flags:workspace_updated"])) {
    return [WORKSPACE_GROUP]
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

  // Fail closed: an event nobody routed explicitly stays out of guests' hands.
  return [BROWSE_GROUP]
}
