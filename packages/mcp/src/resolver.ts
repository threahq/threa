import type { ThreaApiClient } from "./api-client"
import { buildQuery, UnresolvedRefError, type PagedEnvelope } from "./tools/result"

const DEFAULT_TTL_MS = 5 * 60 * 1000

export interface ResolverUser {
  id: string
  name: string
  slug: string
}

interface ResolverStream {
  id: string
  slug?: string | null
  displayName?: string | null
}

interface CacheEntry<T> {
  value: T
  expires: number
}

export interface RefResolverOptions {
  client: ThreaApiClient
  /** Cache lifetime for resolved refs and the users list. Defaults to 5 minutes. */
  ttlMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

/**
 * Resolves identifier arguments that may be a raw id or a sigil-prefixed slug:
 * `#channel-slug` for channels, `@user-slug` for users/bots. Backed by a short
 * TTL cache so repeated resolutions in a session do not re-hit the API.
 */
export class RefResolver {
  private readonly client: ThreaApiClient
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly channelCache = new Map<string, CacheEntry<string>>()
  private allUsersCache?: CacheEntry<ResolverUser[]>
  private allUsersInFlight?: Promise<ResolverUser[]>

  constructor(opts: RefResolverOptions) {
    this.client = opts.client
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.now = opts.now ?? Date.now
  }

  async resolveStream(ref: string): Promise<string> {
    const trimmed = ref.trim()
    if (trimmed.startsWith("#")) return this.resolveChannel(trimmed.slice(1))
    if (trimmed.startsWith("@")) return this.resolveDmWithUser(trimmed.slice(1))
    return trimmed
  }

  async resolveStreams(refs: string[]): Promise<string[]> {
    return Promise.all(refs.map((ref) => this.resolveStream(ref)))
  }

  async resolveUser(ref: string): Promise<string> {
    const trimmed = ref.trim()
    if (trimmed.startsWith("@")) return this.resolveUserSlug(trimmed.slice(1))
    return trimmed
  }

  /** The workspace users, one cached page, for additive enrichment id → name/slug. */
  async allUsers(): Promise<ResolverUser[]> {
    const hit = this.allUsersCache
    if (hit && hit.expires > this.now()) return hit.value
    if (this.allUsersInFlight) return this.allUsersInFlight
    const inFlight = this.client
      .get<PagedEnvelope<ResolverUser>>(`/users${buildQuery({ limit: 200 })}`)
      .then((resp) => {
        this.allUsersCache = { value: resp.data, expires: this.now() + this.ttlMs }
        return resp.data
      })
      .finally(() => {
        this.allUsersInFlight = undefined
      })
    this.allUsersInFlight = inFlight
    return inFlight
  }

  private async resolveUserSlug(slug: string): Promise<string> {
    const target = slug.toLowerCase()
    const users = await this.allUsers()
    const bySlug = users.filter((u) => u.slug?.toLowerCase() === target)
    const matches = bySlug.length > 0 ? bySlug : users.filter((u) => u.name?.toLowerCase() === target)
    if (matches.length === 1) return matches[0]!.id
    if (matches.length > 1) {
      throw new UnresolvedRefError(
        `"@${slug}" is ambiguous. Candidates: ${matches
          .map((u) => `${u.id} (${u.name}, @${u.slug})`)
          .join("; ")}. Pass the usr_ id.`
      )
    }
    throw new UnresolvedRefError(
      `No user matches "@${slug}". Use list_users to find them, then pass the usr_ id. ` +
        "Bots and personas are not queryable by slug on the public API; pass their bot_/persona_ id."
    )
  }

  private async resolveChannel(slug: string): Promise<string> {
    const key = slug.toLowerCase()
    const hit = this.channelCache.get(key)
    if (hit && hit.expires > this.now()) return hit.value
    const resp = await this.client.get<PagedEnvelope<ResolverStream>>(
      `/streams${buildQuery({ type: "channel", query: slug, limit: 200 })}`
    )
    const matches = resp.data.filter((s) => {
      const streamSlug = s.slug?.toLowerCase()
      const bareName = typeof s.displayName === "string" ? s.displayName.replace(/^#/, "").toLowerCase() : undefined
      return streamSlug === key || bareName === key
    })
    if (matches.length === 1) {
      const id = matches[0]!.id
      this.channelCache.set(key, { value: id, expires: this.now() + this.ttlMs })
      return id
    }
    if (matches.length > 1) {
      throw new UnresolvedRefError(
        `"#${slug}" is ambiguous. Candidates: ${matches
          .map((s) => `${s.id} (${s.displayName ?? s.slug})`)
          .join("; ")}. Pass the stream_ id.`
      )
    }
    throw new UnresolvedRefError(
      `No channel matches "#${slug}". Use list_streams (type: "channel") to find it, then pass the stream_ id.`
    )
  }

  private async resolveDmWithUser(slug: string): Promise<string> {
    const userId = await this.resolveUserSlug(slug)
    throw new UnresolvedRefError(
      `Found user @${slug} (${userId}), but the public API does not expose which DM stream is your 1:1 with them ` +
        '(DM streams carry no counterpart on the wire). Get the DM\'s stream_ id with list_streams (type: "dm"), ' +
        `then list_stream_members to find the one whose members include ${userId}, and pass that stream_ id. ` +
        "Or target a channel with #channel-slug."
    )
  }
}
