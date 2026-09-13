import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom"
import { PanelProvider, usePanel } from "@/contexts/panel-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { resetLaunchAncestorsForTests, useRebuildLaunchAncestors } from "./use-launch-ancestors"

/**
 * A cold launch has no history beneath the page. These mount the real router
 * on a single entry, let the hook rebuild, and assert where `navigate(-1)`
 * (the back gesture) lands.
 */

const WS = "ws_1"
const CHANNEL = { id: "chan", type: "channel", parentStreamId: null, rootStreamId: null }
const THREAD = { id: "thr", type: "thread", parentStreamId: "chan", rootStreamId: "chan" }

function Probe() {
  const { closePanel } = usePanel()
  const location = useLocation()
  return (
    <div>
      <span data-testid="loc">{`${location.pathname}${location.search}`}</span>
      <button onClick={closePanel}>close</button>
    </div>
  )
}

/** `rerender` stands in for the streams cache resolving: the live store would re-render the host itself. */
function Host() {
  useRebuildLaunchAncestors(WS)
  const [, setTick] = useState(0)
  return (
    <PanelProvider>
      <Probe />
      <button onClick={() => setTick((t) => t + 1)}>rerender</button>
    </PanelProvider>
  )
}

function mount(initialEntries: string[]) {
  const router = createMemoryRouter([{ path: "*", element: <Host /> }], {
    initialEntries,
    initialIndex: initialEntries.length - 1,
  })
  render(<RouterProvider router={router} />)
  const back = async () => {
    await act(async () => {
      await router.navigate(-1)
    })
  }
  const rerender = () => userEvent.click(screen.getByRole("button", { name: "rerender" }))
  return { router, back, rerender, loc: () => screen.getByTestId("loc").textContent }
}

describe("useRebuildLaunchAncestors", () => {
  const streams = vi.spyOn(workspaceStoreModule, "useWorkspaceStreams")
  const loaded = vi.spyOn(workspaceStoreModule, "useWorkspaceStreamsLoaded")

  beforeEach(() => {
    resetLaunchAncestorsForTests()
    streams.mockReturnValue([CHANNEL, THREAD] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>)
    loaded.mockReturnValue(true)
  })
  afterEach(() => {
    streams.mockReset()
    loaded.mockReset()
  })

  it("puts a thread's channel beneath it, so back lands on the channel and not outside the app", async () => {
    const { back, loc } = mount([`/w/${WS}/s/thr`])
    await act(async () => {})
    expect(loc()).toBe(`/w/${WS}/s/thr`)
    await back()
    expect(loc()).toBe(`/w/${WS}/s/chan`)
    await back()
    expect(loc()).toBe(`/w/${WS}/s/chan`)
  })

  it("restores a panel URL with an entry beneath, and closing pops it, leaving no duplicate", async () => {
    const { back, loc } = mount(["/elsewhere", `/w/${WS}/board?lens=mine&panel=conv:c`])
    await act(async () => {})
    expect(loc()).toBe(`/w/${WS}/board?lens=mine&panel=conv:c`)
    await userEvent.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(`/w/${WS}/board?lens=mine`)
    await back()
    expect(loc()).toBe("/elsewhere")
  })

  it("waits for the streams cache before rebuilding", async () => {
    loaded.mockReturnValue(false)
    const { back, loc, rerender } = mount([`/w/${WS}/s/thr`])
    await act(async () => {})
    await back()
    expect(loc()).toBe(`/w/${WS}/s/thr`)

    loaded.mockReturnValue(true)
    await rerender()
    await back()
    expect(loc()).toBe(`/w/${WS}/s/chan`)
  })

  it("leaves a reload with history already beneath alone", async () => {
    window.history.replaceState({ idx: 2 }, "")
    try {
      const { back, loc } = mount([`/w/${WS}/s/thr`])
      await act(async () => {})
      await back()
      expect(loc()).toBe(`/w/${WS}/s/thr`)
    } finally {
      window.history.replaceState(null, "")
    }
  })

  it("keeps waiting through a replace in the load window", async () => {
    loaded.mockReturnValue(false)
    const { router, back, loc, rerender } = mount([`/w/${WS}/s/thr?m=evt_1`])
    await act(async () => {
      await router.navigate(`/w/${WS}/s/thr`, { replace: true })
    })
    loaded.mockReturnValue(true)
    await rerender()
    await back()
    expect(loc()).toBe(`/w/${WS}/s/chan`)
  })

  it("leaves a launch the viewer has already navigated away from alone", async () => {
    loaded.mockReturnValue(false)
    const { router, back, loc, rerender } = mount([`/w/${WS}/s/thr`])
    await act(async () => {
      await router.navigate(`/w/${WS}/s/chan`)
    })
    loaded.mockReturnValue(true)
    await rerender()
    await back()
    expect(loc()).toBe(`/w/${WS}/s/thr`)
    await back()
    expect(loc()).toBe(`/w/${WS}/s/thr`)
  })
})
