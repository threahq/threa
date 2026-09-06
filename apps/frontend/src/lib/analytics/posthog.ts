import type { CaptureResult, PostHog, Properties } from "posthog-js"

export type AnalyticsRoot = Pick<PostHog, "init">

export type AnalyticsClient = Pick<
  PostHog,
  | "opt_in_capturing"
  | "opt_out_capturing"
  | "identify"
  | "group"
  | "reset"
  | "captureException"
  | "capture"
  | "startSessionRecording"
  | "stopSessionRecording"
>

/**
 * posthog-js attaches the raw browser URL to every event, to the person
 * properties it sends as `$set_once`, and to session-entry copies of both, so a
 * crash report from `/w/ws_x/s/stream_y` would carry a stream id the backend
 * deliberately never sends (E2E streams are excluded server-side, and there is
 * no client-side equivalent). Any segment that is not lowercase-kebab becomes
 * `:id`, which fails closed: every prefixed ULID (INV-2) holds `_` and uppercase.
 */
const ROUTE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Matched against the key with its leading `$` dropped, so posthog's prefixed
// copies ($initial_current_url, $session_entry_pathname, …) are covered as the
// SDK adds them. A fixed key list fails open on every upgrade.
const URL_KEY = /(?:^|_)(?:url|referrer)$/
const PATH_KEY = /(?:^|_)pathname$/

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

function sanitizeBag(bag: Properties): Properties {
  const sanitized: Properties = { ...bag }
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value !== "string") continue
    const name = key.startsWith("$") ? key.slice(1) : key
    if (URL_KEY.test(name)) sanitized[key] = sanitizeUrl(value)
    else if (PATH_KEY.test(name)) sanitized[key] = sanitizePath(value)
  }
  return sanitized
}

export function sanitizeUrlProperties(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event
  return {
    ...event,
    ...(event.properties && { properties: sanitizeBag(event.properties) }),
    ...(event.$set && { $set: sanitizeBag(event.$set) }),
    ...(event.$set_once && { $set_once: sanitizeBag(event.$set_once) }),
  }
}

// Chrome and Firefox word it differently ("completed with undelivered
// notifications" / "limit exceeded"); both mean a ResizeObserver callback
// resized something it observes, and the browser deferred that observation to
// the next frame. Nothing is lost, and it drowned out every real crash.
const BENIGN_EXCEPTION = /^ResizeObserver loop/

export function dropBenignExceptions(event: CaptureResult | null): CaptureResult | null {
  if (!event || event.event !== "$exception") return event
  const exceptions = event.properties?.$exception_list as Array<{ value?: unknown }> | undefined
  const benign = exceptions?.some(
    (exception) => typeof exception.value === "string" && BENIGN_EXCEPTION.test(exception.value)
  )
  return benign ? null : event
}

export function beforeSend(event: CaptureResult | null): CaptureResult | null {
  return sanitizeUrlProperties(dropBenignExceptions(event))
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

// Counts consent decisions, so a start that is still fetching the SDK can tell
// that consent was withdrawn underneath it and drop itself instead of arming
// capture afterwards.
let consentGeneration = 0

let sdk: Promise<AnalyticsRoot> | null = null

/**
 * The SDK is imported here rather than at module scope for two reasons: nothing
 * may load it before consent is granted, and a static import pulls it into the
 * entry chunk, which then crosses the service worker's 2 MiB precache limit and
 * fails the production build (see apps/frontend/vite.config.ts).
 */
function loadSdk(): Promise<AnalyticsRoot> {
  sdk ??= import("posthog-js").then((module) => module.default)
  return sdk
}

/**
 * Every call into posthog-js goes through here. These run inside render-path
 * effects, and a browser that blocks storage or an extension that patches fetch
 * can make the SDK throw — reporting a crash must never cause one. The backend
 * reporter guards its own SDK the same way.
 */
function guard(what: string, action: () => void): void {
  try {
    action()
  } catch (error) {
    console.error(`[Analytics] ${what} failed:`, error)
  }
}

export async function startAnalytics(
  params: StartAnalyticsParams,
  root?: AnalyticsRoot | PromiseLike<AnalyticsRoot>
): Promise<void> {
  if (
    active &&
    active.token === params.token &&
    active.distinctId === params.distinctId &&
    active.workspaceId === params.workspaceId
  ) {
    return
  }

  const started = ++consentGeneration
  const sdkRoot = await (root ?? loadSdk())
  if (started !== consentGeneration) return

  guard("start", () => {
    // One instance per project token. posthog-js ignores a second `init` on an
    // instance it has already loaded, so a user who moves from an EU workspace to
    // a US one in the same tab would otherwise keep writing US activity into the
    // EU project. `api_host` is fixed at init, and travels with the token.
    const client = sdkRoot.init(
      params.token,
      {
        api_host: params.host,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        // Replay is a second, narrower consent, so no recording starts at init.
        // `startSessionRecording` flips this flag at runtime; a second `init`
        // would not, because posthog-js ignores it on a loaded instance.
        disable_session_recording: true,
        session_recording: {
          maskAllInputs: true,
          // Every text node, not just inputs: a replay of Threa is a replay of
          // other people's messages, and they never consented to anything here.
          maskTextSelector: "*",
          // Attachments, avatars and rendered canvases are recorded by `src`,
          // which masking does not touch.
          blockSelector: "img, video, canvas",
        },
        enable_recording_console_log: false,
        capture_exceptions: true,
        persistence: "localStorage+cookie",
        before_send: beforeSend,
      },
      `threa_${params.token}`
    )

    deactivate()
    client.opt_in_capturing()
    client.identify(params.distinctId)
    client.group("workspace", params.workspaceId)

    active = { ...params, client }
  })
}

function deactivate(): void {
  if (!active) return
  const { client } = active
  active = null
  guard("stop", () => {
    client.reset()
    client.opt_out_capturing()
  })
}

export function stopAnalytics(): void {
  consentGeneration++
  deactivate()
}

/**
 * Applied on every gate run rather than at init: replay consent can be revoked
 * while the same instance stays up, and `startSessionRecording` is the only
 * thing that clears `disable_session_recording` on a loaded instance.
 */
export function setSessionReplay(enabled: boolean): void {
  const current = active
  if (!current) return
  guard("sessionReplay", () => {
    if (enabled) current.client.startSessionRecording()
    else current.client.stopSessionRecording()
  })
}

export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  const current = active
  if (!current) return
  guard("captureException", () => current.client.captureException(error, properties))
}

export function capture(event: string, properties?: Record<string, string>): void {
  const current = active
  if (!current) return
  guard("capture", () => current.client.capture(event, properties))
}
