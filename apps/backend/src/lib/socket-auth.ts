import type { Socket } from "socket.io"
import type { ExtendedError } from "socket.io"
import { ACCOUNT_ASSERTION_SOCKET_FIELD, AuthErrorCodes } from "@threahq/types"
import { parseCookies } from "@threahq/backend-common"
import type { AuthService, SessionCookies } from "@threahq/backend-common"

interface Dependencies {
  authService: AuthService
  sessionCookies: SessionCookies
}

/**
 * Shared Socket.io connection auth. Both the main namespace and the dedicated
 * voice namespace authenticate the same way — session cookie → WorkOS user —
 * so the logic lives here once rather than being duplicated per namespace.
 *
 * On success it stamps `socket.data.workosUserId`; downstream handlers resolve
 * the workspace-scoped user from there.
 */
export function createSocketAuthMiddleware({ authService, sessionCookies }: Dependencies) {
  return async (socket: Socket, next: (err?: ExtendedError) => void): Promise<void> => {
    const cookies = parseCookies(socket.handshake.headers.cookie || "")
    const session = sessionCookies.read(cookies)
    if (!session) return next(new Error("No session cookie"))

    // Socket.io won't catch a rejected promise from an async middleware, so a
    // throwing auth call (network/WorkOS error) would hang the connection until
    // timeout. Fail closed: reject the connection rather than leave it pending.
    try {
      const result = await authService.authenticateSession(session)
      if (!result.success || !result.user) return next(new Error("Authentication failed"))
      // The handshake states which signed-in account the client built this
      // socket for. The cookie can name a different one by the time it lands
      // (another tab switched), and a socket is a long-lived subscription —
      // accepting it would stream that account's events into this page. The
      // client revalidates and reconnects. An absent assertion is an older
      // client and connects as before.
      const asserted = socket.handshake.auth?.[ACCOUNT_ASSERTION_SOCKET_FIELD]
      if (asserted !== undefined && asserted !== null) {
        // Supplied but unreadable (a non-string handshake value) is refused
        // rather than waved through as if absent — same rule as the HTTP
        // assertion. Only the mismatch carries the revalidate code; a malformed
        // claim is a client bug, not an account that moved.
        const claim = typeof asserted === "string" ? asserted.trim() : ""
        if (!claim) return next(new Error("Malformed account assertion"))
        if (claim !== result.user.id) {
          const error: ExtendedError = new Error("This browser is signed in as a different account")
          error.data = { code: AuthErrorCodes.ACCOUNT_MISMATCH }
          return next(error)
        }
      }
      socket.data.workosUserId = result.user.id
      next()
    } catch {
      next(new Error("Authentication failed"))
    }
  }
}
