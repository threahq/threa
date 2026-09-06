import { describe, expect, mock, test } from "bun:test"
import type { Request, Response } from "express"
import { HttpError, type AuthService } from "@threahq/backend-common"
import { SessionCookies } from "@threahq/backend-common"
import { createControlPlaneAuthHandlers } from "../../src/features/auth"
import type { AccountsService } from "../../src/features/accounts"
import type { AuthLogService } from "../../src/features/auth-log"

const sessionCookies = new SessionCookies({
  name: "wos_session_test_auth_log",
  options: { path: "/", httpOnly: true, secure: false, sameSite: "lax" },
})

describe("CP auth callback failure → auth_log own-handler row", () => {
  function makeHandlers(recordCallbackFailure: ReturnType<typeof mock>) {
    const authService = {
      authenticateWithCode: mock(async () => ({ success: false })),
    } as unknown as AuthService
    const authLogService = { recordCallbackFailure } as unknown as AuthLogService
    return createControlPlaneAuthHandlers({
      authService,
      sessionCookies,
      accountsService: {} as unknown as AccountsService,
      frontendUrl: "https://app.example.com",
      dedicatedRedirectHosts: [],
      authLogService,
    })
  }

  test("records a denied callback-failure row (ip/user-agent from req) before throwing 401", async () => {
    const recordCallbackFailure = mock(async () => {})
    const handlers = makeHandlers(recordCallbackFailure)

    const req = {
      query: { code: "bad-code" },
      body: {},
      headers: { "user-agent": "Mozilla/5.0" },
      ip: "203.0.113.7",
      cookies: {},
    } as unknown as Request
    const res = { redirect: mock(() => {}), json: mock(() => {}) } as unknown as Response

    await expect(handlers.callback(req, res)).rejects.toMatchObject({
      status: 401,
      code: "AUTH_FAILED",
    } satisfies Partial<HttpError>)

    expect(recordCallbackFailure).toHaveBeenCalledTimes(1)
    expect(recordCallbackFailure).toHaveBeenCalledWith({
      email: null,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
    })
  })

  test("records a denied magic-auth-verify-failure row with the attempted email before throwing 401", async () => {
    const recordMagicAuthVerifyFailure = mock(async () => {})
    const authService = {
      authenticateWithMagicAuth: mock(async () => ({ success: false })),
    } as unknown as AuthService
    const authLogService = { recordMagicAuthVerifyFailure } as unknown as AuthLogService
    const handlers = createControlPlaneAuthHandlers({
      authService,
      sessionCookies,
      accountsService: {} as unknown as AccountsService,
      frontendUrl: "https://app.example.com",
      dedicatedRedirectHosts: [],
      authLogService,
    })

    const req = {
      query: {},
      body: { email: "probe@example.com", code: "000000", intent: "add" },
      headers: { "user-agent": "Mozilla/5.0" },
      ip: "203.0.113.9",
      cookies: {},
    } as unknown as Request
    const res = { redirect: mock(() => {}), json: mock(() => {}) } as unknown as Response

    await expect(handlers.magicVerify(req, res)).rejects.toMatchObject({
      status: 401,
      code: "INVALID_CODE",
    } satisfies Partial<HttpError>)

    expect(recordMagicAuthVerifyFailure).toHaveBeenCalledTimes(1)
    expect(recordMagicAuthVerifyFailure).toHaveBeenCalledWith({
      email: "probe@example.com",
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
    })
  })
})
