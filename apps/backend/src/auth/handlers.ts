import type { Request, Response } from "express"
import { displayNameFromWorkos } from "@threahq/backend-common"
import { HttpError } from "../lib/errors"

export function createAuthHandlers() {
  return {
    async me(req: Request, res: Response) {
      const authUser = req.authUser
      if (!authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }

      const name = displayNameFromWorkos(authUser)
      res.json({
        id: authUser.id,
        email: authUser.email,
        name,
      })
    },
  }
}
