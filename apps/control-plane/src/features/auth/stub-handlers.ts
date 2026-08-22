import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError, renderLoginPage, type SessionCookies, type StubAuthService } from "@threa/backend-common"
import type { AccountsService } from "../accounts"
import { parseCallbackState, splitInnerState } from "./callback-state"

const stubLoginSchema = z.object({
  email: z.email(),
  name: z.string().min(1),
  state: z.string().optional(),
})

const devLoginSchema = z.object({
  email: z.email(),
  name: z.string().min(1),
})

interface Dependencies {
  authStubService: StubAuthService
  sessionCookies: SessionCookies
  /**
   * Same collaborator the real OAuth callback uses. The interactive stub
   * login form is the only add-account entry point on stub-auth environments
   * (dev / staging / PR previews), so it must run the identical park/coalesce
   * sequence — otherwise `intent=add` silently overwrites the active session
   * and the user can never hold two accounts.
   */
  accountsService: AccountsService
}

export function createAuthStubHandlers({ authStubService, sessionCookies, accountsService }: Dependencies) {
  return {
    async getLoginPage(req: Request, res: Response) {
      const state = (req.query.state as string) || ""
      res.send(renderLoginPage(state))
    },

    async handleLogin(req: Request, res: Response) {
      const parsed = stubLoginSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid login parameters", { status: 400, code: "INVALID_LOGIN" })
      }
      const { email, name, state } = parsed.data
      const result = await authStubService.devLogin({ email, name })

      // Mirror the real OAuth callback (handlers.ts `callback`). The stub form
      // is served and submitted same-origin, so the forwarded host is ignored
      // and the redirect stays relative.
      const { isAdd, innerState } = parseCallbackState(state)
      let redirectPath = splitInnerState(innerState).redirectPath

      if (isAdd) {
        const parked = await accountsService.addAndParkActive(
          res,
          req.cookies,
          sessionCookies.read(req.cookies),
          result.session,
          result.user.id
        )
        if (parked.ok) {
          // A successful add makes the just-authenticated account active. The
          // pre-add state path belongs to the previous (now parked) account;
          // routing there 403s and bounces straight back via the workspace
          // resolve→switchAccount path, silently undoing the add. Land on the
          // workspace picker instead; ?accountAdded=1 lets the app drop its
          // stale last-workspace pointer so it can't redirect into the old account.
          redirectPath = "/workspaces?accountAdded=1"
        } else {
          redirectPath += `${redirectPath.includes("?") ? "&" : "?"}accountError=${encodeURIComponent(parked.code)}`
        }
      } else {
        sessionCookies.set(res, result.session)
      }
      res.redirect(redirectPath)
    },

    async handleDevLogin(req: Request, res: Response) {
      const parsed = devLoginSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid login parameters", { status: 400, code: "INVALID_LOGIN" })
      }
      const result = await authStubService.devLogin(parsed.data)
      sessionCookies.set(res, result.session)
      res.json({ user: result.user })
    },
  }
}
