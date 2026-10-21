import { heldPresenceBody } from "@threahq/harness-client"
import { runtimeThreaTarget, type RuntimeTargetResolver } from "./spawners"
import { failureExcerpt, postThrea } from "./threa-http"
import type { ManagedAgent } from "./types"

export interface HeldPresenceDeps {
  target: RuntimeTargetResolver
  post: typeof postThrea
  log: (message: string) => void
}

export function defaultHeldPresenceDeps(): HeldPresenceDeps {
  return { target: runtimeThreaTarget, post: postThrea, log: console.warn }
}

export type HeldPresenceStatus = "held" | "skipped" | "failed"

export interface HeldPresenceOutcome {
  agent: string
  runtimeSessionId?: string
  status: HeldPresenceStatus
  detail: string
}

/**
 * Keep every wound-down session reachable, so nobody has to wake an agent to
 * reach its commands: the queued command is what wakes it.
 *
 * The snapshot is the one `suspendAgent` copied onto the row before killing
 * the session. A row without one is skipped and said out loud, never invented
 * (INV-11) — presence assembled from the inventory would advertise a command
 * set harnessd made up. Reporting is change-only: the pass runs every minute,
 * and a line per suspended session per minute buries everything else.
 */
export function createHeldPresence(deps: HeldPresenceDeps = defaultHeldPresenceDeps()) {
  const reported = new Map<string, string>()
  return async function holdPresenceForSuspended(agents: ManagedAgent[]): Promise<HeldPresenceOutcome[]> {
    const outcomes: HeldPresenceOutcome[] = []
    for (const agent of agents) {
      if (agent.status !== "suspended" || agent.tombstonedAt) continue
      outcomes.push(await holdOne(agent, deps))
    }
    for (const outcome of outcomes) {
      const line = `${outcome.status}\t${outcome.detail}`
      if (reported.get(outcome.agent) === line) continue
      reported.set(outcome.agent, line)
      if (outcome.status !== "held") deps.log(`harnessd: holding presence for ${outcome.agent}: ${outcome.detail}`)
    }
    return outcomes
  }
}

async function holdOne(agent: ManagedAgent, deps: HeldPresenceDeps): Promise<HeldPresenceOutcome> {
  if (!agent.runtimeSessionId) return { agent: agent.name, status: "skipped", detail: "no runtime session recorded" }
  const snapshot = agent.heldPresence
  if (!snapshot) {
    return {
      agent: agent.name,
      runtimeSessionId: agent.runtimeSessionId,
      status: "skipped",
      detail: "no presence snapshot captured at suspend",
    }
  }
  const result: Omit<HeldPresenceOutcome, "status" | "detail"> = {
    agent: agent.name,
    runtimeSessionId: agent.runtimeSessionId,
  }
  try {
    const target = deps.target(agent.runtime, `hold presence for ${agent.name}`)
    const response = await deps.post(target, "/bot-runtime/presence", heldPresenceBody(snapshot))
    if (!response.ok) return { ...result, status: "failed", detail: await failureExcerpt(response) }
  } catch (error) {
    return { ...result, status: "failed", detail: error instanceof Error ? error.message : String(error) }
  }
  return { ...result, status: "held", detail: snapshot.instanceId }
}
