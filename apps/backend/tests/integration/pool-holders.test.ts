import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { toOtlpAttributes } from "@threahq/backend-common"
import { createDatabasePool } from "../../src/db"
import { logger } from "../../src/lib/logger"
import { PoolMonitor, type PoolHolder } from "../../src/lib/observability/pool-monitor"
import { getTestDatabaseTarget } from "../test-database"

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("PoolMonitor holders on a saturated pool", () => {
  let pool: Pool | null = null

  afterEach(async () => {
    await pool?.end()
    pool = null
  })

  test("ships each holder's checkout site and whether it is running a statement", async () => {
    const saturating = createDatabasePool(getTestDatabaseTarget().connectionUrl, { max: 2 })
    pool = saturating
    const monitor = new PoolMonitor({ realtime: saturating }, { disableLogging: true })
    const warnings: { data: Record<string, unknown>; msg: string }[] = []
    const warn = spyOn(logger, "warn").mockImplementation(((data: Record<string, unknown>, msg: string) => {
      warnings.push({ data, msg })
    }) as never)

    const held: PoolClient[] = []
    try {
      held.push(await saturating.connect())
      const busy = await saturating.connect()
      held.push(busy)
      const sleeping = busy.query("SELECT pg_sleep(0.5)")
      const waiting = saturating.query("SELECT 1")
      await until(() => saturating.waitingCount === 1)

      monitor.start()
      monitor.stop()

      await sleeping
      for (const client of held.splice(0)) client.release()
      await waiting
    } finally {
      for (const client of held) client.release()
      warn.mockRestore()
    }

    const saturated = warnings.find((w) => w.msg === "Pool 'realtime' has 1 waiting client(s)")
    const shipped = toOtlpAttributes(saturated?.data ?? {})
    const holders = shipped
      .filter((attribute) => attribute.key.startsWith("holder"))
      .map(
        (attribute) => JSON.parse("stringValue" in attribute.value ? attribute.value.stringValue : "null") as PoolHolder
      )
    expect({
      held: shipped.find((attribute) => attribute.key === "held")?.value,
      holders: holders.map((holder) => ({
        running: holder.query !== null,
        checkedOutHere: holder.site[0]?.includes("tests/integration/pool-holders.test.ts") ?? false,
      })),
    }).toEqual({
      held: { intValue: "2" },
      holders: [
        { running: false, checkedOutHere: true },
        { running: true, checkedOutHere: true },
      ],
    })
  })
})
