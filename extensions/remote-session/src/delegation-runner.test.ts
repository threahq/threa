import { describe, expect, it } from "bun:test"
import { ThreaApiError } from "./client"
import type { ClaimedDelegation, DelegationClient, DelegationSummary } from "./delegation-client"
import { DELEGATION_STOP_REASON, DelegationRunner, type DelegationExecutor } from "./delegation-runner"

function summary(id: string): DelegationSummary {
  return {
    id,
    streamId: "stream_1",
    title: `Task ${id}`,
    status: "open",
    createdAt: "2026-07-12T10:00:00.000Z",
    statusChangedAt: "2026-07-12T10:00:00.000Z",
  }
}

function claimed(id: string): ClaimedDelegation {
  return {
    ...summary(id),
    status: "claimed",
    brief: "Do the thing.",
    contextRefs: [],
    claimToken: `token-${id}`,
    claimExpiresAt: "2026-07-12T10:15:00.000Z",
  }
}

interface StubCalls {
  listOpen: number
  claims: Array<{ id: string; idempotencyKey?: string }>
  completes: Array<{ id: string; token: string; resultMarkdown?: string; metadata?: Record<string, string> }>
  fails: Array<{ id: string; token: string; errorMessage: string }>
  statuses: Array<{ id: string; note: string }>
  heartbeats: number
  accessRequests: string[]
}

function stubClient(overrides: {
  queue?: DelegationSummary[][]
  claimError?: (id: string) => Error | null
  failError?: Error
}): {
  client: DelegationClient
  calls: StubCalls
} {
  const calls: StubCalls = {
    listOpen: 0,
    claims: [],
    completes: [],
    fails: [],
    statuses: [],
    heartbeats: 0,
    accessRequests: [],
  }
  const queue = overrides.queue ?? [[]]
  const client = {
    listOpen: async () => {
      const batch = queue[Math.min(calls.listOpen, queue.length - 1)]
      calls.listOpen += 1
      return batch
    },
    claim: async (id: string, body: { claimedByLabel: string; idempotencyKey?: string }) => {
      calls.claims.push({ id, idempotencyKey: body.idempotencyKey })
      const error = overrides.claimError?.(id)
      if (error) throw error
      return claimed(id)
    },
    heartbeat: async () => {
      calls.heartbeats += 1
      return { claimExpiresAt: "2026-07-12T10:30:00.000Z" }
    },
    reportStatus: async (id: string, _token: string, note: string) => {
      calls.statuses.push({ id, note })
      return summary(id)
    },
    complete: async (
      id: string,
      token: string,
      body: { resultMarkdown?: string; metadata?: Record<string, string> }
    ) => {
      calls.completes.push({ id, token, ...body })
      return { ...summary(id), status: "completed" }
    },
    fail: async (id: string, token: string, errorMessage: string) => {
      calls.fails.push({ id, token, errorMessage })
      if (overrides.failError) throw overrides.failError
      return { ...summary(id), status: "failed" }
    },
    requestAccess: async (id: string) => {
      calls.accessRequests.push(id)
      return { requestId: `bar_${id}`, status: "open" }
    },
  } as unknown as DelegationClient
  return { client, calls }
}

function makeRunner(
  client: DelegationClient,
  executor: DelegationExecutor,
  opts: Partial<ConstructorParameters<typeof DelegationRunner>[0]> = {}
) {
  return new DelegationRunner({
    client,
    executor,
    claimedByLabel: "Test rig",
    // Long intervals: tests drive the runner via notifyAvailable(), never timers.
    pollMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
    ...opts,
  })
}

const flush = () => new Promise((r) => setTimeout(r, 20))

describe("DelegationRunner", () => {
  it("claims with a fresh idempotency key (persisted first) and completes with the executor's result", async () => {
    const { client, calls } = stubClient({ queue: [[summary("dlg_1")], []] })
    const persisted: Array<{ id: string; key: string }> = []
    const runner = makeRunner(
      client,
      async (task, ctx) => {
        await ctx.reportStatus("working")
        return { resultMarkdown: `Done: ${task.title}`, metadata: { "github.pr": "https://x/1" } }
      },
      { persistIdempotencyKey: (id, key) => void persisted.push({ id, key }) }
    )

    runner.start()
    await flush()
    runner.stop()

    expect(calls.claims).toHaveLength(1)
    expect(calls.claims[0]?.idempotencyKey).toBeTruthy()
    expect(persisted[0]).toMatchObject({ id: "dlg_1", key: calls.claims[0]?.idempotencyKey })
    expect(calls.statuses).toEqual([{ id: "dlg_1", note: "working" }])
    expect(calls.completes).toEqual([
      {
        id: "dlg_1",
        token: "token-dlg_1",
        resultMarkdown: "Done: Task dlg_1",
        metadata: { "github.pr": "https://x/1" },
      },
    ])
    expect(calls.fails).toHaveLength(0)
  })

  it("fails the delegation with the executor's error message", async () => {
    const { client, calls } = stubClient({ queue: [[summary("dlg_1")], []] })
    const runner = makeRunner(client, async () => {
      throw new Error("build exploded")
    })

    runner.start()
    await flush()
    runner.stop()

    expect(calls.fails).toEqual([{ id: "dlg_1", token: "token-dlg_1", errorMessage: "build exploded" }])
    expect(calls.completes).toHaveLength(0)
  })

  it("skips quietly past lost claim races (409) and vanished tasks (404), claiming the next", async () => {
    const { client, calls } = stubClient({
      queue: [[summary("dlg_taken"), summary("dlg_gone"), summary("dlg_ours")], []],
      claimError: (id) => {
        if (id === "dlg_taken") return new ThreaApiError("conflict", 409, "DELEGATION_NOT_OPEN")
        if (id === "dlg_gone") return new ThreaApiError("gone", 404, "NOT_FOUND")
        return null
      },
    })
    const runner = makeRunner(client, async () => ({ resultMarkdown: "ok" }))

    runner.start()
    await flush()
    runner.stop()

    expect(calls.claims.map((c) => c.id)).toEqual(["dlg_taken", "dlg_gone", "dlg_ours"])
    expect(calls.completes.map((c) => c.id)).toEqual(["dlg_ours"])
  })

  it("runs one delegation at a time and drains the rest afterwards", async () => {
    const order: string[] = []
    const { client } = stubClient({ queue: [[summary("dlg_1"), summary("dlg_2")], [summary("dlg_2")], []] })
    const runner = makeRunner(client, async (task) => {
      order.push(`start:${task.id}`)
      await new Promise((r) => setTimeout(r, 5))
      order.push(`end:${task.id}`)
      return { resultMarkdown: "ok" }
    })

    runner.start()
    await flush()
    await flush()
    runner.stop()

    // Strict serialization: dlg_1 finishes before dlg_2 starts.
    expect(order).toEqual(["start:dlg_1", "end:dlg_1", "start:dlg_2", "end:dlg_2"])
  })

  it("renews the lease on the heartbeat interval while executing", async () => {
    const { client, calls } = stubClient({ queue: [[summary("dlg_1")], []] })
    const runner = makeRunner(
      client,
      async () => {
        await new Promise((r) => setTimeout(r, 40))
        return { resultMarkdown: "ok" }
      },
      { heartbeatMs: 10 }
    )

    runner.start()
    await new Promise((r) => setTimeout(r, 80))
    runner.stop()

    expect(calls.heartbeats).toBeGreaterThanOrEqual(2)
  })

  it("notifyAvailable() triggers a drain without waiting for the poll timer", async () => {
    const { client, calls } = stubClient({ queue: [[]] })
    const runner = makeRunner(client, async () => ({}))

    runner.start()
    await flush()
    const baseline = calls.listOpen
    runner.notifyAvailable()
    await flush()
    runner.stop()

    expect(calls.listOpen).toBeGreaterThan(baseline)
  })

  it("files an access request exactly once when a nudged id 404s (no stream grant)", async () => {
    const { client, calls } = stubClient({
      queue: [[]],
      claimError: (id) => (id === "dlg_nudged" ? new ThreaApiError("gone", 404, "NOT_FOUND") : null),
    })
    const runner = makeRunner(client, async () => ({}))

    runner.start()
    await flush()
    runner.notifyAvailable({ delegationId: "dlg_nudged" })
    await flush()
    // Re-nudge for the same id: claim 404s again, but the request is not re-filed.
    runner.notifyAvailable({ delegationId: "dlg_nudged" })
    await flush()
    runner.stop()

    expect(calls.claims.map((c) => c.id)).toEqual(["dlg_nudged", "dlg_nudged"])
    expect(calls.accessRequests).toEqual(["dlg_nudged"])
  })

  it("retries the access request on a later nudge after a transient filing failure", async () => {
    const { client, calls } = stubClient({
      queue: [[]],
      claimError: (id) => (id === "dlg_retry" ? new ThreaApiError("gone", 404, "NOT_FOUND") : null),
    })
    let failFirst = true
    client.requestAccess = async (id: string) => {
      if (failFirst) {
        failFirst = false
        throw new ThreaApiError("boom", 500, "INTERNAL")
      }
      calls.accessRequests.push(id)
      return { requestId: `bar_${id}`, status: "open" }
    }
    const runner = makeRunner(client, async () => ({}))

    runner.start()
    await flush()
    runner.notifyAvailable({ delegationId: "dlg_retry" })
    await flush()
    expect(calls.accessRequests).toEqual([])
    // The transient failure must not poison the id: the next nudge re-files.
    runner.notifyAvailable({ delegationId: "dlg_retry" })
    await flush()
    runner.stop()

    expect(calls.accessRequests).toEqual(["dlg_retry"])
  })

  it("does not file an access request when a nudged claim loses the race (409)", async () => {
    const { client, calls } = stubClient({
      queue: [[]],
      claimError: (id) => (id === "dlg_nudged" ? new ThreaApiError("conflict", 409, "DELEGATION_NOT_OPEN") : null),
    })
    const runner = makeRunner(client, async () => ({}))

    runner.start()
    await flush()
    runner.notifyAvailable({ delegationId: "dlg_nudged" })
    await flush()
    runner.stop()

    expect(calls.claims.map((c) => c.id)).toEqual(["dlg_nudged"])
    expect(calls.accessRequests).toEqual([])
  })

  it("does not file an access request for a plain list-path 404 (only nudge-carried ids)", async () => {
    const { client, calls } = stubClient({
      queue: [[summary("dlg_listed")], []],
      claimError: (id) => (id === "dlg_listed" ? new ThreaApiError("gone", 404, "NOT_FOUND") : null),
    })
    const runner = makeRunner(client, async () => ({}))

    runner.start()
    await flush()
    runner.stop()

    expect(calls.claims.map((c) => c.id)).toEqual(["dlg_listed"])
    expect(calls.accessRequests).toEqual([])
  })

  for (const trigger of ["nudge", "poll"] as const) {
    it(`stop wins while a ${trigger} claim is in flight`, async () => {
      let releaseClaim!: (task: ClaimedDelegation) => void
      let claimStarted!: () => void
      const started = new Promise<void>((resolve) => (claimStarted = resolve))
      const calls: StubCalls["fails"] = []
      const client = {
        listOpen: async () => (trigger === "poll" ? [summary("dlg_race")] : []),
        claim: () =>
          new Promise<ClaimedDelegation>((resolve) => {
            releaseClaim = resolve
            claimStarted()
          }),
        fail: async (id: string, token: string, errorMessage: string) => {
          calls.push({ id, token, errorMessage })
        },
      } as unknown as DelegationClient
      let executions = 0
      const runner = makeRunner(client, async () => {
        executions += 1
      })

      runner.start()
      if (trigger === "nudge") runner.notifyAvailable({ delegationId: "dlg_race" })
      await started
      const stopped = runner.stop()
      releaseClaim(claimed("dlg_race"))
      await stopped

      expect({ executions, calls }).toEqual({
        executions: 0,
        calls: [{ id: "dlg_race", token: "token-dlg_race", errorMessage: DELEGATION_STOP_REASON }],
      })
    })
  }

  for (const trigger of ["list", "nudge"] as const) {
    it(`strict stop propagates a failed ${trigger} claim release`, async () => {
      let releaseClaim!: (task: ClaimedDelegation) => void
      let claimStarted!: () => void
      const started = new Promise<void>((resolve) => (claimStarted = resolve))
      const logs: string[] = []
      const releaseError = new Error(trigger === "list" ? "release 500" : "release timed out")
      const client = {
        listOpen: async () => (trigger === "list" ? [summary("dlg_race")] : []),
        claim: () =>
          new Promise<ClaimedDelegation>((resolve) => {
            releaseClaim = resolve
            claimStarted()
          }),
        fail: async () => {
          throw releaseError
        },
      } as unknown as DelegationClient
      const runner = makeRunner(client, async () => {}, { log: (message) => logs.push(message) })

      runner.start()
      if (trigger === "nudge") runner.notifyAvailable({ delegationId: "dlg_race" })
      await started
      const stopped = runner.stop(DELEGATION_STOP_REASON, { strict: true })
      releaseClaim(claimed("dlg_race"))

      await expect(stopped).rejects.toBe(releaseError)
      expect(logs).toEqual([
        `delegation dlg_race stop fail report failed: ${releaseError.message}`,
        `delegation drain failed: ${releaseError.message}`,
      ])
    })
  }

  it("normal shutdown stop clears an overlapping reconnect strict stop", async () => {
    let releaseClaim!: (task: ClaimedDelegation) => void
    let claimStarted!: () => void
    const started = new Promise<void>((resolve) => (claimStarted = resolve))
    const releaseError = new Error("release 500")
    const client = {
      listOpen: async () => [summary("dlg_race")],
      claim: () =>
        new Promise<ClaimedDelegation>((resolve) => {
          releaseClaim = resolve
          claimStarted()
        }),
      fail: async () => {
        throw releaseError
      },
    } as unknown as DelegationClient
    const runner = makeRunner(client, async () => {})

    runner.start()
    await started
    const reconnectStop = runner.stop(DELEGATION_STOP_REASON, { strict: true })
    const shutdownStop = runner.stop()
    releaseClaim(claimed("dlg_race"))

    await expect(reconnectStop).resolves.toBeUndefined()
    await expect(shutdownStop).resolves.toBeUndefined()
  })

  it("strict stop propagates a failed terminal fail for active work", async () => {
    let rejectExecution!: (error: Error) => void
    let executionStarted!: () => void
    const started = new Promise<void>((resolve) => (executionStarted = resolve))
    const releaseError = new Error("terminal fail 500")
    const { client } = stubClient({ queue: [[summary("dlg_active")]], failError: releaseError })
    const runner = makeRunner(
      client,
      () =>
        new Promise((_, reject) => {
          rejectExecution = reject
          executionStarted()
        })
    )

    runner.start()
    await started
    const stopped = runner.stop(DELEGATION_STOP_REASON, { strict: true })
    rejectExecution(new Error("reconnect"))

    await expect(stopped).rejects.toBe(releaseError)
  })

  it("does nothing after stop()", async () => {
    const { client, calls } = stubClient({ queue: [[summary("dlg_1")], []] })
    const runner = makeRunner(client, async () => ({}))
    runner.start()
    await flush()
    runner.stop()
    const baseline = calls.listOpen
    runner.notifyAvailable()
    await flush()
    expect(calls.listOpen).toBe(baseline)
  })
})
