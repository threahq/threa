import { existsSync } from "node:fs"
import { isSafeSessionFileName, readHarnessLinks, type HarnessLink } from "@threa/bot-runtime-client"
import { liveClaudePidsIn } from "./claude-registry"
import {
  attestedRuntimes,
  canonicalOrRaw,
  ledgerIdentity,
  listLocalTmuxPanes,
  parseClaudeChannelLaunch,
  type LocalTmuxPane,
} from "./discovery"
import {
  identityRecordsFor,
  readMintedIdentities,
  writeMintedIdentity,
  type MintedIdentity,
  type WriteMintedIdentityResult,
} from "./identity-store"
import { readInventoryReadonly } from "./inventory"
import { occupancyVeto } from "./mint"
import type { ManagedAgent } from "./types"

export type BackfillDisposition =
  | "recorded"
  | "already recorded"
  | "refused single source"
  | "refused occupied"
  | "refused conflicting"
  | "refused worktree missing"
  | "refused no instance id"
  | "refused unsafe id"

export interface BackfillOutcome {
  /** The canonical worktree: the key every store agrees on. */
  subject: string
  disposition: BackfillDisposition
  detail?: string
}

export interface BackfillDeps {
  identities: () => MintedIdentity[]
  links: () => HarnessLink[]
  panes: () => LocalTmuxPane[]
  inventory: () => ManagedAgent[]
  claudeProcessesIn: (worktree: string) => number[]
  canonicalPath: (path: string) => string
  pathExists: (path: string) => boolean
  write: (record: MintedIdentity) => WriteMintedIdentityResult
  now: () => Date
  log: (message: string) => void
}

export function defaultBackfillDeps(): BackfillDeps {
  return {
    identities: readMintedIdentities,
    links: readHarnessLinks,
    panes: listLocalTmuxPanes,
    inventory: readInventoryReadonly,
    claudeProcessesIn: liveClaudePidsIn,
    canonicalPath: canonicalOrRaw,
    pathExists: existsSync,
    write: writeMintedIdentity,
    now: () => new Date(),
    log: (message) => console.warn(message),
  }
}

type Attestor = "ledger" | "launch" | "inventory"

interface Evidence {
  attestor: Attestor
  runtimeSessionId: string
  instanceId?: string
  /** Set only by the launch attestor: the live process this evidence came from. */
  panePid?: number
}

/** ledger over launch over inventory: the inventory row is immutable per launch and stale by construction. */
const ATTESTOR_RANK: Attestor[] = ["ledger", "launch", "inventory"]

/** Memoized including the throw: `listLocalTmuxPanes` raises when there is no tmux server, and every subject must see that same answer. */
function once<T>(read: () => T): () => T {
  let value: T
  let thrown: unknown
  let done = false
  return () => {
    if (!done) {
      try {
        value = read()
      } catch (error) {
        thrown = error
      }
      done = true
    }
    if (thrown !== undefined) throw thrown
    return value
  }
}

function subjectsOf(agents: ManagedAgent[], canonical: (path: string) => string): Map<string, ManagedAgent[]> {
  const subjects = new Map<string, ManagedAgent[]>()
  for (const agent of agents) {
    if (agent.runtime !== "claude" || !agent.worktree) continue
    const worktree = canonical(agent.worktree)
    const rows = subjects.get(worktree)
    if (rows) rows.push(agent)
    else subjects.set(worktree, [agent])
  }
  return subjects
}

function launchEvidence(worktree: string, deps: BackfillDeps): Evidence[] {
  let panes: LocalTmuxPane[]
  try {
    panes = deps.panes()
  } catch {
    // No tmux server is the ordinary state on a cold boot. A missing rung is a
    // missing rung, never a corroboration: the subject falls to single source.
    return []
  }
  const evidence: Evidence[] = []
  for (const pane of panes) {
    if (deps.canonicalPath(pane.cwd) !== worktree) continue
    const launch = parseClaudeChannelLaunch(pane.startCommand)
    if (!launch?.runtimeSessionId) continue
    evidence.push({
      attestor: "launch",
      runtimeSessionId: launch.runtimeSessionId,
      instanceId: launch.instanceId,
      panePid: pane.panePid,
    })
  }
  return evidence
}

function decide(
  worktree: string,
  rows: ManagedAgent[],
  deps: BackfillDeps,
  dryRun: boolean,
  claimed: Map<string, string>
): BackfillOutcome {
  const records = deps.identities()
  const recorded = identityRecordsFor(worktree, records, deps.canonicalPath)
  const attested = attestedRuntimes(deps.links(), deps.canonicalPath)

  if (!deps.pathExists(worktree)) {
    return { subject: worktree, disposition: "refused worktree missing", detail: worktree }
  }

  const evidence: Evidence[] = []
  const ledger = ledgerIdentity(worktree, attested, deps.canonicalPath)
  if (ledger) {
    evidence.push({ attestor: "ledger", runtimeSessionId: ledger.runtimeSessionId, instanceId: ledger.instanceId })
  }
  evidence.push(...launchEvidence(worktree, deps))
  for (const row of rows) {
    if (row.runtimeSessionId) {
      evidence.push({ attestor: "inventory", runtimeSessionId: row.runtimeSessionId, instanceId: row.instanceId })
    }
  }

  const ids = new Set<string>([
    ...evidence.map((item) => item.runtimeSessionId),
    ...recorded.map((record) => record.runtimeSessionId),
    ...attested.filter((entry) => entry.worktree === worktree).map((entry) => entry.runtimeSessionId),
  ])
  if (ids.size > 1) {
    return {
      subject: worktree,
      disposition: "refused conflicting",
      detail: `sources disagree on ${worktree}: ${[...ids].sort().join(", ")}`,
    }
  }

  if (recorded.length > 0) {
    return { subject: worktree, disposition: "already recorded", detail: recorded[0]!.runtimeSessionId }
  }

  const attestors = new Set(evidence.map((item) => item.attestor))
  if (attestors.size < 2) {
    return {
      subject: worktree,
      disposition: "refused single source",
      detail: attestors.size === 0 ? "no source attests an identity" : `only the ${[...attestors][0]} attests it`,
    }
  }

  const identified = new Set([
    ...records.map((record) => record.runtimeSessionId),
    ...attested.map((entry) => entry.runtimeSessionId),
    ...ids,
  ])
  // A live Claude whose own launch declares the identity being recorded is not
  // an unidentified occupant — it is the session this evidence came from.
  const accounted = new Set(
    evidence.filter((item) => item.panePid !== undefined && ids.has(item.runtimeSessionId)).map((item) => item.panePid!)
  )
  const veto = occupancyVeto(worktree, { ...deps, warn: deps.log }, identified, accounted)
  if (veto) return { subject: worktree, disposition: "refused occupied", detail: veto }

  const winner = evidence.sort((a, b) => ATTESTOR_RANK.indexOf(a.attestor) - ATTESTOR_RANK.indexOf(b.attestor))[0]!
  const instanceId = winner.instanceId ?? evidence.find((item) => item.instanceId)?.instanceId
  if (!instanceId) {
    return { subject: worktree, disposition: "refused no instance id", detail: winner.runtimeSessionId }
  }
  if (!isSafeSessionFileName(winner.runtimeSessionId)) {
    return {
      subject: worktree,
      disposition: "refused unsafe id",
      detail: `unsafe runtime session id: ${JSON.stringify(winner.runtimeSessionId)}`,
    }
  }

  // Decided BEFORE the write, and against ids claimed earlier in this same pass,
  // so a dry run reaches the identical branch. Leaving it to the write's EEXIST
  // reports `recorded` in a preview that then refuses.
  const priorWorktree =
    claimed.get(winner.runtimeSessionId) ??
    records.find((record) => record.runtimeSessionId === winner.runtimeSessionId)?.worktree
  if (priorWorktree !== undefined && deps.canonicalPath(priorWorktree) !== worktree) {
    return {
      subject: worktree,
      disposition: "refused conflicting",
      detail: `${winner.runtimeSessionId} is already recorded for ${priorWorktree}, not ${worktree}`,
    }
  }
  claimed.set(winner.runtimeSessionId, worktree)

  if (dryRun) {
    return { subject: worktree, disposition: "recorded", detail: `${winner.runtimeSessionId} via ${winner.attestor}` }
  }
  const written = deps.write({
    runtimeSessionId: winner.runtimeSessionId,
    instanceId,
    worktree,
    runtimeKind: "claude-code-channel",
    mintedAt: deps.now().toISOString(),
    source: "backfill",
    attestedBy: winner.attestor,
  })
  if (written.status === "created") {
    return { subject: worktree, disposition: "recorded", detail: `${winner.runtimeSessionId} via ${winner.attestor}` }
  }
  if (written.status === "exists") {
    return deps.canonicalPath(written.existing.worktree) === worktree
      ? { subject: worktree, disposition: "already recorded", detail: written.existing.runtimeSessionId }
      : {
          subject: worktree,
          disposition: "refused conflicting",
          detail: `${written.existing.runtimeSessionId} is already recorded for ${written.existing.worktree}, not ${worktree}`,
        }
  }
  return { subject: worktree, disposition: "refused unsafe id", detail: written.reason }
}

/**
 * Write down the identity every store already agrees on, so a session stops
 * depending on `deriveClaudeRuntimeIdentity` — which hashes `os.hostname()` and
 * changes with the wifi network.
 *
 * Two independent sources must agree before anything is written: a lone
 * inventory row is reported as `refused single source`, never recorded. Every
 * subject appears in the returned list with a disposition — a refusal is a
 * reported reason, never a skipped iteration, because a backfill that silently
 * does nothing looks exactly like one that worked (INV-11).
 *
 * The identity store is the only write target. The reaper reads `links/`, so a
 * link record minted here is how a backfill bug becomes a deleted worktree.
 */
export function backfillIdentities(deps: BackfillDeps, dryRun: boolean): BackfillOutcome[] {
  // Read once per pass, not once per subject. Nothing in this pass writes a link
  // record or a pane, and at fleet scale the per-subject reads meant one `tmux
  // list-panes` per subject in `launchEvidence` and a second inside the veto —
  // all of it while the startup path holds the shared lock. `identities` stays
  // per-subject: the wet run's own writes have to be visible to later subjects.
  const passDeps: BackfillDeps = { ...deps, links: once(deps.links), panes: once(deps.panes) }
  const subjects = subjectsOf(deps.inventory(), deps.canonicalPath)
  // Ids claimed earlier in THIS pass: without it a dry run and a wet run diverge
  // whenever two subjects resolve to one id.
  const claimed = new Map<string, string>()
  return [...subjects].map(([worktree, rows]) => decide(worktree, rows, passDeps, dryRun, claimed))
}

export function summarizeBackfill(outcomes: BackfillOutcome[]): Array<[BackfillDisposition, number]> {
  const counts = new Map<BackfillDisposition, number>()
  for (const outcome of outcomes) counts.set(outcome.disposition, (counts.get(outcome.disposition) ?? 0) + 1)
  return [...counts.entries()]
}
