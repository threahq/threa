import { PROD } from "../config"
import { latestRunPerWorkflow, type WorkflowRun } from "../github"
import type { RailwayDeployment } from "../railway"
import type { Finding, Level } from "../types"

export interface PlaneRevision {
  plane: string
  expected: string
  live: string | null
  level: Level
  detail: string
  /** Newest deployment's createdAt when known. */
  deployedAt?: string
}

export interface RevisionReport {
  expected: string
  planes: PlaneRevision[]
  findings: Finding[]
  /** Newest SUCCESS backend deployment timestamp, the default comparison baseline. */
  backendDeployedAt: string | null
}

function shaMatches(expected: string, live: string | null): boolean {
  if (!live) return false
  const n = Math.min(expected.length, live.length)
  return n >= 7 && expected.slice(0, n) === live.slice(0, n)
}

export function short(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 8) : null
}

/** Newest deployment per service, plus the newest SUCCESS per service (what is actually serving). */
export function summarizeRailway(
  deployments: RailwayDeployment[]
): Map<string, { newest: RailwayDeployment; serving: RailwayDeployment | null }> {
  const out = new Map<string, { newest: RailwayDeployment; serving: RailwayDeployment | null }>()
  const sorted = [...deployments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const d of sorted) {
    const cur = out.get(d.service)
    if (!cur) out.set(d.service, { newest: d, serving: d.status === "SUCCESS" ? d : null })
    else if (!cur.serving && d.status === "SUCCESS") cur.serving = d
  }
  return out
}

const IN_PROGRESS = ["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING"]

export function evaluateRailwayPlane(
  service: string,
  expected: string,
  entry: { newest: RailwayDeployment; serving: RailwayDeployment | null } | undefined
): PlaneRevision {
  if (!entry) return { plane: service, expected, live: null, level: "fail", detail: "no deployments found" }
  const { newest, serving } = entry
  const live = serving?.sha ?? null
  const base = { plane: service, expected, live, deployedAt: newest.createdAt }
  if (newest.status === "SUCCESS") {
    if (shaMatches(expected, newest.sha)) return { ...base, level: "ok", detail: "serving expected sha" }
    return {
      ...base,
      level: "pending",
      detail: `serving ${short(newest.sha)}; no deployment for ${short(expected)} yet`,
    }
  }
  if (newest.status === "SKIPPED") {
    if (shaMatches(expected, newest.sha)) {
      return {
        ...base,
        level: "ok",
        detail: `${short(expected)} skipped (${newest.skippedReason ?? "no changes"}); serving ${short(live)}`,
      }
    }
    return {
      ...base,
      level: "pending",
      detail: `newest deployment ${short(newest.sha)} skipped; no deployment for ${short(expected)} yet; serving ${short(live)}`,
    }
  }
  if (IN_PROGRESS.includes(newest.status)) {
    return {
      ...base,
      level: "pending",
      detail: `${newest.status.toLowerCase()} ${short(newest.sha)}; serving ${short(live)}`,
    }
  }
  if (newest.status === "FAILED" || newest.status === "CRASHED") {
    return {
      ...base,
      level: "fail",
      detail: `newest deployment ${short(newest.sha)} ${newest.status}; serving ${short(live)}`,
    }
  }
  return {
    ...base,
    level: shaMatches(expected, live) ? "ok" : "warn",
    detail: `newest ${newest.status.toLowerCase()}; serving ${short(live)}`,
  }
}

export function evaluateFrontendPlane(
  expected: string,
  version: { version: string; builtAt?: string } | null,
  runs: WorkflowRun[]
): PlaneRevision {
  const live = version?.version ?? null
  const base = { plane: "frontend", expected, live }
  if (shaMatches(expected, live)) return { ...base, level: "ok", detail: `version.json serves ${short(live)}` }
  const byName = latestRunPerWorkflow(runs)
  const ci = byName.get(PROD.frontendWorkflows.ci)
  const deploy = byName.get(PROD.frontendWorkflows.deploy)
  const serving = `serving ${short(live) ?? "unknown"}`
  if (!ci) return { ...base, level: "pending", detail: `${serving}; no CI run for ${short(expected)} yet` }
  if (ci.status !== "completed") return { ...base, level: "pending", detail: `${serving}; CI ${ci.status}` }
  if (ci.conclusion !== "success") {
    return {
      ...base,
      level: "fail",
      detail: `${serving}; CI ${ci.conclusion}, so ${PROD.frontendWorkflows.deploy} will not run (${ci.url})`,
    }
  }
  if (!deploy) return { ...base, level: "pending", detail: `${serving}; CI green, deploy not started` }
  if (deploy.status !== "completed") return { ...base, level: "pending", detail: `${serving}; deploy ${deploy.status}` }
  if (deploy.conclusion === "success") {
    return {
      ...base,
      level: "warn",
      detail: `${serving}; deploy succeeded but version.json disagrees (CDN cache, or main moved on?)`,
    }
  }
  return { ...base, level: "fail", detail: `${serving}; deploy ${deploy.conclusion} (${deploy.url})` }
}

export function buildRevisionReport(params: {
  expected: string
  /** null when Railway could not be queried at all (no token): planes are skipped, not failed. */
  deployments: RailwayDeployment[] | null
  frontendVersion: { version: string; builtAt?: string } | null
  runs: WorkflowRun[]
}): RevisionReport {
  const summary = summarizeRailway(params.deployments ?? [])
  const planes: PlaneRevision[] = [
    evaluateFrontendPlane(params.expected, params.frontendVersion, params.runs),
    ...PROD.revisionServices.map((s) =>
      params.deployments
        ? evaluateRailwayPlane(s, params.expected, summary.get(s))
        : {
            plane: s,
            expected: params.expected,
            live: null,
            level: "skipped" as const,
            detail: "Railway not queried (RAILWAY_READONLY_TOKEN missing)",
          }
    ),
  ]
  const findings: Finding[] = planes
    .filter((p) => p.level !== "ok")
    .map((p) => ({ level: p.level, id: `revision.${p.plane}`, message: `${p.plane}: ${p.detail}` }))
  const backend = summary.get("backend")
  return { expected: params.expected, planes, findings, backendDeployedAt: backend?.serving?.createdAt ?? null }
}
