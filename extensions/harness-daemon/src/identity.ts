import { hostname } from "node:os"
import { readHarnessLinks, type HarnessLink } from "@threa/bot-runtime-client"
import {
  attestedRuntimes,
  ledgerRuntimeSessionId,
  listLocalTmuxPanes,
  parseClaudeChannelLaunch,
  parsePiLaunch,
  resolveManagedAgentPane,
  resolveRuntimeIdentity,
  type AttestedRuntime,
  type LocalTmuxPane,
} from "./discovery"
import { identityRecordsFor, readMintedIdentities, type MintedIdentity } from "./identity-store"
import { die } from "./errors"
import { findAgentOrUndefined, readInventoryReadonly } from "./inventory"
import { deriveClaudeRuntimeIdentity, readThreaChannelConfig } from "./spawners"
import type { ManagedAgent, ThreaChannelConfig } from "./types"

const NONE = "-"

export interface IdentityRow {
  kind: "row" | "pane"
  name: string
  recorded: string
  minted: string
  ledger: string
  derived: string
  /** Which rung the one resolver would answer from. */
  source: string
  pane: string
  verdict: string
}

export interface IdentityInputs {
  agents: ManagedAgent[]
  panes: LocalTmuxPane[]
  links: HarnessLink[]
  identities?: MintedIdentity[]
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
  /** Inventory rows every rung but the derivation is silent about. */
  identityless: number
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
  const identities = inputs.identities ?? readMintedIdentities()
  const links = () => inputs.links
  const records = () => identities
  const rows: IdentityRow[] = []
  const claimedPanes = new Set<string>()

  for (const agent of inputs.agents) {
    const resolved = resolveManagedAgentPane(agent, inputs.panes, config, host, links, records)
    const paneId = "pane" in resolved ? resolved.pane.paneId : NONE
    if (paneId !== NONE) claimedPanes.add(paneId)
    const recorded = agent.runtimeSessionId ?? NONE
    const ledger = agent.worktree ? (ledgerRuntimeSessionId(agent.worktree, attested) ?? NONE) : NONE
    const claude = agent.runtime === "claude" && agent.worktree
    const derived = claude ? deriveClaudeRuntimeIdentity(agent.worktree!, config, host).runtimeSessionId : NONE
    rows.push({
      kind: "row",
      name: agent.name,
      recorded,
      minted: claude ? (mintedRuntimeSessionId(agent.worktree!, identities) ?? NONE) : NONE,
      ledger,
      derived,
      source: claude
        ? rowSource(agent.worktree!, { runtimeSessionId: agent.runtimeSessionId }, identities, attested, config, host)
        : NONE,
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
        minted: NONE,
        ledger: NONE,
        derived: NONE,
        source: NONE,
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
      minted: mintedRuntimeSessionId(pane.cwd, identities) ?? NONE,
      ledger,
      derived,
      source: resolveRuntimeIdentity(pane.cwd, { declared: launch, identities, attested }, config, host).source,
      pane: pane.paneId,
      verdict: identityVerdict("found", recorded, derived),
    })
  }

  return rows
}

/**
 * A pane that declares no identity records `-`, and that is precisely the pane
 * worth looking up by id — so any column that attests one counts as a match.
 */
export function rowMatchesRef(row: IdentityRow, ref: string): boolean {
  return row.recorded === ref || row.minted === ref || row.ledger === ref || row.derived === ref
}

function mintedRuntimeSessionId(worktree: string, identities: MintedIdentity[]): string | undefined {
  const records = identityRecordsFor(worktree, identities)
  return records.length === 1 ? records[0]!.runtimeSessionId : undefined
}

function rowSource(
  worktree: string,
  inventory: { instanceId?: string; runtimeSessionId?: string },
  identities: MintedIdentity[],
  attested: AttestedRuntime[],
  config: ThreaChannelConfig,
  host: string
): string {
  return resolveRuntimeIdentity(worktree, { identities, attested, inventory }, config, host).source
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
    identities?: MintedIdentity[]
    config?: ThreaChannelConfig
    host?: string
  } = {}
): IdentityConsistency {
  const agents = inputs.agents ?? readInventoryReadonly()
  const panes = inputs.panes ?? []
  const links = inputs.links ?? readHarnessLinks()
  const identities = inputs.identities ?? readMintedIdentities()
  const attested = attestedRuntimes(links)
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

  // The number that has to fall before the derivation can be deleted: these
  // rows have no identity anywhere but in a hostname hash.
  const identityless = agents.filter(
    (agent) =>
      agent.runtime === "claude" &&
      Boolean(agent.worktree) &&
      resolveRuntimeIdentity(
        agent.worktree!,
        { identities, attested, inventory: { instanceId: agent.instanceId, runtimeSessionId: agent.runtimeSessionId } },
        config,
        host
      ).source === "derived"
  ).length

  return { inventoryRows, linkRecords, livePanes, identityless }
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
  }).filter((row) => !ref || managed || rowMatchesRef(row, ref))
  if (ref && rows.length === 0) die(`no agent or live pane found for ${ref}`)
  console.log(["kind", "name", "recorded", "minted", "ledger", "derived", "source", "pane", "verdict"].join("\t"))
  for (const row of rows) {
    console.log(
      [row.kind, row.name, row.recorded, row.minted, row.ledger, row.derived, row.source, row.pane, row.verdict].join(
        "\t"
      )
    )
  }
  const summary = summarizeIdentityRows(rows)
  const counts = summary.counts.map(([verdict, count]) => `${count} ${verdict}`).join(", ")
  console.log(`harnessd: ${summary.total} subject${summary.total === 1 ? "" : "s"}${counts ? `, ${counts}` : ""}`)
}
