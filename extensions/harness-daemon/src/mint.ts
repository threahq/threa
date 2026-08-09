import { randomBytes } from "node:crypto"
import { readHarnessLinks, type HarnessLink } from "@threa/bot-runtime-client"
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
import { acquireProcessLock, resumeActiveLockPath } from "./lock"
import { DEFAULT_PROFILE, type Profile } from "./profiles"
import { CLAUDE_INSTANCE_ID_PREFIX, CLAUDE_RUNTIME_SESSION_ID_PREFIX } from "./spawners"

export interface MintRequest {
  worktree: string
  runtimeKind: string
  /**
   * Set by a spawn: refuse ANY live occupant, identified or not.
   *
   * The reuse rungs answer "what identity does this directory have", which is
   * right for a backfill and wrong for a launch — reusing an identified live
   * session's id starts a SECOND runtime under it, which is the duplicate-session
   * failure this whole effort exists to remove.
   */
  requireVacant?: boolean
  /** Ids declared in ~/.claude/threa-channel/config.json: recorded as the mint rather than generated. */
  declared?: { instanceId?: string; runtimeSessionId?: string }
  /** Snapshotted onto the record: a later edit to the profiles file must not change how this directory is reaped. */
  profile?: Profile
}

export interface MintDeps {
  identities: () => MintedIdentity[]
  links: () => HarnessLink[]
  panes: () => LocalTmuxPane[]
  claudeProcessesIn: (worktree: string) => number[]
  canonicalPath: (path: string) => string
  write: (record: MintedIdentity) => WriteMintedIdentityResult
  newSuffix: () => string
  now: () => Date
  warn: (message: string) => void
}

export type MintOutcome =
  | { status: "minted"; runtimeSessionId: string; instanceId: string; worktree: string }
  | { status: "reused"; runtimeSessionId: string; instanceId: string; worktree: string; source: string }
  | { status: "refused"; reason: string }

export function defaultMintDeps(): MintDeps {
  return {
    identities: readMintedIdentities,
    links: readHarnessLinks,
    panes: listLocalTmuxPanes,
    claudeProcessesIn: liveClaudePidsIn,
    canonicalPath: canonicalOrRaw,
    write: writeMintedIdentity,
    newSuffix: () => randomBytes(8).toString("hex"),
    now: () => new Date(),
    warn: (message) => console.warn(message),
  }
}

/**
 * An unidentified live Claude in the directory has no evidence in any store,
 * so nothing else can see it. Minting a new identity over it would hand the
 * reaper a worktree it believes is free and let it kill a live session.
 */
export type OccupancyDeps = Pick<MintDeps, "panes" | "claudeProcessesIn" | "canonicalPath" | "warn">

export function occupancyVeto(
  worktree: string,
  deps: OccupancyDeps,
  identifiedSessionIds: Set<string>,
  /**
   * Pids a caller has already tied to the identity it is about to record. The pid
   * arm cannot identify anyone by itself — `~/.claude/sessions` keys on Claude's
   * own session id, not a Threa one — so a caller that knows which pane owns the
   * directory supplies its `panePid`, the same equivalence the reaper uses. A
   * mint supplies none: it has no candidate id yet, so every live pid is a
   * stranger to it.
   */
  accountedPids: Set<number> = new Set()
): string | undefined {
  const pids = deps.claudeProcessesIn(worktree).filter((pid) => !accountedPids.has(pid))
  let panes: LocalTmuxPane[] = []
  let panesRead = true
  try {
    panes = deps
      .panes()
      .filter((pane) => deps.canonicalPath(pane.cwd) === worktree)
      .filter((pane) => {
        const launch = parseClaudeChannelLaunch(pane.startCommand)
        if (!launch) return false
        return !launch.runtimeSessionId || !identifiedSessionIds.has(launch.runtimeSessionId)
      })
  } catch {
    // `listLocalTmuxPanes` throws when there is no tmux server, which is the
    // ordinary state before the first spawn of a boot — and the mint now runs
    // before the session is created. Refusing there would block every cold
    // start; pretending the list was empty would be the silent no-op this whole
    // effort exists to remove. So the pid arm still decides, and the degraded
    // check is reported either way. It is the stronger arm regardless: it sees
    // a detached Claude that has no pane at all.
    panesRead = false
  }
  if (pids.length === 0 && panes.length === 0) {
    if (!panesRead) {
      deps.warn(`harnessd: could not list tmux panes; occupancy of ${worktree} checked by process table only`)
    }
    return undefined
  }
  const parts: string[] = []
  if (!panesRead) parts.push("tmux panes unreadable")
  if (pids.length > 0) parts.push(`pid ${pids.join(", ")}`)
  if (panes.length > 0) parts.push(`pane ${panes.map((pane) => pane.paneId).join(", ")}`)
  return `an unidentified live Claude occupies ${worktree} (${parts.join("; ")})`
}

function ambiguity(kind: string, worktree: string, claimants: Array<{ runtimeSessionId: string }>): string {
  return `${claimants.length} ${kind} name ${worktree}: ${claimants.map((c) => c.runtimeSessionId).join(", ")}`
}

function mintRuntimeIdentityUnlocked(request: MintRequest, deps: MintDeps): MintOutcome {
  const worktree = deps.canonicalPath(request.worktree)

  const records = deps.identities()
  if (request.requireVacant) {
    const occupied = occupancyVeto(worktree, deps, new Set())
    if (occupied) return { status: "refused", reason: occupied }
  }
  // Scoped to the requested kind: identity is per (directory, runtime kind), so
  // a Pi and a Claude coexist in one cwd. Another kind's record is neither
  // reusable — handing a Claude the live Pi's session id makes both pane
  // finders match it — nor grounds to refuse.
  const recorded = identityRecordsFor(worktree, records, deps.canonicalPath, request.runtimeKind)
  if (recorded.length === 1) {
    const record = recorded[0]!
    return {
      status: "reused",
      runtimeSessionId: record.runtimeSessionId,
      instanceId: record.instanceId,
      worktree,
      source: "store",
    }
  }
  // Minting a third id for a doubly-claimed directory is how it stops resolving
  // at all: every later lookup sees an ambiguous set, gives up, and falls back
  // to the hostname derivation this store exists to retire. The write side has
  // to refuse louder than the read side, not quieter.
  if (recorded.length > 1) {
    return { status: "refused", reason: ambiguity(`${request.runtimeKind} identity records`, worktree, recorded) }
  }

  // The link ledger only attests Claude channel sessions, so its rungs answer
  // nothing about any other kind's identity.
  const attestedAll = attestedRuntimes(deps.links())
  const attested = request.runtimeKind === "claude-code-channel" ? attestedAll : []
  const claimants = attested.filter((entry) => deps.canonicalPath(entry.worktree) === worktree)
  if (claimants.length > 1) {
    return { status: "refused", reason: ambiguity("harness link records", worktree, claimants) }
  }
  const ledger = ledgerIdentity(worktree, attested)
  if (ledger) {
    return {
      status: "reused",
      runtimeSessionId: ledger.runtimeSessionId,
      instanceId: ledger.instanceId,
      worktree,
      source: "ledger",
    }
  }

  // The occupancy exemption stays kind-blind: any store that identifies a live
  // pane's declared session means that pane is not a stranger.
  const identified = new Set([
    ...records.map((record) => record.runtimeSessionId),
    ...attestedAll.map((entry) => entry.runtimeSessionId),
  ])
  const veto = occupancyVeto(worktree, deps, identified)
  if (veto) return { status: "refused", reason: veto }

  const suffix = deps.newSuffix()
  const record: MintedIdentity = {
    runtimeSessionId: request.declared?.runtimeSessionId || `${CLAUDE_RUNTIME_SESSION_ID_PREFIX}-${suffix}`,
    instanceId: request.declared?.instanceId || `${CLAUDE_INSTANCE_ID_PREFIX}-${suffix}`,
    worktree,
    runtimeKind: request.runtimeKind,
    mintedAt: deps.now().toISOString(),
    source: "mint",
    profile: request.profile ?? DEFAULT_PROFILE,
  }
  const written = deps.write(record)
  if (written.status === "exists") {
    // A lost race is only a race when both writers meant the same directory.
    // A declared id in ~/.claude/threa-channel/config.json is reused by every
    // spawn, so without this the second worktree adopts an identity the store
    // records as living in the first one.
    if (deps.canonicalPath(written.existing.worktree) !== worktree) {
      return {
        status: "refused",
        reason: `${written.existing.runtimeSessionId} is already recorded for ${written.existing.worktree}, not ${worktree}`,
      }
    }
    return {
      status: "reused",
      runtimeSessionId: written.existing.runtimeSessionId,
      instanceId: written.existing.instanceId,
      worktree: written.existing.worktree,
      source: "store",
    }
  }
  if (written.status === "refused") return { status: "refused", reason: written.reason }
  return {
    status: "minted",
    runtimeSessionId: written.record.runtimeSessionId,
    instanceId: written.record.instanceId,
    worktree,
  }
}

/** Serialized against revive and reap: a mint must not race either. */
export async function mintRuntimeIdentity(
  request: MintRequest,
  deps: MintDeps = defaultMintDeps()
): Promise<MintOutcome> {
  const release = await acquireProcessLock(resumeActiveLockPath())
  try {
    return mintRuntimeIdentityUnlocked(request, deps)
  } finally {
    release()
  }
}
