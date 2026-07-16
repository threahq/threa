import { describe, expect, it, mock } from "bun:test"
import type { Socket } from "socket.io"
import type { AuthService } from "@threa/backend-common"
import { createSocketAuthMiddleware } from "./socket-auth"

function fakeSocket(cookie?: string) {
  return { handshake: { headers: cookie ? { cookie } : {} }, data: {} } as unknown as Socket
}

const COOKIE = "wos_session=tok"

describe("createSocketAuthMiddleware", () => {
  it("stamps the workos user id on success — via verify-only, never the refreshing path", async () => {
    // A WS handshake can't carry Set-Cookie back, so a refresh here would
    // rotate the WorkOS refresh token into a sealed session the browser never
    // receives. The middleware must use verifySession exclusively.
    const authenticateSession = mock(async () => ({ success: true, user: { id: "workos_wrong" } }))
    const authService = {
      verifySession: mock(async () => ({ success: true, user: { id: "workos_1" } })),
      authenticateSession,
    } as unknown as AuthService
    const middleware = createSocketAuthMiddleware(authService)
    const socket = fakeSocket(COOKIE)
    const next = mock((_err?: unknown) => {})

    await middleware(socket, next)

    expect(next).toHaveBeenCalledWith()
    expect(socket.data.workosUserId).toBe("workos_1")
    expect(authenticateSession).not.toHaveBeenCalled()
  })

  it("rejects when the session cookie is missing", async () => {
    const authService = { verifySession: mock(async () => ({ success: true })) } as unknown as AuthService
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware(authService)(fakeSocket(), next)

    expect(authService.verifySession).not.toHaveBeenCalled()
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it("rejects an expired token so the client refreshes over HTTP and reconnects", async () => {
    const authService = {
      verifySession: mock(async () => ({ success: false, reason: "invalid_jwt", terminal: false })),
    } as unknown as AuthService
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware(authService)(fakeSocket(COOKIE), next)

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it("fails closed when verifySession throws", async () => {
    const authService = {
      verifySession: mock(async () => {
        throw new Error("WorkOS unreachable")
      }),
    } as unknown as AuthService
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware(authService)(fakeSocket(COOKIE), next)

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })
})
