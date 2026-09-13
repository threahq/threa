import { describe, expect, it } from "vitest"
import { launchAncestors, type AncestorStream } from "./launch-ancestors"

const WS = "ws_1"
const channel: AncestorStream = { id: "chan", type: "channel", parentStreamId: null, rootStreamId: null }
const thread: AncestorStream = { id: "thr", type: "thread", parentStreamId: "chan", rootStreamId: "chan" }
const nested: AncestorStream = { id: "nested", type: "thread", parentStreamId: "thr", rootStreamId: "chan" }
const aside: AncestorStream = { id: "aside", type: "aside", parentStreamId: "chan", rootStreamId: null }
const asideThread: AncestorStream = { id: "athr", type: "thread", parentStreamId: "aside", rootStreamId: "aside" }

function at(path: string) {
  const [pathname, search] = path.split("?")
  return { pathname, search: search ? `?${search}` : "" }
}

describe("launchAncestors", () => {
  it("leaves a plain channel alone", () => {
    expect(launchAncestors(at(`/w/${WS}/s/chan`), WS, [channel])).toEqual([{ to: `/w/${WS}/s/chan` }])
  })

  it("puts the parent chain beneath a nested thread, root first", () => {
    expect(launchAncestors(at(`/w/${WS}/s/nested`), WS, [channel, thread, nested])).toEqual([
      { to: `/w/${WS}/s/chan` },
      { to: `/w/${WS}/s/thr`, state: { launchRebuild: true } },
      { to: `/w/${WS}/s/nested`, state: { launchRebuild: true } },
    ])
  })

  it("puts the page without its panel beneath a panel URL, the panel hop attesting pop-to-close", () => {
    expect(launchAncestors(at(`/w/${WS}/board?lens=mine&panel=conv:c`), WS, [])).toEqual([
      { to: `/w/${WS}/board?lens=mine` },
      { to: `/w/${WS}/board?lens=mine&panel=conv:c`, state: { launchRebuild: true, panelPopsToClose: true } },
    ])
    expect(launchAncestors(at(`/w/${WS}/s/thr?panel=conv:c`), WS, [channel, thread])).toEqual([
      { to: `/w/${WS}/s/chan` },
      { to: `/w/${WS}/s/thr`, state: { launchRebuild: true } },
      { to: `/w/${WS}/s/thr?panel=conv:c`, state: { launchRebuild: true, panelPopsToClose: true } },
    ])
  })

  it("skips hidden asides: a thread in an aside sits directly on the aside's host", () => {
    expect(launchAncestors(at(`/w/${WS}/s/athr`), WS, [channel, aside, asideThread])).toEqual([
      { to: `/w/${WS}/s/chan` },
      { to: `/w/${WS}/s/athr`, state: { launchRebuild: true } },
    ])
  })

  it("falls back to the cached root when an intermediate thread is not cached", () => {
    expect(launchAncestors(at(`/w/${WS}/s/nested`), WS, [channel, nested])).toEqual([
      { to: `/w/${WS}/s/chan` },
      { to: `/w/${WS}/s/nested`, state: { launchRebuild: true } },
    ])
  })

  it("stops on a parent cycle", () => {
    const a: AncestorStream = { id: "a", type: "thread", parentStreamId: "b", rootStreamId: null }
    const b: AncestorStream = { id: "b", type: "thread", parentStreamId: "a", rootStreamId: null }
    expect(launchAncestors(at(`/w/${WS}/s/a`), WS, [a, b])).toEqual([
      { to: `/w/${WS}/s/b` },
      { to: `/w/${WS}/s/a`, state: { launchRebuild: true } },
    ])
  })
})
