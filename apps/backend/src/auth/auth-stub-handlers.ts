import type { RequestHandler } from "express"
import { z } from "zod"
import {
  renderLoginPage,
  decodeAndSanitizeRedirectState,
  displayNameFromWorkos,
  type SessionCookies,
  type StubAuthService,
} from "@threahq/backend-common"
import { WORKSPACE_INVITABLE_ROLES, WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import type { WorkspaceService } from "../features/workspaces"
import type { StreamService } from "../features/streams"
import type { InvitationService } from "../features/invitations"
import { HttpError } from "../lib/errors"

const workspaceJoinSchema = z.object({
  role: z.enum(WORKSPACE_INVITABLE_ROLES).optional(),
  name: z.string().optional(),
})

interface Dependencies {
  authStubService: StubAuthService
  sessionCookies: SessionCookies
  workspaceService: WorkspaceService
  streamService: StreamService
  invitationService: InvitationService
}

interface AuthStubHandlers {
  getLoginPage: RequestHandler
  handleLogin: RequestHandler
  handleDevLogin: RequestHandler
  handleWorkspaceJoin: RequestHandler
  handleStreamJoin: RequestHandler
}

export function createAuthStubHandlers(deps: Dependencies): AuthStubHandlers {
  const { authStubService, sessionCookies, workspaceService, streamService, invitationService } = deps

  const getLoginPage: RequestHandler = (req, res) => {
    const state = (req.query.state as string) || ""
    res.send(renderLoginPage(state))
  }

  const handleLogin: RequestHandler = async (req, res) => {
    const { email, name, state } = req.body as { email?: string; name?: string; state?: string }

    const { user, session } = await authStubService.devLogin({ email, name })

    // Auto-accept pending invitations (mirrors real WorkOS callback flow)
    const { accepted: acceptedWorkspaceIds } = await invitationService.acceptPendingForEmail(user.email, {
      workosUserId: user.id,
      email: user.email,
      name: user.name,
    })

    sessionCookies.set(res, session, { ...sessionCookies.defaultOptions, secure: false })

    // If user was accepted into exactly one workspace, redirect to setup
    if (acceptedWorkspaceIds.length === 1) {
      return res.redirect(`/w/${acceptedWorkspaceIds[0]}/setup`)
    }

    const redirectTo = decodeAndSanitizeRedirectState(state)
    res.redirect(redirectTo)
  }

  const handleDevLogin: RequestHandler = async (req, res) => {
    const { email, name } = req.body as { email?: string; name?: string }

    const { user, session } = await authStubService.devLogin({ email, name })

    sessionCookies.set(res, session, { ...sessionCookies.defaultOptions, secure: false })

    res.json({ user })
  }

  const handleWorkspaceJoin: RequestHandler = async (req, res) => {
    const workosUserId = req.workosUserId!
    const authUser = req.authUser
    const { workspaceId } = req.params

    const parsed = workspaceJoinSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
    }
    const { role, name: nameOverride } = parsed.data

    if (!authUser) {
      throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
    }

    const name = nameOverride ?? displayNameFromWorkos(authUser)
    const user = await workspaceService.addUser(workspaceId, {
      workosUserId,
      email: authUser.email,
      name,
      role: role ?? WORKSPACE_ROLE_SLUGS.MEMBER,
    })
    res.json({ user })
  }

  const handleStreamJoin: RequestHandler = async (req, res) => {
    const userId = req.user!.id
    const workspaceId = req.workspaceId!
    const { streamId } = req.params

    const member = await streamService.addMember(streamId, userId, workspaceId, userId)
    res.json({ member })
  }

  return {
    getLoginPage,
    handleLogin,
    handleDevLogin,
    handleWorkspaceJoin,
    handleStreamJoin,
  }
}
