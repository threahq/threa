import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import * as contextsModule from "@/contexts"
import { AppStatusPage } from "./app-status"

const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/w/workspace_1/app-status"]}>
      <Routes>
        <Route path="/w/:workspaceId/app-status" element={<AppStatusPage />} />
      </Routes>
    </MemoryRouter>
  )
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (serviceWorkerDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor)
    } else {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker
    }
  })

  it("shows build details and confirms a manual update check", async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: {},
        getRegistration: vi.fn().mockResolvedValue({ waiting: null, installing: null, update }),
      },
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "abc1234", builtAt: "2026-07-14T12:30:00.000Z" }),
    } as Response)

    renderPage()

    expect(screen.getByText("abc1234")).toBeInTheDocument()
    expect(screen.getByText("Last updated")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    expect(update).toHaveBeenCalledOnce()
    expect(await screen.findByText("Up to date")).toBeInTheDocument()
    expect(screen.getByText(/Last checked/)).toBeInTheDocument()
  })

  it("offers to reload once a new worker is ready", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: {},
        getRegistration: vi.fn().mockResolvedValue({
          waiting: { postMessage: vi.fn() },
          installing: null,
          update: vi.fn().mockResolvedValue(undefined),
        }),
      },
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "def5678", builtAt: "2026-07-14T13:00:00.000Z" }),
    } as Response)

    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    expect(await screen.findByText("Update ready")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload and update" })).toBeInTheDocument()
    expect(screen.getByText("def5678")).toBeInTheDocument()
  })
})
