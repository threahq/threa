import { StreamTypes, type StreamType } from "@threahq/types"
import { hiddenStreamIds, isUtilityStream } from "@/lib/streams"
import { getActivityTime } from "@/components/layout/sidebar/utils"

export const DIRECTORY_TABS = ["all", "channels", "scratchpads", "dms", "threads"] as const
export type DirectoryTab = (typeof DIRECTORY_TABS)[number]

const TAB_TYPES: Record<Exclude<DirectoryTab, "all">, StreamType> = {
  channels: StreamTypes.CHANNEL,
  scratchpads: StreamTypes.SCRATCHPAD,
  dms: StreamTypes.DM,
  threads: StreamTypes.THREAD,
}

export interface DirectoryStream {
  id: string
  type: StreamType
  visibility: "public" | "private"
  rootStreamId: string | null
  purpose?: string | null
  archivedAt: string | null
  createdAt: string
  lastMessagePreview?: { createdAt: string } | null
}

export interface DirectoryRow<S extends DirectoryStream> {
  stream: S
  name: string
  /** A public channel the viewer can open but is not a member of. */
  joinable: boolean
}

/**
 * The explorer's rows for one tab: every listable stream of the tab's type,
 * newest activity first. Asides and anything rooted in one never list, same as
 * the sidebar. Threads carry no member rows (INV-62), so they are never joinable.
 */
export function buildDirectoryRows<S extends DirectoryStream>({
  streams,
  memberStreamIds,
  tab,
  archived,
  query,
  nameOf,
}: {
  streams: readonly S[]
  memberStreamIds: ReadonlySet<string>
  tab: DirectoryTab
  archived: boolean
  query: string
  nameOf: (stream: S) => string
}): DirectoryRow<S>[] {
  const hidden = hiddenStreamIds(streams)
  const type = tab === "all" ? null : TAB_TYPES[tab]
  const needle = query.trim().toLowerCase()

  const rows: DirectoryRow<S>[] = []
  for (const stream of streams) {
    if (hidden.has(stream.id) || isUtilityStream(stream)) continue
    if (stream.type === StreamTypes.SYSTEM) continue
    if (type && stream.type !== type) continue
    if (Boolean(stream.archivedAt) !== archived) continue
    const name = nameOf(stream)
    if (needle && !name.toLowerCase().includes(needle)) continue
    const joinable =
      !archived &&
      stream.type === StreamTypes.CHANNEL &&
      stream.visibility === "public" &&
      !memberStreamIds.has(stream.id)
    rows.push({ stream, name, joinable })
  }
  return rows.sort((a, b) => getActivityTime(b.stream) - getActivityTime(a.stream))
}
