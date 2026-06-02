import { INTERNAL_API_KEY_HEADER } from "@threa/types"

interface Env {
  WORKSPACE_REGIONS: KVNamespace
  /** JSON map of region name → { apiUrl, wsUrl } */
  REGIONS: string
  /** Base URL for the control-plane service (handles auth, workspace list/create) */
  CONTROL_PLANE_URL?: string
  /** Shared secret for control-plane internal API */
  INTERNAL_API_KEY?: string
  /** When "true", resolve regions from KV before falling back to env var (staging only) */
  USE_KV_REGIONS?: string
  /** CF Pages project name for frontend proxying (staging only, e.g. "threa-staging") */
  PAGES_PROJECT?: string
  /** The staging base domain (e.g. "staging.threa.io") — used to extract PR subdomain */
  STAGING_DOMAIN?: string
  /** Staging WS domain (e.g. "ws-staging.threa.io") — enables hostname-based WS routing */
  WS_STAGING_DOMAIN?: string
}

interface RegionConfig {
  apiUrl: string
  wsUrl: string
}

type RegionsMap = Record<string, RegionConfig>

/** Routes that should go to the control-plane (auth, workspace collection, regions) */
const AUTH_ROUTE_RE = /^\/api\/auth\//
const INTEGRATION_CALLBACK_RE = /^\/api\/integrations\/[^/]+\/callback\/?$/
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

/** Matches /api/workspaces/:workspaceId with optional trailing path */
const WORKSPACE_ROUTE_RE = /^\/api\/workspaces\/([^/]+)(?:\/.+)?$/
/** Public API v1 routes — routed to regional backend like workspace routes */
const PUBLIC_API_ROUTE_RE = /^\/api\/v1\/workspaces\/([^/]+)(?:\/.+)?$/
/** Dev workspace routes (workspace/stream join — test only) */
const DEV_WORKSPACE_ROUTE_RE = /^\/api\/dev\/workspaces\/([^/]+)(?:\/.+)?$/

/** Matches /api/workspaces/:workspaceId/config exactly */
const CONFIG_ROUTE_RE = /^\/api\/workspaces\/([^/]+)\/config$/

/** KV key for dynamic regions config (used by staging CI to register PR backends) */
const REGIONS_CONFIG_KV_KEY = "__regions_config__"

/** Fixed region name for the stable main staging backend (staging.threa.io) */
const MAIN_STAGING_REGION = "staging"

/** Cache parsed regions per REGIONS string (static per env binding) */
let cachedRegionsRaw: string | null = null
let cachedRegions: RegionsMap | null = null

function getRegionsFromEnv(raw: string): RegionsMap {
  if (raw === cachedRegionsRaw && cachedRegions) return cachedRegions
  cachedRegions = parseRegions(raw)
  cachedRegionsRaw = raw
  return cachedRegions
}

/**
 * Resolve regions map. In staging we merge env (stable regions like "staging")
 * with KV (ephemeral per-PR regions written by scripts/staging-pr.ts). Env is
 * the base; KV entries override on key collision. In production USE_KV_REGIONS
 * is unset, so we use env only.
 */
async function getRegions(envRegions: string, kv: KVNamespace, useKv: boolean): Promise<RegionsMap> {
  const baseRegions = getRegionsFromEnv(envRegions)
  if (!useKv) return baseRegions

  const kvRegions = await kv.get(REGIONS_CONFIG_KV_KEY)
  if (!kvRegions) return baseRegions
  return { ...baseRegions, ...parseRegions(kvRegions) }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const regions = await getRegions(env.REGIONS, env.WORKSPACE_REGIONS, env.USE_KV_REGIONS === "true")
    const url = new URL(request.url)
    const path = url.pathname

    // Router health check (handled locally, not proxied)
    if (path === "/readyz" && request.method === "GET") {
      return new Response("OK", { status: 200 })
    }

    // Staging WS routing: ws-staging.threa.io → proxy to region backend
    // Region is passed as a ?region= query param (set by the config endpoint's wsUrl)
    if (env.WS_STAGING_DOMAIN && url.hostname === env.WS_STAGING_DOMAIN) {
      const regionName = url.searchParams.get("region")
      if (!regionName) return errorResponse(400, "Missing region parameter")
      const config = getRegionConfig(regionName, regions)
      if (!config) return errorResponse(404, "Unknown staging region")
      return proxyRequest(request, config.apiUrl)
    }

    // Staging hostname-pinned routing. The hostname alone determines the region,
    // bypassing the KV workspace→region lookup entirely. Two hostnames pin:
    //   - pr-N-staging.threa.io        → region "pr-N"   (ephemeral PR backend)
    //   - <STAGING_DOMAIN> (e.g. staging.threa.io) → region "staging" (stable main backend)
    // This is what keeps staging.threa.io stable: PRs clone the staging DB and
    // share its workspace IDs, but the worker never resolves region from the
    // shared workspace ID — it's always derived from the request's hostname.
    //
    // When the hostname pins a region, API routes MUST terminate inside this
    // block — never fall through to workspace-id-based routing, even if the
    // pinned region is missing from the regions map. Falling through to the
    // workspace KV lookup would let a stale per-workspace KV entry (e.g. one
    // written by a previous PR deploy) decide the route, which is the exact
    // failure mode hostname pinning exists to prevent.
    const pinnedRegion = resolvePinnedRegion(url.hostname, env.STAGING_DOMAIN)
    if (pinnedRegion) {
      const pinnedBackend = getRegionConfig(pinnedRegion, regions)

      // Control-plane routes still go to the shared CP
      if (env.CONTROL_PLANE_URL) {
        const method = request.method
        if (
          AUTH_ROUTE_RE.test(path) ||
          ACCOUNTS_ROUTE_RE.test(path) ||
          INTEGRATION_CALLBACK_RE.test(path) ||
          (WORKSPACES_COLLECTION_RE.test(path) && (method === "GET" || method === "POST")) ||
          REGIONS_ROUTE_RE.test(path) ||
          DEV_AUTH_ROUTE_RE.test(path) ||
          (INVITATION_ACCEPT_RE.test(path) && method === "POST") ||
          (INVITATION_LOOKUP_RE.test(path) && method === "GET") ||
          (INVITATION_CLAIM_RE.test(path) && method === "POST") ||
          (WAITLIST_ROUTE_RE.test(path) && (method === "POST" || method === "OPTIONS"))
        ) {
          try {
            return await proxyRequest(request, env.CONTROL_PLANE_URL)
          } catch {
            return errorResponse(502, "Control plane unavailable")
          }
        }
      }

      // Config endpoint: return the pinned region's WS URL
      const configMatch2 = path.match(CONFIG_ROUTE_RE)
      if (configMatch2 && request.method === "GET") {
        if (!pinnedBackend) return errorResponse(502, "Region not configured")
        const wsUrl = env.WS_STAGING_DOMAIN
          ? `https://${env.WS_STAGING_DOMAIN}?region=${pinnedRegion}`
          : pinnedBackend.wsUrl
        return Response.json({ region: pinnedRegion, wsUrl })
      }

      // All other API routes go to the pinned region's backend. We refuse to
      // fall through for /api/* even when the region is missing — that path
      // would hit the workspace-id KV lookup we deliberately bypass here.
      if (path.startsWith("/api/")) {
        if (!pinnedBackend) return errorResponse(502, "Region not configured")
        return proxyRequest(request, pinnedBackend.apiUrl)
      }

      // Non-API routes (frontend assets) fall through to proxyToPages below,
      // which derives the Pages host from the same hostname.
    }

    // --- Standard routing (production; staging non-API frontend fallback) ---

    // Control-plane routes (auth, workspace list/create, regions, dev auth)
    if (env.CONTROL_PLANE_URL) {
      const method = request.method
      if (
        AUTH_ROUTE_RE.test(path) ||
        ACCOUNTS_ROUTE_RE.test(path) ||
        INTEGRATION_CALLBACK_RE.test(path) ||
        (WORKSPACES_COLLECTION_RE.test(path) && (method === "GET" || method === "POST")) ||
        REGIONS_ROUTE_RE.test(path) ||
        DEV_AUTH_ROUTE_RE.test(path) ||
        (INVITATION_ACCEPT_RE.test(path) && method === "POST") ||
        (INVITATION_LOOKUP_RE.test(path) && method === "GET") ||
        (INVITATION_CLAIM_RE.test(path) && method === "POST") ||
        (WAITLIST_ROUTE_RE.test(path) && (method === "POST" || method === "OPTIONS"))
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

    // Non-API routes: proxy to CF Pages frontend (staging only)
    if (env.PAGES_PROJECT && env.STAGING_DOMAIN) {
      return proxyToPages(request, env.PAGES_PROJECT, env.STAGING_DOMAIN)
    }

    return errorResponse(404, "Not found")
  },
}

function parseRegions(raw: string): RegionsMap {
  if (!raw) throw new Error("REGIONS env var is empty or missing")
  try {
    return JSON.parse(raw) as RegionsMap
  } catch (e) {
    throw new Error(`REGIONS env var is not valid JSON: ${(e as Error).message}`)
  }
}

async function resolveRegion(workspaceId: string, env: Env): Promise<string | null> {
  // Fast path: KV cache hit
  const cached = await env.WORKSPACE_REGIONS.get(workspaceId)
  if (cached) return cached

  // Slow path: ask the control-plane (source of truth) and cache the result
  if (!env.CONTROL_PLANE_URL || !env.INTERNAL_API_KEY) return null

  const res = await fetch(`${env.CONTROL_PLANE_URL}/internal/workspaces/${workspaceId}/region`, {
    headers: { [INTERNAL_API_KEY_HEADER]: env.INTERNAL_API_KEY },
  })
  if (!res.ok) return null

  const { region } = (await res.json()) as { region: string }
  // Cache in KV so subsequent requests are fast
  await env.WORKSPACE_REGIONS.put(workspaceId, region)
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

  // In staging, construct the wsUrl with region as a query param
  const wsUrl = env.WS_STAGING_DOMAIN ? `https://${env.WS_STAGING_DOMAIN}?region=${region}` : config.wsUrl
  return Response.json({ region, wsUrl })
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

/**
 * Build a regex for flat PR subdomains from the STAGING_DOMAIN env var.
 * e.g. staging.threa.io → /^pr-(\d+)-staging\.threa\.io$/
 * Returns null when STAGING_DOMAIN is not set (production).
 */
function buildPrStagingRe(stagingDomain: string | undefined): RegExp | null {
  if (!stagingDomain) return null
  // staging.threa.io → pr-(\d+)-staging.threa.io
  // Drop the leading subdomain label ("staging") and keep the base domain
  const escapedDomain = stagingDomain.replace(/\./g, "\\.")
  return new RegExp(`^pr-(\\d+)-${escapedDomain}$`)
}

/**
 * Map a hostname to a fixed region name when staging routing applies.
 * Returns null in production (no STAGING_DOMAIN) or for unrecognised hostnames.
 */
function resolvePinnedRegion(hostname: string, stagingDomain: string | undefined): string | null {
  if (!stagingDomain) return null

  // pr-N-staging.threa.io → "pr-N"
  const prRe = buildPrStagingRe(stagingDomain)
  const prMatch = prRe ? hostname.match(prRe) : null
  if (prMatch) return `pr-${prMatch[1]}`

  // staging.threa.io → "staging" (stable main staging backend)
  if (hostname === stagingDomain) return MAIN_STAGING_REGION

  return null
}

/**
 * Proxy non-API requests to the CF Pages frontend deployment.
 * Maps hostnames to Pages URLs:
 *   staging.threa.io         → threa-staging.pages.dev
 *   pr-123-staging.threa.io  → pr-123.threa-staging.pages.dev
 */
async function proxyToPages(request: Request, pagesProject: string, stagingDomain: string): Promise<Response> {
  const url = new URL(request.url)
  const hostname = url.hostname

  let pagesHost = `${pagesProject}.pages.dev`
  if (hostname !== stagingDomain) {
    // Flat PR subdomain: pr-123-staging.threa.io → pr-123.threa-staging.pages.dev
    const prRe = buildPrStagingRe(stagingDomain)
    const prMatch = prRe ? hostname.match(prRe) : null
    if (prMatch) {
      pagesHost = `pr-${prMatch[1]}.${pagesProject}.pages.dev`
    }
  }

  const pagesUrl = new URL(url.pathname + url.search, `https://${pagesHost}`)
  const response = await fetch(pagesUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  })

  // Return the response with original headers (CF Pages handles caching/content-type)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}
