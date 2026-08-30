import { INTERNAL_API_KEY_HEADER, ORIGINAL_HOST_HEADER } from "@threa/types"

interface Env {
  WORKSPACE_REGIONS: KVNamespace
  /** JSON map of region name → { apiUrl, wsUrl } */
  REGIONS: string
  /** Base URL for the control-plane service (handles auth, workspace list/create) */
  CONTROL_PLANE_URL?: string
  /** Shared secret for control-plane internal API */
  INTERNAL_API_KEY?: string
}

interface RegionConfig {
  apiUrl: string
  wsUrl: string
}

type RegionsMap = Record<string, RegionConfig>

/** Routes that should go to the control-plane (auth, workspace collection, regions) */
const AUTH_ROUTE_RE = /^\/api\/auth\//
const INTEGRATION_CALLBACK_RE = /^\/api\/integrations\/[^/]+\/callback\/?$/
/** GitHub App webhook ingress (one URL for all installations) — control-plane only, POST */
const GITHUB_WEBHOOK_RE = /^\/api\/integrations\/github\/webhook\/?$/
const WORKSPACES_COLLECTION_RE = /^\/api\/workspaces\/?$/
const REGIONS_ROUTE_RE = /^\/api\/regions\/?$/
/** Multi-account switcher API (list/resolve/switch/remove) — control-plane only */
const ACCOUNTS_ROUTE_RE = /^\/api\/accounts(?:\/.*)?$/
/** Dev auth routes that the control-plane handles in stub mode */
const DEV_AUTH_ROUTE_RE = /^\/(?:test-auth-login|api\/dev\/login)\/?$/
/** User-facing invitation acceptance (handled by control-plane) */
const INVITATION_ACCEPT_RE = /^\/api\/invitations\/[^/]+\/accept$/
/** Public link-invite lookup + claim (handled by control-plane, unauthenticated) */
const INVITATION_LOOKUP_RE = /^\/api\/invitations\/lookup$/
const INVITATION_CLAIM_RE = /^\/api\/invitations\/claim$/
/**
 * Public waitlist signup from the marketing site (handled by control-plane,
 * unauthenticated). Proxied for POST *and* OPTIONS: the marketing site is a
 * different origin (threa.io -> app.threa.io), so the browser sends a CORS
 * preflight that must reach control-plane's cors() middleware to be answered.
 */
const WAITLIST_ROUTE_RE = /^\/api\/waitlist\/?$/
/**
 * OAuth device authorization grant for `threa-bot connect` (handled by
 * control-plane): the device authorizes and polls `/api/oauth/token`
 * unauthenticated, the browser looks up/approves/denies with its session.
 * Global because the device has no workspace, hence no region, until approval.
 */
const OAUTH_DEVICE_ROUTE_RE = /^\/api\/oauth\/(?:device_authorization|token)$/
const BOT_CONNECT_ROUTE_RE = /^\/api\/bot-connect\/(?:lookup|approve|deny)$/

/** Matches /api/workspaces/:workspaceId with optional trailing path */
const WORKSPACE_ROUTE_RE = /^\/api\/workspaces\/([^/]+)(?:\/.+)?$/
/** Public API v1 routes — routed to regional backend like workspace routes */
const PUBLIC_API_ROUTE_RE = /^\/api\/v1\/workspaces\/([^/]+)(?:\/.+)?$/
/** Dev workspace routes (workspace/stream join — test only) */
const DEV_WORKSPACE_ROUTE_RE = /^\/api\/dev\/workspaces\/([^/]+)(?:\/.+)?$/

/** Matches /api/workspaces/:workspaceId/config exactly */
const CONFIG_ROUTE_RE = /^\/api\/workspaces\/([^/]+)\/config$/

const RETIRED_SESSION_COOKIE_NAMES = [
  "wos_session_staging",
  "wos_session_staging_alt_0",
  "wos_session_staging_alt_1",
  "wos_session_staging_alt_2",
]

/** Cache parsed regions per REGIONS string (static per env binding) */
let cachedRegionsRaw: string | null = null
let cachedRegions: RegionsMap | null = null

function getRegionsFromEnv(raw: string): RegionsMap {
  if (raw === cachedRegionsRaw && cachedRegions) return cachedRegions
  cachedRegions = parseRegions(raw)
  cachedRegionsRaw = raw
  return cachedRegions
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await routeRequest(request, env)
    return expireRetiredSessionCookies(request, response)
  },
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const regions = getRegionsFromEnv(env.REGIONS)
  const url = new URL(request.url)
  const path = url.pathname

  // Router health check (handled locally, not proxied)
  if (path === "/readyz" && request.method === "GET") {
    return new Response("OK", { status: 200 })
  }

  // Control-plane routes (auth, workspace list/create, regions, dev auth)
  if (env.CONTROL_PLANE_URL) {
    const method = request.method
    if (
      AUTH_ROUTE_RE.test(path) ||
      ACCOUNTS_ROUTE_RE.test(path) ||
      INTEGRATION_CALLBACK_RE.test(path) ||
      (GITHUB_WEBHOOK_RE.test(path) && method === "POST") ||
      (WORKSPACES_COLLECTION_RE.test(path) && (method === "GET" || method === "POST")) ||
      REGIONS_ROUTE_RE.test(path) ||
      DEV_AUTH_ROUTE_RE.test(path) ||
      (INVITATION_ACCEPT_RE.test(path) && method === "POST") ||
      (INVITATION_LOOKUP_RE.test(path) && method === "GET") ||
      (INVITATION_CLAIM_RE.test(path) && method === "POST") ||
      (WAITLIST_ROUTE_RE.test(path) && (method === "POST" || method === "OPTIONS")) ||
      (OAUTH_DEVICE_ROUTE_RE.test(path) && method === "POST") ||
      (BOT_CONNECT_ROUTE_RE.test(path) && (method === "GET" || method === "POST"))
    ) {
      try {
        return await proxyRequest(request, env.CONTROL_PLANE_URL)
      } catch {
        return errorResponse(502, "Control plane unavailable")
      }
    }
  }

  // Config endpoint: returns the direct WebSocket URL for a workspace
  const configMatch = path.match(CONFIG_ROUTE_RE)
  if (configMatch && request.method === "GET") {
    return handleConfigRequest(configMatch[1], regions, env)
  }

  // Public API v1 routes (API key auth, routed to regional backend)
  const publicApiMatch = path.match(PUBLIC_API_ROUTE_RE)
  if (publicApiMatch) {
    return routeWorkspaceRequest(request, publicApiMatch[1], regions, env)
  }

  // Workspace-scoped API routes
  const workspaceMatch = path.match(WORKSPACE_ROUTE_RE)
  if (workspaceMatch) {
    return routeWorkspaceRequest(request, workspaceMatch[1], regions, env)
  }

  // Dev workspace routes (e.g. /api/dev/workspaces/:id/join) — test only
  const devWorkspaceMatch = path.match(DEV_WORKSPACE_ROUTE_RE)
  if (devWorkspaceMatch) {
    return routeWorkspaceRequest(request, devWorkspaceMatch[1], regions, env)
  }

  return errorResponse(404, "Not found")
}

function parseRegions(raw: string): RegionsMap {
  if (!raw) throw new Error("REGIONS env var is empty or missing")
  try {
    return JSON.parse(raw) as RegionsMap
  } catch (e) {
    throw new Error(`REGIONS env var is not valid JSON: ${(e as Error).message}`)
  }
}

/**
 * In-isolate cache for the workspace→region lookup. Every workspace-scoped API
 * request resolves the region, and each `KV.get` is a billed read — with a
 * fleet of agent sessions polling through the Worker all day, those reads alone
 * ate a meaningful slice of the daily KV quota, despite the mapping being
 * written once and never changed. The TTL bounds staleness if region migration
 * ever becomes real; isolate recycling clears it anyway. Misses are cached
 * briefly too, so an unknown id can't turn every request into a KV read + a
 * control-plane round-trip.
 */
const REGION_CACHE_TTL_MS = 5 * 60 * 1000
const REGION_NEGATIVE_TTL_MS = 30 * 1000
const REGION_CACHE_MAX_ENTRIES = 5000
const regionCache = new Map<string, { region: string | null; expiresAt: number }>()

/** Test hook: module-level state would otherwise leak between test cases. */
export function clearRegionCache(): void {
  regionCache.clear()
}

function cacheRegion(workspaceId: string, region: string | null): void {
  // Ids come from request URLs, so the key space is attacker-controlled; a hard
  // cap with full reset beats unbounded growth (entries re-warm in one lookup).
  if (regionCache.size >= REGION_CACHE_MAX_ENTRIES) regionCache.clear()
  regionCache.set(workspaceId, {
    region,
    expiresAt: Date.now() + (region ? REGION_CACHE_TTL_MS : REGION_NEGATIVE_TTL_MS),
  })
}

async function resolveRegion(workspaceId: string, env: Env): Promise<string | null> {
  const held = regionCache.get(workspaceId)
  if (held && held.expiresAt > Date.now()) return held.region

  // KV hit: the durable cache shared across isolates/colos
  const cached = await env.WORKSPACE_REGIONS.get(workspaceId)
  if (cached) {
    cacheRegion(workspaceId, cached)
    return cached
  }

  // Slow path: ask the control-plane (source of truth) and cache the result
  if (!env.CONTROL_PLANE_URL || !env.INTERNAL_API_KEY) return null

  const res = await fetch(`${env.CONTROL_PLANE_URL}/internal/workspaces/${workspaceId}/region`, {
    headers: { [INTERNAL_API_KEY_HEADER]: env.INTERNAL_API_KEY },
  })
  if (!res.ok) {
    cacheRegion(workspaceId, null)
    return null
  }

  const { region } = (await res.json()) as { region: string }
  await env.WORKSPACE_REGIONS.put(workspaceId, region)
  cacheRegion(workspaceId, region)
  return region
}

function getRegionConfig(region: string, regions: RegionsMap): RegionConfig | null {
  return regions[region] ?? null
}

async function handleConfigRequest(workspaceId: string, regions: RegionsMap, env: Env): Promise<Response> {
  const region = await resolveRegion(workspaceId, env)
  if (!region) {
    return errorResponse(404, "Workspace not found")
  }

  const config = getRegionConfig(region, regions)
  if (!config) {
    return errorResponse(502, "Region not configured")
  }

  return Response.json({ region, wsUrl: config.wsUrl })
}

async function routeWorkspaceRequest(
  request: Request,
  workspaceId: string,
  regions: RegionsMap,
  env: Env
): Promise<Response> {
  const region = await resolveRegion(workspaceId, env)
  if (!region) {
    return errorResponse(404, "Workspace not found")
  }

  const config = getRegionConfig(region, regions)
  if (!config) {
    return errorResponse(502, "Region not configured")
  }

  return proxyRequest(request, config.apiUrl)
}

function isLocalProxyTarget(targetBaseUrl: string): boolean {
  try {
    const { hostname } = new URL(targetBaseUrl)
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  } catch {
    return false
  }
}

async function proxyRequest(request: Request, targetBaseUrl: string): Promise<Response> {
  const url = new URL(request.url)
  const targetUrl = new URL(url.pathname + url.search, targetBaseUrl)

  const headers = new Headers(request.headers)
  const preserveUpstreamForwardedHeaders = isLocalProxyTarget(targetBaseUrl)
  const forwardedHost = preserveUpstreamForwardedHeaders ? request.headers.get("X-Forwarded-Host") : null
  const forwardedProto = preserveUpstreamForwardedHeaders ? request.headers.get("X-Forwarded-Proto") : null
  const forwardedPort = preserveUpstreamForwardedHeaders ? request.headers.get("X-Forwarded-Port") : null

  headers.set("X-Forwarded-Host", forwardedHost ?? url.host)
  // Railway's edge overwrites X-Forwarded-Host with its own ingress host before
  // the control-plane sees it, so the standard header can't carry the real
  // client host through. Mirror it onto a custom header that survives Railway.
  headers.set(ORIGINAL_HOST_HEADER, forwardedHost ?? url.host)
  headers.set("X-Forwarded-Proto", forwardedProto ?? url.protocol.replace(":", ""))

  if (forwardedPort) {
    headers.set("X-Forwarded-Port", forwardedPort)
  } else if (url.port) {
    headers.set("X-Forwarded-Port", url.port)
  } else {
    headers.delete("X-Forwarded-Port")
  }

  // Only trust CF-Connecting-IP (set by Cloudflare, not spoofable by clients).
  // Strip any client-supplied X-Forwarded-For to prevent rate limit bypass.
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

function expireRetiredSessionCookies(request: Request, response: Response): Response {
  if (new URL(request.url).hostname !== "app.threa.io") return response

  const responseHeaders = new Headers(response.headers)
  for (const name of RETIRED_SESSION_COOKIE_NAMES) {
    responseHeaders.append(
      "Set-Cookie",
      `${name}=; Path=/; Domain=.threa.io; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
    )
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}
