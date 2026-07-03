import { THREA_CALLBACK_TOKEN_HEADER, type SealedReplyBody, type SealingState } from "@threa/bot-runtime-client"

const FETCH_TIMEOUT_MS = 30_000

export interface RuntimeSessionLink {
  linkId: string
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  streamUrlPath: string
}

export interface ExternalHistoryMessage {
  messageId: string
  role: "user" | "assistant"
  authorId: string
  authorType: string
  authorDisplayName?: string
  contentMarkdown: string
  createdAt: string
}

export interface AttachmentSummary {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

/** The slice of `GET /streams/:id/messages` we consume — id plus any attachments. */
export interface StreamMessageSummary {
  id: string
  attachments?: AttachmentSummary[]
}

export interface ClaimedInvocation {
  id: string
  workspaceId: string
  rootStreamId: string
  activeStreamId: string
  sourceMessageId: string
  responseStreamId: string
  actor: { type: "bot"; id: string; slug: string }
  trigger: string
  requiredCapability: string
  promptMarkdown: string
  authorUserId: string
  mentionedActorSlugs: string[]
  claimToken: string
  claimExpiresAt: string
  runtimeSessionId: string | null
  metadata: Record<string, unknown>
  context?: { kind: "inline"; messages: ExternalHistoryMessage[] }
  /** Present on a sealed (E2E) claim as delivered by the server; consumed and cleared by hydration. */
  sealedContext?: unknown
  /** Derived from `sealedContext` at claim time; carries the stream key + binding for sealing replies/steps. */
  sealing?: SealingState
}

export class ThreaApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "ThreaApiError"
  }
}

export interface ThreaClientOptions {
  baseUrl: string
  workspaceId: string
  apiKey: string
}

export class ThreaClient {
  constructor(private readonly opts: ThreaClientOptions) {}

  private get base(): string {
    return this.opts.baseUrl.replace(/\/$/, "")
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    // A FormData body must keep its multipart boundary header, which fetch sets
    // only when Content-Type is left unset — so never force JSON on uploads.
    const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...(isFormData ? {} : { "Content-Type": "application/json" }),
          ...init?.headers,
        },
      })
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      // Don't read the body: proxy/server errors can return large HTML pages.
      throw new ThreaApiError(`Threa API ${response.status}: ${response.statusText}`, response.status)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  private workspacePath(suffix: string): string {
    return `/api/v1/workspaces/${this.opts.workspaceId}${suffix}`
  }

  /** Returns the authenticated principal; only `.kind` (`"bot"` vs `"user"`) is consumed today. */
  async getMe(): Promise<{ kind: string }> {
    const body = await this.request<{ data: { kind: string } }>(this.workspacePath("/me"))
    return body.data
  }

  async createSession(body: Record<string, unknown>): Promise<RuntimeSessionLink> {
    const result = await this.request<{ data: RuntimeSessionLink }>(this.workspacePath("/bot-runtime/sessions"), {
      method: "POST",
      body: JSON.stringify(body),
    })
    return result.data
  }

  async claim(body: Record<string, unknown>): Promise<ClaimedInvocation | null> {
    const result = await this.request<{ data: ClaimedInvocation | null }>(
      this.workspacePath("/bot-invocations/claim"),
      { method: "POST", body: JSON.stringify(body) }
    )
    return result.data
  }

  async complete(invocationId: string, body: Record<string, unknown>): Promise<void> {
    await this.request(this.workspacePath(`/bot-invocations/${invocationId}/complete`), {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  async fail(invocationId: string, body: Record<string, unknown>): Promise<void> {
    await this.request(this.workspacePath(`/bot-invocations/${invocationId}/fail`), {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  async sendMessage(streamId: string, body: Record<string, unknown>): Promise<void> {
    await this.request(this.workspacePath(`/streams/${streamId}/messages`), {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  /** Post one sealed interim message from an in-flight sealed claim (callback-token auth). */
  async sendSealedMessage(invocationId: string, callbackToken: string, body: SealedReplyBody): Promise<void> {
    await this.request(this.workspacePath(`/bot-invocations/${invocationId}/sealed-messages`), {
      method: "POST",
      headers: { [THREA_CALLBACK_TOKEN_HEADER]: callbackToken },
      body: JSON.stringify(body),
    })
  }

  /** Complete a sealed turn with its final sealed reply — or silently (`noResponse`). Callback-token auth. */
  async completeSealed(
    invocationId: string,
    callbackToken: string,
    body: { reply: SealedReplyBody } | { noResponse: true }
  ): Promise<void> {
    await this.request(this.workspacePath(`/bot-invocations/${invocationId}/sealed-complete`), {
      method: "POST",
      headers: { [THREA_CALLBACK_TOKEN_HEADER]: callbackToken },
      body: JSON.stringify(body),
    })
  }

  /** Recent messages for a stream, newest-window first. Used to discover inbound attachments (the claim context omits them). Requires `messages:read` + `streams:read`. */
  async listStreamMessages(streamId: string, query: { limit?: number } = {}): Promise<StreamMessageSummary[]> {
    const suffix = query.limit ? `?limit=${query.limit}` : ""
    const body = await this.request<{ data: StreamMessageSummary[] }>(
      this.workspacePath(`/streams/${streamId}/messages${suffix}`)
    )
    return body.data
  }

  /** Short-lived signed download URL for an attachment. Requires `attachments:read`. */
  async getAttachmentDownloadUrl(attachmentId: string): Promise<string> {
    const body = await this.request<{ data: { url: string } }>(this.workspacePath(`/attachments/${attachmentId}/url`))
    return body.data.url
  }

  /** Upload a file (multipart `file` field) and return its summary. Requires `attachments:write`. */
  async uploadAttachment(form: FormData): Promise<AttachmentSummary> {
    const body = await this.request<{ data: AttachmentSummary }>(this.workspacePath("/attachments"), {
      method: "POST",
      body: form,
    })
    return body.data
  }
}
