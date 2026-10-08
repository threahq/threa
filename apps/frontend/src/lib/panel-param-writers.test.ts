import { describe, expect, it } from "vitest"
import { createMemoryRouter } from "react-router-dom"
import { keepPanelParamReadable, readablePanelParam } from "./panel-tabs"
import { buildConversationLink, buildConversationPanelPath } from "./stream-links"
import { conversationPanelHref } from "./board/panel-href"
import { buildContextRefSourceHref } from "./context-bag/source-link"

const layout = "stream_a.context:stream_b*-conv:conv_c--draft:stream_b:msg_d.compose:stream_b**"

function readableRouter() {
  const router = createMemoryRouter([{ path: "*", element: null }], { initialEntries: ["/w/ws_1/board"] })
  keepPanelParamReadable(router)
  return router
}

describe("?panel= writers", () => {
  it("should spell the panel grammar readably and leave other params encoded", () => {
    const encoded = `?${new URLSearchParams({ trace: "a:b", panel: layout, m: "x y" })}`
    expect(readablePanelParam(encoded)).toBe(`?trace=a%3Ab&panel=${layout}&m=x+y`)
    expect(readablePanelParam(`panel=${encodeURIComponent(layout)}`)).toBe(`panel=${layout}`)
    expect(readablePanelParam("/w/ws_1/board?m=1")).toBe("/w/ws_1/board?m=1")
  })

  it("should navigate to the readable spelling from a string, a path object or search params", async () => {
    const router = readableRouter()
    const searches: string[] = []
    await router.navigate(`/w/ws_1/s/stream_a?${new URLSearchParams({ panel: layout })}`)
    searches.push(router.state.location.search)
    await router.navigate({ pathname: "/w/ws_1/board", search: `?${new URLSearchParams({ panel: layout, m: "1" })}` })
    searches.push(router.state.location.search)
    await router.navigate(-1)
    searches.push(router.state.location.search)
    expect(searches).toEqual([`?panel=${layout}`, `?panel=${layout}&m=1`, `?panel=${layout}`])
  })

  it("should render link hrefs in the readable spelling", () => {
    const router = readableRouter()
    const url = new URL(`http://app/w/ws_1/board?${new URLSearchParams({ panel: layout })}`)
    expect(router.createHref(url)).toBe(`/w/ws_1/board?panel=${layout}`)
  })

  it("should build every panel link readably", () => {
    expect([
      buildConversationPanelPath("ws_1", "conv_c", "msg_1"),
      buildConversationLink("ws_1", "conv_c").replace(window.location.origin, ""),
      readablePanelParam(conversationPanelHref("ws_1", "conv_c", null)),
      readablePanelParam(
        buildContextRefSourceHref({ workspaceId: "ws_1", sourceStreamId: "s", conversationId: "conv_c" })
      ),
    ]).toEqual([
      "/w/ws_1/board?panel=conv:conv_c&m=msg_1",
      "/w/ws_1/board?panel=conv:conv_c",
      "/w/ws_1/board?panel=conv:conv_c",
      "/w/ws_1/board?panel=conv:conv_c",
    ])
  })
})
