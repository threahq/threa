import type { RefResolver } from "./resolver"

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
