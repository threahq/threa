import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { act, render } from "@testing-library/react"
import { RouterProvider, createMemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom"
import { keepPanelParamReadable, readablePanelParam } from "./panel-tabs"
import { buildConversationLink, buildConversationPanelPath } from "./stream-links"
import { conversationPanelHref } from "./board/panel-href"
import { buildContextRefSourceHref } from "./context-bag/source-link"
import { withNotificationActionFailure } from "./sw-notification-format"

const layout = "stream_a.context:stream_b*-conv:conv_c--draft:stream_b:msg_d.compose:stream_b**"

function readableRouter(Component?: () => null) {
  const router = createMemoryRouter([{ path: "*", Component }], { initialEntries: ["/w/ws_1/board"] })
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

  it("should keep useNavigate's replace and history steps through the readable spelling", async () => {
    let navigate: NavigateFunction | undefined
    const router = readableRouter(() => {
      navigate = useNavigate()
      return null
    })
    render(createElement(RouterProvider, { router }))
    const visited: string[] = []
    const visit = async (step: () => void | Promise<void>) => {
      await act(async () => step())
      visited.push(`${router.state.historyAction} ${router.state.location.pathname}${router.state.location.search}`)
    }
    await visit(() => navigate!(`/w/ws_1/s/stream_a?${new URLSearchParams({ panel: layout })}`))
    await visit(() =>
      navigate!(
        { pathname: "/w/ws_1/s/stream_a", search: `?${new URLSearchParams({ panel: layout, m: "1" })}` },
        { replace: true }
      )
    )
    await visit(() => navigate!(-1))
    expect(visited).toEqual([
      `PUSH /w/ws_1/s/stream_a?panel=${layout}`,
      `REPLACE /w/ws_1/s/stream_a?panel=${layout}&m=1`,
      "POP /w/ws_1/board",
    ])
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
      conversationPanelHref("ws_1", "conv_c", null),
      buildContextRefSourceHref({ workspaceId: "ws_1", sourceStreamId: "s", conversationId: "conv_c" }),
      withNotificationActionFailure("/w/ws_1/board?panel=conv:conv_c", "mark_read", "http 401"),
    ]).toEqual([
      "/w/ws_1/board?panel=conv:conv_c&m=msg_1",
      "/w/ws_1/board?panel=conv:conv_c",
      "/w/ws_1/board?panel=conv:conv_c",
      "/w/ws_1/board?panel=conv:conv_c",
      "/w/ws_1/board?panel=conv:conv_c&notify_failed=mark_read%3Ahttp+401",
    ])
  })
})
