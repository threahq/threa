import type { WorkosEvent } from "@threa/backend-common"
import type { AuthLogOutcome } from "./constants"

/** A row ready to insert into `auth_log`. `id` is minted by the repository. */
export interface AuthLogRowInput {
  occurredAt: Date
  workosEventId: string | null
  eventType: string
  workosUserId: string | null
  email: string | null
  organizationId: string | null
  impersonatorEmail: string | null
  ip: string | null
  userAgent: string | null
  outcome: AuthLogOutcome
  detail: Record<string, unknown> | null
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Outcome derives purely from the event type: only WorkOS `*_failed` variants
 * are denials. `authentication.radar_risk_detected` fires on a sign-in that
 * *succeeded* but Radar flagged as risky — a successful authentication, not a
 * denial; the risk signal is the event type itself. Everything else in the
 * ingested set is a successful lifecycle event.
 */
function outcomeFor(eventType: string): AuthLogOutcome {
  if (eventType.endsWith("_failed")) return "denied"
  return "success"
}

/**
 * Build the content-free `detail` extract. Scalar, non-content metadata only —
 * never tokens, codes, or free-text (e.g. the impersonator `reason`, which is
 * operator-authored prose). `authMethod`/`type`/`status`/`errorCode`/`action`
 * are enum-shaped forensic signal, safe to keep.
 */
function detailFor(data: Record<string, unknown>): Record<string, unknown> | null {
  const detail: Record<string, unknown> = {}
  const authMethod = str(data.authMethod)
  if (authMethod) detail.authMethod = authMethod
  const type = str(data.type)
  if (type) detail.type = type
  const status = str(data.status)
  if (status) detail.status = status
  const action = str(data.action)
  if (action) detail.action = action
  const error = data.error
  if (error && typeof error === "object") {
    const code = str((error as Record<string, unknown>).code)
    if (code) detail.errorCode = code
  }
  return Object.keys(detail).length > 0 ? detail : null
}

/**
 * Map a raw WorkOS event to an `auth_log` row. Field placement varies by event
 * category, so extraction is duck-typed against the deserialized (camelCase)
 * payload:
 * - `user.*` payloads key the user id under `id` (object==='user'); everything
 *   else carries it as `userId`.
 * - `api_key.*` payloads carry the org under `owner.id`; `authentication.sso_*`
 *   events nest it under `sso.organizationId`; everything else uses
 *   `organizationId`.
 * - `session.created` carries `impersonator.email` — the operator-impersonation
 *   visibility this table exists to capture.
 */
export function mapWorkosEventToAuthLogRow(event: WorkosEvent): AuthLogRowInput {
  const data = (event.data ?? {}) as Record<string, unknown>

  const isUserObject = str(data.object) === "user"
  const workosUserId = str(data.userId) ?? (isUserObject ? str(data.id) : null)

  const owner = data.owner
  const ownerId = owner && typeof owner === "object" ? str((owner as Record<string, unknown>).id) : null
  const sso = data.sso
  const ssoOrgId = sso && typeof sso === "object" ? str((sso as Record<string, unknown>).organizationId) : null
  const organizationId = str(data.organizationId) ?? ssoOrgId ?? ownerId

  const impersonator = data.impersonator
  const impersonatorEmail =
    impersonator && typeof impersonator === "object" ? str((impersonator as Record<string, unknown>).email) : null

  return {
    occurredAt: new Date(event.createdAt),
    workosEventId: event.id,
    eventType: event.event,
    workosUserId,
    email: str(data.email),
    organizationId,
    impersonatorEmail,
    ip: str(data.ipAddress),
    userAgent: str(data.userAgent),
    outcome: outcomeFor(event.event),
    detail: detailFor(data),
  }
}
