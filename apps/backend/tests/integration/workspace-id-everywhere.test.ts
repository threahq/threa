import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { workspaceIdExemptTables } from "../../../../eslint/threa-plugin.js"
import { setupIsolatedTestDatabase } from "./setup"

/** Tables whose workspace_id may be NULL, each with the rows that legitimately have none. */
const WORKSPACE_ID_NULLABLE_TABLES: Record<string, string> = {
  access_log: "workspace-less auth-surface rows (20260718121300_access_log.sql)",
  cron_schedules: "system-wide schedules belong to no workspace (20260120070234_cron_schedules.sql)",
  cron_ticks: "a tick copies its schedule's workspace_id, NULL when system-wide (20260120070234_cron_schedules.sql)",
  personas: "system personas belong to no workspace (20251210155323_core_schema.sql)",
}

interface TableRow {
  table: string
  hasWorkspaceId: boolean
  workspaceIdNotNull: boolean
}

interface Violation {
  table: string
  problem: string
}

function problemWith(row: TableRow): string | null {
  if (row.table in workspaceIdExemptTables) {
    return row.hasWorkspaceId ? "exempt table carries workspace_id; remove it from the exempt list" : null
  }
  if (!row.hasWorkspaceId) return "missing workspace_id"
  if (row.table in WORKSPACE_ID_NULLABLE_TABLES) {
    return row.workspaceIdNotNull ? "workspace_id is NOT NULL; remove it from the nullable list" : null
  }
  return row.workspaceIdNotNull ? null : "workspace_id is nullable"
}

describe("workspace_id on every table", () => {
  let pool: Pool
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("workspace_id_everywhere")
    pool = isolated.pool
    cleanup = isolated.cleanup
  }, 30_000)

  afterAll(async () => {
    await cleanup()
  }, 30_000)

  test("every table carries workspace_id NOT NULL unless allowlisted", async () => {
    const result = await pool.query<{ table_name: string; has_workspace_id: boolean; not_null: boolean | null }>(`
      SELECT c.relname AS table_name,
             a.attnum IS NOT NULL AS has_workspace_id,
             a.attnotnull AS not_null
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY c.relname
    `)
    const rows: TableRow[] = result.rows.map((row) => ({
      table: row.table_name,
      hasWorkspaceId: row.has_workspace_id,
      workspaceIdNotNull: row.not_null === true,
    }))

    const existing = new Set(rows.map((row) => row.table))
    const violations: Violation[] = [
      ...rows.flatMap((row) => {
        const problem = problemWith(row)
        return problem ? [{ table: row.table, problem }] : []
      }),
      ...[...Object.keys(workspaceIdExemptTables), ...Object.keys(WORKSPACE_ID_NULLABLE_TABLES)]
        .filter((table) => !existing.has(table))
        .map((table) => ({ table, problem: "allowlisted table does not exist" })),
    ]

    expect(violations).toEqual([])
  })
})
