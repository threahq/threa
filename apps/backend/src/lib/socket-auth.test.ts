import { describe, expect, it, mock } from "bun:test"
import type { Socket } from "socket.io"
import type { AuthService } from "@threa/backend-common"
import { createSocketAuthMiddleware } from "./socket-auth"

function fakeSocket(cookie?: string) {
  return { handshake: { headers: cookie ? { cookie } : {} }, data: {} } as unknown as Socket
}

const COOKIE = "wos_session=tok"

describe("createSocketAuthMiddleware", () => {
  it("stamps the workos user id on success", async () => {
    const authService = {
      authenticateSession: mock(async () => ({ success: true, user: { id: "workos_1" } })),
    } as unknown as AuthService
    const middleware = createSocketAuthMiddleware(authService)
    const socket = fakeSocket(COOKIE)
    const next = mock((_err?: unknown) => {})

    await middleware(socket, next)

    expect(next).toHaveBeenCalledWith()
    expect(socket.data.workosUserId).toBe("workos_1")
  })

  it("rejects when the session cookie is missing", async () => {
    const authService = { authenticateSession: mock(async () => ({ success: true })) } as unknown as AuthService
    const next = mock((_err?: unknown) => {})

    await createSocketAuthMiddleware(authService)(fakeSocket(), next)

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

    await createSocketAuthMiddleware(authService)(fakeSocket(COOKIE), next)

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })
})
