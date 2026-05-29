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
}

export interface ResolvedSection {
  section: SidebarSection
  items: StreamItemData[]
}

/**
 * Turn a {@link SidebarConfig} into the ordered, capped, sorted stream lists the
 * sidebar renders. Pure — no React, no IO — so it is exercised directly in tests
 * and reused by every view. Each spec is mutually exclusive today (a stream
 * lands in exactly one smart bucket and is exactly one type), so sections are
 * resolved independently against the shared pool.
 */
export function resolveSections(config: SidebarConfig, input: ResolveSectionsInput): ResolvedSection[] {
  return config.sections.map((section) => ({
    section,
    items: resolveItems(section.spec, input),
  }))
}

function resolveItems(spec: SidebarSectionSpec, input: ResolveSectionsInput): StreamItemData[] {
  if (spec.kind === "smart") return resolveSmartBucket(spec.bucket, input)
  return resolveTypeSection(spec.streamType, input)
}

function resolveSmartBucket(
  bucket: SectionKey,
  { processedStreams, virtualDmStreams, getUnreadCount }: ResolveSectionsInput
): StreamItemData[] {
  const pool = [...processedStreams, ...virtualDmStreams]
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
  { processedStreams, virtualDmStreams, getUnreadCount }: ResolveSectionsInput
): StreamItemData[] {
  if (streamType === "scratchpad") {
    const items = processedStreams.filter((stream) => stream.type === StreamTypes.SCRATCHPAD)
    return sortStreams(items, ALL_SECTIONS.scratchpads.sortType, getUnreadCount)
  }

  if (streamType === "channel") {
    const items = processedStreams.filter((stream) => stream.type === StreamTypes.CHANNEL)
    return sortStreams(items, ALL_SECTIONS.channels.sortType, getUnreadCount)
  }

  // DMs: real DMs by activity, then system streams, then synthetic DM drafts.
  const realDms = processedStreams.filter((stream) => stream.type === StreamTypes.DM)
  const systemStreams = processedStreams.filter((stream) => stream.type === StreamTypes.SYSTEM)
  sortStreams(realDms, "activity", getUnreadCount)
  sortStreams(systemStreams, ALL_SECTIONS.dms.sortType, getUnreadCount)
  return [...realDms, ...systemStreams, ...virtualDmStreams]
}
