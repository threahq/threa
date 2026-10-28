import { afterEach, describe, it, expect, vi } from "vitest"
import { getOpenDocIds, registerOpenDoc, resetOpenDocsForTest, subscribeOpenDocs } from "./open-docs"

describe("open docs", () => {
  afterEach(resetOpenDocsForTest)

  it("should keep a doc open until every pane showing it releases, in opening order", () => {
    const releaseTracker = registerOpenDoc("stream_tracker")
    const releaseChecklist = registerOpenDoc("stream_checklist")
    const releaseTrackerTab = registerOpenDoc("stream_tracker")

    releaseTracker()
    expect(getOpenDocIds()).toEqual(["stream_tracker", "stream_checklist"])

    releaseTrackerTab()
    expect(getOpenDocIds()).toEqual(["stream_checklist"])
    releaseChecklist()
    expect(getOpenDocIds()).toEqual([])
  })

  it("should notify only when the set of open docs changes", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOpenDocs(listener)

    const first = registerOpenDoc("stream_tracker")
    const second = registerOpenDoc("stream_tracker")
    second()
    expect(listener).toHaveBeenCalledTimes(1)
    first()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    registerOpenDoc("stream_other")()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
