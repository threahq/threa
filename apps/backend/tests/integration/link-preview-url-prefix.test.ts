import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTestTransaction } from "./setup"
import { LinkPreviewRepository } from "../../src/features/link-previews/repository"
import { escapeLikePattern } from "../../src/features/link-previews/refresh"

/**
 * Regression (Fable adversarial review on #1374): the query's `ESCAPE '\'` in a
 * TS template literal cooked to `ESCAPE ''`, disabling escape processing — so
 * `escapeLikePattern`'s backslashes became literal pattern characters and any
 * repo name containing `_` never matched. This exercises the real Postgres
 * query; every unit-level caller mocks the repo method and can't catch it.
 */
describe("findByNormalizedUrlPrefix escaping", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("matches underscore repo names literally, without wildcard bleed", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, created_at)
         VALUES
           ('lp_underscore', 'ws_esc_test', 'https://github.com/acme/my_repo/pull/7',
            'https://github.com/acme/my_repo/pull/7', 'completed', 'website', NOW()),
           ('lp_wildcard', 'ws_esc_test', 'https://github.com/acme/myxrepo/pull/7',
            'https://github.com/acme/myxrepo/pull/7', 'completed', 'website', NOW())`
      )

      const rows = await LinkPreviewRepository.findByNormalizedUrlPrefix(
        client,
        "ws_esc_test",
        escapeLikePattern("https://github.com/acme/my_repo/pull/7")
      )

      expect(rows.map((r) => r.id)).toEqual(["lp_underscore"])
    })
  })
})

/**
 * Regression (Sol review round 2 on #1374): the webhook-refresh path must not let
 * a slow pre-merge GET blind-overwrite a newer write. `overwriteMetadata` gains an
 * optional compare-and-set on `fetched_at` (`IS NOT DISTINCT FROM`, so NULL
 * matches NULL). Exercises the real Postgres predicate — a mock can't prove the
 * WHERE clause actually gates the write.
 */
describe("overwriteMetadata compare-and-set on fetched_at", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("writes when expectedFetchedAt matches the row's fetched_at", async () => {
    await withTestTransaction(pool, async (client) => {
      const t0 = new Date("2026-01-01T00:00:00.000Z")
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, fetched_at, created_at)
         VALUES ('lp_cas_win', 'ws_cas', 'https://github.com/a/b/pull/1',
                 'https://github.com/a/b/pull/1', 'completed', 'website', $1, NOW())`,
        [t0]
      )

      const updated = await LinkPreviewRepository.overwriteMetadata(
        client,
        "ws_cas",
        "lp_cas_win",
        { status: "completed", title: "fresh" },
        { expectedFetchedAt: t0 }
      )

      expect(updated?.title).toBe("fresh")
      expect(updated!.fetchedAt!.getTime()).toBeGreaterThan(t0.getTime())
    })
  })

  test("does not write when expectedFetchedAt is stale (CAS loss)", async () => {
    await withTestTransaction(pool, async (client) => {
      const winner = new Date("2026-01-02T00:00:00.000Z")
      const stale = new Date("2026-01-01T00:00:00.000Z")
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, title, fetched_at, created_at)
         VALUES ('lp_cas_lose', 'ws_cas', 'https://github.com/a/b/pull/2',
                 'https://github.com/a/b/pull/2', 'completed', 'website', 'winner', $1, NOW())`,
        [winner]
      )

      const updated = await LinkPreviewRepository.overwriteMetadata(
        client,
        "ws_cas",
        "lp_cas_lose",
        { status: "completed", title: "loser" },
        { expectedFetchedAt: stale }
      )

      expect(updated).toBeNull()
      const { rows } = await client.query(`SELECT title, fetched_at FROM link_previews WHERE id = 'lp_cas_lose'`)
      expect(rows[0].title).toBe("winner")
      expect(new Date(rows[0].fetched_at).getTime()).toBe(winner.getTime())
    })
  })

  test("writes a NULL fetched_at row when expectedFetchedAt is null", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO link_previews (id, workspace_id, url, normalized_url, status, content_type, fetched_at, created_at)
         VALUES ('lp_cas_null', 'ws_cas', 'https://github.com/a/b/pull/3',
                 'https://github.com/a/b/pull/3', 'completed', 'website', NULL, NOW())`
      )

      const updated = await LinkPreviewRepository.overwriteMetadata(
        client,
        "ws_cas",
        "lp_cas_null",
        { status: "completed", title: "first" },
        { expectedFetchedAt: null }
      )

      expect(updated?.title).toBe("first")
      expect(updated!.fetchedAt).not.toBeNull()
    })
  })
})
