/**
 * Standalone process wrapper around the spike harness's fake Cloudflare Realtime
 * server (`apps/backend/scripts/calls-spike/fake-cf-server.ts`) so the two-context
 * calls e2e can boot it as a Playwright `webServer` entry alongside the backend.
 *
 * REUSES the spike seam (never a fork): it is the same fake the control-plane
 * hostile matrix runs against, in `negotiationless` mode — it forwards no media
 * (no valid SDP for a real browser's PeerConnection), which is exactly the point.
 * The e2e asserts the control plane (roster / dock / phases via the `/calls`
 * socket), never bytes. The backend points `CLOUDFLARE_REALTIME_API_BASE` at
 * `${url}/v1/apps`, so with the app id/secret set the media plane is "configured"
 * (`cloudflareEnabled`) without a real CF account.
 *
 * Port comes from `FAKE_CF_PORT` (allocated once in playwright.config.ts); the
 * readiness probe is `GET /healthz`.
 */
import { startFakeCfServer } from "../../apps/backend/scripts/calls-spike/fake-cf-server"

const port = Number(process.env.FAKE_CF_PORT)
if (!port) {
  throw new Error("FAKE_CF_PORT must be set for the calls e2e fake-CF server")
}

const server = startFakeCfServer(port, { negotiationless: true })
console.log(`[fake-cf] listening on ${server.url} (negotiationless)`)

const shutdown = () => {
  server.stop()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
