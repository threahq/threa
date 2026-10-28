import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom"
import { takeBlockFocus } from "@/lib/docs/block-focus"
import { useDocDeepLinkLanding } from "./use-doc-deep-link-landing"

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={["/w/ws_1/s/stream_doc?m=blk_1&panel=stream_other"]}>{children}</MemoryRouter>
}

describe("useDocDeepLinkLanding", () => {
  it("should hand the doc the linked block and take `m` off the URL without a history entry", () => {
    const { result } = renderHook(
      () => {
        useDocDeepLinkLanding("stream_doc", "blk_1")
        return { location: useLocation(), navigation: useNavigationType() }
      },
      { wrapper }
    )

    expect({
      landing: takeBlockFocus("stream_doc"),
      search: result.current.location.search,
      navigation: result.current.navigation,
    }).toEqual({ landing: "blk_1", search: "?panel=stream_other", navigation: "REPLACE" })
  })

  it("should leave the URL alone when the stream is not a doc", () => {
    const { result } = renderHook(
      () => {
        useDocDeepLinkLanding(null, "msg_1")
        return useLocation()
      },
      { wrapper }
    )

    expect({ landing: takeBlockFocus("stream_doc"), search: result.current.search }).toEqual({
      landing: null,
      search: "?m=blk_1&panel=stream_other",
    })
  })
})
