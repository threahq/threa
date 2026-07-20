import type { ManagedAgent } from "./types"
import { inaccessibleBackoffMs } from "./watch"

export interface ScratchpadRef {
  baseUrl: string
  workspaceId?: string
  streamId: string
}

export function parseScratchpadUrl(value: string): ScratchpadRef | undefined {
  try {
    const url = new URL(value)
    const streamId = url.pathname.match(/\/(?:streams|s)\/(stream_[A-Za-z0-9]+)(?:\/|$)/)?.[1]
    if (!streamId) return undefined
    return {
      baseUrl: url.origin,
      workspaceId: url.pathname.match(/\/w\/(ws_[A-Za-z0-9]+)(?:\/|$)/)?.[1],
      streamId,
    }
  } catch {
    return undefined
  }
}

/** An inventory row is immutable per launch, so resume only the newest launch for each name. */
export function latestAgents(agents: ManagedAgent[]): ManagedAgent[] {
  const byName = new Map<string, ManagedAgent>()
  for (const agent of agents) {
    const existing = byName.get(agent.name)
    if (!existing || agent.updatedAt > existing.updatedAt) byName.set(agent.name, agent)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function recordedNoYolo(agent: ManagedAgent): boolean {
  return agent.command.includes("--no-yolo")
}

/** An unparseable stored instant must not suppress forever, so it reads as due. */
export function probeSuppressed(agent: ManagedAgent, nowMs: number): boolean {
  if (!agent.probeBackoffUntil) return false
  const until = Date.parse(agent.probeBackoffUntil)
  return Number.isFinite(until) && until > nowMs
}

export function withProbeBackoff(
  agent: ManagedAgent,
  params: { intervalMs: number; nowMs: number; random?: () => number }
): ManagedAgent {
  const probeFailures = (agent.probeFailures ?? 0) + 1
  const delayMs = inaccessibleBackoffMs(params.intervalMs, probeFailures, params.random)
  return {
    ...agent,
    probeFailures,
    probeBackoffUntil: new Date(params.nowMs + delayMs).toISOString(),
    updatedAt: new Date(params.nowMs).toISOString(),
  }
}

/** Undefined when there is nothing recorded, so a healthy row is never rewritten every pass. */
export function withoutProbeBackoff(agent: ManagedAgent, nowMs: number): ManagedAgent | undefined {
  if (agent.probeFailures === undefined && agent.probeBackoffUntil === undefined) return undefined
  return { ...agent, probeFailures: undefined, probeBackoffUntil: undefined, updatedAt: new Date(nowMs).toISOString() }
}

export type ScratchpadStatus = "active" | "archived" | "inaccessible" | "unavailable"

export async function fetchScratchpadStatus(
  params: {
    baseUrl: string
    workspaceId: string
    apiKey: string
    streamId: string
  },
  sleep: (ms: number) => Promise<void> = Bun.sleep
): Promise<ScratchpadStatus> {
  // A full `up` pass probes every inventory row; retrying through 429s keeps
  // one rate-limit blip from aborting the whole sweep as "unavailable".
  for (let attempt = 0; ; attempt += 1) {
    const status = await fetchScratchpadStatusOnce(params)
    if (typeof status === "string") return status
    if (attempt >= 2) return "unavailable"
    await sleep(status.rateLimitedForMs || 2_000 * (attempt + 1))
  }
}

async function fetchScratchpadStatusOnce(params: {
  baseUrl: string
  workspaceId: string
  apiKey: string
  streamId: string
}): Promise<ScratchpadStatus | { rateLimitedForMs: number }> {
  try {
    const response = await fetch(
      `${params.baseUrl.replace(/\/$/, "")}/api/v1/workspaces/${params.workspaceId}/streams/${params.streamId}`,
      { headers: { authorization: `Bearer ${params.apiKey}` }, signal: AbortSignal.timeout(10_000) }
    )
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"))
      return {
        rateLimitedForMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 0,
      }
    }
    if (response.status === 403 || response.status === 404) return "inaccessible"
    if (!response.ok) return response.status >= 500 ? "unavailable" : "inaccessible"
    const json = (await response.json()) as { data?: { archivedAt?: string | null } }
    if (!json.data || typeof json.data !== "object") return "inaccessible"
    return json.data.archivedAt ? "archived" : "active"
  } catch {
    return "unavailable"
  }
}

export type RuntimePreflightResult =
  | { status: "linked"; rootStreamId: string }
  | { status: "archived" | "inaccessible" | "unavailable"; reason: string }
  | { status: "mismatch"; rootStreamId: string; expectedRootStreamId: string }

export async function preflightRuntimeSession(params: {
  baseUrl: string
  workspaceId: string
  apiKey: string
  runtimeKind: "claude-code-channel" | "pi-local"
  instanceId: string
  runtimeSessionId: string
  displayName: string
  localCwd: string
  expectedRootStreamId: string
  labelName?: string
}): Promise<RuntimePreflightResult> {
  try {
    const response = await fetch(
      `${params.baseUrl.replace(/\/$/, "")}/api/v1/workspaces/${params.workspaceId}/bot-runtime/sessions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${params.apiKey}` },
        body: JSON.stringify({
          runtimeKind: params.runtimeKind,
          instanceId: params.instanceId,
          runtimeSessionId: params.runtimeSessionId,
          displayName: params.displayName,
          localCwd: params.localCwd,
          ...(params.labelName ? { labelName: params.labelName } : {}),
          ifArchived: "wait",
          ifMissing: "error",
        }),
        signal: AbortSignal.timeout(10_000),
      }
    )
    if (response.status === 409) {
      const json = (await response.json().catch(() => ({}))) as { code?: string }
      return json.code === "SCRATCHPAD_ARCHIVED"
        ? { status: "archived", reason: "linked scratchpad is archived" }
        : { status: "inaccessible", reason: json.code ?? "session preflight returned 409" }
    }
    if (response.status === 403 || response.status === 404) {
      return { status: "inaccessible", reason: `session preflight returned ${response.status}` }
    }
    if (!response.ok) {
      const reason = `session preflight returned ${response.status}`
      return response.status === 429 || response.status >= 500
        ? { status: "unavailable", reason }
        : { status: "inaccessible", reason }
    }
    const json = (await response.json()) as { data?: { rootStreamId?: string } }
    const rootStreamId = json.data?.rootStreamId
    if (!rootStreamId) return { status: "inaccessible", reason: "session preflight returned no root stream" }
    if (rootStreamId !== params.expectedRootStreamId) {
      return { status: "mismatch", rootStreamId, expectedRootStreamId: params.expectedRootStreamId }
    }
    return { status: "linked", rootStreamId }
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  }
}
