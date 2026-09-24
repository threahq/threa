const FETCH_TIMEOUT_MS = 30_000
// An upload's deadline grows with its size: the server stores and scans the file
// before answering, so a flat deadline fails large files it has already kept.
const UPLOAD_MIN_BYTES_PER_MS = 256
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const

function deriveHint(status: number): string | undefined {
  if (status === 404) {
    return "A 404 can mean the resource does not exist OR that this API key lacks the scope required to see it."
  }
  if (status === 429) {
    return "Rate limited after retrying with backoff; retry later."
  }
  return undefined
}

export class ThreaApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly hint?: string

  constructor(args: { status: number; code?: string; message: string }) {
    super(args.message)
    this.name = "ThreaApiError"
    this.status = args.status
    this.code = args.code
    this.hint = deriveHint(args.status)
  }
}

export interface ThreaApiClientOptions {
  baseUrl: string
  workspaceId: string
  apiKey: string
  /** Injectable for tests so 429 backoff does not actually wait. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for tests. Defaults to 30s. */
  timeoutMs?: number
}

type Method = "GET" | "POST" | "PATCH" | "DELETE"
type Payload = { json: unknown } | { form: FormData }

export class ThreaApiClient {
  private readonly baseUrl: string
  private readonly workspaceId: string
  private readonly apiKey: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly timeoutMs: number

  constructor(opts: ThreaApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.workspaceId = opts.workspaceId
    this.apiKey = opts.apiKey
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path)
  }

  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>("POST", path, body === undefined ? undefined : { json: body }, headers)
  }

  postForm<T>(path: string, form: FormData, bodyBytes: number): Promise<T> {
    return this.request<T>("POST", path, { form }, undefined, {
      timeoutMs: this.timeoutMs + Math.ceil(bodyBytes / UPLOAD_MIN_BYTES_PER_MS),
    })
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body === undefined ? undefined : { json: body })
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path)
  }

  /** The timeout covers the response headers only: the caller streams the body, which may be large. */
  getRaw(path: string): Promise<Response> {
    return this.request<Response>("GET", path, undefined, undefined, { raw: true })
  }

  private workspacePath(path: string): string {
    return `${this.baseUrl}/api/v1/workspaces/${this.workspaceId}${path}`
  }

  private async request<T>(
    method: Method,
    path: string,
    payload?: Payload,
    extraHeaders?: Record<string, string>,
    { raw = false, timeoutMs = this.timeoutMs }: { raw?: boolean; timeoutMs?: number } = {}
  ): Promise<T> {
    const url = this.workspacePath(path)
    // 429 is safe to retry for any method: the request never executed server-side.
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      // The timer must stay armed across the body read: fetch resolves at headers,
      // and response.json()/text() stream the body — clearing earlier would leave a
      // stalled body with no timeout at all.
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      let retryAfter429 = false
      try {
        const response = await fetch(url, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(payload && "json" in payload ? { "Content-Type": "application/json" } : {}),
            ...(extraHeaders ?? {}),
          },
          ...(payload ? { body: "json" in payload ? JSON.stringify(payload.json) : payload.form } : {}),
        })
        if (response.status === 429 && attempt < RETRY_DELAYS_MS.length) {
          retryAfter429 = true
        } else {
          if (!response.ok) {
            throw await this.toError(response)
          }
          if (raw) return response as T
          if (response.status === 204) return undefined as T
          return (await response.json()) as T
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new ThreaApiError({
            status: 0,
            code: "TIMEOUT",
            message: `Threa API ${method} ${path} timed out after ${timeoutMs}ms`,
          })
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
      if (retryAfter429) await this.sleep(RETRY_DELAYS_MS[attempt]!)
    }
  }

  private async toError(response: Response): Promise<ThreaApiError> {
    let code: string | undefined
    let message: string | undefined
    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        const parsed = JSON.parse((await response.text()).slice(0, 4_000)) as {
          error?: unknown
          code?: unknown
        }
        if (typeof parsed.error === "string") message = parsed.error
        if (typeof parsed.code === "string") code = parsed.code
      } catch {
        // Non-JSON or malformed body: fall through to the status-line message.
      }
    }
    return new ThreaApiError({
      status: response.status,
      code,
      message: message ?? `Threa API ${response.status} ${response.statusText}`,
    })
  }
}
