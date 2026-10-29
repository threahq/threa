import { expect, test } from "bun:test"
import { Pool } from "pg"
import { setupIsolatedTestDatabase } from "./setup"
import { getIsolatedTestTemplate } from "../setup"
import { getTestDatabaseTarget } from "../test-database"

test("should clone pristine migrations and seeds with independent data and schema, then clean up", async () => {
  const fixtures: Awaited<ReturnType<typeof setupIsolatedTestDatabase>>[] = []
  const names: string[] = []
  const admin = new Pool({ connectionString: getTestDatabaseTarget().adminUrl })
  const seed = async (pool: Pool) => ({
    persona: (await pool.query("SELECT * FROM personas WHERE id = 'persona_system_ariadne'")).rows,
    listener: (await pool.query("SELECT * FROM outbox_listeners WHERE listener_id = 'broadcast'")).rows,
  })
  try {
    const acquisitions = await Promise.allSettled(
      ["clone_a", "clone_b"].map(async (label) => {
        fixtures.push(await setupIsolatedTestDatabase(label))
      })
    )
    const failures = acquisitions.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Clone acquisition failed")

    const modifiedClone = fixtures[0]!
    const pristine = await seed(modifiedClone.pool)
    expect(pristine).toMatchObject({
      persona: [{ id: "persona_system_ariadne" }],
      listener: [{ listener_id: "broadcast" }],
    })

    await modifiedClone.pool.query(
      "CREATE TABLE clone_probe (value TEXT, created_at TIMESTAMPTZ DEFAULT clock_timestamp())"
    )
    await modifiedClone.pool.query("INSERT INTO clone_probe (value) VALUES ('only a')")
    await modifiedClone.pool.query("UPDATE personas SET name = 'changed in a' WHERE id = 'persona_system_ariadne'")

    fixtures.push(await setupIsolatedTestDatabase("clone_c"))
    for (const fixture of fixtures) {
      names.push((await fixture.pool.query("SELECT current_database() AS name")).rows[0].name)
      const extensionValues = await fixture.pool.query(
        "SELECT '[1,0]'::vector <-> '[0,0]'::vector AS distance, similarity('clone', 'clone') AS similarity"
      )
      expect(extensionValues.rows).toEqual([{ distance: 1, similarity: 1 }])
    }
    expect(new Set(names).size).toBe(3)

    for (const fixture of fixtures.slice(1)) {
      const table = await fixture.pool.query("SELECT to_regclass('public.clone_probe') AS name")
      expect({ seed: await seed(fixture.pool), table: table.rows }).toEqual({ seed: pristine, table: [{ name: null }] })
    }

    const inserted = await modifiedClone.pool.query(
      "SELECT value, created_at <= clock_timestamp() AND created_at >= $1 AS live_clock FROM clone_probe",
      [pristine.listener[0].last_processed_at]
    )
    expect(inserted.rows).toEqual([{ value: "only a", live_clock: true }])

    const sessions = await admin.query("SELECT datname FROM pg_stat_activity WHERE datname = $1", [
      await getIsolatedTestTemplate(),
    ])
    expect(sessions.rows).toEqual([])
  } finally {
    try {
      const cleanup = await Promise.allSettled(
        fixtures.map(async (fixture) => {
          await fixture.cleanup()
          await fixture.cleanup()
        })
      )
      const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Clone cleanup failed")

      const remaining = await admin.query("SELECT datname FROM pg_database WHERE datname = ANY($1::text[])", [names])
      expect(remaining.rows).toEqual([])
    } finally {
      await admin.end()
    }
  }
}, 120_000)
