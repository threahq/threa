import { PostHog, type PostHogOptions } from "posthog-node"
import { logger } from "../logger"
import type { PostHogConfig } from "./config"

export interface ExceptionContext {
  distinctId?: string
  properties?: Record<string, unknown>
}

export interface AnalyticsEvent {
  distinctId: string
  event: string
  properties?: Record<string, unknown>
  groups?: Record<string, string>
}

export interface AnalyticsReporter {
  captureException(error: unknown, context?: ExceptionContext): void
  captureEvent(event: AnalyticsEvent): void
  /** Flushes queued events; resolves within the bound even if the transport hangs. */
  shutdown(): Promise<void>
}

export class DisabledAnalyticsReporter implements AnalyticsReporter {
  captureException(_error: unknown, _context?: ExceptionContext): void {}

  captureEvent(_event: AnalyticsEvent): void {}

  async shutdown(): Promise<void> {}
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000

export class PostHogAnalyticsReporter implements AnalyticsReporter {
  private readonly client: PostHog
  private readonly service: string
  private readonly region: string | null
  private readonly shutdownTimeoutMs: number

  constructor(params: {
    config: PostHogConfig
    service: string
    region: string | null
    shutdownTimeoutMs?: number
    fetch?: PostHogOptions["fetch"]
  }) {
    this.service = params.service
    this.region = params.region
    this.shutdownTimeoutMs = params.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.client = new PostHog(params.config.projectToken, {
      host: params.config.host,
      flushAt: 1,
      flushInterval: 1000,
      enableExceptionAutocapture: false,
      fetch: params.fetch,
    })
  }

  captureException(error: unknown, context?: ExceptionContext): void {
    try {
      this.client.captureException(error, context?.distinctId ?? `service:${this.service}`, {
        service: this.service,
        region: this.region,
        ...context?.properties,
        // posthog-node only suppresses person processing when no distinct id is
        // given, and one always is. Errors are operational telemetry: they must
        // not create a person profile for a user who never granted consent.
        $process_person_profile: false,
      })
    } catch (reportingError) {
      logger.warn({ err: reportingError }, "PostHog captureException failed")
    }
  }

  captureEvent(event: AnalyticsEvent): void {
    try {
      this.client.capture({
        distinctId: event.distinctId,
        event: event.event,
        properties: { service: this.service, region: this.region, ...event.properties },
        groups: event.groups,
      })
    } catch (reportingError) {
      logger.warn({ err: reportingError }, "PostHog capture failed")
    }
  }

  async shutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        logger.warn("PostHog shutdown timed out, continuing")
        resolve()
      }, this.shutdownTimeoutMs)
      timer.unref?.()

      this.client
        .shutdown(this.shutdownTimeoutMs)
        .catch((err) => {
          logger.warn({ err }, "PostHog shutdown failed")
        })
        .finally(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        })
    })
  }
}
