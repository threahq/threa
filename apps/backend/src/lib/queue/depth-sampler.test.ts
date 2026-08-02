import { afterEach, beforeEach, describe, expect, it, spyOn, mock } from "bun:test"
import type { Pool } from "pg"
import { QueueDepthSampler } from "./depth-sampler"
import { QueueRepository } from "./repository"
import { logger } from "../logger"
import { queueMessagesPending, queueMessagesDlq, queueOldestPendingAgeSeconds } from "../observability"

const pool = {} as Pool

async function gaugeValues(gauge: typeof queueMessagesPending): Promise<Record<string, number>> {
  const metric = await gauge.get()
  const out: Record<string, number> = {}
  for (const sample of metric.values) {
    out[String(sample.labels.queue)] = sample.value
  }
  return out
}

describe("QueueDepthSampler.sampleOnce", () => {
  beforeEach(() => {
    queueMessagesPending.reset()
    queueMessagesDlq.reset()
    queueOldestPendingAgeSeconds.reset()
  })

  afterEach(() => {
    mock.restore()
  })

  it("sets gauges from repo rows", async () => {
    const oldest = new Date(Date.now() - 30_000)
    spyOn(QueueRepository, "depthByQueue").mockResolvedValue([
      { queueName: "embedding", pending: 3, oldestPendingAt: oldest, dlq: 1 },
      { queueName: "naming", pending: 0, oldestPendingAt: null, dlq: 0 },
    ])

    await new QueueDepthSampler({ pool }).sampleOnce()

    expect(await gaugeValues(queueMessagesPending)).toEqual({ embedding: 3, naming: 0 })
    expect(await gaugeValues(queueMessagesDlq)).toEqual({ embedding: 1, naming: 0 })
    const ages = await gaugeValues(queueOldestPendingAgeSeconds)
    expect(ages.naming).toBe(0)
    expect(ages.embedding).toBeGreaterThanOrEqual(29)
    expect(ages.embedding).toBeLessThan(60)
  })

  it("zeroes gauges for queues absent from the sample", async () => {
    const depth = spyOn(QueueRepository, "depthByQueue")
      .mockResolvedValueOnce([{ queueName: "embedding", pending: 5, oldestPendingAt: new Date(), dlq: 2 }])
      .mockResolvedValueOnce([])

    const sampler = new QueueDepthSampler({ pool })
    await sampler.sampleOnce()
    await sampler.sampleOnce()

    expect(depth).toHaveBeenCalledTimes(2)
    expect(await gaugeValues(queueMessagesPending)).toEqual({ embedding: 0 })
    expect(await gaugeValues(queueMessagesDlq)).toEqual({ embedding: 0 })
    expect(await gaugeValues(queueOldestPendingAgeSeconds)).toEqual({ embedding: 0 })
  })

  it("swallows a failing sample and logs the error", async () => {
    spyOn(QueueRepository, "depthByQueue").mockRejectedValue(new Error("db down"))
    const error = spyOn(logger, "error").mockImplementation(() => {})

    await new QueueDepthSampler({ pool }).sampleOnce()

    expect(error).toHaveBeenCalled()
  })
})
