import { logger } from "../logger"

export interface PostHogConfig {
  projectToken: string
  host: string
}

export function loadPostHogConfig(
  env: { POSTHOG_PROJECT_TOKEN?: string; POSTHOG_HOST?: string },
  opts: { isProduction: boolean; service: string }
): PostHogConfig | null {
  const projectToken = env.POSTHOG_PROJECT_TOKEN?.trim()
  const host = env.POSTHOG_HOST?.trim()

  if (projectToken && host) {
    return { projectToken, host }
  }

  if (projectToken && !host) {
    throw new Error(
      "POSTHOG_HOST is required when POSTHOG_PROJECT_TOKEN is set — the host is region-bound (https://eu.i.posthog.com or https://us.i.posthog.com)"
    )
  }

  if (host && !projectToken) {
    throw new Error(
      "POSTHOG_PROJECT_TOKEN is required when POSTHOG_HOST is set — the host is region-bound (https://eu.i.posthog.com or https://us.i.posthog.com)"
    )
  }

  if (opts.isProduction) {
    logger.warn({ service: opts.service }, "POSTHOG_PROJECT_TOKEN unset — error reporting to PostHog disabled")
  }

  return null
}
