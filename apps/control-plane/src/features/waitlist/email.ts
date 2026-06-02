import { Resend } from "resend"
import { logger } from "@threa/backend-common"

/**
 * Sends the one-time waitlist confirmation (single opt-in). Kept behind an
 * interface so production uses Resend while dev and tests use a stub that
 * logs instead of calling out, mirroring the auth-service pattern.
 */
export interface WaitlistEmailSender {
  sendConfirmation(email: string): Promise<void>
}

const SUBJECT = "You're on the Threa waitlist"

const TEXT = `Thanks for joining the Threa waitlist.

Threa is early and invite-only for now. I'll email you when there's a spot.

— Kristoffer`

const HTML = `<div style="font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.6; color: #1f1c18; max-width: 480px;">
  <p>Thanks for joining the Threa waitlist.</p>
  <p>Threa is early and invite-only for now. I'll email you when there's a spot.</p>
  <p style="margin-top: 24px;">— Kristoffer</p>
</div>`

export class ResendWaitlistEmailSender implements WaitlistEmailSender {
  private resend: Resend
  private from: string

  constructor(deps: { apiKey: string; from: string }) {
    this.resend = new Resend(deps.apiKey)
    this.from = deps.from
  }

  async sendConfirmation(email: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: email,
      subject: SUBJECT,
      text: TEXT,
      html: HTML,
    })
    // Resend returns errors in-band rather than throwing; surface them so the
    // caller can log (the signup itself is not failed by a send error).
    if (error) {
      throw new Error(`Resend send failed: ${error.name}: ${error.message}`)
    }
  }
}

/** No-op sender for dev and tests; records intent without sending. */
export class StubWaitlistEmailSender implements WaitlistEmailSender {
  async sendConfirmation(email: string): Promise<void> {
    logger.debug({ to: email }, "Waitlist confirmation email (stub, not sent)")
  }
}
