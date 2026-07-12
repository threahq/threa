import type { ManagedAgent } from "./types"

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
