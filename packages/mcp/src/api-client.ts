const FETCH_TIMEOUT_MS = 30_000
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
}

type Method = "GET" | "POST" | "PATCH" | "DELETE"

export class ThreaApiClient {
  private readonly baseUrl: string
  private readonly workspaceId: string
  private readonly apiKey: string
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: ThreaApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.workspaceId = opts.workspaceId
    this.apiKey = opts.apiKey
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path)
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body)
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body)
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path)
  }

  private workspacePath(path: string): string {
    return `${this.baseUrl}/api/v1/workspaces/${this.workspaceId}${path}`
  }

  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const url = this.workspacePath(path)
    const hasBody = body !== undefined
    // 429 is safe to retry for any method: the request never executed server-side.
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetch(url, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
          },
          ...(hasBody ? { body: JSON.stringify(body) } : {}),
        })
      } finally {
        clearTimeout(timeout)
      }

      if (response.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        await this.sleep(RETRY_DELAYS_MS[attempt]!)
        continue
      }

      if (!response.ok) {
        throw await this.toError(response)
      }

      if (response.status === 204) return undefined as T
      return (await response.json()) as T
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
