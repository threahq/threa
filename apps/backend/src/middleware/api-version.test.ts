import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { createApiVersionGate } from "./api-version"
import * as versions from "../features/public-api/versions"
import { CURRENT_API_VERSION, type VersionChange } from "../features/public-api/versions"

function makeReqRes(opts: {
  header?: string
  userApiKey?: { id: string; apiVersion: string }
  botApiKey?: { id: string; apiVersion: string }
  body?: unknown
}) {
  const headers: Record<string, string | undefined> = { "threa-version": opts.header }
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    userApiKey: opts.userApiKey,
    botApiKey: opts.botApiKey,
    body: opts.body,
  } as unknown as Request

  const jsonCalls: unknown[] = []
  const setHeaders: Record<string, unknown> = {}
  const res = {
    locals: {} as Record<string, unknown>,
    setHeader: (name: string, value: unknown) => {
      setHeaders[name] = value
    },
    json: (payload: unknown) => {
      jsonCalls.push(payload)
      return res
    },
  } as unknown as Response

  return { req, res, jsonCalls, setHeaders }
}

let changesAfterSpy: ReturnType<typeof spyOn> | null = null

afterEach(() => {
  changesAfterSpy?.mockRestore()
  changesAfterSpy = null
})

describe("createApiVersionGate — resolution precedence", () => {
  test("header override beats the key pin", () => {
    const gate = createApiVersionGate("listMessages")
    const { req, res, setHeaders } = makeReqRes({
      header: CURRENT_API_VERSION,
      userApiKey: { id: "uak_1", apiVersion: "2099-01-01" },
    })
    let err: unknown = "unset"
    gate(req, res, ((e?: unknown) => (err = e)) as NextFunction)

    expect(err).toBeUndefined()
    expect(req.apiVersion).toBe(CURRENT_API_VERSION)
    expect(setHeaders["Threa-Version"]).toBe(CURRENT_API_VERSION)
    expect(res.locals.apiVersionLog).toEqual({
      apiVersion: CURRENT_API_VERSION,
      versionSource: "header",
      keyId: "uak_1",
      operationId: "listMessages",
    })
  })

  test("falls back to the user key pin when no header is sent", () => {
    const gate = createApiVersionGate("listMessages")
    const { req, res } = makeReqRes({ userApiKey: { id: "uak_1", apiVersion: "2099-01-01" } })
    gate(req, res, (() => {}) as NextFunction)

    expect(req.apiVersion as string).toBe("2099-01-01")
    expect(res.locals.apiVersionLog).toMatchObject({ versionSource: "key", keyId: "uak_1" })
  })

  test("falls back to the bot key pin when no header is sent", () => {
    const gate = createApiVersionGate("sendMessage")
    const { req, res } = makeReqRes({ botApiKey: { id: "bak_1", apiVersion: CURRENT_API_VERSION } })
    gate(req, res, (() => {}) as NextFunction)

    expect(req.apiVersion).toBe(CURRENT_API_VERSION)
    expect(res.locals.apiVersionLog).toMatchObject({ versionSource: "key", keyId: "bak_1" })
  })

  test("falls back to CURRENT when neither header nor key context is present", () => {
    const gate = createApiVersionGate("listMessages")
    const { req, res } = makeReqRes({})
    gate(req, res, (() => {}) as NextFunction)

    expect(req.apiVersion).toBe(CURRENT_API_VERSION)
    expect(res.locals.apiVersionLog).toMatchObject({ keyId: null })
  })

  test("throws INVALID_API_VERSION on an unknown header", () => {
    const gate = createApiVersionGate("listMessages")
    const { req, res } = makeReqRes({ header: "1999-01-01" })
    expect(() => gate(req, res, (() => {}) as NextFunction)).toThrow(/Unknown API version/)
  })
})

describe("createApiVersionGate — transform pipeline", () => {
  test("upgrades the request oldest→newest and downgrades the response newest→oldest", () => {
    const older: VersionChange = {
      version: "2026-11-01" as VersionChange["version"],
      description: "older",
      operations: new Set(["listMessages"]),
      upgradeRequest: (body) => ({ ...(body as object), older: true }),
      downgradeResponse: (payload) => {
        const arr = (payload as { steps: string[] }).steps
        return { steps: [...arr, "down-older"] }
      },
    }
    const newer: VersionChange = {
      version: "2026-12-01" as VersionChange["version"],
      description: "newer",
      operations: new Set(["listMessages"]),
      upgradeRequest: (body) => ({ ...(body as object), newer: true }),
      downgradeResponse: (payload) => {
        const arr = (payload as { steps: string[] }).steps
        return { steps: [...arr, "down-newer"] }
      },
    }
    // changesAfter returns ascending order; the gate applies upgrades in that
    // order and downgrades in reverse.
    changesAfterSpy = spyOn(versions, "changesAfter").mockReturnValue([older, newer])

    const gate = createApiVersionGate("listMessages")
    const { req, res, jsonCalls } = makeReqRes({
      userApiKey: { id: "uak_1", apiVersion: CURRENT_API_VERSION },
      body: { base: true },
    })
    gate(req, res, (() => {}) as NextFunction)

    expect(req.body).toEqual({ base: true, older: true, newer: true })

    res.json({ steps: ["handler"] })
    expect(jsonCalls).toHaveLength(1)
    expect(jsonCalls[0]).toEqual({ steps: ["handler", "down-newer", "down-older"] })
  })

  test("does not wrap res.json when no change targets the operation", () => {
    const foreign: VersionChange = {
      version: "2026-11-01" as VersionChange["version"],
      description: "unrelated",
      operations: new Set(["sendMessage"]),
      upgradeRequest: (body) => ({ ...(body as object), touched: true }),
    }
    changesAfterSpy = spyOn(versions, "changesAfter").mockReturnValue([foreign])

    const gate = createApiVersionGate("listMessages")
    const { req } = makeReqRes({ userApiKey: { id: "uak_1", apiVersion: CURRENT_API_VERSION }, body: { base: true } })
    const { res, jsonCalls } = makeReqRes({})
    gate(req, res, (() => {}) as NextFunction)

    expect(req.body).toEqual({ base: true })
    res.json({ untouched: true })
    expect(jsonCalls[0]).toEqual({ untouched: true })
  })
})
