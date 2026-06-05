import type { GiphyGif } from "@threa/types"
import type { GiphyConfig } from "../../lib/env"
import { GiphyClient } from "./client"

export interface GiphyServiceDeps {
  config: GiphyConfig
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export interface GiphyPage {
  items: GiphyGif[]
  nextOffset: number | null
}

export class GiphyDisabledError extends Error {
  constructor() {
    super("Giphy is not configured")
    this.name = "GiphyDisabledError"
  }
}

/**
 * Orchestrates the Giphy picker: gates on whether a key is configured and
 * exposes search/trending. The picked GIF is embedded by its CDN URL on the
 * client (no byte download), so this service never touches GIF bytes. The
 * client is constructed once (only when enabled) and reused — no per-call
 * dependency assembly (INV-13).
 */
export class GiphyService {
  private readonly client: GiphyClient | null

  constructor(deps: GiphyServiceDeps) {
    this.client = deps.config.apiKey ? new GiphyClient(deps.config.apiKey, deps.fetchImpl ?? fetch) : null
  }

  isEnabled(): boolean {
    return this.client !== null
  }

  async search(query: string, options: { limit?: number; offset?: number }): Promise<GiphyPage> {
    return this.requireClient().search(query, options)
  }

  async trending(options: { limit?: number; offset?: number }): Promise<GiphyPage> {
    return this.requireClient().trending(options)
  }

  private requireClient(): GiphyClient {
    if (!this.client) throw new GiphyDisabledError()
    return this.client
  }
}
