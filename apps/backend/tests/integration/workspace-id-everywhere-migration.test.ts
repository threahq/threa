import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool, type PoolClient } from "pg"
import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { setupIsolatedTestDatabase, withTestTransaction } from "./setup"

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../src/db/migrations")

/** The workspace_id rollout's files, in the order the migrator runs them. */
const ROLLOUT_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((file) => /^20261001230\d{3}_workspace_id_/.test(file))
  .sort()

const PARENT_WORKSPACE = "ws_parent"
const STALE_WORKSPACE = "ws_stale"

interface Child {
  table: string
  columns: string
  values: string
}

/** One row per table, parents before children: messages feed reactions, agent_sessions feed their steps. */
const CHILDREN: Child[] = [
  {
    table: "messages",
    columns: "id, stream_id, sequence, author_id, author_type, content_markdown, content_json",
    values: "'msg_b', 'stream_b', 1, 'usr_b', 'user', 'hi', '{}'",
  },
  {
    table: "stream_events",
    columns: "id, stream_id, sequence, event_type, payload",
    values: "'event_b', 'stream_b', 1, 'message_created', '{}'",
  },
  { table: "stream_members", columns: "stream_id, member_id", values: "'stream_b', 'member_b'" },
  { table: "stream_persona_participants", columns: "stream_id, persona_id", values: "'stream_b', 'persona_b'" },
  {
    table: "stream_persona_roster",
    columns: "stream_id, persona_id, added_by",
    values: "'stream_b', 'persona_b', 'usr_b'",
  },
  { table: "stream_sequences", columns: "stream_id", values: "'stream_b'" },
  {
    table: "agent_sessions",
    columns: "id, stream_id, persona_id, trigger_message_id, status",
    values: "'session_b', 'stream_b', 'persona_b', 'msg_b', 'running'",
  },
  {
    table: "message_versions",
    columns: "id, message_id, version_number, content_json, content_markdown, edited_by",
    values: "'msgv_b', 'msg_b', 1, '{}', 'hi', 'usr_b'",
  },
  { table: "reactions", columns: "message_id, emoji, user_id", values: "'msg_b', ':+1:', 'usr_b'" },
  {
    table: "agent_session_steps",
    columns: "id, session_id, step_number, step_type",
    values: "'step_b', 'session_b', 1, 'thinking'",
  },
  { table: "user_preference_overrides", columns: "key, value, user_id", values: "'theme', '\"dark\"', 'usr_b'" },
]

function insertStatement(child: Child, workspaceId?: string): string {
  if (workspaceId === undefined) {
    return `INSERT INTO ${child.table} (${child.columns}) VALUES (${child.values})`
  }
  return `INSERT INTO ${child.table} (${child.columns}, workspace_id) VALUES (${child.values}, '${workspaceId}')`
}

async function seedParents(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
     VALUES ('stream_b', $1, 'channel', 'private', 'usr_b')`,
    [PARENT_WORKSPACE]
  )
  await client.query(`INSERT INTO users (id, workspace_id, slug) VALUES ('usr_b', $1, 'bridge-user')`, [
    PARENT_WORKSPACE,
  ])
}

async function readWorkspaceIds(client: PoolClient): Promise<Record<string, string | null>> {
  const entries: Array<[string, string | null]> = []
  for (const child of CHILDREN) {
    const result = await client.query<{ workspace_id: string | null }>(`SELECT workspace_id FROM ${child.table}`)
    entries.push([child.table, result.rows[0]?.workspace_id ?? null])
  }
  return Object.fromEntries(entries)
}

function allWorkspaceIds(workspaceId: string): Record<string, string> {
  return Object.fromEntries(CHILDREN.map((child) => [child.table, workspaceId]))
}

/**
 * The backfill UPDATEs run against a fresh migrated database with no rows, so
 * only seeded rows here prove the join columns are right.
 */
describe("workspace_id rollout migrations", () => {
  let pool: Pool
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("workspace_id_rollout")
    pool = isolated.pool
    cleanup = isolated.cleanup
  }, 30_000)

  afterAll(async () => {
    await cleanup()
  }, 30_000)

  test("should reject an insert on every child table when it omits workspace_id", async () => {
    const failures: Record<string, { code?: string; column?: string }> = {}
    for (const [index, child] of CHILDREN.entries()) {
      failures[child.table] = await withTestTransaction(pool, async (client) => {
        await seedParents(client)
        for (const parent of CHILDREN.slice(0, index)) await client.query(insertStatement(parent, PARENT_WORKSPACE))
        try {
          await client.query(insertStatement(child))
          return {}
        } catch (error) {
          const { code, column } = error as { code?: string; column?: string }
          return { code, column }
        }
      })
    }

    expect(failures).toEqual(
      Object.fromEntries(CHILDREN.map((child) => [child.table, { code: "23502", column: "workspace_id" }]))
    )
  })

  test("should fill every table from its parent and keep value_generation when the backfill UPDATEs run over stale rows", async () => {
    const updates = (
      await Promise.all(ROLLOUT_MIGRATIONS.map((file) => Bun.file(resolve(MIGRATIONS_DIR, file)).text()))
    ).flatMap((sql) => sql.match(/^UPDATE [^;]+;/gm) ?? [])

    const outcome = await withTestTransaction(pool, async (client) => {
      await seedParents(client)
      for (const child of CHILDREN) await client.query(insertStatement(child, PARENT_WORKSPACE))
      const generation = async () =>
        (await client.query<{ value_generation: string }>("SELECT value_generation FROM user_preference_overrides"))
          .rows[0]?.value_generation

      const before = await generation()
      for (const child of CHILDREN) {
        await client.query(`UPDATE ${child.table} SET workspace_id = '${STALE_WORKSPACE}'`)
      }
      const stale = await readWorkspaceIds(client)

      for (const sql of updates) await client.query(sql)
      const backfilled = await readWorkspaceIds(client)
      const afterBackfill = await generation()

      await client.query(`UPDATE user_preference_overrides SET value = '"light"'`)
      const afterValueChange = await generation()

      return {
        stale,
        backfilled,
        generationKept: afterBackfill === before,
        valueChangeBumpsGeneration: afterValueChange !== before,
        updateCount: updates.length,
      }
    })

    expect(outcome).toEqual({
      stale: allWorkspaceIds(STALE_WORKSPACE),
      backfilled: allWorkspaceIds(PARENT_WORKSPACE),
      generationKept: true,
      valueChangeBumpsGeneration: true,
      updateCount: CHILDREN.length,
    })
  })
})
