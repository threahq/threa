import { logger } from "../logger"

const LOGS_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const

export type PostHogLogsLevel = (typeof LOGS_LEVELS)[number]

export interface PostHogConfig {
  projectToken: string
  host: string
  /** Minimum pino level shipped to PostHog Logs. `null` = ship nothing. */
  logsLevel: PostHogLogsLevel | null
}

export function loadPostHogConfig(
  env: { POSTHOG_PROJECT_TOKEN?: string; POSTHOG_HOST?: string; POSTHOG_LOGS_LEVEL?: string },
  opts: { isProduction: boolean; service: string }
): PostHogConfig | null {
  // Parsed before the credential branches so a typo fails the boot that
  // introduced it, not the later one that finally sets a project token.
  const logsLevel = parseLogsLevel(env.POSTHOG_LOGS_LEVEL)
  const projectToken = env.POSTHOG_PROJECT_TOKEN?.trim()
  const host = env.POSTHOG_HOST?.trim()

  if (projectToken && host) {
    return { projectToken, host, logsLevel }
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

function parseLogsLevel(raw: string | undefined): PostHogLogsLevel | null {
  const value = raw?.trim()
  if (!value) return null
  if (!(LOGS_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`POSTHOG_LOGS_LEVEL must be one of ${LOGS_LEVELS.join(", ")} — got "${value}"`)
  }
  return value as PostHogLogsLevel
}
