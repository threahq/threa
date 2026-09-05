import posthog, { type CaptureResult } from "posthog-js"

export type AnalyticsClient = Pick<
  typeof posthog,
  "init" | "opt_in_capturing" | "opt_out_capturing" | "identify" | "group" | "reset" | "captureException"
>

/**
 * posthog-js attaches the raw browser URL to EVERY event, so a crash report from
 * `/w/ws_x/s/stream_y` would carry a stream id the backend deliberately never
 * sends (E2E streams are excluded server-side, and there is no client-side
 * equivalent). Any segment that is not lowercase-kebab becomes `:id`, which
 * fails closed: every prefixed ULID (INV-2) holds `_` and uppercase.
 */
const ROUTE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const URL_PROPERTIES = ["$current_url", "$initial_current_url", "$session_entry_url", "$referrer"]
const PATH_PROPERTIES = ["$pathname", "$initial_pathname"]

function sanitizePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (segment === "" || ROUTE_SEGMENT.test(segment) ? segment : ":id"))
    .join("/")
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${sanitizePath(url.pathname)}`
  } catch {
    // posthog writes the sentinel "$direct" into $referrer when there is none.
    return value.includes("/") ? "" : value
  }
}

export function sanitizeUrlProperties(event: CaptureResult | null): CaptureResult | null {
  if (!event?.properties) return event

  const properties = { ...event.properties }
  for (const key of URL_PROPERTIES) {
    if (typeof properties[key] === "string") properties[key] = sanitizeUrl(properties[key])
  }
  for (const key of PATH_PROPERTIES) {
    if (typeof properties[key] === "string") properties[key] = sanitizePath(properties[key])
  }
  return { ...event, properties }
}

export interface StartAnalyticsParams {
  token: string
  host: string
  distinctId: string
  workspaceId: string
}

interface ActiveAnalytics extends StartAnalyticsParams {
  client: AnalyticsClient
}

let active: ActiveAnalytics | null = null

function sameTarget(a: ActiveAnalytics, b: StartAnalyticsParams, client: AnalyticsClient): boolean {
  return (
    a.client === client &&
    a.token === b.token &&
    a.host === b.host &&
    a.distinctId === b.distinctId &&
    a.workspaceId === b.workspaceId
  )
}

export function startAnalytics(params: StartAnalyticsParams, client: AnalyticsClient = posthog): void {
  if (active && sameTarget(active, params, client)) {
    return
  }
  if (active) {
    stopAnalytics()
  }

  client.init(params.token, {
    api_host: params.host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    capture_exceptions: true,
    persistence: "localStorage+cookie",
    before_send: sanitizeUrlProperties,
  })
  client.opt_in_capturing()
  client.identify(params.distinctId)
  client.group("workspace", params.workspaceId)

  active = { ...params, client }
}

export function stopAnalytics(): void {
  if (!active) return
  const { client } = active
  client.reset()
  client.opt_out_capturing()
  active = null
}

export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  if (!active) return
  active.client.captureException(error, properties)
}
