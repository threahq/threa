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

Kristoffer
Threa · workplace chat that remembers
threa.io`

// Email-client-safe HTML: table layout, all styles inline, hex colors, and a
// system font stack (Space Grotesk leads but won't load in most clients, so it
// falls back cleanly). On-brand with the marketing site: warm paper canvas, a
// hairline card, and a single mono gold eyebrow as the one accent.
const SANS = "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"

const HTML = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>You're on the Threa waitlist</title>
</head>
<body style="margin:0; padding:0; background-color:#f2efe9;">
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; opacity:0;">Thanks for joining the Threa waitlist. I'll email you when there's a spot.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2efe9;">
<tr>
<td align="center" style="padding:40px 20px;">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px; max-width:520px;">
<tr>
<td style="padding:0 4px 22px 4px; font-family:${MONO}; font-size:13px; letter-spacing:0.18em; text-transform:uppercase; color:#20201c;">Threa</td>
</tr>
<tr>
<td style="background-color:#fdfcf9; border:1px solid #e7e1d8; border-radius:6px; padding:36px;">
<p style="margin:0 0 20px 0; font-family:${MONO}; font-size:11px; letter-spacing:0.16em; text-transform:uppercase; color:#d2952d;">You're on the list</p>
<p style="margin:0 0 16px 0; font-family:${SANS}; font-size:16px; line-height:1.6; color:#20201c;">Thanks for joining the Threa waitlist.</p>
<p style="margin:0 0 28px 0; font-family:${SANS}; font-size:16px; line-height:1.6; color:#46413b;">Threa is early and invite-only for now. I'll email you when there's a spot.</p>
<p style="margin:0; font-family:${SANS}; font-size:16px; line-height:1.6; color:#20201c;">Kristoffer</p>
</td>
</tr>
<tr>
<td style="padding:18px 4px 0 4px; font-family:${SANS}; font-size:12px; line-height:1.5; color:#7c756b;">Threa &middot; workplace chat that remembers<br />
<a href="https://threa.io" style="color:#9a7320; text-decoration:none;">threa.io</a></td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`

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
