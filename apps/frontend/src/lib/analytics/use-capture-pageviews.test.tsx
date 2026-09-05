import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import * as analyticsModule from "./posthog"
import { useCapturePageviews } from "./use-capture-pageviews"

function Harness({ to }: { to: string }) {
  useCapturePageviews()
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(to)}>
      go
    </button>
  )
}

function renderAt(initial: string, to: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/w/:workspaceId/*" element={<Harness to={to} />} />
      </Routes>
    </MemoryRouter>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useCapturePageviews", () => {
  it("should capture a pageview on mount and on each path change", () => {
    const capture = vi.spyOn(analyticsModule, "capture").mockImplementation(() => {})
    const { getByText } = renderAt("/w/ws_1", "/w/ws_1/s/stream_1")

    expect(capture).toHaveBeenCalledWith("$pageview")
    expect(capture).toHaveBeenCalledTimes(1)

    fireEvent.click(getByText("go"))

    expect(capture).toHaveBeenCalledTimes(2)
  })

  it("should not capture a pageview when only the query string changes", () => {
    const capture = vi.spyOn(analyticsModule, "capture").mockImplementation(() => {})
    const { getByText } = renderAt("/w/ws_1/memory", "/w/ws_1/memory?memo=memo_1")

    fireEvent.click(getByText("go"))

    expect(capture).toHaveBeenCalledTimes(1)
  })
})
