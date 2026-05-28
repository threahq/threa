import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { createEnclaveRuntimesHandlers } from "./handlers"
import type { EnclaveRuntimesService } from "./service"

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
  instanceUrl: "https://enclave.internal",
}

function buildHandlers(registerKey: ReturnType<typeof mock>) {
  return createEnclaveRuntimesHandlers({
    enclaveRuntimesService: { registerKey } as unknown as EnclaveRuntimesService,
    instanceUrlAllowedPrefixes: [],
  })
}

describe("createEnclaveRuntimesHandlers.registerKey", () => {
  it("rejects a public key that is not 32 bytes", async () => {
    const registerKey = mock(async () => ({ id: "elr_01" }))
    const handlers = buildHandlers(registerKey)
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
    const handlers = buildHandlers(registerKey)
    const req = { body: { ...validBody, publicKey: Buffer.alloc(32).toString("base64") } } as Request
    const res = makeRes()

    await handlers.registerKey(req, res as unknown as Response)

    expect(registerKey).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ id: "elr_01" })
  })
})
