import { StreamTypes, type StreamType } from "@threahq/types"
import { collectSealedStreamIds, hiddenStreamIds, isUtilityStream } from "@/lib/streams"
import { getActivityTime } from "@/components/layout/sidebar/utils"

export const DIRECTORY_TABS = ["all", "channels", "scratchpads", "dms", "threads"] as const
export type DirectoryTab = (typeof DIRECTORY_TABS)[number]

const TAB_TYPES: Record<Exclude<DirectoryTab, "all">, StreamType> = {
  channels: StreamTypes.CHANNEL,
  scratchpads: StreamTypes.SCRATCHPAD,
  dms: StreamTypes.DM,
  threads: StreamTypes.THREAD,
}

export const DIRECTORY_SORTS = ["activity", "name", "members"] as const
export type DirectorySort = (typeof DIRECTORY_SORTS)[number]

export const DIRECTORY_MEMBERSHIPS = ["any", "joined", "not-joined"] as const
export type DirectoryMembership = (typeof DIRECTORY_MEMBERSHIPS)[number]

export interface DirectoryStream {
  id: string
  type: StreamType
  visibility: "public" | "private"
  parentStreamId?: string | null
  rootStreamId: string | null
  purpose?: string | null
  archivedAt: string | null
  createdAt: string
  lastMessagePreview?: { createdAt: string } | null
}

export interface DirectoryRow<S extends DirectoryStream> {
  stream: S
  name: string
  member: boolean
  /** A public channel the viewer can open but is not a member of. */
  joinable: boolean
}

/**
 * The explorer's rows for one tab: every listable stream of the tab's type,
 * in the chosen order (newest activity by default). Asides and anything rooted in one never list, same as
 * the sidebar. Threads carry no member rows (INV-62), so they are never joinable. A thread under an
 * archived stream is sealed with it and never lists as active.
 */
export function buildDirectoryRows<S extends DirectoryStream>({
  streams,
  memberStreamIds,
  tab,
  archived,
  query,
  nameOf,
  membership = "any",
  sort = "activity",
  memberCountOf = () => 0,
}: {
  streams: readonly S[]
  memberStreamIds: ReadonlySet<string>
  tab: DirectoryTab
  archived: boolean
  query: string
  nameOf: (stream: S) => string
  membership?: DirectoryMembership
  sort?: DirectorySort
  memberCountOf?: (streamId: string) => number
}): DirectoryRow<S>[] {
  const hidden = hiddenStreamIds(streams)
  const sealed = archived ? null : collectSealedStreamIds(streams)
  const type = tab === "all" ? null : TAB_TYPES[tab]
  const needle = query.trim().toLowerCase()

  const rows: DirectoryRow<S>[] = []
  for (const stream of streams) {
    if (hidden.has(stream.id) || isUtilityStream(stream)) continue
    if (stream.type === StreamTypes.SYSTEM) continue
    if (type && stream.type !== type) continue
    if (Boolean(stream.archivedAt) !== archived || sealed?.has(stream.id)) continue
    const name = nameOf(stream)
    if (needle && !name.toLowerCase().includes(needle)) continue
    const member = memberStreamIds.has(stream.id)
    if (membership === "joined" && !member) continue
    if (membership === "not-joined" && member) continue
    const joinable = !archived && stream.type === StreamTypes.CHANNEL && stream.visibility === "public" && !member
    rows.push({ stream, name, member, joinable })
  }
  const byActivity = (a: DirectoryRow<S>, b: DirectoryRow<S>) => getActivityTime(b.stream) - getActivityTime(a.stream)
  if (sort === "name") return rows.sort((a, b) => a.name.localeCompare(b.name) || byActivity(a, b))
  if (sort === "members") {
    return rows.sort((a, b) => memberCountOf(b.stream.id) - memberCountOf(a.stream.id) || byActivity(a, b))
  }
  return rows.sort(byActivity)
}

/** The busiest rows over the stats window, busiest first; idle streams never qualify. */
export function pickMostActive<S extends DirectoryStream>(
  rows: readonly DirectoryRow<S>[],
  messageCountOf: (streamId: string) => number,
  limit: number
): DirectoryRow<S>[] {
  return rows
    .filter((row) => messageCountOf(row.stream.id) > 0)
    .sort((a, b) => messageCountOf(b.stream.id) - messageCountOf(a.stream.id))
    .slice(0, limit)
}
