import { afterEach, describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"
import type { Pool } from "pg"
import { EnclaveClaimNudge, notifyEnclaveInvocationAvailable, ENCLAVE_INVOCATION_CHANNEL } from "./claim-nudge"

type FakeClient = EventEmitter & { query: ReturnType<typeof mock>; release: ReturnType<typeof mock> }

function fakeClient(): FakeClient {
  const client = new EventEmitter() as FakeClient
  client.query = mock(async () => ({}) as never)
  client.release = mock(() => {})
  return client
}

function fakePool(client: FakeClient): Pool {
  return { connect: mock(async () => client) } as unknown as Pool
}

// A large keepalive so the interval never fires mid-test; stop() clears it.
function makeNudge(client: FakeClient) {
  return new EnclaveClaimNudge({ listenPool: fakePool(client), keepaliveMs: 60_000 })
}

afterEach(() => mock.restore())

describe("notifyEnclaveInvocationAvailable", () => {
  it("rings the channel doorbell on the given connection", async () => {
    const query = mock(async () => ({}) as never)
    await notifyEnclaveInvocationAvailable({ query } as never)
    expect(query).toHaveBeenCalledWith(`NOTIFY ${ENCLAVE_INVOCATION_CHANNEL}`)
  })
})

describe("EnclaveClaimNudge", () => {
  it("LISTENs on the channel and wakes a parked waiter when a notification arrives", async () => {
    const client = fakeClient()
    const nudge = makeNudge(client)
    await nudge.start()
    expect(client.query).toHaveBeenCalledWith(`LISTEN ${ENCLAVE_INVOCATION_CHANNEL}`)

    let live: boolean | undefined
    const wait = nudge.waitForInvocation({ timeoutMs: 5_000 }).then((result) => {
      live = result
    })
    await Promise.resolve()
    expect(live).toBeUndefined() // still parked

    client.emit("notification", { channel: ENCLAVE_INVOCATION_CHANNEL })
    await wait
    expect(live).toBe(true) // woken, not stopped — re-claim

    await nudge.stop()
  })

  it("resolves true on its own timeout when no nudge arrives (so the long-poll re-claims and gives up on its deadline)", async () => {
    const nudge = makeNudge(fakeClient())
    await nudge.start()
    await expect(nudge.waitForInvocation({ timeoutMs: 10 })).resolves.toBe(true)
    await nudge.stop()
  })

  it("resolves true immediately for a non-positive budget or an already-aborted signal", async () => {
    const nudge = makeNudge(fakeClient())
    await nudge.start()
    await expect(nudge.waitForInvocation({ timeoutMs: 0 })).resolves.toBe(true)
    await expect(nudge.waitForInvocation({ timeoutMs: 5_000, signal: AbortSignal.abort() })).resolves.toBe(true)
    await nudge.stop()
  })

  it("resolves true when the request aborts mid-wait", async () => {
    const nudge = makeNudge(fakeClient())
    await nudge.start()
    const ac = new AbortController()
    const wait = nudge.waitForInvocation({ timeoutMs: 5_000, signal: ac.signal })
    ac.abort()
    await expect(wait).resolves.toBe(true)
    await nudge.stop()
  })

  it("releases parked waiters with false on stop, so the long-poll gives up instead of re-parking", async () => {
    const client = fakeClient()
    const nudge = makeNudge(client)
    await nudge.start()
    const wait = nudge.waitForInvocation({ timeoutMs: 60_000 })
    await nudge.stop()
    await expect(wait).resolves.toBe(false)
    expect(client.release).toHaveBeenCalled()
  })

  it("answers false immediately once stopped, never re-parking", async () => {
    const nudge = makeNudge(fakeClient())
    await nudge.start()
    await nudge.stop()
    await expect(nudge.waitForInvocation({ timeoutMs: 60_000 })).resolves.toBe(false)
  })
})
