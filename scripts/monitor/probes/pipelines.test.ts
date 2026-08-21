import { describe, expect, test } from "bun:test"
import { evaluatePipelines, type PipelineReport } from "./pipelines"

const now = new Date("2026-08-21T18:00:00Z")
const base = (): Omit<PipelineReport, "findings"> => ({
  outbox: { head: 1000, listeners: [] },
  deadLetters: { since: 0, prior: 0 },
  queues: [],
  counters: [],
})
const listener = (over: Partial<PipelineReport["outbox"]["listeners"][number]>) => ({
  listener_id: "broadcast",
  lag: 0,
  last_processed_at: "2026-08-21T17:59:00Z",
  retry_count: 0,
  last_error: null,
  ...over,
})
const queue = (over: Partial<PipelineReport["queues"][number]>) => ({
  queue_name: "persona.agent",
  running: 0,
  ready: 0,
  scheduled: 0,
  oldest_ready_sec: null,
  dlq_since: 0,
  dlq_prior: 0,
  done_since: 0,
  done_prior: 0,
  ...over,
})

describe("evaluatePipelines", () => {
  test("a quiet pipeline has no findings", () => {
    expect(evaluatePipelines({ ...base(), outbox: { head: 1000, listeners: [listener({})] } }, now)).toEqual([])
  })
  test("a listener idle for days with lag is stale, not lagging; a fresh one far behind is lagging; retries surface", () => {
    const report = {
      ...base(),
      outbox: {
        head: 60000,
        listeners: [
          listener({ listener_id: "naming", lag: 52000, last_processed_at: "2026-08-08T06:48:00Z" }),
          listener({ listener_id: "embedding", lag: 900 }),
          listener({ listener_id: "push", lag: 3, retry_count: 2, last_error: "timeout" }),
        ],
      },
    }
    expect(evaluatePipelines(report, now).map((f) => f.id)).toEqual([
      "outbox.stale.naming",
      "outbox.lag.embedding",
      "outbox.retry.push",
    ])
  })
  test("dead letters, DLQ moves, stuck ready messages and failure counters since the baseline warn", () => {
    const report = {
      ...base(),
      deadLetters: { since: 2, prior: 0 },
      queues: [
        queue({ dlq_since: 1 }),
        queue({ queue_name: "embedding.generate", ready: 4, oldest_ready_sec: 900 }),
        queue({ queue_name: "memo.batch-check", ready: 1, oldest_ready_sec: 20 }),
      ],
      counters: [
        { metric: "agent_sessions failed", since: 1, prior: 0 },
        { metric: "agent_sessions completed", since: 9, prior: 8 },
        { metric: "agent_sessions stuck (running, heartbeat > 300s)", since: 0, prior: 0 },
      ],
    }
    expect(evaluatePipelines(report, now).map((f) => f.id)).toEqual([
      "outbox.dlq",
      "queue.dlq.persona.agent",
      "queue.stuck.embedding.generate",
      "counter.agent_sessions failed",
    ])
  })
})

test("a listener row left behind by a removed listener is reported as decommissioned, not as a stale worker", () => {
  const report = {
    ...base(),
    outbox: {
      head: 60000,
      listeners: [listener({ listener_id: "naming", lag: 54628, last_processed_at: "2026-08-08T06:48:00Z" })],
    },
  }
  expect(evaluatePipelines(report, now)).toEqual([])
})
