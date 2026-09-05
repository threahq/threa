import posthog from "posthog-js"

export type AnalyticsClient = Pick<
  typeof posthog,
  "init" | "opt_in_capturing" | "opt_out_capturing" | "identify" | "group" | "reset" | "captureException"
>

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
