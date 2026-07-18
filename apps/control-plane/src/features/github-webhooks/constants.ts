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

/**
 * Retention window for delivery rows. A row is an idempotency guard (the GUID
 * unique index dedupes GitHub retries) plus an operator forensic trail — not an
 * archive; GitHub's own Recent Deliveries UI covers ~30 days, so nothing older
 * is worth keeping. Sweeping a >30-day-old row technically reopens dedupe for
 * its GUID, but a GitHub redelivery that old is effectively nonexistent and the
 * regional queue's `ghwh_<guid>` PK dedupes independently, so the reopen is inert.
 */
export const GITHUB_WEBHOOK_RETENTION_DAYS = 30

/** How often the retention sweep runs. */
export const GITHUB_WEBHOOK_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Rows deleted per DELETE statement. Bounding the batch keeps each delete's lock
 * footprint small so a large backlog can't hold row/index locks long enough to
 * stall concurrent inserts; the sweeper loops until a batch comes back short.
 */
export const GITHUB_WEBHOOK_SWEEP_BATCH_SIZE = 500
