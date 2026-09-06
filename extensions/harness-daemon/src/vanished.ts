import { readHarnessLinks } from "@threahq/harness-client"
import { hostname } from "node:os"
import { listLocalTmuxPanes, resolveManagedAgentPane, type LocalTmuxPane, type ManagedAgentPane } from "./discovery"
import { readMintedIdentities } from "./identity-store"
import { readInventoryReadonly } from "./inventory"
import { latestAgentsByIdentity } from "./resume"
import { readThreaChannelConfig } from "./spawners"
import type { ManagedAgent } from "./types"

export interface VanishedPaneSweepDeps {
  inventory: () => ManagedAgent[]
  /** Pane per agent id, resolved in one pass so tmux and the link ledger are read once. */
  panes: (agents: ManagedAgent[]) => Map<string, ManagedAgentPane>
}

export interface VanishedPaneSweepPass {
  /** Rows whose pane was present at the previous call and is missing now, with the pane last verified as theirs. */
  vanished: Array<{ agent: ManagedAgent; lastPane?: LocalTmuxPane }>
  /** Rows whose pane is present and verified as theirs. */
  live: Array<{ agent: ManagedAgent; pane: LocalTmuxPane }>
}

export interface VanishedPaneSweep {
  next(): VanishedPaneSweepPass
}

export function defaultVanishedPaneSweepDeps(): VanishedPaneSweepDeps {
  return {
    inventory: readInventoryReadonly,
    panes: (agents) => {
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
          ),
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
  const lastPane = new Map<string, LocalTmuxPane>()
  return {
    next() {
      const candidates = latestAgentsByIdentity(deps.inventory()).filter(
        (agent) => agent.status === "online" && Boolean(agent.scratchpadUrl)
      )
      const panes = deps.panes(candidates)
      const pass: VanishedPaneSweepPass = { vanished: [], live: [] }
      const seen = new Set<string>()
      for (const agent of candidates) {
        seen.add(agent.id)
        const resolved = panes.get(agent.id)
        const alive = resolved?.status !== "missing"
        if (present.get(agent.id) === true && !alive) pass.vanished.push({ agent, lastPane: lastPane.get(agent.id) })
        present.set(agent.id, alive)
        if (resolved?.status === "found") {
          lastPane.set(agent.id, resolved.pane)
          pass.live.push({ agent, pane: resolved.pane })
        }
      }
      for (const id of present.keys()) if (!seen.has(id)) present.delete(id)
      for (const id of lastPane.keys()) if (!seen.has(id)) lastPane.delete(id)
      return pass
    },
  }
}
