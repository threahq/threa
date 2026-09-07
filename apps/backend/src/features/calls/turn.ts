import { z } from "zod"
import { HttpError } from "../../lib/errors"

export interface TurnConfig {
  keyId: string
  apiToken: string
  apiBase?: string
  ttlSeconds?: number
  timeoutMs?: number
}

export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface TurnCredentials {
  iceServers: IceServer[]
  expiresAt: string
}

export interface TurnCredentialIssuer {
  issue(): Promise<TurnCredentials>
}

const DEFAULT_TTL_SECONDS = 900
const DEFAULT_TIMEOUT_MS = 5_000
const iceUrlPattern =
  /^(stun|stuns|turn|turns):(?:\/\/)?(?:\[[0-9a-f:.]+\]|[^/?#:\s]+)(?::(\d{1,5}))?(?:\?transport=(?:udp|tcp))?$/i

const providerIceServerSchema = z
  .object({
    urls: z.union([z.string(), z.array(z.string()).min(1)]),
    username: z.string().min(1).optional(),
    credential: z.string().min(1).optional(),
  })
  .strict()

const providerResponseSchema = z
  .object({
    iceServers: z.array(providerIceServerSchema),
  })
  .strict()

function parsedIceUrl(url: string): { protocol: string; blocked: boolean } | null {
  const match = iceUrlPattern.exec(url)
  if (!match) return null
  const port = match[2] === undefined ? undefined : Number(match[2])
  if (port !== undefined && (port < 1 || port > 65_535)) return null
  return { protocol: match[1].toLowerCase(), blocked: port === 53 }
}

function providerError(): HttpError {
  return new HttpError("TURN provider returned invalid credentials", {
    status: 502,
    code: "CALL_TURN_PROVIDER_ERROR",
  })
}

export class CloudflareTurnIssuer implements TurnCredentialIssuer {
  constructor(
    private readonly config: TurnConfig,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async issue(): Promise<TurnCredentials> {
    const ttl = this.config.ttlSeconds ?? DEFAULT_TTL_SECONDS
    const requestedAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const base = this.config.apiBase ?? "https://rtc.live.cloudflare.com/v1"
      const response = await this.fetcher(
        `${base}/turn/keys/${encodeURIComponent(this.config.keyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl }),
          signal: controller.signal,
        }
      )
      if (!response.ok) {
        throw new HttpError("TURN provider rejected the credential request", {
          status: 502,
          code: "CALL_TURN_PROVIDER_ERROR",
        })
      }

      let unparsedBody: unknown
      try {
        unparsedBody = await response.json()
      } catch {
        throw providerError()
      }
      const parsedBody = providerResponseSchema.safeParse(unparsedBody)
      if (!parsedBody.success) throw providerError()

      let hasTurnUrl = false
      const iceServers = parsedBody.data.iceServers.flatMap((server): IceServer[] => {
        const sourceUrls = Array.isArray(server.urls) ? server.urls : [server.urls]
        const urls = sourceUrls.filter((url) => {
          const parsed = parsedIceUrl(url)
          if (!parsed) throw providerError()
          if (parsed.protocol === "turn" || parsed.protocol === "turns") {
            if (!server.username || !server.credential) throw providerError()
            if (!parsed.blocked) hasTurnUrl = true
          }
          return !parsed.blocked
        })
        if (urls.length === 0) return []
        return [
          {
            urls: Array.isArray(server.urls) ? urls : urls[0],
            ...(server.username === undefined ? {} : { username: server.username }),
            ...(server.credential === undefined ? {} : { credential: server.credential }),
          },
        ]
      })
      if (!hasTurnUrl) throw providerError()

      return { iceServers, expiresAt: new Date(requestedAt + ttl * 1000).toISOString() }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError("TURN credentials are temporarily unavailable", {
        status: 503,
        code: "CALL_TURN_UNAVAILABLE",
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}
