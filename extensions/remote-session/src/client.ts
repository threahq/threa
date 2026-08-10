import {
  THREA_CALLBACK_TOKEN_HEADER,
  type AttachmentRef,
  type ProvisionedWrap,
  type SealedReplyBody,
  type SealingState,
} from "@threa/bot-runtime-client"

const FETCH_TIMEOUT_MS = 30_000

/**
 * A sealed message body on the wire: the sealed ciphertext plus the E2E
 * attachment row ids the server binds to the message (the per-file keys ride
 * only inside the sealed payload's `attachmentRefs`).
 */
export type SealedWireReply = SealedReplyBody & { attachmentIds?: string[] }

export interface RuntimeSessionLink {
  linkId: string
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  streamUrlPath: string
  /** The linked scratchpad's encryption state (create echoes the request; resume reports the actual state). */
  e2eEnabled?: boolean
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
  /** Present on a session-control claim on an E2E stream: SSK wraps to seal the command ack. */
  sealedAck?: unknown
  /** Derived from `sealedContext` at claim time; carries the stream key + binding for sealing replies/steps. */
  sealing?: SealingState
  /** Attachment refs opened from the sealed trigger/history payloads at claim time — download + decrypt is the turn's job. */
  sealedAttachments?: { prompt: AttachmentRef[]; history: AttachmentRef[] }
}

export class ThreaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The server's structured error `code` (e.g. `E2E_STREAM_PLAINTEXT_UNSUPPORTED`), when the body was JSON. */
    readonly code?: string
  ) {
    super(message)
    this.name = "ThreaApiError"
  }
}

export interface ThreaClientOptions {
  baseUrl: string
  workspaceId: string
  apiKey: string
  fetchTimeoutMs?: number
}

export class ThreaClient {
  constructor(private readonly opts: ThreaClientOptions) {}

  private get base(): string {
    return this.opts.baseUrl.replace(/\/$/, "")
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    // One abort window over headers AND body. Clearing the timer once headers
    // arrived left every `response.text()`/`response.json()` below unbounded —
    // a stalled body hung the channel's request forever, the MCP server went
    // unresponsive, and Claude Code SIGINT-restarted it, failing the in-flight
    // invocation as "channel shut down" (observed live 2026-08-10; same
    // pathogen as pi-remote's #1841).
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS)
    try {
      return await this.requestWithin<T>(path, init, controller.signal)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async requestWithin<T>(path: string, init: RequestInit | undefined, signal: AbortSignal): Promise<T> {
    // A FormData body must keep its multipart boundary header, which fetch sets
    // only when Content-Type is left unset — so never force JSON on uploads.
    const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      // Read the structured `code` so callers can branch on the specific error
      // (e.g. an E2E-plaintext rejection vs a capability/validation 400) instead
      // of swallowing every same-status error alike. Only parse a JSON body and
      // cap it — a proxy/server 5xx can return a large HTML page, which we must
      // not pull into memory.
      let code: string | undefined
      let serverMessage: string | undefined
      if (response.headers.get("content-type")?.includes("application/json")) {
        try {
          const body = (await response.text()).slice(0, 2000)
          const parsed = JSON.parse(body) as { code?: unknown; error?: unknown }
          if (typeof parsed.code === "string") code = parsed.code
          if (typeof parsed.error === "string") serverMessage = parsed.error
        } catch {
          code = undefined
        }
      }
      // Carry the structured code + server message in the text too — most call
      // sites log `error.message` only, and "Threa API 409: Conflict" gives the
      // user nothing to act on.
      const detail = [code, serverMessage].filter(Boolean).join(" — ")
      throw new ThreaApiError(
        `Threa API ${response.status}${detail ? ` (${detail})` : `: ${response.statusText}`}`,
        response.status,
        code
      )
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
  async sendSealedMessage(invocationId: string, callbackToken: string, body: SealedWireReply): Promise<void> {
    await this.request(this.workspacePath(`/bot-invocations/${invocationId}/sealed-messages`), {
      method: "POST",
      headers: { [THREA_CALLBACK_TOKEN_HEADER]: callbackToken },
      body: JSON.stringify(body),
    })
  }

  /** The bot owner's active encryption key (public half). 404 = the owner has not set up encryption. */
  async getOwnerE2eKey(): Promise<{ keyId: string; publicKey: string }> {
    const body = await this.request<{ data: { keyId: string; publicKey: string } }>(
      this.workspacePath("/bot-runtime/owner-e2e-key")
    )
    return body.data
  }

  /** Phase two of harness-created E2E scratchpads: store the generation-0 stream-key wraps. */
  async provisionStreamKeyWraps(
    streamId: string,
    body: { keyGeneration: number; wraps: ProvisionedWrap[] }
  ): Promise<void> {
    await this.request(this.workspacePath(`/streams/${streamId}/e2e/key-wraps`), {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  /** Complete a sealed turn with its final sealed reply — or silently (`noResponse`). Callback-token auth. */
  async completeSealed(
    invocationId: string,
    callbackToken: string,
    body: { reply: SealedWireReply } | { noResponse: true }
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

  /** `archivedAt` for a stream, or null while it is live. Requires `streams:read`. */
  async getStreamArchivedAt(streamId: string): Promise<string | null> {
    const body = await this.request<{ data: { archivedAt?: string | null } }>(
      this.workspacePath(`/streams/${streamId}`)
    )
    return body.data?.archivedAt ?? null
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
