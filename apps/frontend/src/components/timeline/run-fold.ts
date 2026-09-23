import { setBlockCollapse } from "@/lib/markdown/collapse-cache"
import { composeBlockCollapseKey } from "@/lib/markdown/markdown-block-context"
import type { TimelineItem } from "./event-list"

/**
 * A same-author run folds as one unit: folded, only the head row renders
 * (clamped) and the rest of the run is dropped from the list; open, the last
 * row carries the run's Collapse control and no member folds on its own.
 */
export type RunFold =
  | {
      state: "folded"
      key: string
      headMessageId: string
      lastMessageId: string
      hiddenCount: number
      unreadCount: number
    }
  | { state: "open"; key: string; headMessageId: string; lastMessageId: string; isLast: boolean }

/**
 * Per-timeline memory the fold pass reads and writes. Heights outlive their row
 * so a hidden member still counts toward its run. A run folds only when the
 * viewer collapses it, never by default.
 */
export interface RunFoldStore {
  subscribe(listener: () => void): () => void
  getVersion(): number
  reportHeight(messageId: string, heightPx: number): void
  heightOf(messageId: string): number | undefined
  /** A viewer's explicit toggle: persisted, and it supersedes the reveal that opened the run. */
  setCollapsed(fold: RunFold, collapsed: boolean): void
  /** The run the viewer just toggled; the list restores scroll and focus once. */
  toggledRun: { headMessageId: string; collapsed: boolean } | null
  /** Run key → the reveal target that opened it. */
  revealedBy: Map<string, string>
  /** `key\nmessageId` reveals the viewer has since overridden with a toggle. */
  spentReveals: Set<string>
  /**
   * Run key → the last member when the run folded. Messages the author adds
   * afterwards render below the fold instead of popping it open.
   */
  foldedThrough: Map<string, string>
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
    setCollapsed(fold, collapsed) {
      const revealedBy = store.revealedBy.get(fold.key)
      if (revealedBy !== undefined) store.spentReveals.add(`${fold.key}\n${revealedBy}`)
      store.revealedBy.delete(fold.key)
      if (collapsed) store.foldedThrough.set(fold.key, fold.lastMessageId)
      store.toggledRun = { headMessageId: fold.headMessageId, collapsed }
      setBlockCollapse(fold.key, fold.headMessageId, "run", collapsed)
    },
    toggledRun: null,
    revealedBy: new Map(),
    spentReveals: new Set(),
    foldedThrough: new Map(),
  }
  return store
}

export function composeRunFoldKey(headMessageId: string): string {
  return composeBlockCollapseKey(headMessageId, "run", "head")
}

export interface FoldAuthorRunsOptions {
  store: RunFoldStore
  collapseAtHeight: number
  /** Read watermark; `undefined` while read state is still resolving, `null` when never read. */
  frontierSequence: bigint | null | undefined
  /** The viewer's own messages are never unread. */
  viewerId: string | null | undefined
  persisted: (key: string) => boolean | undefined
  /** Deep-link / search targets: a folded run containing one opens. */
  revealMessageIds: ReadonlyArray<string | null | undefined>
}

interface RunMember {
  index: number
  messageId: string
  sequence: bigint
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
 * Writes to `store` are first-write-wins memos (fold boundary, reveals), so
 * re-running the pass over the same input is idempotent.
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
      own: !!options.viewerId && item.event.actorId === options.viewerId,
    }
    if (item.groupContinuation === true && current) {
      current.push(member)
    } else {
      current = [member]
      runs.push(current)
    }
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
    const key = composeRunFoldKey(head.messageId)

    let knownHeight = 0
    for (const member of run) knownHeight += store.heightOf(member.messageId) ?? 0
    const persisted = options.persisted(key)
    if (persisted !== true && knownHeight <= options.collapseAtHeight) continue

    let collapsed = persisted === true
    let end = run.length - 1
    if (collapsed) {
      const through = run.findIndex((member) => member.messageId === store.foldedThrough.get(key))
      if (through > 0) end = through
      else store.foldedThrough.set(key, last.messageId)
      if (!store.revealedBy.has(key)) {
        const target = run
          .slice(1, end + 1)
          .find((member) => reveal.has(member.messageId) && !store.spentReveals.has(`${key}\n${member.messageId}`))
        if (target) store.revealedBy.set(key, target.messageId)
      }
    }
    if (store.revealedBy.has(key)) collapsed = false

    if (collapsed) {
      const folded = run.slice(1, end + 1)
      annotations.set(head.index, {
        state: "folded",
        key,
        headMessageId: head.messageId,
        lastMessageId: run[end].messageId,
        hiddenCount: folded.length,
        unreadCount: folded.filter(isUnread).length,
      })
      for (const member of folded) hidden.add(member.index)
    } else {
      store.foldedThrough.delete(key)
      for (const member of run) {
        annotations.set(member.index, {
          state: "open",
          key,
          headMessageId: head.messageId,
          lastMessageId: last.messageId,
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
