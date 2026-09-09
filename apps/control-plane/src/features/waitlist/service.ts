import type { Pool } from "pg"
import { waitlistId, logger } from "@threahq/backend-common"
import { WaitlistRepository } from "./repository"
import type { WaitlistEmailSender } from "./email"
import type { WaitlistNotifier } from "./notifier"

interface Dependencies {
  pool: Pool
  emailSender: WaitlistEmailSender
  notifier: WaitlistNotifier
}

export class WaitlistService {
  private pool: Pool
  private emailSender: WaitlistEmailSender
  private notifier: WaitlistNotifier

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.emailSender = deps.emailSender
    this.notifier = deps.notifier
  }

  /**
   * Record a signup. Email is normalized (trimmed + lowercased) so the UNIQUE
   * constraint dedupes case/whitespace variants. Idempotent: a repeat signup
   * returns normally without surfacing that the email already exists, and does
   * not re-send the confirmation.
   */
  async signUp(input: { email: string; source: string | null }): Promise<void> {
    const email = input.email.trim().toLowerCase()
    const id = waitlistId()
    const created = await WaitlistRepository.insert(this.pool, {
      id,
      email,
      source: input.source,
    })
    if (!created) return

    logger.info({ source: input.source }, "Waitlist signup")

    // Both side effects are best-effort: a failure must not fail the signup,
    // which is already persisted. Log and move on.
    try {
      await this.emailSender.sendConfirmation(email)
    } catch (err) {
      logger.error({ err }, "Waitlist confirmation email failed to send")
    }

    try {
      await this.notifier.notifySignup({ id, email, source: input.source })
    } catch (err) {
      logger.error({ err }, "Waitlist signup notification failed to post")
    }
  }
}
