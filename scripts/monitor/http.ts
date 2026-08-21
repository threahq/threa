export type FetchLike = typeof fetch

export interface HttpProbeResult {
  url: string
  status: number | null
  ms: number
  body: string
  error?: string
}

export async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<HttpProbeResult> {
  const started = performance.now()
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const body = await res.text()
    return { url, status: res.status, ms: Math.round(performance.now() - started), body }
  } catch (error) {
    return {
      url,
      status: null,
      ms: Math.round(performance.now() - started),
      body: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
