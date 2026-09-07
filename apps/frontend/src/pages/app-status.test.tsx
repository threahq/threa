import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { act, render, screen, userEvent, waitFor } from "@/test"
import * as contextsModule from "@/contexts"
import { AppUpdateProvider } from "@/hooks/use-app-update"
import type { AppUpdateState } from "@/lib/app-update"
import { SonnerRoot, toast } from "@/lib/sonner-module"
import { AppUpdateNotifier } from "@/components/app-update-toast"
import { AppStatusPage } from "./app-status"
import { TestAppUpdateController, asAppUpdateController } from "@/test/app-update-controller"

function renderPage(controller: TestAppUpdateController, extras?: ReactNode) {
  return render(
    <AppUpdateProvider controller={asAppUpdateController(controller)}>
      {extras}
      <MemoryRouter initialEntries={["/w/workspace_1/app-status"]}>
        <Routes>
          <Route path="/w/:workspaceId/app-status" element={<AppStatusPage />} />
        </Routes>
      </MemoryRouter>
    </AppUpdateProvider>
  )
}

function renderPageWith(snapshot: Partial<AppUpdateState>) {
  const controller = new TestAppUpdateController(snapshot)
  return { controller, ...renderPage(controller) }
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value })
}

function restoreOnline() {
  delete (navigator as { onLine?: boolean }).onLine
}

describe("AppStatusPage", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "abc1234")
    vi.stubGlobal("__APP_BUILT_AT__", "2026-07-14T12:30:00.000Z")
    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      state: "collapsed",
      isMobile: false,
      togglePinned: vi.fn(),
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    restoreOnline()
  })

  it("should show build details and report the result when the user checks for updates", async () => {
    const { controller } = renderPageWith({})

    expect(screen.getByText("abc1234")).toBeInTheDocument()
    expect(screen.getByText("Updated on this device")).toBeInTheDocument()
    expect(screen.getByText("Build created")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    expect(controller.checkCalls).toBe(1)
    act(() => controller.emit({ phase: "current", lastCheckedAt: new Date("2026-07-14T15:00:00.000Z") }))

    expect(screen.getByText("Up to date")).toBeInTheDocument()
    expect(screen.getByText(/Last checked/)).toBeInTheDocument()
  })

  it("should keep the check button busy while the shared check is running", async () => {
    const { controller } = renderPageWith({ phase: "checking" })

    expect(screen.getByRole("button", { name: /Check for updates/ })).toBeDisabled()

    act(() => controller.emit({ phase: "idle" }))
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled()
  })

  it("should report a real background install instead of offering a reload", () => {
    renderPageWith({ phase: "downloading" })

    expect(screen.getByText("Downloading update…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Downloading…/ })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Reload and update" })).not.toBeInTheDocument()
  })

  it("should name the version of the worker that is actually ready", () => {
    renderPageWith({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" })

    expect(screen.getByText("Update ready")).toBeInTheDocument()
    expect(screen.getByText("def5678")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload and update" })).toBeEnabled()
  })

  it("should not invent a version when the ready worker doesn't report one", () => {
    renderPageWith({ phase: "ready", readyVersion: null, readyBuildId: "build-1" })

    expect(screen.getByText("A new build is downloaded and ready.")).toBeInTheDocument()
    expect(screen.queryByText("build-1")).not.toBeInTheDocument()
  })

  it("should go busy on click and stay busy while the apply is in flight", async () => {
    const { controller } = renderPageWith({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" })

    await userEvent.click(screen.getByRole("button", { name: "Reload and update" }))

    expect(controller.applyCalls).toBe(1)
    const busy = screen.getByRole("button", { name: /Updating…/ })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute("aria-busy", "true")
    expect(screen.getByText("Updating…", { selector: "h2" })).toBeInTheDocument()
  })

  it("should still be applying after the page remounts, because the phase is shared", async () => {
    const controller = new TestAppUpdateController({ phase: "ready", readyBuildId: "def5678-1" })
    const view = renderPage(controller)

    await userEvent.click(screen.getByRole("button", { name: "Reload and update" }))
    expect(screen.getByRole("button", { name: /Updating…/ })).toBeDisabled()

    view.unmount()
    renderPage(controller)

    expect(screen.getByRole("button", { name: /Updating…/ })).toBeDisabled()
  })

  it("should keep the update available while offline, because the build is already local", () => {
    setOnline(false)
    renderPageWith({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" })

    expect(screen.getByText("Offline")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload and update" })).toBeEnabled()
  })

  it("should keep the downloaded build on offer while a background check runs", async () => {
    const { controller } = renderPageWith({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" })

    act(() => controller.emit({ phase: "checking" }))

    expect(screen.getByRole("button", { name: "Reload and update" })).toBeEnabled()
    expect(screen.getByText("Update ready")).toBeInTheDocument()
  })

  it("should keep the downloaded build on offer when the phase stops saying ready", () => {
    // The coordinator reports the phase of the last observation; a check that
    // finds no waiting worker (it activated in another tab) can land on
    // `unavailable` while that build is still the one a reload lands on.
    renderPageWith({ phase: "unavailable", readyVersion: "def5678", readyBuildId: "def5678-1" })

    expect(screen.getByText("Update ready")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload and update" })).toBeEnabled()
  })

  it("should ask for one apply when both the page and the notice are mounted", async () => {
    const controller = new TestAppUpdateController({ phase: "ready", readyBuildId: "def5678-1" })
    renderPage(
      controller,
      <>
        <SonnerRoot />
        <AppUpdateNotifier />
      </>
    )

    await userEvent.click(await screen.findByRole("button", { name: "Reload" }))

    expect(controller.applyCalls).toBe(1)
    // Neither surface can ask again: the page button is busy and the notice has
    // become the progress surface for the same operation.
    expect(screen.getByRole("button", { name: /Updating…/ })).toBeDisabled()
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument())
    expect(await screen.findByText("Updating Threa…")).toBeInTheDocument()
    expect(controller.applyCalls).toBe(1)
    act(() => toast.dismiss())
  })

  it("should offer another check when the update check itself failed", async () => {
    const { controller } = renderPageWith({ phase: "failed", failure: "check-failed" })

    expect(screen.getByText("Couldn't check for updates")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    expect(controller.checkCalls).toBe(1)
  })

  it("should retry the same apply when activation failed", async () => {
    const { controller } = renderPageWith({ phase: "failed", failure: "activation-timeout", readyBuildId: "def5678-1" })

    expect(screen.getByText("Update didn't start")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(controller.applyCalls).toBe(1)
    expect(controller.checkCalls).toBe(0)
  })

  it("should not offer a reload when a newer build exists on the server but isn't downloaded", () => {
    renderPageWith({ phase: "unavailable", latestVersion: "ghi9012" })

    expect(screen.getByText("No update ready yet")).toBeInTheDocument()
    expect(screen.queryByText("ghi9012")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled()
  })

  it("should offer a check, not a doomed retry, when activation failed with no target left", () => {
    renderPageWith({ phase: "failed", failure: "activation-failed", readyBuildId: null })

    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
  })

  it("should report offline support as unsupported when the browser has no service worker", () => {
    renderPageWith({})

    expect(screen.getByText("Not supported")).toBeInTheDocument()
  })
})
