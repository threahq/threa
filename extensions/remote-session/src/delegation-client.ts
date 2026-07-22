import { ThreaApiError } from "./client"

const FETCH_TIMEOUT_MS = 30_000
const CALLBACK_TOKEN_HEADER = "X-Threa-Callback-Token"

/** Wire shape of a delegation on the public API (list + lifecycle responses). */
export interface DelegationSummary {
  id: string
  streamId: string
  title: string
  status: string
  claimedByLabel?: string
  statusNote?: string
  resultMessageId?: string
  sourceConversationId?: string
  createdAt: string
  statusChangedAt: string
}

/** The claim response: the executor's full working set plus the one-time token. */
export interface ClaimedDelegation extends DelegationSummary {
  brief: string
  contextRefs: string[]
  /** Cleartext, returned exactly once — send it back as X-Threa-Callback-Token. */
  claimToken: string
  claimExpiresAt: string
}

export interface DelegationClientOptions {
  baseUrl: string
  workspaceId: string
  apiKey: string
}

/**
 * HTTP client for the delegation lifecycle (roadmap 5.3/5.4) — a deliberate
 * sibling of `ThreaClient`, not an extension of it: the bot-runtime surface is
 * bot-key-only with body-carried claim tokens, while delegations accept either
 * key kind and authenticate transitions with the `X-Threa-Callback-Token`
 * header. Keeping the clients separate keeps the two credential/transport
 * models from cross-contaminating (the recorded 5.3 ruling).
 */
export class DelegationClient {
  constructor(private readonly opts: DelegationClientOptions) {}

  private get base(): string {
    return this.opts.baseUrl.replace(/\/$/, "")
  }

  private path(suffix: string): string {
    return `${this.base}/api/v1/workspaces/${this.opts.workspaceId}/delegations${suffix}`
  }

  private async request<T>(url: string, init?: RequestInit & { claimToken?: string }): Promise<T> {
    const { claimToken, ...request } = init ?? {}
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(url, {
        ...request,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          ...(claimToken ? { [CALLBACK_TOKEN_HEADER]: claimToken } : {}),
          ...request.headers,
        },
      })
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      let code: string | undefined
      if (response.headers.get("content-type")?.includes("application/json")) {
        try {
          const parsed = JSON.parse((await response.text()).slice(0, 2000)) as { code?: unknown }
          if (typeof parsed.code === "string") code = parsed.code
        } catch {
          code = undefined
        }
      }
      throw new ThreaApiError(`Threa API ${response.status}: ${response.statusText}`, response.status, code)
    }
    const { data } = (await response.json()) as { data: T }
    return data
  }

  /** Open delegations the key can access, oldest first. `since` narrows to a delta. */
  async listOpen(opts?: { since?: string }): Promise<DelegationSummary[]> {
    const query = opts?.since ? `?since=${encodeURIComponent(opts.since)}` : ""
    return this.request<DelegationSummary[]>(this.path(query))
  }

  /**
   * CAS-claim one delegation. Persist `idempotencyKey` BEFORE calling: a retry
   * bearing the live claim's key re-keys it (fresh token + lease) instead of
   * 409ing — the crash-between-response-and-persist recovery path.
   * Throws `ThreaApiError` 409 (`DELEGATION_NOT_OPEN`) on a lost race.
   */
  async claim(id: string, body: { claimedByLabel: string; idempotencyKey?: string }): Promise<ClaimedDelegation> {
    return this.request<ClaimedDelegation>(this.path(`/${id}/claim`), {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  /** Renew the 15-minute lease. Liveness only — nothing changes on the card. */
  async heartbeat(id: string, claimToken: string): Promise<{ claimExpiresAt: string }> {
    return this.request(this.path(`/${id}/heartbeat`), { method: "POST", body: "{}", claimToken })
  }

  /** Progress note on the card (`claimed|running → running`); also renews the lease. */
  async reportStatus(id: string, claimToken: string, statusNote: string): Promise<DelegationSummary> {
    return this.request(this.path(`/${id}/status`), {
      method: "POST",
      body: JSON.stringify({ statusNote }),
      claimToken,
    })
  }

  /**
   * Terminal success. `resultMarkdown` posts into the delegation card's thread
   * as the key's identity in the same transaction as the flip; retries with the
   * same token are idempotent (the committed outcome comes back, nothing double-posts).
   */
  async complete(
    id: string,
    claimToken: string,
    body: { resultMarkdown?: string; metadata?: Record<string, string> }
  ): Promise<DelegationSummary & { resultMessageId?: string; resultThreadId?: string }> {
    return this.request(this.path(`/${id}/complete`), {
      method: "POST",
      body: JSON.stringify(body),
      claimToken,
    })
  }

  /** Terminal failure: the reason lands on the card. Idempotent like complete. */
  async fail(id: string, claimToken: string, errorMessage: string): Promise<DelegationSummary> {
    return this.request(this.path(`/${id}/fail`), {
      method: "POST",
      body: JSON.stringify({ errorMessage }),
      claimToken,
    })
  }

  /**
   * Ask a stream member to grant this bot access to the delegation's stream
   * (F3). Called when a claim 404s for lack of a channel grant — files a card a
   * member approves or denies. No claim token: the bot has no claim yet. Returns
   * `{ status: "already_granted" }` (no `requestId`) when the bot already had
   * access, else `{ requestId, status: "open" }`; idempotent per (bot, stream).
   */
  async requestAccess(
    delegationId: string,
    opts?: { requestedByLabel?: string }
  ): Promise<{ requestId?: string; status: string }> {
    return this.request(this.path(`/${delegationId}/request-access`), {
      method: "POST",
      body: JSON.stringify(opts?.requestedByLabel ? { requestedByLabel: opts.requestedByLabel } : {}),
    })
  }
}
