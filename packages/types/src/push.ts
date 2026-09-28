/** What the push service (FCM, Mozilla autopush, APNs, WNS) answered for one device. */
export const PUSH_PROVIDER_OUTCOMES = {
  ACCEPTED: "accepted",
  REGISTRATION_GONE: "registration_gone",
  REJECTED: "rejected",
  UNREACHABLE: "unreachable",
  /** The stored registration's keys cannot be encrypted to, so no request reached the push service. */
  INVALID_REGISTRATION: "invalid_registration",
} as const

export type PushProviderOutcome = (typeof PUSH_PROVIDER_OUTCOMES)[keyof typeof PUSH_PROVIDER_OUTCOMES]

export interface PushTestDeviceResult {
  subscriptionId: string
  deviceKey: string
  userAgent: string | null
  outcome: PushProviderOutcome
  statusCode: number | null
}

export interface PushTestResponse {
  testId: string
  attempted: number
  accepted: number
  failed: number
  /** Equals `accepted`. Read by cached frontend bundles that predate `devices`; the push service accepting a message is not a device showing it. */
  delivered: number
  devices: PushTestDeviceResult[]
  /**
   * Present when the test's per-device results were kept for polling at
   * {@link pushTestProgressPath}. Absent from backends that predate receipts,
   * null when they could not be stored: both mean provider results only.
   */
  progress?: { expiresAt: string } | null
}

/**
 * What a service worker reports about a push that carried a receipt
 * capability. `received` is progress; the other three are terminal, and the
 * first terminal report wins. `notification_created` means `showNotification`
 * resolved, not that the OS displayed it.
 */
export const PUSH_RECEIPT_STAGES = {
  RECEIVED: "received",
  NOTIFICATION_CREATED: "notification_created",
  CREATION_FAILED: "creation_failed",
  SUPPRESSED: "suppressed",
} as const

export type PushReceiptStage = (typeof PUSH_RECEIPT_STAGES)[keyof typeof PUSH_RECEIPT_STAGES]

/** Why a worker intentionally showed nothing. Sent only with the `suppressed` stage. */
export const PUSH_RECEIPT_SUPPRESSION_REASONS = {
  /** The user is looking at the stream in a focused window. */
  PRESENCE: "presence",
} as const

export type PushReceiptSuppressionReason =
  (typeof PUSH_RECEIPT_SUPPRESSION_REASONS)[keyof typeof PUSH_RECEIPT_SUPPRESSION_REASONS]

/**
 * Receipt protocol version a service worker advertises in its STATUS_REPLY
 * (`pushReceiptVersion`), which the subscribe handshake forwards as
 * `receiptVersion`. A registration without it is unknown: no capability is
 * issued to it and it never counts as a missing receipt.
 */
export const PUSH_RECEIPT_SW_VERSION = 1

/**
 * Opaque base64url receipt capability, carried in the encrypted push payload as
 * top-level `receipt.token`, beside `data`. A pre-receipt worker copies `data`
 * into notification data that any same-origin page can read, and never looks
 * at `receipt`.
 */
export const PUSH_RECEIPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Body of `POST {@link pushReceiptPath}`. No cookie or auth header: the token is the credential. */
export interface PushReceiptRequest {
  token: string
  stage: PushReceiptStage
  reason?: PushReceiptSuppressionReason
}

/** Same-origin receipt route. The service worker builds it from the payload's workspaceId, never from a URL in the payload. */
export function pushReceiptPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/push/receipts`
}

export function pushTestProgressPath(workspaceId: string, testId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/push/test/${encodeURIComponent(testId)}`
}

/**
 * Every push API route, workspace-scoped or not: subscription bodies carry the
 * device's endpoint and keys, and tests and receipts link a device to a user.
 * Matched on a pathname in any letter case, as Express routes it; any
 * workspace segment matches, well-formed or not.
 */
const PUSH_REQUEST_PATH = /^\/api\/(?:workspaces\/[^/]*\/)?push(?:\/|$)/i

export function isPushRequestPath(pathname: string): boolean {
  return PUSH_REQUEST_PATH.test(pathname)
}

export interface PushTestDeviceProgress {
  subscriptionId: string
  deviceKey: string
  userAgent: string | null
  /** Null until the push service answered. */
  outcome: PushProviderOutcome | null
  statusCode: number | null
  receipt: {
    /** Whether this device's worker was given a capability. False: its worker cannot report, provider result only. */
    expected: boolean
    /** Terminal stage when reported, else `received` once reported, else null (unconfirmed). */
    stage: PushReceiptStage | null
    reason: PushReceiptSuppressionReason | null
  }
}

/** `GET {@link pushTestProgressPath}`: the caller's own test only. */
export interface PushTestProgress {
  testId: string
  /** After this, no further receipt can be recorded; anything still unreported stays unconfirmed. */
  expiresAt: string
  devices: PushTestDeviceProgress[]
}
