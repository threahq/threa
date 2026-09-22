import { setBlockCollapse } from "@/lib/markdown/collapse-cache"
import { composeBlockCollapseKey } from "@/lib/markdown/markdown-block-context"
import type { TimelineItem } from "./event-list"

/**
 * A same-author run folds as one unit: folded, only the head row renders
 * (clamped) and the rest of the run is dropped from the list; open, the last
 * row carries the run's Collapse control and no member folds on its own.
 */
export type RunFold =
  | { state: "folded"; key: string; headMessageId: string; hiddenCount: number; unreadCount: number }
  | { state: "open"; key: string; headMessageId: string; isLast: boolean }

/**
 * Per-timeline memory the fold pass reads and writes. Heights outlive their row
 * so a hidden member still counts toward its run. A run's default is decided
 * once, the first time every member has been measured, and a message that was
 * ever shown in an open run never folds by default again this session — a run
 * the viewer has already seen open must not snap shut under them.
 */
export interface RunFoldStore {
  subscribe(listener: () => void): () => void
  getVersion(): number
  reportHeight(messageId: string, heightPx: number): void
  heightOf(messageId: string): number | undefined
  /** A viewer's explicit toggle: persisted, and it supersedes a deep-link reveal. */
  setCollapsed(key: string, headMessageId: string, collapsed: boolean): void
  /** Head of the run the viewer just folded; the list brings it back on screen once. */
  collapsedHeadMessageId: string | null
  /**
   * Server time of the newest message known when the timeline first rendered,
   * from the rendered events or the stream's last-message preview, whichever is
   * newer. Server time rather than sequence so a stale event cache catching up
   * does not pass off older messages as live arrivals.
   */
  baselineAtMs: number | null
  decisions: Map<string, boolean>
  openedMessageIds: Set<string>
  revealedKeys: Set<string>
}

export function createRunFoldStore(): RunFoldStore {
  const heights = new Map<string, number>()
  const listeners = new Set<() => void>()
  let version = 0
  const store: RunFoldStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    reportHeight(messageId, heightPx) {
      if (heights.get(messageId) === heightPx) return
      heights.set(messageId, heightPx)
      version++
      for (const listener of listeners) listener()
    },
    heightOf: (messageId) => heights.get(messageId),
    setCollapsed(key, headMessageId, collapsed) {
      store.revealedKeys.delete(key)
      store.collapsedHeadMessageId = collapsed ? headMessageId : null
      setBlockCollapse(key, headMessageId, "run", collapsed)
    },
    collapsedHeadMessageId: null,
    baselineAtMs: null,
    decisions: new Map(),
    openedMessageIds: new Set(),
    revealedKeys: new Set(),
  }
  return store
}

export function composeRunFoldKey(headMessageId: string, lastMessageId: string): string {
  return composeBlockCollapseKey(headMessageId, "run", lastMessageId)
}

export interface FoldAuthorRunsOptions {
  store: RunFoldStore
  /** The viewer's collapse preference: runs start folded when true. */
  defaultCollapsed: boolean
  collapseAtHeight: number
  /** Read watermark; `undefined` while read state is still resolving, `null` when never read. */
  frontierSequence: bigint | null | undefined
  /** The viewer's own messages are never unread. */
  viewerId: string | null | undefined
  /** `createdAt` of the stream's newest message, as the workspace last knew it. */
  latestKnownAt: string | null | undefined
  persisted: (key: string) => boolean | undefined
  /** Deep-link / search targets: a folded run containing one opens. */
  revealMessageIds: ReadonlyArray<string | null | undefined>
}

interface RunMember {
  index: number
  messageId: string
  sequence: bigint
  createdAtMs: number
  own: boolean
}

function messageIdOf(item: TimelineItem): string | undefined {
  if (item.type !== "event") return undefined
  return (item.event.payload as { messageId?: string } | undefined)?.messageId
}

function parseSequence(sequence: string): bigint {
  try {
    return BigInt(sequence)
  } catch {
    return 0n
  }
}

/**
 * Folds same-author runs (heads and `groupContinuation` rows, as stamped by the
 * grouping passes) behind one control. Runs of a single message are left to the
 * message's own fold.
 *
 * Writes to `store` are first-write-wins memos (baseline, per-run decision,
 * opened messages, reveals), so re-running the pass over the same input is
 * idempotent.
 */
export function foldAuthorRuns(items: TimelineItem[], options: FoldAuthorRunsOptions): TimelineItem[] {
  const { store } = options
  const runs: RunMember[][] = []
  let current: RunMember[] | null = null
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const messageId = messageIdOf(item)
    if (item.type !== "event" || !messageId) {
      current = null
      continue
    }
    const member = {
      index,
      messageId,
      sequence: parseSequence(item.event.sequence),
      createdAtMs: Date.parse(item.event.createdAt),
      own: !!options.viewerId && item.event.actorId === options.viewerId,
    }
    if (item.groupContinuation === true && current) {
      current.push(member)
    } else {
      current = [member]
      runs.push(current)
    }
  }

  if (store.baselineAtMs === null) {
    let max = options.latestKnownAt ? Date.parse(options.latestKnownAt) : Number.NEGATIVE_INFINITY
    for (const run of runs) for (const member of run) max = Math.max(max, member.createdAtMs)
    store.baselineAtMs = max
  }

  const frontier = options.frontierSequence
  const isUnread = (member: RunMember) =>
    !member.own && frontier !== undefined && (frontier === null || member.sequence > frontier)

  const reveal = new Set(options.revealMessageIds.filter((id): id is string => !!id))
  const annotations = new Map<number, RunFold>()
  const hidden = new Set<number>()

  for (const run of runs) {
    if (run.length < 2) continue
    const head = run[0]
    const last = run[run.length - 1]
    const key = composeRunFoldKey(head.messageId, last.messageId)

    let knownHeight = 0
    let allMeasured = true
    for (const member of run) {
      const height = store.heightOf(member.messageId)
      if (height === undefined) allMeasured = false
      else knownHeight += height
    }
    const persisted = options.persisted(key)
    const foldable = persisted === true || knownHeight > options.collapseAtHeight

    let decision = store.decisions.get(key)
    // Settle as soon as the answer can't change: every member measured, or the
    // measured part alone already crosses the threshold (a long run whose tail
    // is still outside the rendered range).
    if (decision === undefined && (allMeasured || foldable) && frontier !== undefined) {
      const baseline = store.baselineAtMs ?? Number.NEGATIVE_INFINITY
      const fresh = run.some((member) => member.createdAtMs > baseline || isUnread(member))
      const opened = run.some((member) => store.openedMessageIds.has(member.messageId))
      decision = options.defaultCollapsed && foldable && !fresh && !opened
      store.decisions.set(key, decision)
    }
    if (decision === false) for (const member of run) store.openedMessageIds.add(member.messageId)

    if (!foldable) continue

    let collapsed = persisted ?? decision ?? false
    if (collapsed && !store.revealedKeys.has(key) && run.some((member) => reveal.has(member.messageId))) {
      store.revealedKeys.add(key)
    }
    if (store.revealedKeys.has(key)) collapsed = false

    if (collapsed) {
      annotations.set(head.index, {
        state: "folded",
        key,
        headMessageId: head.messageId,
        hiddenCount: run.length - 1,
        unreadCount: run.slice(1).filter(isUnread).length,
      })
      for (const member of run.slice(1)) hidden.add(member.index)
    } else {
      for (const member of run) {
        annotations.set(member.index, {
          state: "open",
          key,
          headMessageId: head.messageId,
          isLast: member === last,
        })
      }
    }
  }

  if (annotations.size === 0) return items
  const out: TimelineItem[] = []
  for (let index = 0; index < items.length; index++) {
    if (hidden.has(index)) continue
    const item = items[index]
    const runFold = annotations.get(index)
    out.push(runFold && item.type === "event" ? { ...item, runFold } : item)
  }
  return out
}
