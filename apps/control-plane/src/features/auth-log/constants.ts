import type { WorkosEventName } from "@threahq/backend-common"

/** Lease identifier for the singleton auth_log WorkOS event poller. */
export const AUTH_LOG_EVENT_POLLER_NAME = "auth-log-events"

/**
 * WorkOS event types ingested into `auth_log` (design §7.5). Names must match
 * the live Events API catalog (https://workos.com/docs/events), not the SDK
 * `EventName` union — one name the API rejects 400s the whole `listEvents`
 * call and stalls the poller. Excluded until relevant: `connection.*`/
 * `dsync.*` (no SSO/SCIM orgs yet), `flag.*`, role/permission template
 * events, and the deprecated `organization_membership.added/removed` aliases
 * (superseded by created/deleted).
 */
export const AUTH_LOG_EVENT_TYPES = [
  "authentication.email_verification_succeeded",
  "authentication.magic_auth_failed",
  "authentication.magic_auth_succeeded",
  "authentication.mfa_succeeded",
  "authentication.oauth_failed",
  "authentication.oauth_succeeded",
  "authentication.passkey_failed",
  "authentication.passkey_succeeded",
  "authentication.password_failed",
  "authentication.password_succeeded",
  "authentication.sso_failed",
  "authentication.sso_succeeded",
  "authentication.radar_risk_detected",
  "session.created",
  "session.revoked",
  "user.created",
  "user.updated",
  "user.deleted",
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "invitation.resent",
  "password_reset.created",
  "password_reset.succeeded",
  "magic_auth.created",
  "email_verification.created",
  "api_key.created",
  "api_key.revoked",
  // The SDK 7.82.0 union lags the API: it types `api_key.deleted`, but the
  // live Events API only accepts `api_key.revoked`. Drop the widening once
  // the SDK union includes it.
] as const satisfies readonly (WorkosEventName | "api_key.revoked")[]

export type AuthLogEventType = (typeof AUTH_LOG_EVENT_TYPES)[number]

export const AUTH_LOG_OUTCOMES = ["success", "denied"] as const
export type AuthLogOutcome = (typeof AUTH_LOG_OUTCOMES)[number]

/** Own-handler event types for failures WorkOS structurally cannot see. */
export const AUTH_LOG_CP_CALLBACK_FAILED = "cp.callback_failed"
export const AUTH_LOG_CP_MAGIC_AUTH_VERIFY_FAILED = "cp.magic_auth_verify_failed"
export const AUTH_LOG_CP_BACKOFFICE_REQUEST = "cp.backoffice_request"
