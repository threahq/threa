import { type StreamType, StreamTypes } from "@threa/types"
import { ALL_SECTIONS, SMART_SECTIONS } from "./config"
import type { SidebarConfig, SidebarSection, SidebarSectionSpec } from "./sidebar-config"
import type { SectionKey, StreamItemData } from "./types"
import { sortStreams } from "./utils"

type TypeSectionStream = Extract<StreamType, "scratchpad" | "channel" | "dm">

/** Important is capped so a noisy day can't bury the rest of the sidebar. */
const IMPORTANT_LIMIT = 10
/** Recent shows at most this many reads; unreads beyond it still surface (see below). */
const RECENT_LIMIT = 5

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
 */
export function resolveSections(config: SidebarConfig, input: ResolveSectionsInput): ResolvedSection[] {
  const claimed = new Set<string>()
  // Streams pinned to any custom section, gathered before resolving so they can
  // be withheld from every other section wherever those sit in the order.
  const customClaimed = new Set<string>()
  // Streams carrying a label that is pinned as a section, gathered the same way
  // so the label lens claims them out of the smart/type buckets — a labeled
  // stream lives under its label, not its automatic bucket, regardless of order.
  const labeledClaimed = new Set<string>()
  for (const section of config.sections) {
    if (section.spec.kind === "custom") for (const id of section.spec.streamIds) customClaimed.add(id)
    if (section.spec.kind === "label") {
      const ids = input.streamIdsByLabel.get(section.spec.labelId)
      if (ids) for (const id of ids) labeledClaimed.add(id)
    }
  }
  return config.sections.map((section) => {
    const items = resolveItems(section.spec, input, claimed, customClaimed, labeledClaimed)
    for (const item of items) claimed.add(item.id)
    return { section, items }
  })
}

function resolveItems(
  spec: SidebarSectionSpec,
  input: ResolveSectionsInput,
  claimed: ReadonlySet<string>,
  customClaimed: ReadonlySet<string>,
  labeledClaimed: ReadonlySet<string>
): StreamItemData[] {
  // A custom section draws only its own membership, minus anything an earlier
  // custom section already took (single-membership; topmost custom wins).
  if (spec.kind === "custom") return resolveCustomSection(spec.streamIds, input, claimed)
  // A label lens shows its streams out of the buckets, but a stream filed into a
  // custom section still trumps the label — fold custom membership into the
  // exclusion. Topmost label wins via the running `claimed` set.
  if (spec.kind === "label") {
    const exclude = customClaimed.size === 0 ? claimed : new Set([...claimed, ...customClaimed])
    return resolveLabelSection(spec.labelId, input, exclude)
  }
  // Smart/type buckets never show a stream that was filed into a custom section
  // or that carries a pinned label, so fold both memberships into their
  // exclusion set on top of the running claims.
  const exclude =
    customClaimed.size === 0 && labeledClaimed.size === 0
      ? claimed
      : new Set([...claimed, ...customClaimed, ...labeledClaimed])
  if (spec.kind === "smart") return resolveSmartBucket(spec.bucket, input, exclude)
  if (spec.kind === "type") return resolveTypeSection(spec.streamType, input, exclude)
  // Quick links draw no streams — the block renders its own link list, so the
  // resolved section is a positional placeholder the stream list renders specially.
  return []
}

/**
 * Streams the viewer filed into a custom section, by activity. Draws from real
 * streams only (synthetic DM drafts can't be filed). Preserves the membership's
 * resolution against `claimed` so a stream duplicated across custom sections
 * (stray data) only surfaces in the first.
 */
function resolveCustomSection(
  streamIds: readonly string[],
  { processedStreams, getUnreadCount }: ResolveSectionsInput,
  exclude: ReadonlySet<string>
): StreamItemData[] {
  if (streamIds.length === 0) return []
  const members = new Set(streamIds)
  const items = processedStreams.filter((stream) => members.has(stream.id) && !exclude.has(stream.id))
  return sortStreams(items, "activity", getUnreadCount)
}

/** Streams carrying a label, by activity. Draws from real streams only (synthetic DM drafts can't be labeled). */
function resolveLabelSection(
  labelId: string,
  { processedStreams, streamIdsByLabel, getUnreadCount }: ResolveSectionsInput,
  exclude: ReadonlySet<string>
): StreamItemData[] {
  const streamIds = streamIdsByLabel.get(labelId)
  if (!streamIds || streamIds.size === 0) return []
  const items = processedStreams.filter((stream) => streamIds.has(stream.id) && !exclude.has(stream.id))
  return sortStreams(items, "activity", getUnreadCount)
}

function resolveSmartBucket(
  bucket: SectionKey,
  { processedStreams, virtualDmStreams, getUnreadCount }: ResolveSectionsInput,
  exclude: ReadonlySet<string>
): StreamItemData[] {
  const pool = [...processedStreams, ...virtualDmStreams].filter((stream) => !exclude.has(stream.id))
  const items = pool.filter((stream) => stream.section === bucket)

  switch (bucket) {
    case "important":
      sortStreams(items, SMART_SECTIONS.important.sortType, getUnreadCount)
      return items.slice(0, IMPORTANT_LIMIT)

    case "recent": {
      // Show unreads, OR up to RECENT_LIMIT most recent:
      // - no unreads → at most RECENT_LIMIT reads
      // - <RECENT_LIMIT unreads → unreads + reads filling the remaining slots
      // - ≥RECENT_LIMIT unreads → all unreads (cap is lifted so nothing unread hides)
      sortStreams(items, SMART_SECTIONS.recent.sortType, getUnreadCount)
      const unreads = items.filter((stream) => getUnreadCount(stream.id) > 0)
      const reads = items.filter((stream) => getUnreadCount(stream.id) === 0)
      if (unreads.length >= RECENT_LIMIT) return unreads
      return [...unreads, ...reads.slice(0, RECENT_LIMIT - unreads.length)]
    }

    case "pinned":
      sortStreams(items, SMART_SECTIONS.pinned.sortType, getUnreadCount)
      return items

    case "other":
      sortStreams(items, SMART_SECTIONS.other.sortType, getUnreadCount)
      return items
  }
}

function resolveTypeSection(
  streamType: TypeSectionStream,
  { processedStreams, virtualDmStreams, getUnreadCount }: ResolveSectionsInput,
  exclude: ReadonlySet<string>
): StreamItemData[] {
  const streams = processedStreams.filter((stream) => !exclude.has(stream.id))

  if (streamType === "scratchpad") {
    const items = streams.filter((stream) => stream.type === StreamTypes.SCRATCHPAD)
    return sortStreams(items, ALL_SECTIONS.scratchpads.sortType, getUnreadCount)
  }

  if (streamType === "channel") {
    const items = streams.filter((stream) => stream.type === StreamTypes.CHANNEL)
    return sortStreams(items, ALL_SECTIONS.channels.sortType, getUnreadCount)
  }

  // DMs: real DMs by activity, then system streams, then synthetic DM drafts.
  const realDms = streams.filter((stream) => stream.type === StreamTypes.DM)
  const systemStreams = streams.filter((stream) => stream.type === StreamTypes.SYSTEM)
  const drafts = virtualDmStreams.filter((stream) => !exclude.has(stream.id))
  sortStreams(realDms, "activity", getUnreadCount)
  sortStreams(systemStreams, ALL_SECTIONS.dms.sortType, getUnreadCount)
  return [...realDms, ...systemStreams, ...drafts]
}
