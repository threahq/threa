import { describe, it, expect, beforeEach } from "vitest"
import type { StreamEvent } from "@threahq/types"
import { __resetCollapseCacheForTests, getBlockCollapse } from "@/lib/markdown/collapse-cache"
import { composeRunFoldKey, createRunFoldStore, foldAuthorRuns, type RunFold, type RunFoldStore } from "./run-fold"
import type { TimelineItem } from "./event-list"

const AUTHOR = "usr_author"
const VIEWER = "usr_viewer"

function message(n: number, continuation = false, actorId = AUTHOR): TimelineItem {
  const event: StreamEvent = {
    id: `event_${n}`,
    streamId: "stream_1",
    sequence: String(n),
    eventType: "message_created",
    payload: { messageId: `msg_${n}`, contentMarkdown: `m${n}` },
    actorId,
    actorType: "user",
    createdAt: new Date(Date.UTC(2026, 8, 22, 0, n)).toISOString(),
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

function fold(
  store: RunFoldStore,
  items: TimelineItem[],
  overrides: Partial<Parameters<typeof foldAuthorRuns>[1]> = {}
) {
  return foldAuthorRuns(items, {
    store,
    collapseAtHeight: AT,
    frontierSequence: 100n,
    viewerId: VIEWER,
    persisted: getBlockCollapse,
    revealMessageIds: [],
    ...overrides,
  })
}

/** Presses the run's Collapse control, found on `messageId`'s row. */
function collapse(store: RunFoldStore, items: TimelineItem[], messageId: string) {
  store.setCollapsed(foldOf(fold(store, items), messageId), true)
}

describe("foldAuthorRuns", () => {
  beforeEach(() => __resetCollapseCacheForTests())

  it("never folds a tall run by itself, and puts its Collapse control on the last row", () => {
    const store = createRunFoldStore()
    const items = [message(1), ...run(2, 4), message(5)]
    measure(store, 1, 5, 200)

    expect(describeRows(fold(store, items))).toEqual(["msg_1", "msg_2 open", "msg_3 open", "msg_4 open last", "msg_5"])
  })

  it("leaves a run that fits under the threshold alone", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 100)

    expect(describeRows(fold(store, items))).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  it("offers Collapse once a run grows past the threshold, without folding it", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 100)
    fold(store, items)
    // A link preview lands and the run grows past the threshold.
    measure(store, 1, 3, 300)

    expect(describeRows(fold(store, items))).toEqual(["msg_1 open", "msg_2 open", "msg_3 open last"])
  })

  it("folds a run down to its head when the viewer collapses it, and remembers it", () => {
    const store = createRunFoldStore()
    const items = [message(1), ...run(2, 4), message(5)]
    measure(store, 1, 5, 200)
    collapse(store, items, "msg_4")

    expect(getBlockCollapse(composeRunFoldKey("msg_2"))).toBe(true)
    expect(describeRows(fold(store, items))).toEqual(["msg_1", "msg_2 folded +2", "msg_5"])
    // A fresh timeline (reload) folds it before anything is measured.
    expect(describeRows(fold(createRunFoldStore(), items))).toEqual(["msg_1", "msg_2 folded +2", "msg_5"])
  })

  it("opens a collapsed run for good when the viewer opens it", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)
    collapse(store, items, "msg_3")
    store.setCollapsed(foldOf(fold(store, items), "msg_1"), false)

    expect(getBlockCollapse(composeRunFoldKey("msg_1"))).toBe(false)
    expect(describeRows(fold(createRunFoldStore(), items))).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  it("counts unread messages hidden behind a collapsed run, never the viewer's own", () => {
    const store = createRunFoldStore()
    const theirs = run(1, 3)
    const mine = run(4, 6, VIEWER)
    measure(store, 1, 6, 200)
    collapse(store, theirs, "msg_3")
    collapse(store, mine, "msg_6")

    // Marked unread from message 2 after the runs were collapsed.
    expect(describeRows(fold(store, [...theirs, ...mine], { frontierSequence: 1n }))).toEqual([
      "msg_1 folded +2 (2 new)",
      "msg_4 folded +2",
    ])
    expect(describeRows(fold(store, theirs, { frontierSequence: null }))).toEqual(["msg_1 folded +2 (2 new)"])
    expect(describeRows(fold(store, theirs, { frontierSequence: undefined }))).toEqual(["msg_1 folded +2"])
  })

  it("opens a collapsed run holding a deep-link target until the viewer collapses it again", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)
    collapse(store, items, "msg_3")
    expect(describeRows(fold(store, items))).toEqual(["msg_1 folded +2"])

    expect(describeRows(fold(store, items, { revealMessageIds: ["msg_3"] }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
    // The highlight clears; the run stays where the viewer was taken.
    expect(describeRows(fold(store, items))).toEqual(["msg_1 open", "msg_2 open", "msg_3 open last"])

    collapse(store, items, "msg_3")
    expect(describeRows(fold(store, items))).toEqual(["msg_1 folded +2"])
  })

  it("keeps a run collapsed while the search match that opened it stays active", () => {
    const store = createRunFoldStore()
    const items = run(1, 3)
    measure(store, 1, 3, 200)
    collapse(store, items, "msg_3")
    const searching = { revealMessageIds: ["msg_2"] }
    const open = fold(store, items, searching)
    expect(describeRows(open)).toEqual(["msg_1 open", "msg_2 open", "msg_3 open last"])

    store.setCollapsed(foldOf(open, "msg_3"), true)
    expect(describeRows(fold(store, items, searching))).toEqual(["msg_1 folded +2"])
    // Stepping to another match in the run opens it again.
    expect(describeRows(fold(store, items, { revealMessageIds: ["msg_3"] }))).toEqual([
      "msg_1 open",
      "msg_2 open",
      "msg_3 open last",
    ])
  })

  it("keeps a collapsed run collapsed when its author adds to it, with the new message below the fold", () => {
    const store = createRunFoldStore()
    measure(store, 1, 3, 200)
    collapse(store, run(1, 3), "msg_3")

    store.reportHeight("msg_4", 200)
    expect(describeRows(fold(store, run(1, 4)))).toEqual(["msg_1 folded +2", "msg_4"])
    // Unfolding and folding again takes in the whole run.
    store.setCollapsed(foldOf(fold(store, run(1, 4)), "msg_1"), false)
    collapse(store, run(1, 4), "msg_4")
    expect(describeRows(fold(store, run(1, 4)))).toEqual(["msg_1 folded +3"])
  })

  it("treats rows between messages as run boundaries", () => {
    const store = createRunFoldStore()
    const items: TimelineItem[] = [...run(1, 2), { type: "day_divider", dayStartMs: 0 }, message(3, true)]
    measure(store, 1, 3, 300)

    expect(describeRows(fold(store, items))).toEqual(["msg_1 open", "msg_2 open last", "day_divider", "msg_3"])
  })
})
