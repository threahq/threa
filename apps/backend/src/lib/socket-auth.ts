import type { Socket } from "socket.io"
import type { ExtendedError } from "socket.io"
import { parseCookies, SESSION_COOKIE_NAME } from "@threa/backend-common"
import type { AuthService } from "@threa/backend-common"

/**
 * Shared Socket.io connection auth. Both the main namespace and the dedicated
 * voice namespace authenticate the same way — session cookie → WorkOS user —
 * so the logic lives here once rather than being duplicated per namespace.
 *
 * On success it stamps `socket.data.workosUserId`; downstream handlers resolve
 * the workspace-scoped user from there.
 */
export function createSocketAuthMiddleware(authService: AuthService) {
  return async (socket: Socket, next: (err?: ExtendedError) => void): Promise<void> => {
    const cookies = parseCookies(socket.handshake.headers.cookie || "")
    const session = cookies[SESSION_COOKIE_NAME]
    if (!session) return next(new Error("No session cookie"))

    const result = await authService.authenticateSession(session)
    if (!result.success || !result.user) return next(new Error("Authentication failed"))

    socket.data.workosUserId = result.user.id
    next()
  }
}
