import { PROD, THRESHOLDS } from "./config"
import { ReadProxyClient } from "./db"
import type { Credentials } from "./env"
import { remoteMainSha, runsForCommit, type ExecLike } from "./github"
import { timedFetch, type FetchLike } from "./http"
import { RailwayClient } from "./railway"
import { probeLiveness, type LivenessReport } from "./probes/liveness"
import { probeLogs, type LogReport } from "./probes/logs"
import { probePipelines, type PipelineReport } from "./probes/pipelines"
import { probeResources, type ResourceReport } from "./probes/resources"
import { buildRevisionReport, type RevisionReport } from "./probes/revision"
import { makeWindow, worst, type Finding, type Level, type Window } from "./types"

export interface Deps {
  fetchImpl: FetchLike
  exec: ExecLike
  creds: Credentials
  now: () => Date
}

export interface SectionError {
  section: string
  error: string
}

export interface Snapshot {
  at: string
  expectedSha: string
  window: Window
  revision: RevisionReport | null
  liveness: LivenessReport | null
  pipelines: PipelineReport | null
  logs: LogReport | null
  resources: ResourceReport | null
  errors: SectionError[]
  findings: Finding[]
  level: Level
}

export interface SnapshotOptions {
  sha?: string
  /** ISO timestamp or undefined (= backend deploy time). */
  since?: string
  sections: Set<"revision" | "liveness" | "pipelines" | "logs" | "resources">
}

export function clients(deps: Deps): { railway: RailwayClient | null; db: ReadProxyClient | null } {
  const railway = deps.creds.RAILWAY_READONLY_TOKEN
    ? new RailwayClient(deps.creds.RAILWAY_READONLY_TOKEN, deps.fetchImpl)
    : null
  const db =
    deps.creds.DB_READ_PROXY_URL && deps.creds.DB_READ_PROXY_SECRET
      ? new ReadProxyClient(deps.creds.DB_READ_PROXY_URL, deps.creds.DB_READ_PROXY_SECRET, deps.fetchImpl)
      : null
  return { railway, db }
}

export async function fetchFrontendVersion(
  fetchImpl: FetchLike,
  cacheBuster: string
): Promise<{ version: string; builtAt?: string } | null> {
  const res = await timedFetch(fetchImpl, `${PROD.frontendUrl}/version.json?cb=${cacheBuster}`)
  if (res.status !== 200) return null
  try {
    const parsed = JSON.parse(res.body) as { version?: unknown; builtAt?: unknown }
    return typeof parsed.version === "string"
      ? { version: parsed.version, builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : undefined }
      : null
  } catch {
    return null
  }
}

export async function resolveExpectedSha(deps: Deps, sha?: string): Promise<string> {
  if (sha) return sha
  return remoteMainSha(deps.exec)
}

/** Revision only: what `verify` polls. */
export async function takeRevision(
  deps: Deps,
  expectedSha: string
): Promise<{
  revision: RevisionReport
  deployments: Awaited<ReturnType<RailwayClient["listDeployments"]>> | null
  errors: SectionError[]
}> {
  const { railway } = clients(deps)
  const errors: SectionError[] = []
  const cb = String(deps.now().getTime())
  const [deployments, frontendVersion, runs] = await Promise.all([
    railway
      ? railway.listDeployments().catch((e: Error) => {
          errors.push({ section: "railway", error: e.message })
          return []
        })
      : Promise.resolve(null),
    fetchFrontendVersion(deps.fetchImpl, cb),
    runsForCommit(deps.exec, PROD.githubRepo, expectedSha).catch((e: Error) => {
      errors.push({ section: "github", error: e.message })
      return []
    }),
  ])
  if (!railway) errors.push({ section: "railway", error: "RAILWAY_READONLY_TOKEN missing; Railway planes skipped" })
  const revision = buildRevisionReport({ expected: expectedSha, deployments, frontendVersion, runs })
  return { revision, deployments, errors }
}

export async function takeSnapshot(deps: Deps, opts: SnapshotOptions): Promise<Snapshot> {
  const now = deps.now()
  const expectedSha = await resolveExpectedSha(deps, opts.sha)
  const { railway, db } = clients(deps)
  const errors: SectionError[] = []
  const { revision, deployments, errors: revErrors } = await takeRevision(deps, expectedSha)
  errors.push(...revErrors)

  const sinceIso =
    opts.since ?? revision.backendDeployedAt ?? new Date(now.getTime() - THRESHOLDS.minWindowMs).toISOString()
  const label = opts.since
    ? "since --since"
    : revision.backendDeployedAt
      ? "since backend deploy"
      : "last 30m (no deploy time)"
  const window = makeWindow(new Date(sinceIso), now, THRESHOLDS.minWindowMs, label)

  const guard = async <T>(section: string, enabled: boolean, run: () => Promise<T>): Promise<T | null> => {
    if (!enabled) return null
    try {
      return await run()
    } catch (e) {
      errors.push({ section, error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  const [liveness, pipelines, logs, resources] = await Promise.all([
    guard("liveness", opts.sections.has("liveness"), () =>
      probeLiveness({
        fetchImpl: deps.fetchImpl,
        creds: deps.creds,
        deployments: deployments ?? [],
        cacheBuster: String(now.getTime()),
      })
    ),
    guard("pipelines", opts.sections.has("pipelines"), async () => {
      if (!db) throw new Error("DB_READ_PROXY_URL/SECRET missing; pipelines skipped")
      return probePipelines(db, window)
    }),
    guard("logs", opts.sections.has("logs"), async () => {
      if (!railway) throw new Error("RAILWAY_READONLY_TOKEN missing; logs skipped")
      return probeLogs(railway, window)
    }),
    guard("resources", opts.sections.has("resources"), async () => {
      if (!railway) throw new Error("RAILWAY_READONLY_TOKEN missing; resources skipped")
      return probeResources(railway, window)
    }),
  ])

  const findings: Finding[] = [
    ...(opts.sections.has("revision") ? revision.findings : []),
    ...(liveness?.findings ?? []),
    ...(pipelines?.findings ?? []),
    ...(logs?.findings ?? []),
    ...(resources?.findings ?? []),
    ...errors.map((e) => ({ level: "warn" as Level, id: `error.${e.section}`, message: `${e.section}: ${e.error}` })),
  ]
  return {
    at: now.toISOString(),
    expectedSha,
    window,
    revision: opts.sections.has("revision") ? revision : null,
    liveness,
    pipelines,
    logs,
    resources,
    errors,
    findings,
    level: worst(findings.map((f) => f.level)),
  }
}
