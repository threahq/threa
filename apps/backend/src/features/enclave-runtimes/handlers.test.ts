import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { createEnclaveRuntimesHandlers } from "./handlers"
import { EnclaveRuntimesRepository } from "./repository"
import type { EnclaveRuntimesService } from "./service"
import type { EnclaveClaimService } from "./claim-service"

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

function buildHandlers(overrides: { registerKey?: ReturnType<typeof mock>; claimTurn?: ReturnType<typeof mock> } = {}) {
  return createEnclaveRuntimesHandlers({
    pool: {} as Pool,
    enclaveRuntimesService: {
      registerKey: overrides.registerKey ?? mock(async () => ({ id: "elr_01" })),
    } as unknown as EnclaveRuntimesService,
    enclaveClaimService: {
      claimTurn: overrides.claimTurn ?? mock(async () => null),
    } as unknown as EnclaveClaimService,
  })
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

  const RUNTIME = {
    id: "elr_01",
    instanceId: "enci_01",
    keyId: "eik_01",
    publicKey: new Uint8Array(32),
    registeredAt: new Date(),
    lastSeenAt: new Date(),
    revokedAt: null,
  }

  it("rejects an unregistered or revoked EIK before touching the queue", async () => {
    spyOn(EnclaveRuntimesRepository, "findByKeyId").mockResolvedValue(null)
    const claimTurn = mock(async () => null)
    const handlers = buildHandlers({ claimTurn })
    const res = makeRes()

    await expect(
      handlers.claim({ body: { keyId: "eik_ghost" } } as Request, res as unknown as Response)
    ).rejects.toMatchObject({ status: 404, code: "ENCLAVE_RUNTIME_NOT_FOUND" })
    expect(claimTurn).not.toHaveBeenCalled()
  })

  it("answers 204 with no body when there is no claimable work", async () => {
    spyOn(EnclaveRuntimesRepository, "findByKeyId").mockResolvedValue(RUNTIME)
    const handlers = buildHandlers({ claimTurn: mock(async () => null) })
    const res = makeRes()

    await handlers.claim({ body: { keyId: "eik_01" } } as Request, res as unknown as Response)

    expect(res.statusCode).toBe(204)
    expect(res.body).toBeUndefined()
  })

  it("hands the claimed assignment back as 200 { assignment }", async () => {
    spyOn(EnclaveRuntimesRepository, "findByKeyId").mockResolvedValue(RUNTIME)
    const assignment = { sessionId: "session_1", streamId: "stream_1" }
    const claimTurn = mock(async () => assignment)
    const handlers = buildHandlers({ claimTurn })
    const res = makeRes()

    await handlers.claim({ body: { keyId: "eik_01" } } as Request, res as unknown as Response)

    expect(claimTurn).toHaveBeenCalledWith("eik_01")
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ assignment })
  })
})
