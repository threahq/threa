import { LabelableResourceTypes, StreamTypes, Visibilities } from "@threa/types"
import {
  isStreamScopedEvent,
  isOutboxEventType,
  isOneOfOutboxEventType,
  isAuthorScopedEvent,
  isUserScopedEvent,
  isBotScopedEvent,
  type OutboxEvent,
  type StreamCreatedOutboxPayload,
  type StreamMemberAddedOutboxPayload,
  type ActivityCreatedOutboxPayload,
  type StreamDisplayNameUpdatedPayload,
  type AttachmentTranscodedOutboxPayload,
  type AttachmentThumbnailedOutboxPayload,
  type MessagesMovedOutboxPayload,
  type LabelUpsertedOutboxPayload,
  type LabelDeletedOutboxPayload,
  type LabelMemberJoinedOutboxPayload,
  type LabelMemberLeftOutboxPayload,
  type LabelAssignedOutboxPayload,
  type LabelUnassignedOutboxPayload,
} from "./repository"
import { logger } from "../logger"

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
 * Socket.io room for a delivery group. Rooms are the group name prefixed with
 * the workspace scope: `ws:<wsId>`, `ws:<wsId>:stream:<id>`, `ws:<wsId>:user:<id>`.
 */
export function groupToRoom(workspaceId: string, group: string): string {
  return group === WORKSPACE_GROUP ? `ws:${workspaceId}` : `ws:${workspaceId}:${group}`
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

  // Labels: `targetUserId` is the visibility discriminator — private-label
  // events are viewer-scoped, public-label events go workspace-wide.
  if (isOneOfOutboxEventType(event, ["label:created", "label:updated"])) {
    const payload = event.payload as LabelUpsertedOutboxPayload
    return payload.targetUserId ? [userGroup(payload.targetUserId)] : [WORKSPACE_GROUP]
  }

  if (isOutboxEventType(event, "label:deleted")) {
    const payload = event.payload as LabelDeletedOutboxPayload
    return payload.targetUserId ? [userGroup(payload.targetUserId)] : [WORKSPACE_GROUP]
  }

  if (isOneOfOutboxEventType(event, ["label:member_joined", "label:member_left"])) {
    const payload = event.payload as LabelMemberJoinedOutboxPayload | LabelMemberLeftOutboxPayload
    return [userGroup(payload.targetUserId)]
  }

  // Assignments follow the label's visibility: private rows to the creator;
  // public rows scoped to the resource's own audience (a public label on a
  // private channel reaches exactly its members, identical to a message).
  if (isOneOfOutboxEventType(event, ["label:assigned", "label:unassigned"])) {
    const payload = event.payload as LabelAssignedOutboxPayload | LabelUnassignedOutboxPayload
    if (payload.targetUserId) {
      return [userGroup(payload.targetUserId)]
    }
    const { resourceType, resourceId } = "assignment" in payload ? payload.assignment : payload
    if (resourceType === LabelableResourceTypes.STREAM) {
      return [streamGroup(resourceId)]
    }
    // Every labelable resource type must map to a delivery group here, or its
    // public assignments would neither broadcast nor reach the sync log. The
    // `never` assignment enforces that at build time; we log rather than throw
    // because this runs in the outbox dispatcher, where a throw stalls the
    // cursor and blocks every later event.
    const unmapped: never = resourceType
    logger.error(
      { eventType: event.eventType, resourceType: unmapped, resourceId },
      "delivery groups: no mapping for public-label resource type"
    )
    return []
  }

  if (isStreamScopedEvent(event)) {
    const { streamId } = event.payload
    return [streamGroup(streamId)]
  }

  return [WORKSPACE_GROUP]
}
