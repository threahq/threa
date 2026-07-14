import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { act, render, screen, userEvent } from "@/test"
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

interface FakeRegistration {
  waiting: ServiceWorker | null
  installing: ServiceWorker | null
  update: () => Promise<unknown>
}

function installServiceWorker(registration: FakeRegistration, controlled = true) {
  const listeners = new Set<() => void>()
  const registrationListeners = new Set<() => void>()
  const liveRegistration = Object.assign(registration, {
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "updatefound") registrationListeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "updatefound") registrationListeners.delete(listener)
    }),
  })
  const serviceWorker = {
    controller: controlled ? {} : null,
    getRegistration: vi.fn().mockResolvedValue(liveRegistration),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "controllerchange") listeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "controllerchange") listeners.delete(listener)
    }),
    takeControl() {
      serviceWorker.controller = {}
      for (const listener of listeners) listener()
    },
    parkUpdate(worker: ServiceWorker) {
      liveRegistration.waiting = worker
      for (const listener of registrationListeners) listener()
    },
  }
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker })
  return serviceWorker
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
    if (serviceWorkerDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor)
    } else {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker
    }
  })

  it("shows build details and confirms a manual update check", async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    installServiceWorker({ waiting: null, installing: null, update })
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "abc1234", builtAt: "2026-07-14T12:30:00.000Z" }),
    } as Response)

    renderPage()

    expect(screen.getByText("abc1234")).toBeInTheDocument()
    expect(screen.getByText("Updated on this device")).toBeInTheDocument()
    expect(screen.getByText("Build created")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    expect(update).toHaveBeenCalledOnce()
    expect(await screen.findByText("Up to date")).toBeInTheDocument()
    expect(screen.getByText(/Last checked/)).toBeInTheDocument()
  })

  it("offers to reload once a new worker is ready", async () => {
    installServiceWorker({
      waiting: { postMessage: vi.fn() } as unknown as ServiceWorker,
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "def5678", builtAt: "2026-07-14T13:00:00.000Z" }),
    } as Response)

    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    expect(await screen.findByText("Update ready")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload and update" })).toBeInTheDocument()
  })

  it("downloads again instead of reloading before an update is parked", async () => {
    installServiceWorker({
      waiting: null,
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "def5678" }),
    } as Response)

    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    expect(await screen.findByText("Update available")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Download update" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Reload and update" })).not.toBeInTheDocument()
  })

  it("does not call a first service-worker activation an app update", async () => {
    installServiceWorker({
      waiting: null,
      installing: { state: "activated" } as ServiceWorker,
      update: vi.fn().mockResolvedValue(undefined),
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "abc1234" }),
    } as Response)

    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    expect(await screen.findByText("Up to date")).toBeInTheDocument()
    expect(screen.queryByText("Update ready")).not.toBeInTheDocument()
  })

  it("switches from download to reload when the worker finishes in the background", async () => {
    const serviceWorker = installServiceWorker({
      waiting: null,
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "def5678" }),
    } as Response)

    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    expect(await screen.findByRole("button", { name: "Download update" })).toBeInTheDocument()

    act(() => serviceWorker.parkUpdate({ postMessage: vi.fn() } as unknown as ServiceWorker))

    expect(screen.getByRole("button", { name: "Reload and update" })).toBeInTheDocument()
  })

  it("finishes a manual check when registration.update stalls", async () => {
    vi.useFakeTimers()
    installServiceWorker({
      waiting: null,
      installing: null,
      update: vi.fn(() => new Promise(() => {})),
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "abc1234" }),
    } as Response)

    renderPage()
    act(() => screen.getByRole("button", { name: "Check for updates" }).click())
    await act(async () => vi.advanceTimersByTimeAsync(5_000))

    expect(screen.getByText("Up to date")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled()
  })

  it("updates offline readiness when the service worker takes control", () => {
    const serviceWorker = installServiceWorker(
      { waiting: null, installing: null, update: vi.fn().mockResolvedValue(undefined) },
      false
    )

    renderPage()
    expect(screen.getByText("Starting")).toBeInTheDocument()

    act(() => serviceWorker.takeControl())

    expect(screen.getByText("Ready")).toBeInTheDocument()
  })
})
