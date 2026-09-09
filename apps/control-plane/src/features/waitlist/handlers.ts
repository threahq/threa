import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threahq/backend-common"
import type { WaitlistService } from "./service"

const signUpSchema = z.object({
  // Trim before validating so a pasted address with stray whitespace still
  // passes; the service lowercases for the UNIQUE dedupe.
  email: z.string().trim().pipe(z.email()),
  // Where the signup came from (e.g. "home", "about"). Optional metadata, capped
  // so a crafted payload can't bloat the row. The charset is a page identifier
  // our own forms set, and it is narrow on purpose: the value is rendered inside
  // a markdown code span when the signup is announced, and a backtick or newline
  // would close that span early and let the rest be parsed as a mention (INV-64).
  // Never gates the signup: an empty, oversized, non-string, or off-charset
  // source is caught and dropped (-> undefined) rather than failing the parse
  // and rejecting a valid email.
  source: z
    .string()
    .trim()
    .max(40)
    .regex(/^[\w./-]*$/)
    .optional()
    .catch(undefined),
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
        source: parsed.data.source || null,
      })
      res.json({ ok: true })
    },
  }
}
