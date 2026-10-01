import { z } from "zod"
import { VISIBILITY_OPTIONS, type Visibility } from "./constants"

// A stream connection shares one host channel with one partner workspace. The
// control plane owns the record; each side's region keeps a projection row,
// written only from the snapshots below.

export const STREAM_CONNECTION_STATES = ["invited", "active", "revoked"] as const
export type StreamConnectionState = (typeof STREAM_CONNECTION_STATES)[number]

export const StreamConnectionStates = {
  INVITED: "invited",
  ACTIVE: "active",
  REVOKED: "revoked",
} as const satisfies Record<string, StreamConnectionState>

export const STREAM_CONNECTION_ROLES = ["host", "partner"] as const
export type StreamConnectionRole = (typeof STREAM_CONNECTION_ROLES)[number]

export const StreamConnectionRoles = {
  HOST: "host",
  PARTNER: "partner",
} as const satisfies Record<string, StreamConnectionRole>

export const StreamConnectionErrorCodes = {
  DISABLED: "STREAM_CONNECTIONS_DISABLED",
  NOT_FOUND: "STREAM_CONNECTION_NOT_FOUND",
  REVOKED: "STREAM_CONNECTION_REVOKED",
  EXPIRED: "STREAM_CONNECTION_EXPIRED",
  ALREADY_ACCEPTED: "STREAM_CONNECTION_ALREADY_ACCEPTED",
  SAME_WORKSPACE: "STREAM_CONNECTION_SAME_WORKSPACE",
  NOT_SHAREABLE: "STREAM_NOT_SHAREABLE",
  ALREADY_SHARED: "STREAM_ALREADY_SHARED",
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
  partnerWorkspaceId: z.string().min(1).nullable(),
  partnerWorkspaceName: z.string().nullable(),
  partnerRegion: z.string().min(1).nullable(),
  partnerVisibility: z.enum(VISIBILITY_OPTIONS).nullable(),
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

export const STREAM_CONNECTION_TOKEN_MAX_LENGTH = 200

export const acceptStreamConnectionSchema = z
  .object({
    token: z.string().min(1).max(STREAM_CONNECTION_TOKEN_MAX_LENGTH),
    visibility: z.enum(VISIBILITY_OPTIONS),
  })
  .strict()
export type AcceptStreamConnectionInput = z.infer<typeof acceptStreamConnectionSchema>

/** What the invite page shows before accepting. Safe for any signed-in user holding the token. */
export interface StreamConnectionLookupResponse {
  connectionId: string
  /** A revoked invite is an error, never a lookup result. */
  state: Exclude<StreamConnectionState, "revoked">
  hostWorkspaceId: string
  hostWorkspaceName: string
  /** Where the host's data lives. Accepting agrees to the partner's copy being served from there too. */
  hostRegion: string
  streamDisplayName: string | null
  streamSlug: string | null
  /** Set once accepted, and only for a member of the partner workspace. */
  partnerWorkspaceId: string | null
  partnerWorkspaceName: string | null
  expiresAt: string
}
