import { z } from "zod"
import { VISIBILITY_OPTIONS, type Visibility } from "./constants"

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
  SAME_WORKSPACE: "STREAM_CONNECTION_SAME_WORKSPACE",
  NOT_SHAREABLE: "STREAM_NOT_SHAREABLE",
} as const
export type StreamConnectionErrorCode = (typeof StreamConnectionErrorCodes)[keyof typeof StreamConnectionErrorCodes]

/** How long an invite link stays valid. */
export const STREAM_CONNECTION_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Control plane → region wire format: the full current state of one connection.
 * Unknown keys are dropped rather than rejected, so a control plane that adds a
 * field ahead of a region's deploy doesn't dead-letter the sync.
 */
export const streamConnectionSnapshotSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  state: z.enum(STREAM_CONNECTION_STATES),
  hostWorkspaceId: z.string().min(1),
  hostWorkspaceName: z.string(),
  hostRegion: z.string().min(1),
  hostStreamId: z.string().min(1),
  hostStreamSlug: z.string().nullable(),
  hostStreamDisplayName: z.string().nullable(),
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

/** One side's view of a connection, as the regional API returns it. */
export interface StreamConnection {
  id: string
  role: StreamConnectionRole
  state: StreamConnectionState
  /** The host's stream id. Both sides use it, since the partner's copy keeps the host's ids. */
  streamId: string
  streamSlug: string | null
  streamDisplayName: string | null
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

export const streamConnectionTokenSchema = z.string().min(1).max(200)

export const acceptStreamConnectionSchema = z
  .object({
    token: streamConnectionTokenSchema,
    visibility: z.enum(VISIBILITY_OPTIONS),
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
