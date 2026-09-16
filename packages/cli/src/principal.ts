import { ThreaApiError, type ThreaApiClient } from "./api-client"
import type { ThreaConfig } from "./config"

type Principal = { kind: string; userId?: string; botId?: string }

export interface AssertPrincipalOptions {
  /** Waits between `/me` attempts that failed on the network, a timeout, 429 or 5xx. None by default. */
  retryDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

/** No declaration means no assertion: human use of a personal key is unchanged. */
export async function assertPrincipal(
  client: ThreaApiClient,
  config: ThreaConfig,
  { retryDelaysMs = [], sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: AssertPrincipalOptions = {}
): Promise<void> {
  if (config.principal === undefined) return
  const data = await fetchPrincipal(client, retryDelaysMs, sleep)
  if (data.kind === config.principal) return
  throw new Error(
    `threa: config declares principal "${config.principal}" but the key belongs to ${data.kind} ${
      data.userId ?? data.botId ?? "?"
    } (INV-11)`
  )
}

async function fetchPrincipal(
  client: ThreaApiClient,
  retryDelaysMs: readonly number[],
  sleep: (ms: number) => Promise<void>
): Promise<Principal> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await client.get<{ data: Principal }>("/me")).data
    } catch (error) {
      const delay = retryDelaysMs[attempt]
      if (delay === undefined || !isTransient(error)) throw error
      process.stderr.write(`[threa] /me failed, retrying: ${error instanceof Error ? error.message : String(error)}\n`)
      await sleep(delay)
    }
  }
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof ThreaApiError)) return true
  return error.status === 0 || error.status === 429 || error.status >= 500
}
