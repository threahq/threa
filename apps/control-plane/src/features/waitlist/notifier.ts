import { logger } from "@threahq/backend-common"

export interface WaitlistSignup {
  id: string
  email: string
  source: string | null
}

/**
 * Announces a new signup so a human finds out. Behind an interface for the same
 * reason as `WaitlistEmailSender`: production posts into Threa, dev and tests
 * log instead of calling out.
 */
export interface WaitlistNotifier {
  notifySignup(signup: WaitlistSignup): Promise<void>
}

const REQUEST_TIMEOUT_MS = 10_000

function buildContent(signup: WaitlistSignup): string {
  const from = signup.source ? ` · from \`${signup.source}\`` : ""
  // The address is a code span so an `@` in it can never be read as mention
  // input by the ingestion-time resolver (INV-64).
  return `**New waitlist signup**\n\n\`${signup.email}\`${from}`
}

/** Posts the signup as a bot message through the public API. */
export class ThreaWaitlistNotifier implements WaitlistNotifier {
  private url: string
  private apiKey: string

  constructor(deps: { apiBaseUrl: string; apiKey: string; workspaceId: string; streamId: string }) {
    const base = deps.apiBaseUrl.replace(/\/+$/, "")
    this.url = `${base}/api/v1/workspaces/${deps.workspaceId}/streams/${deps.streamId}/messages`
    this.apiKey = deps.apiKey
  }

  async notifySignup(signup: WaitlistSignup): Promise<void> {
    // clientMessageId keys on the row id, so a retry after a timeout collapses
    // onto the same message via the backend's ON CONFLICT (stream_id,
    // client_message_id) guard instead of posting the signup twice.
    const payload = {
      content: buildContent(signup),
      clientMessageId: `waitlist:${signup.id}`,
      metadata: {
        source: "waitlist",
        "waitlist.id": signup.id,
        ...(signup.source ? { "waitlist.source": signup.source } : {}),
      },
    }

    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`Threa API returned ${res.status}: ${body}`)
    }
  }
}

/** No-op notifier for dev and tests; records intent without posting. */
export class StubWaitlistNotifier implements WaitlistNotifier {
  async notifySignup(signup: WaitlistSignup): Promise<void> {
    logger.debug({ waitlistId: signup.id }, "Waitlist signup notification (stub, not posted)")
  }
}
