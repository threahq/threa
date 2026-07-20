import type { RefResolver, ResolverStreamInfo } from "./resolver"

type UsersById = Map<string, { name: string; slug: string }>

interface RawMessage {
  authorId?: unknown
  authorType?: unknown
  authorDisplayName?: unknown
}

async function loadUsersById(resolver: RefResolver): Promise<UsersById | null> {
  try {
    const users = await resolver.allUsers()
    return new Map(users.map((u) => [u.id, { name: u.name, slug: u.slug }]))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[threa] enrichment skipped: users fetch failed: ${detail}\n`)
    return null
  }
}

function enrichOne(row: unknown, usersById: UsersById): unknown {
  if (!row || typeof row !== "object") return row
  const m = row as RawMessage & Record<string, unknown>
  if (typeof m.authorId !== "string") return row
  const user = usersById.get(m.authorId)
  const name = user?.name ?? (typeof m.authorDisplayName === "string" ? m.authorDisplayName : undefined)
  const author: { id: string; type?: string; name?: string; slug?: string } = { id: m.authorId }
  if (typeof m.authorType === "string") author.type = m.authorType
  if (name != null) author.name = name
  if (user?.slug) author.slug = user.slug
  return { ...m, author }
}

/**
 * Additively attach `author: {id, type, name, slug?}` to message rows. Bot/persona
 * authors are absent from /users, so their `name` falls back to the wire's
 * `authorDisplayName` and `slug` is omitted. Non-fatal: a failed users fetch
 * returns the rows untouched. Fetches the users list once (cached) only when at
 * least one row carries an authorId.
 */
export async function enrichMessages(rows: unknown, resolver: RefResolver): Promise<unknown> {
  if (!Array.isArray(rows)) return rows
  if (!rows.some((row) => row && typeof row === "object" && typeof (row as RawMessage).authorId === "string")) {
    return rows
  }
  const usersById = await loadUsersById(resolver)
  if (!usersById) return rows
  return rows.map((row) => enrichOne(row, usersById))
}

export interface StreamRef {
  id: string
  name?: string
  type?: string
}

function toStreamRef(info: ResolverStreamInfo | null, id: string): StreamRef {
  const ref: StreamRef = { id }
  if (info?.displayName ?? info?.slug) ref.name = info.displayName ?? info.slug
  if (info?.type) ref.type = info.type
  return ref
}

/**
 * Additively attach `stream: {id, name?, type?}` (and `rootStream` when the row's
 * stream is a thread) to rows carrying a `streamId`. Stream infos come from
 * per-id GET /streams/{id}, deduped and cached in the resolver; a failed lookup
 * degrades to a bare `{id}` ref. Rows without a streamId pass through untouched.
 */
export async function enrichStreamContext(rows: unknown, resolver: RefResolver): Promise<unknown> {
  if (!Array.isArray(rows)) return rows
  const streamIds = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const { streamId, rootStreamId } = row as { streamId?: unknown; rootStreamId?: unknown }
    if (typeof streamId === "string") streamIds.add(streamId)
    if (typeof rootStreamId === "string") streamIds.add(rootStreamId)
  }
  if (streamIds.size === 0) return rows

  const infos = new Map<string, ResolverStreamInfo | null>()
  await Promise.all([...streamIds].map(async (id) => infos.set(id, await resolver.streamInfo(id))))
  const rootIds = new Set<string>()
  for (const [id, info] of infos) {
    if (info?.rootStreamId && info.rootStreamId !== id && !infos.has(info.rootStreamId)) {
      rootIds.add(info.rootStreamId)
    }
  }
  await Promise.all([...rootIds].map(async (id) => infos.set(id, await resolver.streamInfo(id))))

  return rows.map((row) => {
    if (!row || typeof row !== "object") return row
    const r = row as { streamId?: unknown; rootStreamId?: unknown } & Record<string, unknown>
    if (typeof r.streamId !== "string") return row
    const info = infos.get(r.streamId) ?? null
    const out: Record<string, unknown> = { ...r, stream: toStreamRef(info, r.streamId) }
    const rootId = typeof r.rootStreamId === "string" ? r.rootStreamId : info?.rootStreamId
    if (rootId && rootId !== r.streamId) {
      out.rootStream = toStreamRef(infos.get(rootId) ?? null, rootId)
    }
    return out
  })
}

/**
 * Additively attach a `participants: [{id, name, slug?}]` array parallel to a
 * conversation's `participantIds`. Non-fatal and cached like enrichMessages.
 */
export async function enrichConversation(conversation: unknown, resolver: RefResolver): Promise<unknown> {
  if (!conversation || typeof conversation !== "object") return conversation
  const c = conversation as { participantIds?: unknown } & Record<string, unknown>
  if (!Array.isArray(c.participantIds) || c.participantIds.length === 0) return conversation
  const usersById = await loadUsersById(resolver)
  if (!usersById) return conversation
  const participants = c.participantIds.map((id) => {
    if (typeof id !== "string") return { id }
    const user = usersById.get(id)
    const entry: { id: string; name?: string; slug?: string } = { id }
    if (user?.name) entry.name = user.name
    if (user?.slug) entry.slug = user.slug
    return entry
  })
  return { ...c, participants }
}
