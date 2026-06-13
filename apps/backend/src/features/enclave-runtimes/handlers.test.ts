import { afterEach, describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { createEnclaveRuntimesHandlers } from "./handlers"
import type { EnclaveRuntimesService } from "./service"
import type { EnclaveClaimService } from "./claim-service"
import type { EnclaveClaimWaiter } from "./claim-nudge"

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    end() {
      return this
    },
  }
}

const validBody = {
  instanceId: "enci_01",
  keyId: "eik_01",
}

function buildHandlers(
  overrides: {
    registerKey?: ReturnType<typeof mock>
    isRegisteredLive?: ReturnType<typeof mock>
    claimTurn?: ReturnType<typeof mock>
    enclaveClaimNudge?: EnclaveClaimWaiter | null
  } = {}
) {
  return createEnclaveRuntimesHandlers({
    enclaveRuntimesService: {
      registerKey: overrides.registerKey ?? mock(async () => ({ id: "elr_01" })),
      isRegisteredLive: overrides.isRegisteredLive ?? mock(async () => true),
    } as unknown as EnclaveRuntimesService,
    enclaveClaimService: {
      claimTurn: overrides.claimTurn ?? mock(async () => null),
    } as unknown as EnclaveClaimService,
    enclaveClaimNudge: overrides.enclaveClaimNudge ?? null,
  })
}

// Express requests are event emitters; the long-poll subscribes to "close".
function makeReq(body: unknown, on?: (event: string, cb: () => void) => void): Request {
  return { body, on: on ?? (() => {}), off: () => {} } as unknown as Request
}

describe("createEnclaveRuntimesHandlers.registerKey", () => {
  afterEach(() => mock.restore())

  it("rejects a public key that is not 32 bytes", async () => {
    const registerKey = mock(async () => ({ id: "elr_01" }))
    const handlers = buildHandlers({ registerKey })
    const req = { body: { ...validBody, publicKey: Buffer.alloc(16).toString("base64") } } as Request
    const res = makeRes()

    await expect(handlers.registerKey(req, res as unknown as Response)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PUBLIC_KEY",
    })
    expect(registerKey).not.toHaveBeenCalled()
  })

  it("registers a valid 32-byte public key", async () => {
    const registerKey = mock(async () => ({ id: "elr_01" }))
    const handlers = buildHandlers({ registerKey })
    const req = { body: { ...validBody, publicKey: Buffer.alloc(32).toString("base64") } } as Request
    const res = makeRes()

    await handlers.registerKey(req, res as unknown as Response)

    expect(registerKey).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ id: "elr_01" })
  })
})

describe("createEnclaveRuntimesHandlers.claim", () => {
  afterEach(() => mock.restore())

  it("rejects an unregistered or revoked EIK before touching the queue", async () => {
    const isRegisteredLive = mock(async () => false)
    const claimTurn = mock(async () => null)
    const handlers = buildHandlers({ isRegisteredLive, claimTurn })
    const res = makeRes()

    await expect(
      handlers.claim({ body: { keyId: "eik_ghost" } } as Request, res as unknown as Response)
    ).rejects.toMatchObject({ status: 404, code: "ENCLAVE_RUNTIME_NOT_FOUND" })
    expect(claimTurn).not.toHaveBeenCalled()
  })

  it("answers 204 with no body when there is no claimable work", async () => {
    const handlers = buildHandlers({ claimTurn: mock(async () => null) })
    const res = makeRes()

    await handlers.claim({ body: { keyId: "eik_01" } } as Request, res as unknown as Response)

    expect(res.statusCode).toBe(204)
    expect(res.body).toBeUndefined()
  })

  it("hands the claimed assignment back as 200 { assignment }", async () => {
    const assignment = { sessionId: "session_1", streamId: "stream_1" }
    const claimTurn = mock(async () => assignment)
    const handlers = buildHandlers({ claimTurn })
    const res = makeRes()

    await handlers.claim({ body: { keyId: "eik_01" } } as Request, res as unknown as Response)

    expect(claimTurn).toHaveBeenCalledWith("eik_01")
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ assignment })
  })

  it("long-polls: parks on the nudge and answers 200 once work appears", async () => {
    const assignment = { sessionId: "session_1", streamId: "stream_1" }
    let calls = 0
    // Empty on the immediate claim; the work shows up after the first nudge.
    const claimTurn = mock(async () => (++calls >= 2 ? assignment : null))
    const waitForInvocation = mock(async () => true)
    const handlers = buildHandlers({ claimTurn, enclaveClaimNudge: { waitForInvocation } })
    const res = makeRes()

    await handlers.claim(makeReq({ keyId: "eik_01", waitMs: 5_000 }), res as unknown as Response)

    expect(waitForInvocation).toHaveBeenCalledTimes(1)
    expect(claimTurn).toHaveBeenCalledTimes(2)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ assignment })
  })

  it("long-polls: answers 204 when the budget lapses with no work", async () => {
    const claimTurn = mock(async () => null)
    // Faithful stand-in: resolve `true` (a timeout, not a shutdown) after the
    // requested budget so the loop's deadline elapses and it gives up — no real
    // wake-up arrives.
    const waitForInvocation = mock(
      ({ timeoutMs }: { timeoutMs: number }) => new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs))
    )
    const handlers = buildHandlers({ claimTurn, enclaveClaimNudge: { waitForInvocation } })
    const res = makeRes()

    await handlers.claim(makeReq({ keyId: "eik_01", waitMs: 20 }), res as unknown as Response)

    expect(res.statusCode).toBe(204)
    expect(res.body).toBeUndefined()
  })

  it("long-polls: stops without writing when the instance hangs up mid-wait", async () => {
    let closeHandler: (() => void) | undefined
    const claimTurn = mock(async () => null)
    // The wait ends because the client disconnected — fire the close handler,
    // then resolve as the real nudge would when the request aborts.
    const waitForInvocation = mock(async () => {
      closeHandler?.()
      return true
    })
    const handlers = buildHandlers({ claimTurn, enclaveClaimNudge: { waitForInvocation } })
    const res = makeRes()
    const req = makeReq({ keyId: "eik_01", waitMs: 5_000 }, (event, cb) => {
      if (event === "close") closeHandler = cb
    })

    await handlers.claim(req, res as unknown as Response)

    // Claimed only the pre-wait attempt; never wrote to the dead socket.
    expect(claimTurn).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200) // untouched default — no .status() call
    expect(res.body).toBeUndefined()
  })

  it("long-polls: gives up with 204 when the nudge stops (shutdown), without re-parking", async () => {
    const claimTurn = mock(async () => null)
    // A stopped nudge resolves the wait with false; the loop must break rather
    // than re-park (which would hang graceful shutdown for the whole budget).
    const waitForInvocation = mock(async () => false)
    const handlers = buildHandlers({ claimTurn, enclaveClaimNudge: { waitForInvocation } })
    const res = makeRes()

    await handlers.claim(makeReq({ keyId: "eik_01", waitMs: 5_000 }), res as unknown as Response)

    expect(waitForInvocation).toHaveBeenCalledTimes(1) // one wait, then break — no re-park
    expect(res.statusCode).toBe(204)
  })

  it("skips the long-poll when no nudge is wired, answering 204 immediately", async () => {
    const claimTurn = mock(async () => null)
    const handlers = buildHandlers({ claimTurn, enclaveClaimNudge: null })
    const res = makeRes()

    await handlers.claim(makeReq({ keyId: "eik_01", waitMs: 5_000 }), res as unknown as Response)

    expect(claimTurn).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(204)
  })
})
