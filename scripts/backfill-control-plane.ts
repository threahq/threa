/**
 * Backfill control-plane DB from regional backend DB.
 *
 * Copies workspaces and memberships so existing dev users see their workspaces
 * after the control-plane service is introduced.
 *
 * Usage: bun scripts/backfill-control-plane.ts
 *
 * Reads DATABASE_URL from apps/backend/.env (or env) for the backend DB,
 * derives the control-plane DB URL by appending _cp (same as scripts/dev.ts).
 * Idempotent — safe to run multiple times.
 */
import { createDatabasePool, runMigrations } from "../packages/backend-common/src"
import * as fs from "fs"
import * as path from "path"

function loadEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (!fs.existsSync(filePath)) return env
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIndex = trimmed.indexOf("=")
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex)
    let value = trimmed.slice(eqIndex + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

const backendEnv = loadEnvFile(path.join(process.cwd(), "apps/backend/.env"))
const backendDbUrl =
  backendEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://threa:threa@localhost:5454/threa"
const cpDbUrl = backendDbUrl.replace(/\/([^/?]+)(\?.*)?$/, "/$1_cp$2")

console.log(`Backend DB: ${backendDbUrl}`)
console.log(`Control-plane DB: ${cpDbUrl}`)

const backendPool = createDatabasePool(backendDbUrl, { max: 2 })
const cpPool = createDatabasePool(cpDbUrl, { max: 2 })

try {
  // Run control-plane migrations first so tables exist
  const migrationsGlob = path.join(process.cwd(), "apps/control-plane/src/db/migrations/*.sql")
  await runMigrations(cpPool, migrationsGlob)
  console.log("Control-plane migrations applied")

  // Fetch workspaces + creator's workos_user_id from backend; an unclaimed
  // workspace has no creator and reaches the registry with a null one.
  const workspaces = await backendPool.query<{
    id: string
    name: string
    slug: string
    created_by: string | null
    created_at: Date
    updated_at: Date
    workos_user_id: string | null
  }>(`
    SELECT w.id, w.name, w.slug, w.created_by, w.created_at, w.updated_at, u.workos_user_id
    FROM workspaces w
    LEFT JOIN users u ON u.id = w.created_by
    WHERE w.created_by IS NULL OR u.workos_user_id IS NOT NULL
  `)

  console.log(`Found ${workspaces.rows.length} workspace(s) to backfill`)

  for (const ws of workspaces.rows) {
    await cpPool.query(
      `INSERT INTO workspace_registry (id, name, slug, region, created_by_workos_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
      [ws.id, ws.name, ws.slug, "local", ws.workos_user_id, ws.created_at, ws.updated_at]
    )
    console.log(`  workspace: ${ws.slug} (${ws.id})`)
  }

  // Fetch members — handle both schemas:
  // Old: users.workspace_id + users.joined_at (no workspace_members table)
  // New: workspace_members join users
  const hasWorkspaceMembers = await backendPool
    .query("SELECT 1 FROM information_schema.tables WHERE table_name = 'workspace_members' LIMIT 1")
    .then((r) => r.rows.length > 0)

  const members = hasWorkspaceMembers
    ? await backendPool.query<{ workspace_id: string; workos_user_id: string; joined_at: Date }>(`
        SELECT wm.workspace_id, u.workos_user_id, wm.joined_at
        FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
        WHERE u.workos_user_id IS NOT NULL
      `)
    : await backendPool.query<{ workspace_id: string; workos_user_id: string; joined_at: Date }>(`
        SELECT workspace_id, workos_user_id, joined_at
        FROM users
        WHERE workos_user_id IS NOT NULL AND workspace_id IS NOT NULL
      `)

  console.log(`Found ${members.rows.length} membership(s) to backfill`)

  for (const m of members.rows) {
    await cpPool.query(
      `INSERT INTO workspace_memberships (workspace_id, workos_user_id, joined_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, workos_user_id) DO NOTHING`,
      [m.workspace_id, m.workos_user_id, m.joined_at]
    )
    console.log(`  membership: ${m.workos_user_id} → ${m.workspace_id}`)
  }

  console.log("Backfill complete")
} finally {
  await backendPool.end()
  await cpPool.end()
}
