import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threa/backend-common"
import type { WaitlistService } from "./service"

const signUpSchema = z.object({
  // Trim before validating so a pasted address with stray whitespace still
  // passes; the service lowercases for the UNIQUE dedupe.
  email: z.string().trim().pipe(z.email()),
  // Where the signup came from (e.g. "home", "about"). Optional, capped so a
  // crafted payload can't bloat the row.
  source: z.string().trim().min(1).max(40).optional(),
  // Honeypot: a hidden field real users never fill. Bots that auto-complete
  // every input trip it, and we silently drop the submission.
  hp: z.string().optional(),
})

interface Dependencies {
  waitlistService: WaitlistService
}

export function createWaitlistHandlers({ waitlistService }: Dependencies) {
  return {
    async signUp(req: Request, res: Response) {
      const parsed = signUpSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("A valid email is required", { status: 400, code: "INVALID_EMAIL" })
      }

      // Pretend success for honeypot hits so bots get no signal.
      if (parsed.data.hp && parsed.data.hp.trim().length > 0) {
        res.json({ ok: true })
        return
      }

      await waitlistService.signUp({
        email: parsed.data.email,
        source: parsed.data.source ?? null,
      })
      res.json({ ok: true })
    },
  }
}
