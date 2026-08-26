/**
 * Call limits and lifecycle timing. One source of truth (INV-33); status arrays
 * are the authority for the TEXT columns validated in code (INV-3), with union
 * types derived from them (INV-31).
 */

export const CALL_STATUSES = ["active", "empty_grace", "ended"] as const
export type CallStatus = (typeof CALL_STATUSES)[number]

export const CALL_MODES = ["video", "audio_only"] as const
export type CallMode = (typeof CALL_MODES)[number]

/** v1 media transport. Only 'sfu' is accepted; the Later direct-calls privacy mode (p2p) is deferred. */
export const CALL_MEDIA_TRANSPORTS = ["sfu"] as const
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

/**
 * The kinds of media an endpoint can publish. CF Realtime pushes no remote-track
 * notification, so the published-track registry rides our versioned roster and
 * clients pull peers' tracks on roster changes. `trackName` is the CF track name
 * the peer pulls by.
 */
export const PUBLISHED_TRACK_KINDS = ["mic", "camera", "share_video", "share_audio"] as const
export type PublishedTrackKind = (typeof PUBLISHED_TRACK_KINDS)[number]

export interface PublishedTrack {
  kind: PublishedTrackKind
  trackName: string
}

/**
 * Server-owned mute/camera claims mirrored to every client through the roster —
 * the authority the UI derives badges from (a client's local `track.enabled` is
 * cosmetic; this is the truth peers see). Sparse: an absent field means "no
 * claim yet" (client defaults apply).
 */
export interface MediaState {
  muted?: boolean
  cameraOn?: boolean
}

/**
 * Sweep cadence for the lease reaper (`createCallSweeper`). One source of truth
 * (INV-33) shared by `server.ts` (the production sweeper) and the spike harness
 * (`SWEEP_INTERVAL_MS`), so the two can never drift — the hostile matrix's timing
 * assertions and the deployed cadence are the same number by construction.
 * `server.ts` layers a `CALL_SWEEP_INTERVAL_MS` env override on top (crash-recovery
 * latency is deployment-tunable; the spike findings flagged a shorter cadence as
 * an M1 option, and the e2e suite drives it low for a deterministic end).
 */
export const CALL_SWEEP_INTERVAL_MS = 15_000

/**
 * How long a call sits in `empty_grace` after the last participant leaves before
 * it ends. Env-overridable for the same reason as the sweep cadence (worst-case
 * crash-recovery latency is grace + sweep, so a shorter calls-specific grace was
 * an explicit M1 option) — the e2e suite sets it low so an ended call's
 * timeline card lands within the test window.
 */
export const EMPTY_GRACE_MS = Number(process.env.CALL_EMPTY_GRACE_MS) || 45_000

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

/**
 * Per-socket control/proxy event budget on the `/calls` namespace: a simple
 * token bucket (INV — abuse hardening). Renegotiation churn and roster catch-up
 * on a bad network burst, so the ceiling is generous; it only trips a runaway
 * client. Refills continuously at `CALL_SOCKET_RATE_REFILL_PER_SEC`.
 */
export const CALL_SOCKET_RATE_BURST = 40
export const CALL_SOCKET_RATE_REFILL_PER_SEC = 10
