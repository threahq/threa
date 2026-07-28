import { hostname } from "node:os"
import { readHarnessLinks, type HarnessLink } from "@threa/bot-runtime-client"
import {
  attestedRuntimes,
  ledgerRuntimeSessionId,
  listLocalTmuxPanes,
  parseClaudeChannelLaunch,
  parsePiLaunch,
  resolveManagedAgentPane,
  type LocalTmuxPane,
} from "./discovery"
import { die } from "./errors"
import { findAgentOrUndefined, readInventoryReadonly } from "./inventory"
import { deriveClaudeRuntimeIdentity, readThreaChannelConfig } from "./spawners"
import type { ManagedAgent, ThreaChannelConfig } from "./types"

const NONE = "-"

export interface IdentityRow {
  kind: "row" | "pane"
  name: string
  recorded: string
  ledger: string
  derived: string
  pane: string
  verdict: string
}

export interface IdentityInputs {
  agents: ManagedAgent[]
  panes: LocalTmuxPane[]
  links: HarnessLink[]
  config?: ThreaChannelConfig
  host?: string
  includeUnmanagedPanes?: boolean
}

export interface IdentitySummary {
  total: number
  counts: Array<[string, number]>
}

export interface IdentityConsistency {
  inventoryRows: number
  linkRecords: number
  livePanes: number
}

/**
 * `drifted` is orthogonal to the resolution status: the row that preceded the
 * 2026-07-28 duplicate storm resolved fine and still carried an identity today's
 * derivation no longer reproduces, so both have to be printed.
 */
export function identityVerdict(status: string, recorded: string, derived: string): string {
  const drifted = recorded !== NONE && derived !== NONE && recorded !== derived
  return drifted ? `${status},drifted` : status
}

export function buildIdentityRows(inputs: IdentityInputs): IdentityRow[] {
  const config = inputs.config ?? {}
  const host = inputs.host ?? hostname()
  const attested = attestedRuntimes(inputs.links)
  const links = () => inputs.links
  const rows: IdentityRow[] = []
  const claimedPanes = new Set<string>()

  for (const agent of inputs.agents) {
    const resolved = resolveManagedAgentPane(agent, inputs.panes, config, host, links)
    const paneId = "pane" in resolved ? resolved.pane.paneId : NONE
    if (paneId !== NONE) claimedPanes.add(paneId)
    const recorded = agent.runtimeSessionId ?? NONE
    const ledger = agent.worktree ? (ledgerRuntimeSessionId(agent.worktree, attested) ?? NONE) : NONE
    const derived =
      agent.runtime === "claude" && agent.worktree
        ? deriveClaudeRuntimeIdentity(agent.worktree, config, host).runtimeSessionId
        : NONE
    rows.push({
      kind: "row",
      name: agent.name,
      recorded,
      ledger,
      derived,
      pane: paneId,
      verdict: identityVerdict(resolved.status, recorded, derived),
    })
  }

  if (inputs.includeUnmanagedPanes === false) return rows

  for (const pane of inputs.panes) {
    if (claimedPanes.has(pane.paneId)) continue
    const pi = parsePiLaunch(pane.startCommand)
    if (pi) {
      rows.push({
        kind: "pane",
        name: pane.windowName,
        recorded: pi.sessionId,
        ledger: NONE,
        derived: NONE,
        pane: pane.paneId,
        verdict: identityVerdict("found", pi.sessionId, NONE),
      })
      continue
    }
    const launch = parseClaudeChannelLaunch(pane.startCommand)
    if (!launch) continue
    const recorded = launch.runtimeSessionId ?? NONE
    const ledger = ledgerRuntimeSessionId(pane.cwd, attested) ?? NONE
    const derived = deriveClaudeRuntimeIdentity(pane.cwd, config, host).runtimeSessionId
    rows.push({
      kind: "pane",
      name: pane.windowName,
      recorded,
      ledger,
      derived,
      pane: pane.paneId,
      verdict: identityVerdict("found", recorded, derived),
    })
  }

  return rows
}

export function summarizeIdentityRows(rows: IdentityRow[]): IdentitySummary {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1)
  return { total: rows.length, counts: [...counts.entries()] }
}

export function identityConsistency(
  inputs: {
    agents?: ManagedAgent[]
    panes?: LocalTmuxPane[]
    links?: HarnessLink[]
    config?: ThreaChannelConfig
    host?: string
  } = {}
): IdentityConsistency {
  const agents = inputs.agents ?? readInventoryReadonly()
  const panes = inputs.panes ?? []
  const links = inputs.links ?? readHarnessLinks()
  const config = inputs.config ?? {}
  const host = inputs.host ?? hostname()
  const derived = (cwd: string) => deriveClaudeRuntimeIdentity(cwd, config, host).runtimeSessionId

  const inventoryRows = agents.filter(
    (agent) =>
      agent.runtime === "claude" &&
      Boolean(agent.worktree) &&
      Boolean(agent.runtimeSessionId) &&
      derived(agent.worktree!) !== agent.runtimeSessionId
  ).length
  const linkRecords = links.filter(
    (link) =>
      (link.runtimeKind === "claude-code-channel" || link.runtimeKind === "unknown") &&
      derived(link.worktree) !== link.runtimeSessionId
  ).length
  const livePanes = panes.filter((pane) => {
    const declared = parseClaudeChannelLaunch(pane.startCommand)?.runtimeSessionId
    return Boolean(declared) && derived(pane.cwd) !== declared
  }).length

  return { inventoryRows, linkRecords, livePanes }
}

export function resolveIdentity(ref?: string): void {
  const inventory = readInventoryReadonly()
  // A ref that names no inventory row may still name a live unmanaged pane —
  // the usage string advertises a runtime session id, and `resolve` is how you
  // find a cold-takeover candidate in the first place.
  const managed = ref ? findAgentOrUndefined(ref, inventory) : undefined
  const rows = buildIdentityRows({
    agents: ref ? (managed ? [managed] : []) : inventory,
    panes: listLocalTmuxPanes(),
    links: readHarnessLinks(),
    config: readThreaChannelConfig(),
    includeUnmanagedPanes: !managed,
  }).filter((row) => !ref || managed || row.recorded === ref)
  if (ref && rows.length === 0) die(`no agent or live pane found for ${ref}`)
  console.log(["kind", "name", "recorded", "ledger", "derived", "pane", "verdict"].join("\t"))
  for (const row of rows) {
    console.log([row.kind, row.name, row.recorded, row.ledger, row.derived, row.pane, row.verdict].join("\t"))
  }
  const summary = summarizeIdentityRows(rows)
  const counts = summary.counts.map(([verdict, count]) => `${count} ${verdict}`).join(", ")
  console.log(`harnessd: ${summary.total} subject${summary.total === 1 ? "" : "s"}${counts ? `, ${counts}` : ""}`)
}
