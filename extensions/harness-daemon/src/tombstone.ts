import { existsSync } from "node:fs"
import { readInventory, upsertAgent } from "./inventory"
import { fetchScratchpadStatus, parseScratchpadUrl, type ScratchpadStatus, probeSuppressed } from "./resume"
import type { ManagedAgent } from "./types"

export type TombstoneDisposition =
  | "tombstoned"
  | "kept worktree present"
  | "kept scratchpad active"
  | "kept scratchpad unreadable"
  | "already tombstoned"
  | "kept probe suppressed"

export interface TombstoneOutcome {
  /** The inventory row id: the only thing that identifies a row uniquely. */
  subject: string
  disposition: TombstoneDisposition
  detail?: string
}

export interface TombstoneDeps {
  inventory: () => ManagedAgent[]
  pathExists: (path: string) => boolean
  scratchpadStatus: (agent: ManagedAgent) => Promise<ScratchpadStatus>
  persist: (agent: ManagedAgent) => void
  now: () => Date
}

export function defaultTombstoneDeps(target: { baseUrl: string; workspaceId: string; apiKey: string }): TombstoneDeps {
  return {
    inventory: readInventory,
    pathExists: existsSync,
    scratchpadStatus: async (agent) => {
      const ref = agent.scratchpadUrl ? parseScratchpadUrl(agent.scratchpadUrl) : undefined
      if (!ref) return "unavailable"
      return fetchScratchpadStatus({
        ...target,
        workspaceId: ref.workspaceId ?? target.workspaceId,
        streamId: ref.streamId,
      })
    },
    persist: upsertAgent,
    now: () => new Date(),
  }
}

async function decide(agent: ManagedAgent, deps: TombstoneDeps, dryRun: boolean): Promise<TombstoneOutcome> {
  if (agent.tombstonedAt) {
    return { subject: agent.id, disposition: "already tombstoned", detail: agent.tombstonedAt }
  }
  if (agent.worktree && deps.pathExists(agent.worktree)) {
    return { subject: agent.id, disposition: "kept worktree present", detail: agent.worktree }
  }
  if (!agent.scratchpadUrl || !parseScratchpadUrl(agent.scratchpadUrl)) {
    return { subject: agent.id, disposition: "kept scratchpad unreadable", detail: "no scratchpad url" }
  }
  // Last, because everything above is local. The revive path already decided
  // this row is not worth asking about yet, and this pass probes the same
  // endpoint — re-asking hammers exactly the scratchpads the backoff protects,
  // and since a row is never deleted and an inaccessible one can never be
  // tombstoned, that set only ever grows.
  if (probeSuppressed(agent, deps.now().getTime())) {
    return { subject: agent.id, disposition: "kept probe suppressed", detail: agent.probeBackoffUntil }
  }
  const status = await deps.scratchpadStatus(agent)
  if (status === "active") return { subject: agent.id, disposition: "kept scratchpad active", detail: agent.name }
  // Kris's ruling: an inaccessible (403/404) scratchpad is never grounds — the
  // same rule the reaper follows. Losing sight of a scratchpad is not evidence
  // its session ended.
  if (status !== "archived") {
    return { subject: agent.id, disposition: "kept scratchpad unreadable", detail: status }
  }
  if (!dryRun) {
    const tombstonedAt = deps.now().toISOString()
    deps.persist({ ...agent, tombstonedAt, updatedAt: tombstonedAt })
  }
  return { subject: agent.id, disposition: "tombstoned", detail: agent.name }
}

/**
 * Retire the inventory rows that can never be revived again.
 *
 * Kris's ruling, binding: tombstone a row only when its worktree is gone AND its
 * scratchpad is archived. **Never delete history outright** — a tombstoned row
 * still reads back, still lists, and is still findable by its explicit id.
 *
 * This is inventory hygiene, NOT a safety bound — the plan claimed otherwise and
 * the claim does not survive contact with the code. What stops a newly visible
 * dormant row recreating a stale worktree is `reviveAgent`'s `status === "active"`
 * gate, which precedes `restoreWorktree`. A tombstone's precondition (worktree
 * gone AND scratchpad archived) is a strict SUBSET of that gate's refusal, so
 * every row this could retire is already refused. What it buys is an end to
 * re-probing rows that are provably dead.
 *
 * Every row gets a disposition — a keep is a reported reason, never a skipped
 * iteration (INV-11).
 */
export async function tombstoneAbandonedRows(deps: TombstoneDeps, dryRun: boolean): Promise<TombstoneOutcome[]> {
  const outcomes: TombstoneOutcome[] = []
  for (const agent of deps.inventory()) outcomes.push(await decide(agent, deps, dryRun))
  return outcomes
}

export function summarizeTombstones(outcomes: TombstoneOutcome[]): Array<[TombstoneDisposition, number]> {
  const counts = new Map<TombstoneDisposition, number>()
  for (const outcome of outcomes) counts.set(outcome.disposition, (counts.get(outcome.disposition) ?? 0) + 1)
  return [...counts.entries()]
}
