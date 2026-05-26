import { afterEach, describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { createUserE2eKeysHandlers } from "./handlers"
import { HttpError } from "../../lib/errors"
import type { UserE2eKeysService } from "./service"
import type { KdfParams } from "./repository"

const KDF_PARAMS: KdfParams = { algorithm: "argon2id", m: 65536, t: 3, p: 1, version: 19 }

function fakeRes() {
  const res: Partial<Response> = {}
  res.status = mock((_code: number) => res as Response)
  res.json = mock((_body: unknown) => res as Response)
  res.end = mock(() => res as Response)
  return res as Response
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { id: "usr_1" },
    workspaceId: "ws_1",
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request
}

function makeService(overrides: Partial<UserE2eKeysService> = {}): UserE2eKeysService {
  return overrides as UserE2eKeysService
}

describe("createUserE2eKeysHandlers.get", () => {
  afterEach(() => mock.restore())

  it("returns the active key serialized as base64", async () => {
    const created = new Date("2026-05-26T12:00:00.000Z")
    const getActive = mock(async () => ({
      id: "e2ek_01",
      userId: "usr_1",
      workspaceId: "ws_1",
      keyId: "e2ek_01",
      publicKey: Buffer.from([1, 2, 3]),
      encryptedPrivateBundle: Buffer.from([9, 8, 7]),
      kdfSalt: Buffer.from([4, 5, 6]),
      kdfParams: KDF_PARAMS,
      createdAt: created,
      revokedAt: null,
    }))
    const handlers = createUserE2eKeysHandlers({
      userE2eKeysService: makeService({ getActive: getActive as any }),
    })

    const res = fakeRes()
    await handlers.get(fakeReq(), res)

    expect(getActive).toHaveBeenCalledWith("ws_1", "usr_1")
    expect(res.json).toHaveBeenCalledTimes(1)
    const [body] = (res.json as ReturnType<typeof mock>).mock.calls[0]
    expect(body.key.keyId).toBe("e2ek_01")
    expect(body.key.publicKey).toBe(Buffer.from([1, 2, 3]).toString("base64"))
    expect(body.key.encryptedPrivateBundle).toBe(Buffer.from([9, 8, 7]).toString("base64"))
    expect(body.key.kdfSalt).toBe(Buffer.from([4, 5, 6]).toString("base64"))
    expect(body.key.kdfParams).toEqual(KDF_PARAMS)
    expect(body.key.createdAt).toBe("2026-05-26T12:00:00.000Z")
  })

  it("throws 404 when the user has not set up a key", async () => {
    const getActive = mock(async () => null)
    const handlers = createUserE2eKeysHandlers({
      userE2eKeysService: makeService({ getActive: getActive as any }),
    })

    await expect(handlers.get(fakeReq(), fakeRes())).rejects.toBeInstanceOf(HttpError)
  })
})

describe("createUserE2eKeysHandlers.set", () => {
  afterEach(() => mock.restore())

  const validBody = {
    publicKey: Buffer.from([1, 2, 3]).toString("base64"),
    encryptedPrivateBundle: Buffer.from([9, 8, 7]).toString("base64"),
    kdfSalt: Buffer.from([4, 5, 6]).toString("base64"),
    kdfParams: KDF_PARAMS,
  }

  it("decodes base64 to Buffer before handing off to the service", async () => {
    let captured: any = null
    const setUserKey = mock(async (input: any) => {
      captured = input
      return {
        rotated: false,
        key: {
          id: "e2ek_01",
          userId: "usr_1",
          workspaceId: "ws_1",
          keyId: "e2ek_01",
          publicKey: input.publicKey,
          encryptedPrivateBundle: input.encryptedPrivateBundle,
          kdfSalt: input.kdfSalt,
          kdfParams: input.kdfParams,
          createdAt: new Date(),
          revokedAt: null,
        },
      }
    })
    const handlers = createUserE2eKeysHandlers({
      userE2eKeysService: makeService({ setUserKey: setUserKey as any }),
    })

    const res = fakeRes()
    await handlers.set(fakeReq({ body: validBody }), res)

    expect(setUserKey).toHaveBeenCalledTimes(1)
    expect(captured.publicKey).toBeInstanceOf(Buffer)
    expect(captured.publicKey).toEqual(Buffer.from([1, 2, 3]))
    expect(captured.encryptedPrivateBundle).toEqual(Buffer.from([9, 8, 7]))
    expect(captured.kdfSalt).toEqual(Buffer.from([4, 5, 6]))
    expect(res.status).toHaveBeenCalledWith(201)
  })

  it("returns 200 with rotated:true when the service reports a rotation", async () => {
    const setUserKey = mock(async (_input: any) => ({
      rotated: true,
      key: {
        id: "e2ek_02",
        userId: "usr_1",
        workspaceId: "ws_1",
        keyId: "e2ek_02",
        publicKey: Buffer.from([1]),
        encryptedPrivateBundle: Buffer.from([2]),
        kdfSalt: Buffer.from([3]),
        kdfParams: KDF_PARAMS,
        createdAt: new Date(),
        revokedAt: null,
      },
    }))
    const handlers = createUserE2eKeysHandlers({
      userE2eKeysService: makeService({ setUserKey: setUserKey as any }),
    })

    const res = fakeRes()
    await handlers.set(fakeReq({ body: validBody }), res)

    expect(res.status).toHaveBeenCalledWith(200)
    const [body] = (res.json as ReturnType<typeof mock>).mock.calls[0]
    expect(body.rotated).toBe(true)
  })

  it("rejects payloads missing required fields with a 400 HttpError", async () => {
    const handlers = createUserE2eKeysHandlers({ userE2eKeysService: makeService() })
    await expect(handlers.set(fakeReq({ body: { publicKey: "abc" } }), fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("rejects payloads with non-base64 characters", async () => {
    const handlers = createUserE2eKeysHandlers({ userE2eKeysService: makeService() })
    await expect(
      handlers.set(
        fakeReq({
          body: { ...validBody, publicKey: "not base64!" },
        }),
        fakeRes()
      )
    ).rejects.toBeInstanceOf(HttpError)
  })

  it("rejects payloads with unrecognized KDF algorithm", async () => {
    const handlers = createUserE2eKeysHandlers({ userE2eKeysService: makeService() })
    await expect(
      handlers.set(
        fakeReq({
          body: { ...validBody, kdfParams: { ...KDF_PARAMS, algorithm: "scrypt" } },
        }),
        fakeRes()
      )
    ).rejects.toBeInstanceOf(HttpError)
  })

  it("rejects payloads with absurdly oversized public key", async () => {
    const handlers = createUserE2eKeysHandlers({ userE2eKeysService: makeService() })
    const huge = "A".repeat(8192)
    await expect(handlers.set(fakeReq({ body: { ...validBody, publicKey: huge } }), fakeRes())).rejects.toBeInstanceOf(
      HttpError
    )
  })
})

describe("createUserE2eKeysHandlers.revoke", () => {
  afterEach(() => mock.restore())

  it("revokes the active key and returns 204", async () => {
    const revokeActive = mock(async () => undefined)
    const handlers = createUserE2eKeysHandlers({
      userE2eKeysService: makeService({ revokeActive: revokeActive as any }),
    })

    const res = fakeRes()
    await handlers.revoke(fakeReq(), res)

    expect(revokeActive).toHaveBeenCalledWith("ws_1", "usr_1")
    expect(res.status).toHaveBeenCalledWith(204)
    expect(res.end).toHaveBeenCalledTimes(1)
  })

  it("surfaces 404 from the service when no active key exists", async () => {
    const revokeActive = mock(async () => {
      throw new HttpError("No active E2E key to revoke", { status: 404, code: "E2E_KEY_NOT_FOUND" })
    })
    const handlers = createUserE2eKeysHandlers({
      userE2eKeysService: makeService({ revokeActive: revokeActive as any }),
    })

    await expect(handlers.revoke(fakeReq(), fakeRes())).rejects.toBeInstanceOf(HttpError)
  })
})
