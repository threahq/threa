import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { canonicalOrRaw, defaultAgentIdentityResolver, type AgentIdentityResolver } from "./discovery"
import { die } from "./errors"
import type { AgentStatus, ManagedAgent, RuntimeKind } from "./types"

const DEFAULT_INVENTORY_PATH = `${homedir()}/.threa/harnessd/inventory.sqlite`

interface ManagedAgentRow {
  id: string
  name: string
  runtime: RuntimeKind
  status: AgentStatus
  worktree: string | null
  branch: string | null
  tmux_session: string | null
  tmux_window: string | null
  tmux_window_id: string | null
  tmux_pane_id: string | null
  scratchpad_url: string | null
  instance_id: string | null
  runtime_session_id: string | null
  command_json: string
  created_at: string
  updated_at: string
  last_output: string | null
  probe_failures: number | null
  probe_backoff_until: string | null
  tombstoned_at: string | null
}

export function inventoryPath(): string {
  return process.env.THREA_HARNESSD_INVENTORY || DEFAULT_INVENTORY_PATH
}

function openInventory(): Database {
  const path = inventoryPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      runtime TEXT NOT NULL,
      status TEXT NOT NULL,
      worktree TEXT,
      branch TEXT,
      tmux_session TEXT,
      tmux_window TEXT,
      tmux_window_id TEXT,
      tmux_pane_id TEXT,
      scratchpad_url TEXT,
      instance_id TEXT,
      runtime_session_id TEXT,
      command_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_output TEXT,
      probe_failures INTEGER,
      probe_backoff_until TEXT,
      tombstoned_at TEXT
    )
  `)
  // CREATE TABLE IF NOT EXISTS won't extend an existing inventory, so add new columns in place.
  const columns = db.query("PRAGMA table_info(managed_agents)").all() as Array<{ name: string }>
  const added: Array<[string, string]> = [
    ["tmux_window_id", "TEXT"],
    ["tmux_pane_id", "TEXT"],
    ["instance_id", "TEXT"],
    ["runtime_session_id", "TEXT"],
    ["probe_failures", "INTEGER"],
    ["probe_backoff_until", "TEXT"],
    ["tombstoned_at", "TEXT"],
  ]
  for (const [column, type] of added) {
    if (!columns.some((existing) => existing.name === column)) {
      db.exec(`ALTER TABLE managed_agents ADD COLUMN ${column} ${type}`)
    }
  }
  return db
}

function rowToAgent(row: ManagedAgentRow): ManagedAgent {
  return {
    id: row.id,
    name: row.name,
    runtime: row.runtime,
    status: row.status,
    worktree: row.worktree ?? undefined,
    branch: row.branch ?? undefined,
    tmuxSession: row.tmux_session ?? undefined,
    tmuxWindow: row.tmux_window ?? undefined,
    tmuxWindowId: row.tmux_window_id ?? undefined,
    tmuxPaneId: row.tmux_pane_id ?? undefined,
    scratchpadUrl: row.scratchpad_url ?? undefined,
    instanceId: row.instance_id ?? undefined,
    runtimeSessionId: row.runtime_session_id ?? undefined,
    command: JSON.parse(row.command_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOutput: row.last_output ?? undefined,
    probeFailures: row.probe_failures ?? undefined,
    probeBackoffUntil: row.probe_backoff_until ?? undefined,
    tombstonedAt: row.tombstoned_at ?? undefined,
  }
}

export function readInventory(): ManagedAgent[] {
  if (!existsSync(inventoryPath())) return []
  const db = openInventory()
  try {
    const rows = db.query("SELECT * FROM managed_agents ORDER BY created_at ASC").all() as ManagedAgentRow[]
    return rows.map(rowToAgent)
  } finally {
    db.close()
  }
}

export function readInventoryReadonly(): ManagedAgent[] {
  const path = inventoryPath()
  if (!existsSync(path)) return []
  const db = new Database(path, { readonly: true })
  try {
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'managed_agents'").get()
    if (!table) return []
    const columns = new Set(
      (db.query("PRAGMA table_info(managed_agents)").all() as Array<{ name: string }>).map(({ name }) => name)
    )
    const optional = [
      "worktree",
      "branch",
      "tmux_session",
      "tmux_window",
      "tmux_window_id",
      "tmux_pane_id",
      "scratchpad_url",
      "instance_id",
      "runtime_session_id",
      "last_output",
      "probe_failures",
      "probe_backoff_until",
      "tombstoned_at",
    ]
    const projection = optional.map((name) => (columns.has(name) ? name : `NULL AS ${name}`))
    const rows = db
      .query(
        `SELECT id, name, runtime, status, ${projection.join(", ")}, command_json, created_at, updated_at FROM managed_agents ORDER BY created_at ASC`
      )
      .all() as ManagedAgentRow[]
    return rows.map(rowToAgent)
  } finally {
    db.close()
  }
}

export function upsertAgent(agent: ManagedAgent): void {
  const db = openInventory()
  try {
    db.query(
      `
      INSERT INTO managed_agents (
        id, name, runtime, status, worktree, branch, tmux_session, tmux_window,
        tmux_window_id, tmux_pane_id, scratchpad_url, instance_id, runtime_session_id, command_json,
        created_at, updated_at, last_output, probe_failures, probe_backoff_until, tombstoned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        runtime = excluded.runtime,
        status = excluded.status,
        worktree = excluded.worktree,
        branch = excluded.branch,
        tmux_session = excluded.tmux_session,
        tmux_window = excluded.tmux_window,
        tmux_window_id = excluded.tmux_window_id,
        tmux_pane_id = excluded.tmux_pane_id,
        scratchpad_url = excluded.scratchpad_url,
        instance_id = excluded.instance_id,
        runtime_session_id = excluded.runtime_session_id,
        command_json = excluded.command_json,
        updated_at = excluded.updated_at,
        last_output = excluded.last_output,
        probe_failures = excluded.probe_failures,
        probe_backoff_until = excluded.probe_backoff_until,
        tombstoned_at = excluded.tombstoned_at
    `
    ).run(
      agent.id,
      agent.name,
      agent.runtime,
      agent.status,
      agent.worktree ?? null,
      agent.branch ?? null,
      agent.tmuxSession ?? null,
      agent.tmuxWindow ?? null,
      agent.tmuxWindowId ?? null,
      agent.tmuxPaneId ?? null,
      agent.scratchpadUrl ?? null,
      agent.instanceId ?? null,
      agent.runtimeSessionId ?? null,
      JSON.stringify(agent.command),
      agent.createdAt,
      agent.updatedAt,
      agent.lastOutput ?? null,
      agent.probeFailures ?? null,
      agent.probeBackoffUntil ?? null,
      agent.tombstonedAt ?? null
    )
  } finally {
    db.close()
  }
}

function newest(agents: ManagedAgent[]): ManagedAgent | undefined {
  return [...agents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

/**
 * Selection is by identity, not by name: two rows called `feature` are two
 * sessions, and a renamed session is still one.
 *
 * A tombstoned row matches by explicit id only, so `list` and `resolve` keep
 * showing history while nothing selects it for revival.
 */
export function findAgentOrUndefined(
  ref: string,
  agents: ManagedAgent[] = readInventory(),
  resolve?: AgentIdentityResolver
): ManagedAgent | undefined {
  const byId = agents.find((agent) => agent.id === ref)
  if (byId) return byId

  const live = agents.filter((agent) => !agent.tombstonedAt)
  const byRecordedSession = newest(live.filter((agent) => agent.runtimeSessionId === ref))
  if (byRecordedSession) return byRecordedSession

  // Built once, and only when a rung actually needs it: it reads the identity
  // and link stores.
  let resolver: AgentIdentityResolver | undefined = resolve
  const identityOf = (agent: ManagedAgent) => (resolver ??= defaultAgentIdentityResolver())(agent)

  if (live.some((agent) => agent.worktree)) {
    const byResolvedSession = live.filter((agent) => identityOf(agent) === ref)
    // One identity can name two directories — the live inventory carries such a
    // pair from the identity-inheritance bug fixed in 647a99978. Picking the
    // newest would point `stop` and `kick` at a pane in a directory the operator
    // never named, so the worktrees have to be told apart or refused.
    const claimed = [...new Set(byResolvedSession.map((agent) => canonicalOrRaw(agent.worktree ?? agent.id)))].sort()
    if (claimed.length > 1) die(`${ref} names ${claimed.length} worktrees: ${claimed.join(", ")}; use id`)
    if (byResolvedSession.length > 0) return newest(byResolvedSession)

    const target = canonicalOrRaw(ref)
    const byWorktree = newest(live.filter((agent) => agent.worktree && canonicalOrRaw(agent.worktree) === target))
    if (byWorktree) return byWorktree
  }

  const matches = live.filter((agent) => agent.name === ref)
  if (matches.length > 1) {
    const competing = [...new Set(matches.map((agent) => identityOf(agent) ?? agent.id))].sort()
    if (competing.length > 1) die(`multiple agents match ${ref}: ${competing.join(", ")}; use id`)
    const directories = [...new Set(matches.map((agent) => canonicalOrRaw(agent.worktree ?? agent.id)))].sort()
    if (directories.length > 1) die(`${ref} names ${directories.length} worktrees: ${directories.join(", ")}; use id`)
    return newest(matches)
  }
  return matches[0]
}

export function findAgent(ref: string): ManagedAgent {
  return findAgentOrUndefined(ref) ?? die(`no agent found for ${ref}`)
}
