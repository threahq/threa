/**
 * Backoffice router — a tiny Cloudflare Worker that fronts the Threa
 * backoffice app.
 *
 * Responsibilities:
 * - Proxy `/api/*` and `/test-auth-login*` to the control-plane. The
 *   backoffice has no regional backend, so there's nothing workspace-scoped
 *   to route — everything goes to the control-plane.
 * - Proxy everything else to the `threa-backoffice` Cloudflare Pages
 *   deployment when `PAGES_PROJECT` is configured. This is the mode used
 *   when the worker's Cloudflare Route is `admin.threa.io/*`.
 * - When `PAGES_PROJECT` is unset (route scoped to `/api/*`), non-API paths
 *   return 404.
 *
 * Keeping this worker entirely independent of `workspace-router` matches the
 * project convention of one router worker per concern, and avoids coupling
 * workspace routing logic to the backoffice surface.
 */
import { ORIGINAL_HOST_HEADER } from "@threa/types"

interface Env {
  /** Base URL for the control-plane service (handles backoffice + auth). */
  CONTROL_PLANE_URL: string
  /** CF Pages project name that serves the backoffice static assets (optional). */
  PAGES_PROJECT?: string
}

const API_ROUTE_RE = /^\/api\//
/** Dev auth routes that the control-plane exposes in stub mode only. */
const DEV_AUTH_ROUTE_RE = /^\/test-auth-login\/?$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Router health check
    if (path === "/readyz" && request.method === "GET") {
      return new Response("OK", { status: 200 })
    }

    // Control-plane routes: every /api/* call plus stub-auth login in dev
    if (API_ROUTE_RE.test(path) || DEV_AUTH_ROUTE_RE.test(path)) {
      try {
        return await proxyRequest(request, env.CONTROL_PLANE_URL)
      } catch {
        return errorResponse(502, "Control plane unavailable")
      }
    }

    // Non-API: serve the CF Pages backoffice deployment if configured.
    if (env.PAGES_PROJECT) {
      return proxyToPages(request, env.PAGES_PROJECT)
    }

    return errorResponse(404, "Not found")
  },
}

async function proxyRequest(request: Request, targetBaseUrl: string): Promise<Response> {
  const url = new URL(request.url)
  const targetUrl = new URL(url.pathname + url.search, targetBaseUrl)

  const headers = new Headers(request.headers)
  headers.set("X-Forwarded-Host", url.host)
  // Railway's edge overwrites X-Forwarded-Host with its own ingress host before
  // the control-plane sees it, so the standard header can't carry the real
  // client host (e.g. admin.threa.io) through. Mirror it onto a custom header
  // that survives Railway, which the control-plane uses to pick the per-host
  // WorkOS redirect URI and trust the post-auth redirect target.
  headers.set(ORIGINAL_HOST_HEADER, url.host)
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""))

  // Trust only CF-Connecting-IP (set by Cloudflare). Strip any client-supplied
  // X-Forwarded-For to prevent rate-limit bypass on the control-plane.
  const clientIp = request.headers.get("CF-Connecting-IP")
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp)
  } else {
    headers.delete("X-Forwarded-For")
  }

  headers.delete("host")

  return fetch(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  })
}

/**
 * Proxy non-API requests to the CF Pages backoffice deployment
 * (`<project>.pages.dev`). Preserves caching/content-type headers from Pages.
 */
async function proxyToPages(request: Request, pagesProject: string): Promise<Response> {
  const url = new URL(request.url)
  const pagesUrl = new URL(url.pathname + url.search, `https://${pagesProject}.pages.dev`)
  const response = await fetch(pagesUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  })
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}
