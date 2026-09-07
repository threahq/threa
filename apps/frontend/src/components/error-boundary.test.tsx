import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { ErrorBoundary } from "./error-boundary"
import * as swRecoveryModule from "@/lib/sw-recovery"
import * as appUpdateModule from "@/hooks/use-app-update"
import * as appBuildModule from "@/lib/app-build"
import * as analyticsModule from "@/lib/analytics/posthog"

function renderThrowing(error: Error) {
  const Thrower = () => {
    throw error
  }
  const router = createMemoryRouter([{ path: "/", element: <Thrower />, errorElement: <ErrorBoundary /> }])
  return render(<RouterProvider router={router} />)
}

function renderWithChunkError() {
  return renderThrowing(
    new Error("Failed to fetch dynamically imported module: https://app.threa.io/assets/board-AbC123.js")
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ErrorBoundary crash reporting", () => {
  it("should hand the route error to analytics when a route crashes", async () => {
    const capture = vi.spyOn(analyticsModule, "captureException").mockImplementation(() => {})
    const crash = new Error("boom")

    renderThrowing(crash)

    await waitFor(() => expect(capture).toHaveBeenCalledWith(crash))
  })
})

describe("ErrorBoundary chunk-load recovery gating", () => {
  it("should reload without clearing anything when a newer deploy is confirmed", async () => {
    vi.spyOn(appBuildModule, "currentAppVersion").mockReturnValue("build-1")
    vi.spyOn(appUpdateModule, "fetchLatestVersion").mockResolvedValue("build-2")
    const recover = vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(true)

    renderWithChunkError()

    await waitFor(() => expect(recover).toHaveBeenCalled())
    // No `force`: the automatic path is a capped plain reload. Passing force
    // here is what unregistered the worker and deleted every cache.
    expect(recover).toHaveBeenCalledWith()
    // Reload in flight — the lightweight status, never the scary card.
    expect(screen.getByText("Reloading Threa")).toBeTruthy()
  })

  it("should not reload when the version probe can't confirm a newer deploy (slow network, same message)", async () => {
    // A slow-network dynamic-import failure carries the SAME browser message as
    // a stale-deploy 404, and a reload can't fix a connection. Fall through to
    // the error card, whose Try Again serves from the intact cache.
    vi.spyOn(appBuildModule, "currentAppVersion").mockReturnValue("build-1")
    vi.spyOn(appUpdateModule, "fetchLatestVersion").mockResolvedValue("build-1")
    const recover = vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(true)

    renderWithChunkError()

    expect(await screen.findByText("Something Went Wrong")).toBeTruthy()
    expect(recover).not.toHaveBeenCalled()
  })

  it("should not reload when the version probe itself fails (offline)", async () => {
    vi.spyOn(appBuildModule, "currentAppVersion").mockReturnValue("build-1")
    vi.spyOn(appUpdateModule, "fetchLatestVersion").mockResolvedValue(null)
    const recover = vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(true)

    renderWithChunkError()

    expect(await screen.findByText("Something Went Wrong")).toBeTruthy()
    expect(recover).not.toHaveBeenCalled()
  })

  it("should point at the manual reset when the reload cap is spent", async () => {
    vi.spyOn(appBuildModule, "currentAppVersion").mockReturnValue("build-1")
    vi.spyOn(appUpdateModule, "fetchLatestVersion").mockResolvedValue("build-2")
    vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(false)

    renderWithChunkError()

    expect(await screen.findByText("Update needed")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Clear cache & reload/ })).toBeInTheDocument()
  })
})

describe("ErrorBoundary manual reset", () => {
  it("should clear caches only when the user picks the manual reset", async () => {
    const recover = vi.spyOn(swRecoveryModule, "runSwRecovery").mockResolvedValue(true)

    renderThrowing(new Error("boom"))
    await userEvent.click(screen.getByRole("button", { name: /Clear cache & reload/ }))

    expect(recover).toHaveBeenCalledWith({ force: true, bustUrls: undefined })
  })
})
