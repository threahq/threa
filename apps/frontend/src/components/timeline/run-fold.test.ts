import { describe, it, expect, beforeEach } from "vitest"
import type { StreamEvent } from "@threahq/types"
import { __resetCollapseCacheForTests, getBlockCollapse } from "@/lib/markdown/collapse-cache"
import { composeRunFoldKey, createRunFoldStore, foldAuthorRuns, type RunFold, type RunFoldStore } from "./run-fold"
import type { TimelineItem } from "./event-list"

const AUTHOR = "usr_author"
const VIEWER = "usr_viewer"

function at(n: number): string {
  return new Date(Date.UTC(2026, 8, 22, 0, n)).toISOString()
}

function message(n: number, continuation = false, actorId = AUTHOR): TimelineItem {
  const event: StreamEvent = {
    id: `event_${n}`,
    streamId: "stream_1",
    sequence: String(n),
    eventType: "message_created",
    payload: { messageId: `msg_${n}`, contentMarkdown: `m${n}` },
    actorId,
    actorType: "user",
    createdAt: at(n),
  }
  return { type: "event", event, groupContinuation: continuation }
}

/** A run of messages `from..to` by one author. */
function run(from: number, to: number, actorId = AUTHOR): TimelineItem[] {
  const items: TimelineItem[] = []
  for (let n = from; n <= to; n++) items.push(message(n, n !== from, actorId))
  return items
}

function measure(store: RunFoldStore, from: number, to: number, heightPx: number) {
  for (let n = from; n <= to; n++) store.reportHeight(`msg_${n}`, heightPx)
}

function describeRows(items: TimelineItem[]) {
  return items.map((item) => {
    if (item.type !== "event") return item.type
    const id = (item.event.payload as { messageId: string }).messageId
    const fold = item.runFold
    if (!fold) return id
    if (fold.state === "open") return `${id} open${fold.isLast ? " last" : ""}`
    return `${id} folded +${fold.hiddenCount}${fold.unreadCount ? ` (${fold.unreadCount} new)` : ""}`
  })
}

function foldOf(items: TimelineItem[], messageId: string): RunFold {
  const item = items.find(
    (i) => i.type === "event" && (i.event.payload as { messageId: string }).messageId === messageId
  )
  if (item?.type !== "event" || !item.runFold) throw new Error(`${messageId} carries no run fold`)
  return item.runFold
}

const AT = 400
const NOTHING_PERSISTED = () => undefined

function fold(
  store: RunFoldStore,
  items: TimelineItem[],
  overrides: Partial<Parameters<typeof foldAuthorRuns>[1]> = {}
) {
  return foldAuthorRuns(items, {
    store,
    defaultCollapsed: true,
    collapseAtHeight: AT,
    frontierSequence: 100n,
    viewerId: VIEWER,
    latestKnownAt: null,
    persisted: NOTHING_PERSISTED,
    revealMessageIds: [],
    ...overrides,
  })
}

describe("foldAuthorRuns", () => {
  beforeEach(() => __resetCollapseCacheForTests())

  it("folds a tall, read run present at open down to its head", () => {
    const store = createRunFoldStore()
    const items = [message(1), ...run(2, 4), message(5)]
    fold(store, items)
    measure(store, 1, 5, 200)

    expect(describeRows(fold(store, items))).toEqual(["msg_1", "msg_2 folded +2", "msg_5"])
  })

  it("leaves a run that fits under the threshold alone", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 100)

    expect(describeRows(fold(store, items))).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  it("keeps a run with an unread message open, with the control on its last row", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)

    expect(describeRows(fold(store, items, { frontierSequence: 2n }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
  })

  it("keeps a run that arrived after open unfolded", () => {
    const store = createRunFoldStore()
    fold(store, [message(1)])
    const items = [message(1), ...run(2, 4)]
    measure(store, 1, 4, 200)

    expect(describeRows(fold(store, items, { frontierSequence: 10n }))).toEqual([
      "msg_1",
      "msg_2 open",
      "msg_3 open",
      "msg_4 open last",
    ])
  })

  it("folds a read run the stale cache was missing at open", () => {
    const store = createRunFoldStore()
    fold(store, [message(1)], { latestKnownAt: at(4) })
    const items = [message(1), ...run(2, 4)]
    measure(store, 1, 4, 200)

    expect(describeRows(fold(store, items, { latestKnownAt: at(4) }))).toEqual(["msg_1", "msg_2 folded +2"])
  })

  it("never counts the viewer's own messages as unread", () => {
    const store = createRunFoldStore()
    const items = run(1, 3, VIEWER)
    measure(store, 1, 3, 200)

    expect(describeRows(fold(store, items, { frontierSequence: null }))).toEqual(["msg_1 folded +2"])
  })

  it("treats a never-read stream as unread", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)

    expect(describeRows(fold(store, items, { frontierSequence: null }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
  })

  it("counts unread messages hidden behind a folded run", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)
    fold(store, items)

    // Marked unread from message 2 after the run folded.
    expect(describeRows(fold(store, items, { frontierSequence: 1n }))).toEqual(["msg_1 folded +2 (2 new)"])
  })

  it("never folds a run by itself once it has shown open", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 100)
    fold(store, items)
    // A link preview lands and the run grows past the threshold.
    measure(store, 1, 3, 300)

    expect(describeRows(fold(store, items))).toEqual(["msg_1 open", "msg_2 open", "msg_3 open last"])
  })

  it("keeps a grown run open when its author adds to it", () => {
    const store = createRunFoldStore()
    measure(store, 1, 2, 100)
    fold(store, run(1, 2))
    measure(store, 3, 3, 300)

    expect(describeRows(fold(store, run(1, 3)))).toEqual(["msg_1 open", "msg_2 open", "msg_3 open last"])
  })

  it("decides once read state resolves, not before", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)

    expect(describeRows(fold(store, items, { frontierSequence: undefined }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
    expect(describeRows(fold(store, items))).toEqual(["msg_1 folded +2"])
  })

  it("settles a long run whose tail is not measured yet", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    store.reportHeight("msg_1", 500)

    expect(describeRows(fold(store, items))).toEqual(["msg_1 folded +2"])
  })

  it("follows the viewer's persisted toggle over the default", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    const key = composeRunFoldKey("msg_1")

    expect(describeRows(fold(store, items, { persisted: (k) => (k === key ? true : undefined) }))).toEqual([
      "msg_1 folded +2",
    ])
    measure(store, 1, 3, 200)
    expect(describeRows(fold(store, items, { persisted: (k) => (k === key ? false : undefined) }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
  })

  it("does not fold when the viewer has message collapsing off", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)

    expect(describeRows(fold(store, items, { defaultCollapsed: false }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
  })

  it("opens a folded run holding a deep-link target until the viewer collapses it again", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)
    expect(describeRows(fold(store, items))).toEqual(["msg_1 folded +2"])

    expect(describeRows(fold(store, items, { revealMessageIds: ["msg_3"] }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
    // The highlight clears; the run stays where the viewer was taken.
    expect(describeRows(fold(store, items))).toEqual(["msg_1 open", "msg_2 open", "msg_3 open last"])

    store.setCollapsed(foldOf(fold(store, items), "msg_3"), true)
    expect(getBlockCollapse(composeRunFoldKey("msg_1"))).toBe(true)
    expect(describeRows(fold(store, items, { persisted: getBlockCollapse }))).toEqual(["msg_1 folded +2"])
  })

  it("keeps a run collapsed while the search match that opened it stays active", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)
    const searching = { revealMessageIds: ["msg_2"], persisted: getBlockCollapse }
    const open = fold(store, items, searching)
    expect(describeRows(open)).toEqual(["msg_1 open", "msg_2 open", "msg_3 open last"])

    store.setCollapsed(foldOf(open, "msg_3"), true)
    expect(describeRows(fold(store, items, searching))).toEqual(["msg_1 folded +2"])
    // Stepping to another match in the run opens it again.
    expect(describeRows(fold(store, items, { ...searching, revealMessageIds: ["msg_3"] }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
  })

  it("keeps a folded run folded when its author adds to it, with the new message below the fold", () => {
    const store = createRunFoldStore()
    measure(store, 1, 3, 200)
    expect(describeRows(fold(store, run(1, 3)))).toEqual(["msg_1 folded +2"])

    store.reportHeight("msg_4", 200)
    expect(describeRows(fold(store, run(1, 4)))).toEqual(["msg_1 folded +2", "msg_4"])
  })

  it("keeps the viewer's collapse when the run grows", () => {
    const store = createRunFoldStore()
    const options = { defaultCollapsed: false, persisted: getBlockCollapse }
    measure(store, 1, 3, 200)
    const open = fold(store, run(1, 3), options)
    store.setCollapsed(foldOf(open, "msg_3"), true)

    store.reportHeight("msg_4", 200)
    expect(describeRows(fold(store, run(1, 4), options))).toEqual(["msg_1 folded +2", "msg_4"])
    // Unfolding and folding again takes in the whole run.
    store.setCollapsed(foldOf(fold(store, run(1, 4), options), "msg_1"), false)
    store.setCollapsed(foldOf(fold(store, run(1, 4), options), "msg_4"), true)
    expect(describeRows(fold(store, run(1, 4), options))).toEqual(["msg_1 folded +3"])
  })

  it("does not take an empty first pass as the open-time baseline", () => {
    const store = createRunFoldStore()
    fold(store, [])
    const items = run(1, 3)
    measure(store, 1, 3, 200)

    expect(describeRows(fold(store, items))).toEqual(["msg_1 folded +2"])
  })

  it("treats rows between messages as run boundaries", () => {
    const store = createRunFoldStore()
    const items: TimelineItem[] = [...run(1, 2), { type: "day_divider", dayStartMs: 0 }, message(3, true)]
    measure(store, 1, 3, 300)

    expect(describeRows(fold(store, items))).toEqual(["msg_1 folded +1", "day_divider", "msg_3"])
  })
})
