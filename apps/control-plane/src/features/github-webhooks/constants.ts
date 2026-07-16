export const GITHUB_WEBHOOK_PATH = "/api/integrations/github/webhook"

export const GITHUB_PROVIDER = "github"

export const OUTBOX_GITHUB_WEBHOOK_DISPATCH = "github_webhook_dispatch"

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
