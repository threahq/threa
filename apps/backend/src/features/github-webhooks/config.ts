import { z } from "zod"

/**
 * Event types that drive a preview refresh. `installation` is handled as a
 * lifecycle event (deactivate on delete/suspend); the PR/issue types derive
 * canonical URLs and refresh matching previews. CP already filters to the
 * app's subscribed set, so anything else that arrives is a clean no-op.
 */
export const GITHUB_REFRESH_EVENT_TYPES = ["pull_request", "pull_request_review", "issues"] as const

export const GITHUB_INSTALLATION_EVENT_TYPE = "installation"

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
