/**
 * Half B (live Cloudflare validation) shared credential gate.
 *
 * Every `cf-*.ts` script answers a `CLOUDFLARE_API.md` open question against the
 * REAL Cloudflare Realtime API and therefore needs a CF dev app. Absent the
 * credentials, each script must fail fast with a single clear message (INV-11 —
 * no silent fallback), which is the "unexecuted, blocked on creds" state the PR
 * ships in until a dev account exists.
 *
 * Required env:
 *   CLOUDFLARE_REALTIME_APP_ID      CF Realtime app id (dev app)
 *   CLOUDFLARE_REALTIME_APP_SECRET  its app secret (media-plane bearer)
 * Optional:
 *   CLOUDFLARE_REALTIME_API_BASE    base override (default CF production base)
 */

import { CloudflareRealtimeApi } from "../../../src/features/calls"

export interface CfCreds {
  appId: string
  appSecret: string
  apiBase?: string
}

const NEEDS_CREDS_MESSAGE =
  "BLOCKED — needs a Cloudflare Realtime dev app.\n" +
  "Set CLOUDFLARE_REALTIME_APP_ID and CLOUDFLARE_REALTIME_APP_SECRET (and optionally\n" +
  "CLOUDFLARE_REALTIME_API_BASE) to run this live-CF probe. Until then this Half-B\n" +
  "script is unexecuted by design — see apps/backend/src/features/calls/CLOUDFLARE_API.md."

/** Return the CF creds or exit(2) with the clear needs-creds message. */
export function requireCfCreds(): CfCreds {
  const appId = process.env.CLOUDFLARE_REALTIME_APP_ID
  const appSecret = process.env.CLOUDFLARE_REALTIME_APP_SECRET
  if (!appId || !appSecret) {
    console.error(NEEDS_CREDS_MESSAGE)
    process.exit(2)
  }
  return { appId, appSecret, apiBase: process.env.CLOUDFLARE_REALTIME_API_BASE }
}

export function makeLiveCf(creds: CfCreds): CloudflareRealtimeApi {
  return new CloudflareRealtimeApi({
    appId: creds.appId,
    appSecret: creds.appSecret,
    apiBase: creds.apiBase,
    enabled: true,
  })
}

/** Direct authenticated fetch to the CF API for probes that go outside the typed adapter. */
export async function cfFetch(
  creds: CfCreds,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const base = (creds.apiBase ?? "https://rtc.live.cloudflare.com/v1/apps").replace(/\/$/, "")
  const res = await fetch(`${base}/${creds.appId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${creds.appSecret}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}
