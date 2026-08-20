// Client-side call constants and the publisher watchdog policy. Mirrors the
// backend's `features/calls/config.ts` where the two must agree (track kinds,
// modes, lease TTL); the publish-layer ladder is client-only (the SFU does
// per-receiver adaptation, so this only steps the *published* encode).

export const CALL_MODES = ["video", "audio_only"] as const
export type CallMode = (typeof CALL_MODES)[number]

export const PUBLISHED_TRACK_KINDS = ["mic", "camera", "share_video", "share_audio"] as const
export type PublishedTrackKind = (typeof PUBLISHED_TRACK_KINDS)[number]

/**
 * Endpoint lease TTL, mirrored from the backend (`ENDPOINT_LEASE_TTL_MS`). The
 * server hands the authoritative value back on `call:join` (`leaseTtlMs`); this
 * is the fallback when an ack somehow omits it.
 */
export const ENDPOINT_LEASE_TTL_MS = 45_000

/**
 * The owning tab renews its lease at TTL/3 so two missed renewals still precede
 * expiry. The renew timer is derived from the server-supplied TTL, falling back
 * to this fraction of {@link ENDPOINT_LEASE_TTL_MS}.
 */
export const LEASE_RENEW_FRACTION = 1 / 3

export function leaseRenewIntervalMs(leaseTtlMs: number): number {
  return Math.max(1_000, Math.floor(leaseTtlMs * LEASE_RENEW_FRACTION))
}

/**
 * The published-camera ladder for the publisher watchdog. Highest layer first;
 * the watchdog steps *down* one rung when the encoder is bandwidth/CPU limited
 * and *up* one rung when it has recovered for a sustained window. Per-receiver
 * adaptation is the SFU's job — this only protects the uplink from collapse.
 */
export interface PublishLayer {
  maxHeight: number
  maxFramerate: number
  /** `RTCRtpEncodingParameters.maxBitrate` in bits/sec. */
  maxBitrate: number
}

export const CAMERA_PUBLISH_LADDER: readonly PublishLayer[] = [
  { maxHeight: 720, maxFramerate: 30, maxBitrate: 1_500_000 },
  { maxHeight: 480, maxFramerate: 30, maxBitrate: 700_000 },
  { maxHeight: 360, maxFramerate: 20, maxBitrate: 350_000 },
  { maxHeight: 180, maxFramerate: 15, maxBitrate: 150_000 },
] as const

/** Screen-share encode targets, keyed by the track's `contentHint`. */
export const SHARE_PUBLISH_LAYERS: Record<"detail" | "motion", PublishLayer> = {
  detail: { maxHeight: 1080, maxFramerate: 15, maxBitrate: 2_500_000 },
  motion: { maxHeight: 720, maxFramerate: 30, maxBitrate: 2_000_000 },
}

/**
 * Watchdog sampling + hysteresis. Sample `getStats` on this interval; step down
 * immediately on a limited sample, but require several consecutive healthy
 * samples before stepping back up so the layer doesn't oscillate.
 */
export const WATCHDOG_SAMPLE_MS = 3_000
export const WATCHDOG_HEALTHY_SAMPLES_TO_UPGRADE = 4

/**
 * Failed peer-track pulls re-diff against the live roster after this delay, up
 * to the attempt cap per track. Without it a single failed pull loses that
 * peer's track for the rest of the call — no later roster event re-offers a
 * track that didn't change. Capped because a pull against a dead track holds
 * the transport's serial negotiation queue for the backend's full CF timeout.
 */
export const PULL_RETRY_DELAY_MS = 2_000
export const PULL_RETRY_MAX_ATTEMPTS = 3

/** Mic audio constraints: browser AEC/NS/AGC applied once at capture. (The combined mic+camera acquisition rule lives on captureAndPublish.) */
export const AUDIO_CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/** Camera capture defaults; the watchdog re-applies encode caps via sender params. */
export const VIDEO_CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
}
