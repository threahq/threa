import { PROD, THRESHOLDS } from "../config"
import type { Credentials } from "../env"
import { timedFetch, type FetchLike, type HttpProbeResult } from "../http"
import type { RailwayDeployment } from "../railway"
import type { Finding, Level } from "../types"

export interface LivenessCheck {
  name: string
  url: string
  status: number | null
  ms: number
  level: Level
  detail: string
}

export interface LivenessReport {
  checks: LivenessCheck[]
  findings: Finding[]
}

export function grade(name: string, res: HttpProbeResult, expectStatus = 200): LivenessCheck {
  const base = { name, url: res.url, status: res.status, ms: res.ms }
  if (res.error) return { ...base, level: "fail", detail: res.error }
  if (res.status !== expectStatus)
    return { ...base, level: "fail", detail: `HTTP ${res.status} (expected ${expectStatus}) ${res.body.slice(0, 120)}` }
  if (res.ms > THRESHOLDS.slowHttpMs)
    return { ...base, level: "warn", detail: `${res.ms}ms (> ${THRESHOLDS.slowHttpMs}ms)` }
  return { ...base, level: "ok", detail: `${res.ms}ms` }
}

/** Railway services publish their host as the deployment's staticUrl; only services with one are probed. */
export function healthTargets(deployments: RailwayDeployment[]): Array<{ name: string; url: string }> {
  const seen = new Map<string, string>()
  for (const d of [...deployments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (d.staticUrl && !seen.has(d.service) && (PROD.revisionServices as readonly string[]).includes(d.service)) {
      seen.set(d.service, d.staticUrl)
    }
  }
  return [...seen.entries()].map(([name, host]) => ({ name: `${name} /health`, url: `https://${host}/health` }))
}

export async function probeLiveness(params: {
  fetchImpl: FetchLike
  creds: Credentials
  deployments: RailwayDeployment[]
  cacheBuster: string
}): Promise<LivenessReport> {
  const { fetchImpl, creds } = params
  const tasks: Array<Promise<LivenessCheck>> = []
  tasks.push(timedFetch(fetchImpl, `${PROD.frontendUrl}/?cb=${params.cacheBuster}`).then((r) => grade("frontend /", r)))
  tasks.push(
    timedFetch(fetchImpl, `${PROD.frontendUrl}/api/regions`).then((r) =>
      grade("router → control-plane /api/regions", r)
    )
  )
  const targets = healthTargets(params.deployments)
  if (creds.DB_READ_PROXY_URL && !targets.some((t) => t.name.startsWith("db-read-proxy"))) {
    tasks.push(
      timedFetch(fetchImpl, `${creds.DB_READ_PROXY_URL.replace(/\/$/, "")}/health`).then((r) =>
        grade("db-read-proxy /health", r)
      )
    )
  }
  for (const t of targets) tasks.push(timedFetch(fetchImpl, t.url).then((r) => grade(t.name, r)))
  const ws = creds.THREA_PROD_DEFAULT_WORKSPACE
  if (creds.THREA_PROD_READ_ONLY_API_KEY && creds.THREA_PROD_BASE_URL && ws) {
    const url = `${creds.THREA_PROD_BASE_URL.replace(/\/$/, "")}/api/v1/workspaces/${ws}/me`
    tasks.push(
      timedFetch(fetchImpl, url, { headers: { Authorization: `Bearer ${creds.THREA_PROD_READ_ONLY_API_KEY}` } }).then(
        (r) => grade("public API /me (auth → router → backend → db)", r)
      )
    )
  }
  const checks = await Promise.all(tasks)
  const findings: Finding[] = checks
    .filter((c) => c.level !== "ok")
    .map((c) => ({ level: c.level, id: `liveness.${c.name}`, message: `${c.name}: ${c.detail}` }))
  return { checks, findings }
}
