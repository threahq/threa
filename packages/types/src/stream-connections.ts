import { z } from "zod"
import {
  ATTACHMENT_SAFETY_STATUSES,
  AUTHOR_TYPES,
  CREATABLE_VISIBILITIES,
  VISIBILITY_OPTIONS,
  type Visibility,
} from "./constants"
import type { JSONContent } from "./prosemirror"

// A stream connection is one invite link to a host channel: pending until a
// partner workspace accepts it, then that partner's place in the channel. A
// channel can hold any number of them, so several workspaces can share it. The
// control plane owns the record; each region keeps a projection row per
// workspace it holds, written only from the snapshots below.

export const STREAM_CONNECTION_STATES = ["invited", "active", "revoked"] as const
export type StreamConnectionState = (typeof STREAM_CONNECTION_STATES)[number]

export const StreamConnectionStates = {
  INVITED: "invited",
  ACTIVE: "active",
  REVOKED: "revoked",
} as const satisfies Record<string, StreamConnectionState>

/** A peer is another partner in the same channel, seen from a partner's workspace. */
const STREAM_CONNECTION_ROLES = ["host", "partner", "peer"] as const
export type StreamConnectionRole = (typeof STREAM_CONNECTION_ROLES)[number]

export const StreamConnectionErrorCodes = {
  DISABLED: "STREAM_CONNECTIONS_DISABLED",
  NOT_FOUND: "STREAM_CONNECTION_NOT_FOUND",
  REVOKED: "STREAM_CONNECTION_REVOKED",
  EXPIRED: "STREAM_CONNECTION_EXPIRED",
  ALREADY_ACCEPTED: "STREAM_CONNECTION_ALREADY_ACCEPTED",
  ALREADY_CONNECTED: "STREAM_CONNECTION_ALREADY_CONNECTED",
  NOT_SHAREABLE: "STREAM_NOT_SHAREABLE",
  TOO_MANY_INVITES: "STREAM_CONNECTION_TOO_MANY_INVITES",
  /** The host's region didn't answer, so the invite can be neither shown nor accepted for now. */
  HOST_REGION_UNAVAILABLE: "STREAM_CONNECTION_HOST_REGION_UNAVAILABLE",
  /** The host refused a partner's write: the channel, message or author isn't one the partner may write as. */
  WRITE_REFUSED: "STREAM_CONNECTION_WRITE_REFUSED",
  /** The host's region didn't answer a partner's write, so it was not applied. */
  HOST_UNREACHABLE: "STREAM_CONNECTION_HOST_UNREACHABLE",
  /** A write into a shared channel's copy that can't cross to the host as sent: files, steering, or a send with no client message id. */
  COPY_WRITE_UNSUPPORTED: "STREAM_CONNECTION_COPY_WRITE_UNSUPPORTED",
} as const
export type StreamConnectionErrorCode = (typeof StreamConnectionErrorCodes)[keyof typeof StreamConnectionErrorCodes]

export const streamConnectionIdSchema = z.string().min(1).max(64)

/**
 * Control plane → region wire format: the full current state of one connection.
 * Unknown keys are dropped, so a control plane that adds a field ahead of a
 * region's deploy doesn't dead-letter the sync. A new state value is rejected,
 * so a change that adds one deploys the regions first.
 */
export const streamConnectionSnapshotSchema = z.object({
  id: streamConnectionIdSchema,
  revision: z.number().int().positive(),
  state: z.enum(STREAM_CONNECTION_STATES),
  hostWorkspaceId: z.string().min(1),
  hostWorkspaceName: z.string(),
  hostRegion: z.string().min(1),
  hostStreamId: z.string().min(1),
  /** A user of the host workspace. */
  invitedBy: z.string().min(1),
  partnerWorkspaceId: z.string().min(1).nullable(),
  partnerWorkspaceName: z.string().nullable(),
  partnerRegion: z.string().min(1).nullable(),
  partnerVisibility: z.enum(VISIBILITY_OPTIONS).nullable(),
  /** A user of the partner workspace. */
  acceptedBy: z.string().min(1).nullable(),
  /** The channel's other partners, each holding a peer row for this connection. Empty while the invite is pending. */
  peerWorkspaceIds: z.array(z.string().min(1)),
  expiresAt: z.iso.datetime(),
})
export type StreamConnectionSnapshot = z.infer<typeof streamConnectionSnapshotSchema>

/**
 * Region → control plane: the host channel as it stands now. The control plane
 * keeps no copy of the channel's name, so a rename shows on the invite page.
 */
export const streamConnectionChannelSchema = z.object({
  shareable: z.boolean(),
  slug: z.string().nullable(),
  displayName: z.string().nullable(),
})
export type StreamConnectionChannel = z.infer<typeof streamConnectionChannelSchema>

/** One side's view of a connection, as the regional API returns it. */
export interface StreamConnection {
  id: string
  role: StreamConnectionRole
  state: StreamConnectionState
  /** Orders updates to this row: a higher revision is newer. */
  revision: number
  /** The host channel's id. Only the host's row names a stream of its own workspace. */
  streamId: string
  remoteWorkspaceId: string | null
  remoteWorkspaceName: string | null
  /** The partner admin's choice at accept. Null until accepted. */
  partnerVisibility: Visibility | null
  /** Who minted the link. Only on the host's row, since the id names a user of the host workspace. */
  invitedBy: string | null
  /** Who accepted. Only on the partner's row, since the id names a user of the partner workspace. */
  acceptedBy: string | null
  /** The invite link's deadline. Only meaningful while the state is invited. */
  expiresAt: string
}

export interface CreateStreamConnectionInviteResponse {
  connection: StreamConnection
  /** The plaintext invite token. Returned once, at creation. */
  token: string
}

export interface ListStreamConnectionsResponse {
  connections: StreamConnection[]
}

export interface StreamConnectionResponse {
  connection: StreamConnection
}

/** Socket event `stream_connection:updated`: a row of this workspace changed. */
export interface StreamConnectionUpdatedPayload {
  workspaceId: string
  streamId: string
  connection: StreamConnection
}

export const streamConnectionTokenSchema = z.string().min(1).max(200)

export const acceptStreamConnectionSchema = z
  .object({
    token: streamConnectionTokenSchema,
    visibility: z.enum(CREATABLE_VISIBILITIES),
  })
  .strict()
export type AcceptStreamConnectionInput = z.infer<typeof acceptStreamConnectionSchema>

interface StreamConnectionLookupBase {
  hostWorkspaceId: string
  hostWorkspaceName: string
  /** Where the host's data lives. Accepting agrees to the partner's copy being served from there too. */
  hostRegion: string
  streamDisplayName: string | null
  streamSlug: string | null
}

interface StreamConnectionLookupPartner {
  workspaceId: string
  workspaceName: string
}

/**
 * What the invite page shows. A revoked or expired invite is an error, never a
 * lookup result, and so is a used one unless the viewer belongs to the partner.
 */
export type StreamConnectionLookupResponse =
  | (StreamConnectionLookupBase & {
      state: typeof StreamConnectionStates.INVITED
      partnerWorkspaceId: null
      partnerWorkspaceName: null
      /** Workspaces already in the channel, who will see what the accepting workspace's members post. */
      partners: StreamConnectionLookupPartner[]
    })
  | (StreamConnectionLookupBase & {
      state: typeof StreamConnectionStates.ACTIVE
      partnerWorkspaceId: string
      partnerWorkspaceName: string
    })

// The bridge: how a partner's region reads a shared channel from the host's
// region. The partner calls the host workspace's API path with the bridge key,
// naming itself in this header, which must match the connection's partner.
export const BRIDGE_WORKSPACE_HEADER = "X-Threa-Bridge-Workspace"

/** A stream event sequence, as a decimal string. */
const bridgeSequenceSchema = z.string().regex(/^\d+$/)

const bridgeContentSchema = z.custom<JSONContent>(
  (value) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "doc"
)

/** One stream of the shared tree: the channel, or a thread anchored on one of the tree's messages. */
export const bridgeStreamSchema = z.object({
  id: z.string().min(1),
  parentStreamId: z.string().min(1).nullable(),
  parentAnchorId: z.string().min(1).nullable(),
  slug: z.string().nullable(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  descriptionJson: bridgeContentSchema.nullable(),
  archivedAt: z.iso.datetime().nullable(),
  /** The stream's latest event sequence. A partner whose cursor is here has read everything. */
  head: bridgeSequenceSchema,
})
export type BridgeStream = z.infer<typeof bridgeStreamSchema>

export const bridgeManifestSchema = z.object({ streams: z.array(bridgeStreamSchema) })
export type BridgeManifest = z.infer<typeof bridgeManifestSchema>

export const bridgeAttachmentSchema = z.object({
  id: z.string().regex(/^attach_[0-9A-Za-z]+$/),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  safetyStatus: z.enum(ATTACHMENT_SAFETY_STATUSES),
  /** Pixel dimensions of an image. Absent from a host that predates them. */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
})
export type BridgeAttachment = z.infer<typeof bridgeAttachmentSchema>

/** Whether a partner can fetch a host attachment's bytes yet, and where from. */
export const bridgeAttachmentResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), url: z.string().min(1) }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("blocked") }),
  z.object({ status: z.literal("failed") }),
])
export type BridgeAttachmentResponse = z.infer<typeof bridgeAttachmentResponseSchema>

/** A message's current state. */
export const bridgeMessageSchema = z.object({
  id: z.string().min(1),
  streamId: z.string().min(1),
  authorId: z.string().min(1),
  authorType: z.enum(AUTHOR_TYPES),
  contentJson: bridgeContentSchema,
  contentMarkdown: z.string(),
  /** Emoji to the ids of the users who reacted with it. */
  reactions: z.record(z.string(), z.array(z.string())),
  revision: z.number().int().positive(),
  editedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  attachments: z.array(bridgeAttachmentSchema),
  /** Set only on a message written by one of the caller's own users, so it can match it to the send it made. */
  clientMessageId: z.string().nullable().default(null),
})
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>

/** A host user who wrote or reacted in the shared tree, as the partner shows them. */
export const bridgeUserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string().min(1),
})
export type BridgeUser = z.infer<typeof bridgeUserSchema>

/**
 * What a partner's write carries about one of its own users. The host keeps a
 * copy under this id, so it must be a user id: a persona or bot id would put
 * a row in the host's users that isn't one.
 */
export const bridgeWriteUserSchema = bridgeUserSchema.extend({ id: z.string().regex(/^usr_/) })
export type BridgeWriteUser = z.infer<typeof bridgeWriteUserSchema>

/** A partner's message into a shared stream, written as one of its users. `users` names the partner users its content mentions. */
export const bridgeSendMessageSchema = z.object({
  author: bridgeWriteUserSchema,
  users: z.array(bridgeWriteUserSchema),
  clientMessageId: z.string().min(1),
  contentJson: bridgeContentSchema,
})
export type BridgeSendMessage = z.infer<typeof bridgeSendMessageSchema>

export const bridgeSendMessageResponseSchema = z.object({ messageId: z.string().min(1) })
export type BridgeSendMessageResponse = z.infer<typeof bridgeSendMessageResponseSchema>

export const bridgeEditMessageSchema = z.object({
  author: bridgeWriteUserSchema,
  users: z.array(bridgeWriteUserSchema),
  contentJson: bridgeContentSchema,
})
export type BridgeEditMessage = z.infer<typeof bridgeEditMessageSchema>

/** The emoji is in the path. */
export const bridgeAddReactionSchema = z.object({ author: bridgeWriteUserSchema })
export type BridgeAddReaction = z.infer<typeof bridgeAddReactionSchema>

/** A delete names its author in the query, since a DELETE carries no body. */
export const bridgeDeleteMessageQuerySchema = z.object({ authorId: z.string().regex(/^usr_/) })
export const bridgeRemoveReactionQuerySchema = z.object({ userId: z.string().regex(/^usr_/) })

/** A host custom persona or bot that wrote or reacted in the shared tree, as the partner shows it. */
export const bridgeActorSchema = z.object({
  id: z.string().regex(/^(persona|bot)_/),
  name: z.string(),
  avatarEmoji: z.string().nullable(),
})
export type BridgeActor = z.infer<typeof bridgeActorSchema>

/** What a partner applies: a message to upsert, or one to drop because it was deleted or left the shared tree. */
export const bridgeChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), message: bridgeMessageSchema }),
  z.object({ kind: z.literal("message_removed"), messageId: z.string().min(1) }),
])
export type BridgeChange = z.infer<typeof bridgeChangeSchema>

/**
 * A page of one stream's changes after a cursor. The cursor moves past every
 * event read, including the ones the host keeps to itself, so a page can hold
 * fewer changes than events.
 */
export const bridgeEventsSchema = z.object({
  changes: z.array(bridgeChangeSchema),
  /** Every user the changes name as an author or reactor. */
  users: z.array(bridgeUserSchema),
  /** Every custom persona and bot the changes name as an author or reactor. Absent from a host that predates it. */
  actors: z.array(bridgeActorSchema).default([]),
  cursor: bridgeSequenceSchema,
  hasMore: z.boolean(),
})
export type BridgeEvents = z.infer<typeof bridgeEventsSchema>
