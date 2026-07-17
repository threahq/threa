export const GITHUB_WEBHOOK_PATH = "/api/integrations/github/webhook"

export const GITHUB_PROVIDER = "github"

export const OUTBOX_GITHUB_WEBHOOK_DISPATCH = "github_webhook_dispatch"

/**
 * Delivery-row status state machine. `dispatched` = routes matched and outbox
 * events were fanned out; `no_routes` = acknowledged but no regions matched (the
 * rollout window before the backfill registered routes), which a later redelivery
 * can promote to `dispatched`. Single source of truth for the CAS/promotion SQL
 * and the reconcile check (INV-33) — a typo'd literal would silently break both.
 */
export const GITHUB_WEBHOOK_DELIVERY_STATUS = {
  DISPATCHED: "dispatched",
  NO_ROUTES: "no_routes",
} as const

export type GithubWebhookDeliveryStatus =
  (typeof GITHUB_WEBHOOK_DELIVERY_STATUS)[keyof typeof GITHUB_WEBHOOK_DELIVERY_STATUS]

/**
 * Events the app is subscribed to and that drive a live preview refresh. Any
 * other event type is acknowledged (202) but never fanned out. `ping` is
 * handled separately (200) as GitHub's endpoint health check.
 */
export const FORWARDED_GITHUB_EVENT_TYPES = ["pull_request", "pull_request_review", "issues", "installation"] as const

export interface GithubWebhookDispatchPayload {
  deliveryId: string
  region: string
}
