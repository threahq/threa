import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
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
      probe_backoff_until TEXT
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
        created_at, updated_at, last_output, probe_failures, probe_backoff_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        probe_backoff_until = excluded.probe_backoff_until
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
      agent.probeBackoffUntil ?? null
    )
  } finally {
    db.close()
  }
}

export function findAgentOrUndefined(ref: string, agents: ManagedAgent[] = readInventory()): ManagedAgent | undefined {
  const byId = agents.find((agent) => agent.id === ref)
  if (byId) return byId

  const byRuntimeSession = agents
    .filter((agent) => agent.runtimeSessionId === ref)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (byRuntimeSession[0]) return byRuntimeSession[0]

  const matches = agents.filter((agent) => agent.name === ref)
  if (matches.length > 1) die(`multiple agents match ${ref}; use id`)
  return matches[0]
}

export function findAgent(ref: string): ManagedAgent {
  return findAgentOrUndefined(ref) ?? die(`no agent found for ${ref}`)
}
