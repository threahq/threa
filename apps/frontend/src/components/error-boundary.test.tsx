import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { ErrorBoundary } from "./error-boundary"
import * as swRecoveryModule from "@/lib/sw-recovery"
import * as appUpdateModule from "@/hooks/use-app-update"
import * as appBuildModule from "@/lib/app-build"
import * as analyticsModule from "@/lib/analytics/posthog"

function renderWithChunkError() {
  const Thrower = () => {
    throw new Error("Failed to fetch dynamically imported module: https://app.threa.io/assets/board-AbC123.js")
  }
  const router = createMemoryRouter([{ path: "/", element: <Thrower />, errorElement: <ErrorBoundary /> }])
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ErrorBoundary crash reporting", () => {
  it("should hand the route error to analytics when a route crashes", async () => {
    const capture = vi.spyOn(analyticsModule, "captureException").mockImplementation(() => {})
    const crash = new Error("boom")
    const Thrower = () => {
      throw crash
    }
    const router = createMemoryRouter([{ path: "/", element: <Thrower />, errorElement: <ErrorBoundary /> }])

    render(<RouterProvider router={router} />)

    await waitFor(() => expect(capture).toHaveBeenCalledWith(crash))
  })
})

describe("ErrorBoundary chunk-load recovery gating", () => {
  it("wipes only on a confirmed newer deploy", async () => {
    vi.spyOn(appBuildModule, "currentAppVersion").mockReturnValue("build-1")
    vi.spyOn(appUpdateModule, "fetchLatestVersion").mockResolvedValue("build-2")
    const recover = vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(true)

    renderWithChunkError()

    await waitFor(() => expect(recover).toHaveBeenCalled())
    expect(recover).toHaveBeenCalledWith({ bustUrls: ["https://app.threa.io/assets/board-AbC123.js"] })
    // Recovery in flight — the lightweight status, never the scary card.
    expect(screen.getByText("Updating Threa")).toBeTruthy()
  })

  it("keeps the cache when the version probe can't confirm a newer deploy (slow network, same message)", async () => {
    // A slow-network dynamic-import failure carries the SAME browser message as
    // a stale-deploy 404. Same version = not a deploy — the wipe would destroy
    // the precached shell exactly when the network can't rebuild it.
    vi.spyOn(appBuildModule, "currentAppVersion").mockReturnValue("build-1")
    vi.spyOn(appUpdateModule, "fetchLatestVersion").mockResolvedValue("build-1")
    const recover = vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(true)

    renderWithChunkError()

    expect(await screen.findByText("Something Went Wrong")).toBeTruthy()
    expect(recover).not.toHaveBeenCalled()
  })

  it("keeps the cache when the version probe itself fails (offline)", async () => {
    vi.spyOn(appBuildModule, "currentAppVersion").mockReturnValue("build-1")
    vi.spyOn(appUpdateModule, "fetchLatestVersion").mockResolvedValue(null)
    const recover = vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(true)

    renderWithChunkError()

    expect(await screen.findByText("Something Went Wrong")).toBeTruthy()
    expect(recover).not.toHaveBeenCalled()
  })

  it("shows the update-needed escape when recovery is confirmed but capped", async () => {
    vi.spyOn(appBuildModule, "currentAppVersion").mockReturnValue("build-1")
    vi.spyOn(appUpdateModule, "fetchLatestVersion").mockResolvedValue("build-2")
    vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(false)

    renderWithChunkError()

    expect(await screen.findByText("Update needed")).toBeTruthy()
  })
})
