import { readHarnessLinks } from "@threa/harness-client"
import { hostname } from "node:os"
import { listLocalTmuxPanes, resolveManagedAgentPane, type ManagedAgentPane } from "./discovery"
import { readMintedIdentities } from "./identity-store"
import { readInventoryReadonly } from "./inventory"
import { latestAgentsByIdentity } from "./resume"
import { readThreaChannelConfig } from "./spawners"
import type { ManagedAgent } from "./types"

export interface VanishedPaneSweepDeps {
  inventory: () => ManagedAgent[]
  /** Pane status per agent id, resolved in one pass so tmux and the link ledger are read once. */
  paneStatuses: (agents: ManagedAgent[]) => Map<string, ManagedAgentPane["status"]>
}

export interface VanishedPaneSweep {
  /** The rows whose pane was present at the previous call and is missing now. */
  next(): ManagedAgent[]
}

export function defaultVanishedPaneSweepDeps(): VanishedPaneSweepDeps {
  return {
    inventory: readInventoryReadonly,
    paneStatuses: (agents) => {
      const panes = listLocalTmuxPanes()
      const config = readThreaChannelConfig()
      const host = hostname()
      const links = readHarnessLinks()
      const identities = readMintedIdentities()
      return new Map(
        agents.map((agent) => [
          agent.id,
          resolveManagedAgentPane(
            agent,
            panes,
            config,
            host,
            () => links,
            () => identities
          ).status,
        ])
      )
    },
  }
}

/**
 * Notices a managed runtime dying between watch passes. The watcher's other
 * triggers are all external — a supervisor socket reconnect, an unarchive —
 * so a session the kernel or an operator killed at 04:10 stayed dead until
 * one of those happened to fire (06:40 on 2026-09-02). Only present→missing
 * transitions count: the first call records the state the startup
 * reconciliation just produced, and a row the revive path then refuses
 * (archived, occupied, inaccessible) stays missing without being re-reported
 * every minute. Ambiguous and unverified panes count as present, the same
 * reading the revive path takes, because the alternative is a duplicate.
 */
export function createVanishedPaneSweep(
  deps: VanishedPaneSweepDeps = defaultVanishedPaneSweepDeps()
): VanishedPaneSweep {
  const present = new Map<string, boolean>()
  return {
    next() {
      const candidates = latestAgentsByIdentity(deps.inventory()).filter(
        (agent) => agent.status === "online" && Boolean(agent.scratchpadUrl)
      )
      const statuses = deps.paneStatuses(candidates)
      const vanished: ManagedAgent[] = []
      const seen = new Set<string>()
      for (const agent of candidates) {
        seen.add(agent.id)
        const alive = statuses.get(agent.id) !== "missing"
        if (present.get(agent.id) === true && !alive) vanished.push(agent)
        present.set(agent.id, alive)
      }
      for (const id of present.keys()) if (!seen.has(id)) present.delete(id)
      return vanished
    },
  }
}
