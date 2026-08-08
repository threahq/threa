import { describe, expect, it, jest } from "bun:test"
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
  releases: Array<{ id: string; token: string }>
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
    releases: [],
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
    release: async (id: string, token: string) => {
      calls.releases.push({ id, token })
      return { ...summary(id), status: "open" }
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

  it("contains a synchronous executor throw, clears its heartbeat, and continues draining", async () => {
    jest.useFakeTimers()
    try {
      const { client, calls } = stubClient({
        queue: [[summary("dlg_sync"), summary("dlg_next")], [summary("dlg_next")], []],
      })
      const runner = makeRunner(
        client,
        ((task: ClaimedDelegation) => {
          if (task.id === "dlg_sync") throw new Error("sync exploded")
          return Promise.resolve({ resultMarkdown: "done" })
        }) as DelegationExecutor,
        { heartbeatMs: 10 }
      )

      runner.start()
      for (let index = 0; calls.listOpen < 3 && index < 100; index += 1) await Promise.resolve()

      expect(calls.fails).toEqual([{ id: "dlg_sync", token: "token-dlg_sync", errorMessage: "sync exploded" }])
      expect(calls.completes.map((call) => call.id)).toEqual(["dlg_next"])
      expect(calls.releases).toEqual([])
      jest.advanceTimersByTime(100)
      await Promise.resolve()
      expect(calls.heartbeats).toBe(0)
      await runner.stop()
    } finally {
      jest.useRealTimers()
    }
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
      const calls: StubCalls["releases"] = []
      const client = {
        listOpen: async () => (trigger === "poll" ? [summary("dlg_race")] : []),
        claim: () =>
          new Promise<ClaimedDelegation>((resolve) => {
            releaseClaim = resolve
            claimStarted()
          }),
        release: async (id: string, token: string) => {
          calls.push({ id, token })
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
        calls: [{ id: "dlg_race", token: "token-dlg_race" }],
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
        release: async () => {
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
        `delegation dlg_race release failed: ${releaseError.message}`,
        `delegation drain failed: ${releaseError.message}`,
      ])
    })
  }

  it("normal shutdown does not downgrade an overlapping strict stop", async () => {
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
      release: async () => {
        throw releaseError
      },
    } as unknown as DelegationClient
    const runner = makeRunner(client, async () => {})

    runner.start()
    await started
    const reconnectStop = runner.stop(DELEGATION_STOP_REASON, { strict: true })
    const shutdownStop = runner.stop()
    releaseClaim(claimed("dlg_race"))

    await expect(reconnectStop).rejects.toBe(releaseError)
    await expect(shutdownStop).resolves.toBeUndefined()
  })

  for (const phase of ["active", "pending"] as const) {
    for (const order of ["normal-strict", "strict-normal"] as const) {
      it(`${phase} overlapping stop applies policy per caller in ${order} order`, async () => {
        let started!: () => void
        const operationStarted = new Promise<void>((resolve) => (started = resolve))
        const releaseError = new Error(`${phase} release failed`)
        const client =
          phase === "active"
            ? {
                listOpen: async () => [summary("dlg_overlap")],
                claim: async () => claimed("dlg_overlap"),
                release: async () => {
                  throw releaseError
                },
              }
            : {
                listOpen: async () => [summary("dlg_overlap")],
                claim: () => {
                  started()
                  return new Promise<never>(() => {})
                },
              }
        const runner = makeRunner(
          client as unknown as DelegationClient,
          phase === "active"
            ? async () => {
                started()
                return new Promise<never>(() => {})
              }
            : async () => {},
          { shutdownWaitMs: phase === "pending" ? 5 : 100 }
        )
        runner.start()
        await operationStarted
        const firstStrict = order === "strict-normal"
        const first = runner.stop(DELEGATION_STOP_REASON, { strict: firstStrict })
        const second = runner.stop(DELEGATION_STOP_REASON, { strict: !firstStrict })
        const strict = firstStrict ? first : second
        const normal = firstStrict ? second : first

        if (phase === "active") await expect(strict).rejects.toBe(releaseError)
        else await expect(strict).rejects.toThrow("stop timed out after 5ms")
        await expect(normal).resolves.toBeUndefined()
      })
    }
  }

  it("strict stop rejects on a pending claim timeout", async () => {
    let started!: () => void
    const claimStarted = new Promise<void>((resolve) => (started = resolve))
    const client = {
      listOpen: async () => [summary("dlg_pending")],
      claim: () => {
        started()
        return new Promise<never>(() => {})
      },
    } as unknown as DelegationClient
    const runner = makeRunner(client, async () => {}, { shutdownWaitMs: 5 })
    runner.start()
    await claimStarted
    await expect(runner.stop(DELEGATION_STOP_REASON, { strict: true })).rejects.toThrow("stop timed out after 5ms")
  })

  it("strict stop propagates a failed release for active work", async () => {
    let rejectExecution!: (error: Error) => void
    let executionStarted!: () => void
    const started = new Promise<void>((resolve) => (executionStarted = resolve))
    const releaseError = new Error("release 500")
    const { client } = stubClient({ queue: [[summary("dlg_active")]] })
    client.release = async () => {
      throw releaseError
    }
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

  it("releases a stale pre-stop claim after restart without executing it", async () => {
    let resolveOld!: (task: ClaimedDelegation) => void
    let listCount = 0
    const releases: Array<{ id: string; token: string }> = []
    const executions: string[] = []
    const client = {
      listOpen: async () => {
        listCount += 1
        if (listCount === 1) return [summary("dlg_old")]
        if (listCount === 2) return [summary("dlg_new")]
        return []
      },
      claim: async (id: string) =>
        id === "dlg_old" ? new Promise<ClaimedDelegation>((resolve) => (resolveOld = resolve)) : claimed(id),
      release: async (id: string, token: string) => {
        releases.push({ id, token })
      },
      complete: async () => summary("done"),
    } as unknown as DelegationClient
    const runner = makeRunner(
      client,
      async (task) => {
        executions.push(task.id)
      },
      { shutdownWaitMs: 5 }
    )

    runner.start()
    await flush()
    await runner.stop()
    runner.start()
    await flush()
    resolveOld(claimed("dlg_old"))
    await flush()
    await runner.stop()

    expect(executions).toEqual(["dlg_new"])
    expect(releases).toEqual([{ id: "dlg_old", token: "token-dlg_old" }])
  })

  it("detaches a stopped non-cooperative executor and clears its heartbeat before restart", async () => {
    let listCount = 0
    let heartbeats = 0
    const completes: string[] = []
    const fails: string[] = []
    const client = {
      listOpen: async () => {
        listCount += 1
        if (listCount === 1) return [summary("dlg_stuck")]
        if (listCount === 2) return [summary("dlg_new")]
        return []
      },
      claim: async (id: string) => claimed(id),
      heartbeat: async () => {
        heartbeats += 1
      },
      release: () => new Promise<never>(() => {}),
      complete: async (id: string) => {
        completes.push(id)
        return summary(id)
      },
      fail: async (id: string) => {
        fails.push(id)
        return summary(id)
      },
    } as unknown as DelegationClient
    const runner = makeRunner(
      client,
      async (task) => {
        if (task.id === "dlg_stuck") return new Promise<never>(() => {})
        return { resultMarkdown: "done" }
      },
      { heartbeatMs: 2, shutdownWaitMs: 5 }
    )

    runner.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await runner.stop()
    const stoppedHeartbeatCount = heartbeats
    runner.start()
    await flush()
    await runner.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(heartbeats).toBe(stoppedHeartbeatCount)
    expect(completes).toEqual(["dlg_new"])
    expect(fails).toEqual([])
  })

  it("aborts on heartbeat 404 and never completes or releases the lost claim", async () => {
    const { client, calls } = stubClient({ queue: [[summary("dlg_lost")], []] })
    client.heartbeat = async () => {
      calls.heartbeats += 1
      throw new ThreaApiError("lost", 404, "NOT_FOUND")
    }
    let aborted = false
    const runner = makeRunner(
      client,
      async (_task, ctx) => {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener(
            "abort",
            () => {
              aborted = true
              resolve()
            },
            { once: true }
          )
        )
        return { resultMarkdown: "must not complete" }
      },
      { heartbeatMs: 5 }
    )
    runner.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await runner.stop()
    expect({ aborted, completes: calls.completes, fails: calls.fails, releases: calls.releases }).toEqual({
      aborted: true,
      completes: [],
      fails: [],
      releases: [],
    })
  })

  it("aborts on status-report 404 and suppresses terminal writes", async () => {
    const { client, calls } = stubClient({ queue: [[summary("dlg_lost")], []] })
    client.reportStatus = async () => {
      throw new ThreaApiError("lost", 404, "NOT_FOUND")
    }
    const runner = makeRunner(client, async (_task, ctx) => {
      await ctx.reportStatus("working")
      return { resultMarkdown: "must not complete" }
    })
    runner.start()
    await flush()
    await runner.stop()
    expect({ completes: calls.completes, fails: calls.fails, releases: calls.releases }).toEqual({
      completes: [],
      fails: [],
      releases: [],
    })
  })

  for (const failure of [new ThreaApiError("unavailable", 500, "INTERNAL"), new Error("network unavailable")]) {
    const label = failure instanceof ThreaApiError ? "API 500" : "network error"
    it(`keeps executing after a transient status-report ${label}`, async () => {
      const { client, calls } = stubClient({ queue: [[summary("dlg_live")], []] })
      client.reportStatus = async () => {
        throw failure
      }
      const runner = makeRunner(client, async (_task, ctx) => {
        await ctx.reportStatus("working")
        return { resultMarkdown: "done" }
      })
      runner.start()
      await flush()
      await runner.stop()
      expect({
        completes: calls.completes.map((call) => call.id),
        fails: calls.fails,
        releases: calls.releases,
      }).toEqual({
        completes: ["dlg_live"],
        fails: [],
        releases: [],
      })
    })

    it(`keeps executing after a transient heartbeat ${label}`, async () => {
      const { client, calls } = stubClient({ queue: [[summary("dlg_live")], []] })
      client.heartbeat = async () => {
        calls.heartbeats += 1
        throw failure
      }
      const runner = makeRunner(
        client,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { resultMarkdown: "done" }
        },
        { heartbeatMs: 5 }
      )
      runner.start()
      await new Promise((resolve) => setTimeout(resolve, 40))
      await runner.stop()
      expect({
        completes: calls.completes.map((call) => call.id),
        fails: calls.fails,
        releases: calls.releases,
      }).toEqual({
        completes: ["dlg_live"],
        fails: [],
        releases: [],
      })
    })
  }

  for (const trigger of ["heartbeat", "status"] as const) {
    for (const late of ["resolve", "reject"] as const) {
      it(`drains after ${trigger} 404 with a non-cooperative executor and safely consumes late ${late}`, async () => {
        let settleOld!: (value?: { resultMarkdown: string }) => void
        let rejectOld!: (error: Error) => void
        let listCount = 0
        const completes: string[] = []
        const fails: string[] = []
        const releases: string[] = []
        const client = {
          listOpen: async () => {
            listCount += 1
            if (listCount === 1) return [summary("dlg_old")]
            if (listCount === 2) return [summary("dlg_new")]
            return []
          },
          claim: async (id: string) => claimed(id),
          heartbeat: async (id: string) => {
            if (trigger === "heartbeat" && id === "dlg_old") throw new ThreaApiError("lost", 404, "NOT_FOUND")
          },
          reportStatus: async (id: string) => {
            if (trigger === "status" && id === "dlg_old") throw new ThreaApiError("lost", 404, "NOT_FOUND")
          },
          complete: async (id: string) => {
            completes.push(id)
            return summary(id)
          },
          fail: async (id: string) => {
            fails.push(id)
            return summary(id)
          },
          release: async (id: string) => {
            releases.push(id)
            return summary(id)
          },
        } as unknown as DelegationClient
        const runner = makeRunner(
          client,
          async (task, ctx) => {
            if (task.id === "dlg_new") return { resultMarkdown: "done" }
            if (trigger === "status") await ctx.reportStatus("working")
            return new Promise((resolve, reject) => {
              settleOld = resolve
              rejectOld = reject
            })
          },
          { heartbeatMs: 2 }
        )

        runner.start()
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(completes).toEqual(["dlg_new"])
        if (late === "resolve") settleOld({ resultMarkdown: "stale" })
        else rejectOld(new Error("late failure"))
        await flush()
        await runner.stop()
        expect({ completes, fails, releases }).toEqual({ completes: ["dlg_new"], fails: [], releases: [] })
      })
    }
  }

  it("controlled stop aborts active work and releases instead of completing or failing", async () => {
    const { client, calls } = stubClient({ queue: [[summary("dlg_active")], []] })
    let started!: () => void
    const executionStarted = new Promise<void>((resolve) => (started = resolve))
    const runner = makeRunner(client, async (_task, ctx) => {
      started()
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
      return { resultMarkdown: "must not complete" }
    })
    runner.start()
    await executionStarted
    await runner.stop()
    expect({ completes: calls.completes, fails: calls.fails, releases: calls.releases }).toEqual({
      completes: [],
      fails: [],
      releases: [{ id: "dlg_active", token: "token-dlg_active" }],
    })
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
