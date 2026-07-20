/**
 * Call limits and lifecycle timing. One source of truth (INV-33); status arrays
 * are the authority for the TEXT columns validated in code (INV-3), with union
 * types derived from them (INV-31).
 */

export const CALL_STATUSES = ["active", "empty_grace", "ended"] as const
export type CallStatus = (typeof CALL_STATUSES)[number]

export const CALL_MODES = ["video", "audio_only"] as const
export type CallMode = (typeof CALL_MODES)[number]

/** v1 always 'sfu'; 'p2p' is reserved for the Later direct-calls privacy mode. */
export const CALL_MEDIA_TRANSPORTS = ["sfu", "p2p"] as const
export type CallMediaTransport = (typeof CALL_MEDIA_TRANSPORTS)[number]

export const CALL_ENDED_REASONS = ["completed", "reaped"] as const
export type CallEndedReason = (typeof CALL_ENDED_REASONS)[number]

export const CALL_INVITATION_STATUSES = [
  "ringing",
  "accepted",
  "declined",
  "busy",
  "expired",
  "cancelled",
  "superseded",
] as const
export type CallInvitationStatus = (typeof CALL_INVITATION_STATUSES)[number]

export const CALL_PARTICIPANT_STATUSES = ["joined", "left", "removed"] as const
export type CallParticipantStatus = (typeof CALL_PARTICIPANT_STATUSES)[number]

export const CALL_ENDPOINT_STATUSES = ["connected", "reconnecting", "closed"] as const
export type CallEndpointStatus = (typeof CALL_ENDPOINT_STATUSES)[number]

/** How long a call sits in `empty_grace` after the last participant leaves before it ends. */
export const EMPTY_GRACE_MS = 45_000

/** Endpoint lease TTL; a lease not renewed within this window is swept to `closed`. */
export const ENDPOINT_LEASE_TTL_MS = 45_000

/**
 * The owning instance renews an endpoint lease at TTL/3 so two missed renewals
 * still precede expiry. Consumed by the socket layer in a later PR.
 */
export const ENDPOINT_LEASE_RENEW_MS = Math.floor(ENDPOINT_LEASE_TTL_MS / 3)

/** How long a DM ring stays live before the sweep expires it → missed call. */
export const INVITATION_TTL_MS = 45_000

/** Product comfort cap on concurrent joined participants (the SFU has no hard cliff). */
export const CALL_PRODUCT_CAP = 50
