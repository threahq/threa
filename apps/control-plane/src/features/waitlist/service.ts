import type { Pool } from "pg"
import { waitlistId, logger } from "@threa/backend-common"
import { WaitlistRepository } from "./repository"
import type { WaitlistEmailSender } from "./email"

interface Dependencies {
  pool: Pool
  emailSender: WaitlistEmailSender
}

export class WaitlistService {
  private pool: Pool
  private emailSender: WaitlistEmailSender

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.emailSender = deps.emailSender
  }

  /**
   * Record a signup. Email is normalized (trimmed + lowercased) so the UNIQUE
   * constraint dedupes case/whitespace variants. Idempotent: a repeat signup
   * returns normally without surfacing that the email already exists, and does
   * not re-send the confirmation.
   */
  async signUp(input: { email: string; source: string | null }): Promise<void> {
    const email = input.email.trim().toLowerCase()
    const created = await WaitlistRepository.insert(this.pool, {
      id: waitlistId(),
      email,
      source: input.source,
    })
    if (!created) return

    logger.info({ source: input.source }, "Waitlist signup")

    // Confirmation is best-effort: a send failure must not fail the signup,
    // which is already persisted. Log and move on.
    try {
      await this.emailSender.sendConfirmation(email)
    } catch (err) {
      logger.error({ err }, "Waitlist confirmation email failed to send")
    }
  }
}
