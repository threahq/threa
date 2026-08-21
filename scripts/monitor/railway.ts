import type { FetchLike } from "./http"

const ENDPOINT = "https://backboard.railway.com/graphql/v2"

export interface RailwayDeployment {
  id: string
  status: string
  createdAt: string
  staticUrl: string | null
  service: string
  sha: string | null
  commitMessage: string | null
  skippedReason: string | null
}

export interface RailwayLogLine {
  timestamp: string
  severity: string
  message: string
  service: string | null
  attributes: Record<string, string>
}

export interface RailwayMetricSeries {
  measurement: string
  serviceId: string | null
  values: Array<{ ts: number; value: number }>
}

export class RailwayClient {
  private scope: { projectId: string; environmentId: string } | null = null
  private serviceNames: Map<string, string> | null = null

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike
  ) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Project-Access-Token": this.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`railway ${res.status}: ${text.slice(0, 300)}`)
    let json: { data?: T; errors?: Array<{ message: string }> }
    try {
      json = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> }
    } catch {
      throw new Error(`railway ${res.status}: non-JSON body ${text.slice(0, 200)}`)
    }
    if (json.errors?.length) throw new Error(`railway: ${json.errors.map((e) => e.message).join("; ")}`)
    if (!json.data) throw new Error(`railway: empty response (${res.status})`)
    return json.data
  }

  async getScope(): Promise<{ projectId: string; environmentId: string }> {
    if (this.scope) return this.scope
    const data = await this.query<{ projectToken: { projectId: string; environmentId: string } }>(
      "query { projectToken { projectId environmentId } }"
    )
    this.scope = data.projectToken
    return this.scope
  }

  /** serviceId → name, for resolving log/metric tags. */
  async getServiceNames(): Promise<Map<string, string>> {
    if (this.serviceNames) return this.serviceNames
    const { projectId } = await this.getScope()
    const data = await this.query<{ project: { services: { edges: Array<{ node: { id: string; name: string } }> } } }>(
      "query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }",
      { id: projectId }
    )
    this.serviceNames = new Map(data.project.services.edges.map((e) => [e.node.id, e.node.name]))
    return this.serviceNames
  }

  async listDeployments(first = 30): Promise<RailwayDeployment[]> {
    const { projectId, environmentId } = await this.getScope()
    const data = await this.query<{
      deployments: {
        edges: Array<{
          node: {
            id: string
            status: string
            createdAt: string
            staticUrl: string | null
            service: { name: string }
            meta: Record<string, unknown> | null
          }
        }>
      }
    }>(
      `query($pid: String!, $envId: String!, $first: Int!) {
        deployments(input: { projectId: $pid, environmentId: $envId }, first: $first) {
          edges { node { id status createdAt staticUrl service { name } meta } }
        }
      }`,
      { pid: projectId, envId: environmentId, first }
    )
    return data.deployments.edges.map(({ node }) => ({
      id: node.id,
      status: node.status,
      createdAt: node.createdAt,
      staticUrl: node.staticUrl,
      service: node.service.name,
      sha: typeof node.meta?.commitHash === "string" ? node.meta.commitHash : null,
      commitMessage: typeof node.meta?.commitMessage === "string" ? node.meta.commitMessage : null,
      skippedReason: typeof node.meta?.skippedReason === "string" ? node.meta.skippedReason : null,
    }))
  }

  /**
   * Logs across all deployments of the environment, oldest-first. Railway pads the result
   * with ~100 lines from before `after` unless `beforeLimit: 0` is sent, and `beforeDate`
   * is not a strict bound either, so the window is also enforced client-side.
   */
  async environmentLogs(params: {
    filter: string
    after: string
    before?: string
    limit: number
  }): Promise<RailwayLogLine[]> {
    const { environmentId } = await this.getScope()
    const names = await this.getServiceNames()
    const data = await this.query<{
      environmentLogs: Array<{
        timestamp: string
        severity: string
        message: string
        attributes: Array<{ key: string; value: string }>
        tags: { serviceId: string | null } | null
      }>
    }>(
      `query($envId: String!, $filter: String, $after: String, $before: String, $n: Int) {
        environmentLogs(environmentId: $envId, filter: $filter, afterDate: $after, beforeDate: $before, afterLimit: $n, beforeLimit: 0) {
          timestamp severity message attributes { key value } tags { serviceId }
        }
      }`,
      {
        envId: environmentId,
        filter: params.filter,
        after: params.after,
        before: params.before ?? null,
        n: params.limit,
      }
    )
    return data.environmentLogs
      .filter((l) => l.timestamp >= params.after && (!params.before || l.timestamp < params.before))
      .map((l) => ({
        timestamp: l.timestamp,
        severity: l.severity,
        message: l.message,
        service: l.tags?.serviceId ? (names.get(l.tags.serviceId) ?? l.tags.serviceId) : null,
        attributes: Object.fromEntries(l.attributes.map((a) => [a.key, a.value])),
      }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  async metrics(params: { start: string; measurements: string[] }): Promise<RailwayMetricSeries[]> {
    const { environmentId } = await this.getScope()
    const data = await this.query<{
      metrics: Array<{
        measurement: string
        tags: { serviceId: string | null }
        values: Array<{ ts: number; value: number }>
      }>
    }>(
      `query($envId: String!, $start: DateTime!, $measurements: [MetricMeasurement!]!) {
        metrics(environmentId: $envId, startDate: $start, groupBy: [SERVICE_ID], measurements: $measurements) {
          measurement tags { serviceId } values { ts value }
        }
      }`,
      { envId: environmentId, start: params.start, measurements: params.measurements }
    )
    return data.metrics.map((m) => ({ measurement: m.measurement, serviceId: m.tags.serviceId, values: m.values }))
  }
}
