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
}
