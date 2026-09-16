export interface HermesRunEvent {
  event: string
  run_id: string
  [key: string]: unknown
}

export interface CreateRunInput {
  input: string
  sessionId: string
  /** Hermes requires 1-255 visible ASCII; a Threa invocation id qualifies. */
  idempotencyKey: string
  sessionKey: string
}

export interface CreatedRun {
  runId: string
  replayed: boolean
}

export interface RunStatus {
  runId: string
  status: string
  output?: string
  error?: string
}

export interface SteerAccepted {
  runId: string
  accepted: boolean
}

export interface StopResult {
  runId: string
  status: string
}

export interface ApprovalResult {
  runId: string
  choice: string
  resolved: boolean
}

export interface ModelProviderOptions {
  slug: string
  name?: string
  models: string[]
}

export interface ModelOptions {
  providers: ModelProviderOptions[]
  model?: string
  provider?: string
}

export interface SessionModelLock {
  sessionId: string
  provider: string
  model: string
}

export class HermesApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly body?: string

  constructor(message: string, options: { status: number; code?: string; body?: string }) {
    super(message)
    this.name = "HermesApiError"
    this.status = options.status
    if (options.code !== undefined) this.code = options.code
    if (options.body !== undefined) this.body = options.body
  }
}

/** Narrower than `typeof fetch` so a test stub need not implement `preconnect`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface HermesRunsClientOptions {
  baseUrl: string
  apiKey: string
  fetch?: FetchLike
  /** Injectable for tests; the subscribe retry that covers the admission race. */
  sleep?: (ms: number) => Promise<void>
}

const SUBSCRIBE_ATTEMPTS = 3
const SUBSCRIBE_BACKOFF_MS = 250

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export class HermesRunsClient {
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: HermesRunsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async createRun(input: CreateRunInput, signal?: AbortSignal): Promise<CreatedRun> {
    const response = await this.request(
      "/v1/runs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
          "X-Hermes-Session-Key": input.sessionKey,
        },
        body: JSON.stringify({ input: input.input, session_id: input.sessionId }),
      },
      signal
    )
    const payload = (await this.readJson(response)) as { run_id?: unknown; replayed?: unknown }
    const runId = str(payload.run_id)
    if (!runId) {
      throw new HermesApiError("Hermes accepted the run without a run_id", { status: response.status })
    }
    return { runId, replayed: payload.replayed === true }
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunStatus> {
    const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" }, signal)
    const payload = (await this.readJson(response)) as Record<string, unknown>
    return {
      runId: str(payload.run_id) ?? runId,
      status: str(payload.status) ?? "unknown",
      ...(str(payload.output) === undefined ? {} : { output: payload.output as string }),
      ...(str(payload.error) === undefined ? {} : { error: payload.error as string }),
    }
  }

  /** Fold text into a run that is still `running`; a queued or finishing run answers 409 `run_not_accepting_steer`. */
  async steerRun(runId: string, input: string, signal?: AbortSignal): Promise<SteerAccepted> {
    const response = await this.request(
      `/v1/runs/${encodeURIComponent(runId)}/steer`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) },
      signal
    )
    const payload = (await this.readJson(response)) as { run_id?: unknown; accepted?: unknown }
    return { runId: str(payload.run_id) ?? runId, accepted: payload.accepted !== false }
  }

  async stopRun(runId: string, signal?: AbortSignal): Promise<StopResult> {
    const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }, signal)
    const payload = (await this.readJson(response)) as { run_id?: unknown; status?: unknown }
    return { runId: str(payload.run_id) ?? runId, status: str(payload.status) ?? "unknown" }
  }

  async respondApproval(
    runId: string,
    answer: { choice: string; requestId?: string },
    signal?: AbortSignal
  ): Promise<ApprovalResult> {
    const response = await this.request(
      `/v1/runs/${encodeURIComponent(runId)}/approval`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choice: answer.choice,
          ...(answer.requestId ? { request_id: answer.requestId } : {}),
        }),
      },
      signal
    )
    const payload = (await this.readJson(response)) as { run_id?: unknown; choice?: unknown; resolved?: unknown }
    return {
      runId: str(payload.run_id) ?? runId,
      choice: str(payload.choice) ?? answer.choice,
      resolved: payload.resolved !== false,
    }
  }

  async listModelOptions(signal?: AbortSignal): Promise<ModelOptions> {
    const response = await this.request("/api/model/options", { method: "GET" }, signal)
    const payload = (await this.readJson(response)) as {
      providers?: unknown
      model?: unknown
      provider?: unknown
    }
    const providers = Array.isArray(payload.providers)
      ? payload.providers.flatMap((entry): ModelProviderOptions[] => {
          const record = (entry ?? {}) as { slug?: unknown; name?: unknown; models?: unknown }
          const slug = str(record.slug)
          if (!slug) return []
          const models = Array.isArray(record.models) ? record.models.flatMap((m) => str(m) ?? []) : []
          return [{ slug, ...(str(record.name) === undefined ? {} : { name: record.name as string }), models }]
        })
      : []
    return {
      providers,
      ...(str(payload.model) === undefined ? {} : { model: payload.model as string }),
      ...(str(payload.provider) === undefined ? {} : { provider: payload.provider as string }),
    }
  }

  /** Sessions are created lazily by the first run, so a model lock has to create the row first. */
  async createSession(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      "/api/sessions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) },
      signal
    )
  }

  async lockSessionModel(
    id: string,
    runtime: { provider: string; model: string },
    signal?: AbortSignal
  ): Promise<SessionModelLock> {
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(id)}/model`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(runtime) },
      signal
    )
    const payload = (await this.readJson(response)) as { session_id?: unknown; runtime?: unknown }
    const locked = (payload.runtime ?? {}) as { provider?: unknown; model?: unknown }
    return {
      sessionId: str(payload.session_id) ?? id,
      provider: str(locked.provider) ?? runtime.provider,
      model: str(locked.model) ?? runtime.model,
    }
  }

  /**
   * The events SSE stream. Hermes admits a subscribe slightly before the run is
   * registered, but not always in time: a `run_not_found` right after admission
   * is the race, not a missing run, so it is retried before it becomes an error.
   */
  async *streamEvents(runId: string, signal?: AbortSignal): AsyncIterable<HermesRunEvent> {
    let response: Response | undefined
    for (let attempt = 1; attempt <= SUBSCRIBE_ATTEMPTS; attempt += 1) {
      try {
        response = await this.request(
          `/v1/runs/${encodeURIComponent(runId)}/events`,
          { method: "GET", headers: { Accept: "text/event-stream" } },
          signal
        )
        break
      } catch (error) {
        const retryable = error instanceof HermesApiError && error.status === 404 && error.code === "run_not_found"
        if (!retryable || attempt === SUBSCRIBE_ATTEMPTS) throw error
        await this.sleep(SUBSCRIBE_BACKOFF_MS)
      }
    }
    if (!response?.body) return
    yield* parseSseEvents(response.body)
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${this.apiKey}`)
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) throw await toApiError(response)
    return response
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new HermesApiError("Hermes returned a non-JSON response", { status: response.status, body: text })
    }
  }
}

async function toApiError(response: Response): Promise<HermesApiError> {
  const body = await response.text().catch(() => "")
  let code: string | undefined
  let message = `Hermes request failed with ${response.status}`
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } }
    code = str(parsed.error?.code)
    message = str(parsed.error?.message) ?? message
  } catch {
    // A non-JSON body is kept verbatim on `body`.
  }
  return new HermesApiError(message, {
    status: response.status,
    ...(code === undefined ? {} : { code }),
    ...(body ? { body } : {}),
  })
}

/**
 * Hermes frames are `data: <json>\n\n` with no `event:` line; `:` comment lines
 * are keepalives and the end-of-stream marker. Chunk boundaries fall anywhere,
 * so lines are assembled from a carry buffer rather than per chunk.
 */
export async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<HermesRunEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let dataLines: string[] = []

  const flush = (): HermesRunEvent | undefined => {
    if (dataLines.length === 0) return undefined
    const raw = dataLines.join("\n")
    dataLines = []
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as HermesRunEvent
    } catch {
      // A frame we cannot parse is dropped; the run's own terminal event still governs.
    }
    return undefined
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (line === "") {
          const event = flush()
          if (event) yield event
        } else if (line.startsWith(":")) {
          if (line.slice(1).trim() === "stream closed") return
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""))
        }
        newline = buffer.indexOf("\n")
      }
    }
    const trailing = flush()
    if (trailing) yield trailing
  } finally {
    reader.cancel().catch(() => undefined)
  }
}
