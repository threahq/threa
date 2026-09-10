import { describe, expect, it, mock } from "bun:test"
import type { Socket } from "socket.io"
import { ACCOUNT_ASSERTION_SOCKET_FIELD, AuthErrorCodes } from "@threahq/types"
import { SessionCookies, type AuthService } from "@threahq/backend-common"
import { createSocketAuthMiddleware } from "./socket-auth"

function fakeSocket(cookie?: string, auth?: Record<string, unknown>) {
  return { handshake: { headers: cookie ? { cookie } : {}, ...(auth && { auth }) }, data: {} } as unknown as Socket
}

const sessionCookies = new SessionCookies({
  name: "wos_session",
  options: { path: "/", httpOnly: true, secure: false, sameSite: "lax" },
})
const COOKIE = "wos_session=tok"

describe("createSocketAuthMiddleware", () => {
  it("stamps the workos user id on success", async () => {
    const authService = {
      authenticateSession: mock(async () => ({ success: true, user: { id: "workos_1" } })),
    } as unknown as AuthService
    const middleware = createSocketAuthMiddleware({ authService, sessionCookies })
    const socket = fakeSocket(COOKIE)
    const next = mock((_err?: unknown) => {})

    await middleware(socket, next)

    expect(next).toHaveBeenCalledWith()
    expect(socket.data.workosUserId).toBe("workos_1")
  })

  it("refuses a handshake formed for a different signed-in account", async () => {
    const authService = {
      authenticateSession: mock(async () => ({ success: true, user: { id: "workos_b" } })),
    } as unknown as AuthService
    const socket = fakeSocket(COOKIE, { [ACCOUNT_ASSERTION_SOCKET_FIELD]: "workos_a" })
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware({ authService, sessionCookies })(socket, next)

    const error = next.mock.calls[0][0] as Error & { data?: unknown }
    expect({ message: error.message, data: error.data, stamped: socket.data.workosUserId }).toEqual({
      message: "This browser is signed in as a different account",
      data: { code: AuthErrorCodes.ACCOUNT_MISMATCH },
      stamped: undefined,
    })
  })

  it("accepts a handshake whose assertion matches the session's account", async () => {
    const authService = {
      authenticateSession: mock(async () => ({ success: true, user: { id: "workos_a" } })),
    } as unknown as AuthService
    const socket = fakeSocket(COOKIE, { [ACCOUNT_ASSERTION_SOCKET_FIELD]: "workos_a" })
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware({ authService, sessionCookies })(socket, next)

    expect(next).toHaveBeenCalledWith()
    expect(socket.data.workosUserId).toBe("workos_a")
  })

  it("refuses a handshake whose assertion is supplied but unreadable", async () => {
    // The handshake auth object is client JSON, so the assertion can arrive as
    // any type. A `typeof === "string"` guard treats a non-string as absent and
    // lets a long-lived subscription past the check entirely.
    const authService = {
      authenticateSession: mock(async () => ({ success: true, user: { id: "workos_b" } })),
    } as unknown as AuthService
    const socket = fakeSocket(COOKIE, { [ACCOUNT_ASSERTION_SOCKET_FIELD]: ["workos_a"] })
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware({ authService, sessionCookies })(socket, next)

    const error = next.mock.calls[0][0] as Error & { data?: unknown }
    expect({ message: error.message, data: error.data, stamped: socket.data.workosUserId }).toEqual({
      message: "Malformed account assertion",
      // No revalidate code: a malformed claim is a client bug, not an account
      // that moved, so the client must not treat it as one.
      data: undefined,
      stamped: undefined,
    })
  })

  it("rejects when the session cookie is missing", async () => {
    const authService = { authenticateSession: mock(async () => ({ success: true })) } as unknown as AuthService
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware({ authService, sessionCookies })(fakeSocket(), next)

    expect(authService.authenticateSession).not.toHaveBeenCalled()
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it("fails closed when authenticateSession throws", async () => {
    const authService = {
      authenticateSession: mock(async () => {
        throw new Error("WorkOS unreachable")
      }),
    } as unknown as AuthService
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware({ authService, sessionCookies })(fakeSocket(COOKIE), next)

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })
})
