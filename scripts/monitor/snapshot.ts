import { PROD, THRESHOLDS } from "./config"
import { ReadProxyClient } from "./db"
import type { Credentials } from "./env"
import { remoteMainSha, runsForCommit, type ExecLike } from "./github"
import { timedFetch, type FetchLike } from "./http"
import { RailwayClient, type RailwayDeployment } from "./railway"
import { probeLiveness, type LivenessReport } from "./probes/liveness"
import { probeLogs, type LogReport } from "./probes/logs"
import { probePipelines, type PipelineReport } from "./probes/pipelines"
import { probeResources, type ResourceReport } from "./probes/resources"
import { buildRevisionReport, summarizeRailway, type RevisionReport } from "./probes/revision"
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

export type Section = "revision" | "liveness" | "pipelines" | "logs" | "resources"

export interface Snapshot {
  at: string
  /** null when the revision section was excluded (no git/GitHub lookups were made). */
  expectedSha: string | null
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
  /** ISO timestamp; undefined means "the newest SUCCESS backend deployment". */
  since?: string
  sections: Set<Section>
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

async function listDeployments(
  railway: RailwayClient | null,
  errors: SectionError[]
): Promise<RailwayDeployment[] | null> {
  if (!railway) {
    errors.push({ section: "railway", error: "RAILWAY_READONLY_TOKEN missing; Railway planes skipped" })
    return null
  }
  try {
    return await railway.listDeployments()
  } catch (error) {
    errors.push({ section: "railway", error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

/** Revision only: what `verify` polls. */
export async function takeRevision(
  deps: Deps,
  expectedSha: string
): Promise<{ revision: RevisionReport; deployments: RailwayDeployment[] | null; errors: SectionError[] }> {
  const { railway } = clients(deps)
  const errors: SectionError[] = []
  const cacheBuster = String(deps.now().getTime())
  const [deployments, frontendVersion, runs] = await Promise.all([
    listDeployments(railway, errors),
    fetchFrontendVersion(deps.fetchImpl, cacheBuster),
    runsForCommit(deps.exec, PROD.githubRepo, expectedSha).catch((error: Error) => {
      errors.push({ section: "github", error: error.message })
      return []
    }),
  ])
  const revision = buildRevisionReport({ expected: expectedSha, deployments, frontendVersion, runs })
  return { revision, deployments, errors }
}

export async function takeSnapshot(deps: Deps, opts: SnapshotOptions): Promise<Snapshot> {
  const now = deps.now()
  const { railway, db } = clients(deps)
  const errors: SectionError[] = []

  let expectedSha: string | null = null
  let revision: RevisionReport | null = null
  let deployments: RailwayDeployment[] | null = null
  if (opts.sections.has("revision")) {
    expectedSha = await resolveExpectedSha(deps, opts.sha)
    const taken = await takeRevision(deps, expectedSha)
    revision = taken.revision
    deployments = taken.deployments
    errors.push(...taken.errors)
  } else if (opts.sections.has("liveness") || !opts.since) {
    // Liveness needs the Railway hosts and the default baseline needs the backend deploy time.
    deployments = await listDeployments(railway, errors)
  }

  const backendDeployedAt =
    revision?.backendDeployedAt ?? summarizeRailway(deployments ?? []).get("backend")?.serving?.createdAt ?? null
  const sinceIso = opts.since ?? backendDeployedAt ?? new Date(now.getTime() - THRESHOLDS.minWindowMs).toISOString()
  const label = opts.since ? "since --since" : backendDeployedAt ? "since backend deploy" : "last 30m (no deploy time)"
  const window = makeWindow(new Date(sinceIso), now, THRESHOLDS.minWindowMs, label)

  const guard = async <T>(section: Section, run: () => Promise<T>): Promise<T | null> => {
    if (!opts.sections.has(section)) return null
    try {
      return await run()
    } catch (error) {
      errors.push({ section, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  const [liveness, pipelines, logs, resources] = await Promise.all([
    guard("liveness", () =>
      probeLiveness({
        fetchImpl: deps.fetchImpl,
        creds: deps.creds,
        deployments: deployments ?? [],
        cacheBuster: String(now.getTime()),
      })
    ),
    guard("pipelines", async () => {
      if (!db) throw new Error("DB_READ_PROXY_URL/SECRET missing; pipelines skipped")
      return probePipelines(db, window)
    }),
    guard("logs", async () => {
      if (!railway) throw new Error("RAILWAY_READONLY_TOKEN missing; logs skipped")
      return probeLogs(railway, window)
    }),
    guard("resources", async () => {
      if (!railway) throw new Error("RAILWAY_READONLY_TOKEN missing; resources skipped")
      return probeResources(railway, window)
    }),
  ])

  const findings: Finding[] = [
    ...(revision?.findings ?? []),
    ...(liveness?.findings ?? []),
    ...(pipelines?.findings ?? []),
    ...(logs?.findings ?? []),
    ...(resources?.findings ?? []),
    ...errors.map((sectionError) => ({
      level: "warn" as Level,
      id: `error.${sectionError.section}`,
      message: `${sectionError.section}: ${sectionError.error}`,
    })),
  ]
  return {
    at: now.toISOString(),
    expectedSha,
    window,
    revision,
    liveness,
    pipelines,
    logs,
    resources,
    errors,
    findings,
    level: worst(findings.map((finding) => finding.level)),
  }
}
