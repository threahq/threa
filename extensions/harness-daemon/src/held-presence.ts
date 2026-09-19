import { readSessionPresence, type SessionPresenceSnapshot } from "@threahq/harness-client"
import { runtimeThreaTarget, type RuntimeTargetResolver } from "./spawners"
import { failureExcerpt, postThrea } from "./threa-http"
import type { ManagedAgent } from "./types"

/**
 * The capability that marks presence harnessd published on a session's behalf.
 *
 * The server gates this presence on freshness — harnessd re-posts it every
 * watch pass, so a supervisor that stopped takes the commands with it. Nothing
 * else re-posts on a timer, which is why the marker exists at all: the same
 * check over ordinary presence would hide a live session that has simply been
 * quiet for an hour.
 */
export const SUPERVISOR_HELD_CAPABILITY = "supervisorHeld"

export interface HeldPresenceDeps {
  read: (runtimeSessionId: string) => SessionPresenceSnapshot | undefined
  target: RuntimeTargetResolver
  post: typeof postThrea
  log: (message: string) => void
}

export function defaultHeldPresenceDeps(): HeldPresenceDeps {
  return { read: readSessionPresence, target: runtimeThreaTarget, post: postThrea, log: console.warn }
}

export type HeldPresenceStatus = "held" | "skipped" | "failed"

export interface HeldPresenceOutcome {
  agent: string
  runtimeSessionId?: string
  status: HeldPresenceStatus
  detail: string
}

/**
 * Presence for a session that is not running: available, taking invocations,
 * and advertising exactly what the session itself last advertised.
 *
 * No status text and no BIK. A user should not have to know their agent is
 * asleep, and the private key the session registered died with its process, so
 * a write on its behalf clears it rather than leaving the server wrapping
 * stream keys to a holder that no longer exists.
 */
export function heldPresenceBody(snapshot: SessionPresenceSnapshot): Record<string, unknown> {
  return {
    runtimeKind: snapshot.runtimeKind,
    instanceId: snapshot.instanceId,
    runtimeSessionId: snapshot.runtimeSessionId,
    ...(snapshot.displayName ? { displayName: snapshot.displayName } : {}),
    status: "available",
    acceptingInvocations: true,
    capabilities: { ...snapshot.capabilities, [SUPERVISOR_HELD_CAPABILITY]: true },
    ...(snapshot.manifest ? { manifest: snapshot.manifest } : {}),
  }
}

/**
 * Keep every wound-down session reachable, so nobody has to wake an agent to
 * reach its commands: the queued command is what wakes it.
 *
 * A row with no snapshot is skipped and said out loud, never invented
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
  const snapshot = deps.read(agent.runtimeSessionId)
  if (!snapshot) {
    return {
      agent: agent.name,
      runtimeSessionId: agent.runtimeSessionId,
      status: "skipped",
      detail: "no presence snapshot to replay",
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
