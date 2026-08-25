import { z } from "zod"

/**
 * Event types that drive a preview refresh: each derives a canonical URL from
 * its payload and re-fetches matching previews. The two `installation*` types
 * below are handled separately. CP already filters to the app's subscribed set,
 * so anything else is a clean no-op.
 */
export const GITHUB_REFRESH_EVENT_TYPES = ["pull_request", "pull_request_review", "issues"] as const

/** Installation lifecycle. Deactivates only on `deleted`; suspend/unsuspend are no-ops. */
export const GITHUB_INSTALLATION_EVENT_TYPE = "installation"

/**
 * Repository access for the installation changed on GitHub (`added`/`removed`).
 * The grant lives on GitHub, so this is the only push signal that a workspace's
 * cached repository list went stale; the worker reconciles it.
 */
export const GITHUB_INSTALLATION_REPOSITORIES_EVENT_TYPE = "installation_repositories"

/** Wire shape sent by CP's `RegionalClient.dispatchGithubWebhook`. */
export const githubWebhookEventSchema = z.object({
  deliveryGuid: z.string().min(1),
  eventType: z.string().min(1),
  action: z.string().nullable(),
  installationId: z.string().nullable(),
  repositoryFullName: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
})

export type GithubWebhookEventInput = z.infer<typeof githubWebhookEventSchema>
