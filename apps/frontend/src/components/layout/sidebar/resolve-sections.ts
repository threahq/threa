import { type StreamType, StreamTypes, type InboxOrder } from "@threahq/types"
import type { SidebarConfig, SidebarSection, SidebarSectionSpec } from "./sidebar-config"
import type { SectionKey, StreamItemData } from "./types"
import { isUnreadStream, sortStreams, sortStreamsStatic } from "./utils"

type TypeSectionStream = Extract<StreamType, "scratchpad" | "channel" | "dm">

/** Important is capped so a noisy day can't bury the rest of the sidebar. */
const IMPORTANT_LIMIT = 10
/** Recent shows at most this many reads; unreads beyond it still surface (see below). */
const RECENT_LIMIT = 5

const EMPTY_SET: ReadonlySet<string> = new Set()

/** Merge id sets, returning the single non-empty input unchanged when there is only one. */
function union(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
  const nonEmpty = sets.filter((set) => set.size > 0)
  if (nonEmpty.length === 0) return EMPTY_SET
  if (nonEmpty.length === 1) return nonEmpty[0]
  const out = new Set<string>()
  for (const set of nonEmpty) for (const id of set) out.add(id)
  return out
}

export interface ResolveSectionsInput {
  /** Real streams, already filtered + enriched with urgency/section. */
  processedStreams: StreamItemData[]
  /** Synthetic DM drafts for members the user hasn't messaged yet. */
  virtualDmStreams: StreamItemData[]
  getUnreadCount: (streamId: string) => number
  /**
   * For each label id, the set of stream ids the viewer can see that carry it.
   * Drives `{ kind: "label" }` sections; an absent label resolves to empty.
   */
  streamIdsByLabel: Map<string, Set<string>>
  /**
   * The viewer's currently-unread stream ids (muted excluded). Empty unless the
   * layout has an `{ kind: "unread" }` section. Members render only in Unread;
   * every other section excludes them, so an unread stream shows once — in
   * Unread — and drops back to its home section the moment it's read. Drives both
   * the Unread section's contents and the exclusion the other sections apply.
   */
  unreadStreamIds: ReadonlySet<string>
  /** Sidebar Inbox sort order (`inboxOrder` preference). Drives Unread section ordering only. */
  inboxOrder: InboxOrder
  /** First-arrival timestamp per stream currently held/unread, for `inboxOrder: "arrival"` sorting. */
  inboxArrivedAt: Record<string, string>
  /**
   * The viewer's own membership join time per stream, keying the static
   * non-channel order (newest joined first); a stream with no membership row
   * (a virtual DM draft, or any stream the viewer never separately joined)
   * falls back to its `createdAt`.
   */
  joinedAtByStreamId: ReadonlyMap<string, string>
  /** Type of every stream the viewer can see, visible in the sidebar or not; places a thread in its root's type section. */
  streamTypeById: ReadonlyMap<string, StreamType>
  /**
   * Threads that keep their row while read: open in the main view or side panel,
   * or with an agent working in them.
   */
  keptThreadIds?: ReadonlySet<string>
  /**
   * Threads shown earlier this page load; a read one keeps its row, marked
   * `held`, until the viewer clears it, so reading never pulls a row away.
   */
  heldThreadIds?: ReadonlySet<string>
}

export interface ResolvedSection {
  section: SidebarSection
  items: StreamItemData[]
}

/**
 * The label id of the label section a stream is currently rendered under, or
 * null when it isn't shown in a label section. Drives the "remove the old
 * label?" prompt when a stream is dragged out of its label lens — the stream is
 * placed in exactly one section, so the first match is its visible home.
 */
export function findSourceLabelId(streamId: string, resolved: ResolvedSection[]): string | null {
  for (const { section, items } of resolved) {
    if (section.spec.kind !== "label") continue
    if (items.some((item) => item.id === streamId)) return section.spec.labelId
  }
  return null
}

/**
 * Turn a {@link SidebarConfig} into the ordered, capped, sorted stream lists the
 * sidebar renders. Pure — no React, no IO — so it is exercised directly in tests
 * and reused by every view. Each stream appears in the topmost section that
 * claims it: sections resolve in order and a stream already shown above is
 * excluded from every section below. Smart buckets and stream types are mutually
 * exclusive by construction, but label sections overlap with them (a labeled
 * stream also matches its smart/type bucket), so without this the same stream
 * would show twice — once in its label lens and again lower down. Exclusion runs
 * before each section's caps, so a capped bucket (e.g. Recent) backfills the
 * slots freed by streams claimed above it.
 *
 * Custom sections and pinned label sections are the exception to topmost-wins:
 * a stream filed into a custom section, or carrying a pinned label, shows under
 * that section **only**, even when a smart/type bucket ordered above it would
 * also match. Both memberships are collected up front and excluded from the
 * automatic buckets regardless of order — so an explicit "filing" trumps the
 * layout order rather than competing for the topmost claim. Custom sections
 * out-rank label sections (a stream filed into a custom section is withheld
 * from the label lens too); among label sections, the topmost one wins.
 *
 * The Unread section ({@link ResolveSectionsInput.unreadStreamIds}) trumps every
 * other section: an unread stream shows **only** in the Unread section, drawn out
 * of its smart/type bucket and its custom/label home alike, so there is one copy.
 * Membership is the live unread set, so reading a stream drops it from here and it
 * reappears in its home section.
 */
export function resolveSections(config: SidebarConfig, input: ResolveSectionsInput): ResolvedSection[] {
  const resolved = markHeldThreads(resolveFlat(config, input), input)
  return nestThreads(resolved)
}

function resolveFlat(config: SidebarConfig, input: ResolveSectionsInput): ResolvedSection[] {
  const claimed = new Set<string>()
  // Streams pinned to any custom section, gathered before resolving so they can
  // be withheld from every other section wherever those sit in the order.
  const customClaimed = new Set<string>()
  // Streams carrying a label that is pinned as a section, gathered the same way
  // so the label lens claims them out of the smart/type buckets — a labeled
  // stream lives under its label, not its automatic bucket, regardless of order.
  const labeledClaimed = new Set<string>()
  const overflowBuckets = new Set<SectionKey>()
  for (const section of config.sections) {
    if (section.spec.kind === "custom") for (const id of section.spec.streamIds) customClaimed.add(id)
    if (section.spec.kind === "label") {
      const ids = input.streamIdsByLabel.get(section.spec.labelId)
      if (ids) for (const id of ids) labeledClaimed.add(id)
    }
    if (section.spec.kind === "smart" && section.spec.bucket !== "other") {
      overflowBuckets.add(section.spec.bucket)
    }
  }

  const resolved = config.sections.map((section) => {
    const items = resolveItems(section.spec, input, claimed, customClaimed, labeledClaimed)
    // The Unread section never claims its streams: every other section already
    // excludes its members via `unreadStreamIds`, and claiming would also block a
    // stream from returning to its home section once it's read.
    if (section.spec.kind !== "unread") for (const item of items) claimed.add(item.id)
    return { section, items }
  })

  const remainder = resolved.find(({ section }) => section.spec.kind === "smart" && section.spec.bucket === "other")
  if (!remainder) return resolved

  const idle = idleThreadIds(input)
  const overflow = [...input.processedStreams, ...input.virtualDmStreams].filter(
    (stream) =>
      !claimed.has(stream.id) &&
      !input.unreadStreamIds.has(stream.id) &&
      !idle.has(stream.id) &&
      overflowBuckets.has(stream.section)
  )
  if (overflow.length === 0) return resolved

  const items = sortStreamsStatic([...remainder.items, ...overflow], input.joinedAtByStreamId)
  return resolved.map((entry) => (entry === remainder ? { ...entry, items } : entry))
}

function resolveItems(
  spec: SidebarSectionSpec,
  input: ResolveSectionsInput,
  claimed: ReadonlySet<string>,
  customClaimed: ReadonlySet<string>,
  labeledClaimed: ReadonlySet<string>
): StreamItemData[] {
  const unread = input.unreadStreamIds
  // The Unread section draws its members regardless of the running claims (nothing
  // above can have taken them, since every other section excludes the unread set).
  if (spec.kind === "unread") return resolveUnreadSection(input)
  // A custom section draws its own membership minus anything an earlier custom
  // section took (single-membership; topmost custom wins) and minus the unread set.
  if (spec.kind === "custom") return resolveCustomSection(spec.streamIds, input, union(claimed, unread))
  // A label lens shows its streams out of the buckets, but a stream filed into a
  // custom section trumps the label, and an unread stream shows only in Unread —
  // fold both into the exclusion. Topmost label wins via the running `claimed`.
  if (spec.kind === "label") return resolveLabelSection(spec.labelId, input, union(claimed, customClaimed, unread))
  // Smart/type buckets never show a stream filed into a custom section, carrying a
  // pinned label, or currently unread — fold all three into the exclusion. They
  // also skip read threads: an automatic section lists a thread only while it's
  // unread, kept or held, since the rest are a click away inside their root stream.
  const exclude = union(claimed, customClaimed, labeledClaimed, unread, idleThreadIds(input))
  if (spec.kind === "smart") return resolveSmartBucket(spec.bucket, input, exclude)
  if (spec.kind === "type") return resolveTypeSection(spec.streamType, input, exclude)
  // Quick links draw no streams — the block renders its own link list, so the
  // resolved section is a positional placeholder the stream list renders specially.
  return []
}

/**
 * The Unread section's members (see {@link ResolveSectionsInput.unreadStreamIds}),
 * by activity. Draws from real streams only — synthetic DM drafts are never
 * unread. Reading a stream removes it from the set, so it leaves here in the same
 * render and returns to its home section.
 */
function resolveUnreadSection({
  processedStreams,
  unreadStreamIds,
  getUnreadCount,
  inboxOrder,
  inboxArrivedAt,
}: ResolveSectionsInput): StreamItemData[] {
  if (unreadStreamIds.size === 0) return []
  const items = processedStreams.filter((stream) => unreadStreamIds.has(stream.id))
  sortStreams(items, "activity", getUnreadCount)
  if (inboxOrder !== "arrival") return items
  // Oldest-arrival first; streams with no recorded arrival sort after those
  // with one and keep the activity order just established (stable sort).
  return items.sort((a, b) => {
    const arrivalA = inboxArrivedAt[a.id]
    const arrivalB = inboxArrivedAt[b.id]
    if (arrivalA !== undefined && arrivalB !== undefined) {
      return new Date(arrivalA).getTime() - new Date(arrivalB).getTime()
    }
    if (arrivalA !== undefined) return -1
    if (arrivalB !== undefined) return 1
    return 0
  })
}

/**
 * Streams the viewer filed into a custom section, statically ordered. Draws
 * from real streams only (synthetic DM drafts can't be filed). Preserves the
 * membership's resolution against `claimed` so a stream duplicated across
 * custom sections (stray data) only surfaces in the first.
 */
function resolveCustomSection(
  streamIds: readonly string[],
  { processedStreams, joinedAtByStreamId }: ResolveSectionsInput,
  exclude: ReadonlySet<string>
): StreamItemData[] {
  if (streamIds.length === 0) return []
  const members = new Set(streamIds)
  const items = processedStreams.filter((stream) => members.has(stream.id) && !exclude.has(stream.id))
  return sortStreamsStatic(items, joinedAtByStreamId)
}

/** Streams carrying a label, statically ordered. Draws from real streams only (synthetic DM drafts can't be labeled). */
function resolveLabelSection(
  labelId: string,
  { processedStreams, streamIdsByLabel, joinedAtByStreamId }: ResolveSectionsInput,
  exclude: ReadonlySet<string>
): StreamItemData[] {
  const streamIds = streamIdsByLabel.get(labelId)
  if (!streamIds || streamIds.size === 0) return []
  const items = processedStreams.filter((stream) => streamIds.has(stream.id) && !exclude.has(stream.id))
  return sortStreamsStatic(items, joinedAtByStreamId)
}

function resolveSmartBucket(
  bucket: SectionKey,
  { processedStreams, virtualDmStreams, getUnreadCount, joinedAtByStreamId }: ResolveSectionsInput,
  exclude: ReadonlySet<string>
): StreamItemData[] {
  const pool = [...processedStreams, ...virtualDmStreams].filter((stream) => !exclude.has(stream.id))
  const items = pool.filter((stream) => stream.section === bucket)

  switch (bucket) {
    case "important": {
      sortStreams(items, "importance", getUnreadCount)
      const top = items.slice(0, IMPORTANT_LIMIT)
      return sortStreamsStatic(top, joinedAtByStreamId)
    }

    case "recent": {
      // Show unreads, OR up to RECENT_LIMIT most recent:
      // - no unreads → at most RECENT_LIMIT reads
      // - <RECENT_LIMIT unreads → unreads + reads filling the remaining slots
      // - ≥RECENT_LIMIT unreads → all unreads (cap is lifted so nothing unread hides)
      sortStreams(items, "activity", getUnreadCount)
      const unreads = items.filter((stream) => getUnreadCount(stream.id) > 0)
      const reads = items.filter((stream) => getUnreadCount(stream.id) === 0)
      const selected =
        unreads.length >= RECENT_LIMIT ? unreads : [...unreads, ...reads.slice(0, RECENT_LIMIT - unreads.length)]
      return sortStreamsStatic(selected, joinedAtByStreamId)
    }

    case "other":
      return sortStreamsStatic(items, joinedAtByStreamId)
  }
}

function resolveTypeSection(
  streamType: TypeSectionStream,
  { processedStreams, virtualDmStreams, joinedAtByStreamId, streamTypeById }: ResolveSectionsInput,
  exclude: ReadonlySet<string>
): StreamItemData[] {
  const streams = processedStreams.filter((stream) => !exclude.has(stream.id))
  // In the tree a thread lives in its root's type section; `nestThreads` then
  // moves it under the root's row wherever that row landed.
  const threads = streams.filter(
    (stream) => stream.type === StreamTypes.THREAD && threadHomeType(stream, streamTypeById) === streamType
  )

  if (streamType === "scratchpad") {
    const items = streams.filter((stream) => stream.type === StreamTypes.SCRATCHPAD)
    return [...sortStreamsStatic(items, joinedAtByStreamId), ...sortStreamsStatic(threads, joinedAtByStreamId)]
  }

  if (streamType === "channel") {
    const items = streams.filter((stream) => stream.type === StreamTypes.CHANNEL)
    return [...sortStreamsStatic(items, joinedAtByStreamId), ...sortStreamsStatic(threads, joinedAtByStreamId)]
  }

  // DMs: real DMs static, then system streams static, then synthetic DM drafts
  // (already alphabetical from buildVirtualDmDrafts).
  const realDms = streams.filter((stream) => stream.type === StreamTypes.DM)
  const systemStreams = streams.filter((stream) => stream.type === StreamTypes.SYSTEM)
  const drafts = virtualDmStreams.filter((stream) => !exclude.has(stream.id))
  return [
    ...sortStreamsStatic(realDms, joinedAtByStreamId),
    ...sortStreamsStatic(systemStreams, joinedAtByStreamId),
    ...sortStreamsStatic(threads, joinedAtByStreamId),
    ...drafts,
  ]
}

/** The type section a thread falls back to when its root has no row: its root's. */
function threadHomeType(
  thread: StreamItemData,
  streamTypeById: ReadonlyMap<string, StreamType>
): TypeSectionStream | null {
  const rootType = thread.rootStreamId ? streamTypeById.get(thread.rootStreamId) : undefined
  if (rootType === StreamTypes.CHANNEL) return "channel"
  if (rootType === StreamTypes.SCRATCHPAD) return "scratchpad"
  if (rootType === StreamTypes.DM || rootType === StreamTypes.SYSTEM) return "dm"
  return null
}

/** Read threads nothing keeps: not open, no agent working, not held. */
function idleThreadIds(input: ResolveSectionsInput): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const stream of input.processedStreams) {
    if (isReadUnkeptThread(stream, input) && !input.heldThreadIds?.has(stream.id)) ids.add(stream.id)
  }
  return ids
}

function isReadUnkeptThread(stream: StreamItemData, input: ResolveSectionsInput): boolean {
  return (
    stream.type === StreamTypes.THREAD &&
    !input.keptThreadIds?.has(stream.id) &&
    !isUnreadStream(stream, input.getUnreadCount(stream.id))
  )
}

/** Flag the rows smart/type sections list only because they're held. */
function markHeldThreads(resolved: ResolvedSection[], input: ResolveSectionsInput): ResolvedSection[] {
  const heldThreadIds = input.heldThreadIds
  if (!heldThreadIds?.size) return resolved
  return resolved.map((entry) => {
    const kind = entry.section.spec.kind
    if (kind !== "smart" && kind !== "type") return entry
    const items = entry.items.map((item) =>
      heldThreadIds.has(item.id) && isReadUnkeptThread(item, input) ? { ...item, held: true } : item
    )
    return { ...entry, items }
  })
}

/**
 * Move each thread under its root stream's row. A thread in an automatic
 * (smart/type) section follows its root to whichever section the root landed in;
 * one the viewer filed (custom/label) stays there and nests only when its root
 * shares the section. A thread whose root has no row (root in the Inbox, or not
 * listed) stays a top-level row. Inbox rows never nest. Children follow their
 * root in static order and carry `treeParentId`.
 */
function nestThreads(resolved: ResolvedSection[]): ResolvedSection[] {
  const rootSection = new Map<string, number>()
  resolved.forEach(({ section, items }, index) => {
    if (section.spec.kind === "unread") return
    for (const item of items) if (item.type !== StreamTypes.THREAD) rootSection.set(item.id, index)
  })

  const children = new Map<string, StreamItemData[]>()
  const moved = new Set<string>()
  resolved.forEach(({ section, items }, index) => {
    if (section.spec.kind === "unread") return
    const automatic = section.spec.kind === "smart" || section.spec.kind === "type"
    for (const item of items) {
      if (item.type !== StreamTypes.THREAD || !item.rootStreamId) continue
      const target = rootSection.get(item.rootStreamId)
      if (target === undefined || (target !== index && !automatic)) continue
      const kids = children.get(item.rootStreamId) ?? []
      kids.push(item)
      children.set(item.rootStreamId, kids)
      moved.add(item.id)
    }
  })
  if (moved.size === 0) return resolved

  return resolved.map((entry) => {
    if (entry.section.spec.kind === "unread") return entry
    const items: StreamItemData[] = []
    for (const item of entry.items) {
      if (moved.has(item.id)) continue
      items.push(item)
      const kids = children.get(item.id)
      if (kids) for (const kid of kids) items.push({ ...kid, treeParentId: item.id })
    }
    return { ...entry, items }
  })
}
