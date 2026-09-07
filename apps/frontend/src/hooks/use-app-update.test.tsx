import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { AppUpdateProvider, useAppUpdate } from "./use-app-update"
import { AppUpdateController, AppUpdateLifecycle } from "@/lib/app-update"

function createLifecycle(): AppUpdateLifecycle {
  return {
    onOnline: () => () => undefined,
    onVisible: () => () => undefined,
    onPageshow: () => () => undefined,
  }
}

function TestConsumer() {
  const state = useAppUpdate()
  return (
    <div>
      <span data-testid="phase">{state.phase}</span>
      <span data-testid="readyVersion">{state.readyVersion ?? "none"}</span>
      <span data-testid="readyBuildId">{state.readyBuildId ?? "none"}</span>
      <span data-testid="failure">{state.failure ?? "none"}</span>
      <button onClick={() => void state.check()}>Check</button>
      <button onClick={() => void state.apply()}>Apply</button>
    </div>
  )
}

describe("AppUpdateProvider + useAppUpdate", () => {
  let controller: AppUpdateController
  let reload: () => void

  beforeEach(() => {
    reload = vi.fn() as () => void
    controller = new AppUpdateController({
      serviceWorker: undefined,
      fetchLatestVersion: async () => null,
      buildInfo: { version: "A", buildId: "A" },
      isDev: false,
      pollIntervalMs: 300_000,
      lifecycle: createLifecycle(),
      reload,
    })
  })

  afterEach(() => {
    controller.dispose()
  })

  it("renders initial state from the shared controller", () => {
    render(
      <AppUpdateProvider controller={controller}>
        <TestConsumer />
      </AppUpdateProvider>
    )
    expect(screen.getByTestId("phase").textContent).toBe("idle")
  })

  it("reacts to controller state changes", async () => {
    // isDev: true so the provider's start() effect never schedules its own
    // background check (see app-update.ts) — this test is about the hook
    // mirroring controller state, not real update-check plumbing, and a
    // real-timer background check racing the manual setState below would
    // make this test flaky.
    const devController = new AppUpdateController({
      serviceWorker: undefined,
      fetchLatestVersion: async () => null,
      buildInfo: { version: "A", buildId: "A" },
      isDev: true,
      pollIntervalMs: 300_000,
      lifecycle: createLifecycle(),
      reload,
    })
    render(
      <AppUpdateProvider controller={devController}>
        <TestConsumer />
      </AppUpdateProvider>
    )
    act(() => {
      ;(devController as unknown as { setState: (partial: Record<string, unknown>) => void }).setState({
        phase: "ready",
        readyVersion: "B",
        readyBuildId: "B",
      })
    })
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("ready"))
    expect(screen.getByTestId("readyVersion").textContent).toBe("B")
    expect(screen.getByTestId("readyBuildId").textContent).toBe("B")
    devController.dispose()
  })

  it("check action delegates to the controller", async () => {
    const checkSpy = vi.spyOn(controller, "check").mockResolvedValue(undefined)
    render(
      <AppUpdateProvider controller={controller}>
        <TestConsumer />
      </AppUpdateProvider>
    )
    act(() => screen.getByText("Check").click())
    await waitFor(() => expect(checkSpy).toHaveBeenCalledOnce())
  })

  it("apply action delegates to the controller", async () => {
    const applySpy = vi.spyOn(controller, "apply").mockResolvedValue(undefined)
    render(
      <AppUpdateProvider controller={controller}>
        <TestConsumer />
      </AppUpdateProvider>
    )
    act(() => screen.getByText("Apply").click())
    await waitFor(() => expect(applySpy).toHaveBeenCalledOnce())
  })

  it("throws when used outside the provider", () => {
    function Isolated() {
      useAppUpdate()
      return null
    }
    expect(() => render(<Isolated />)).toThrow("useAppUpdate must be used within AppUpdateProvider")
  })

  it("returns stable check and apply action identities across renders", () => {
    function wrapper({ children }: { children: ReactNode }) {
      return <AppUpdateProvider controller={controller}>{children}</AppUpdateProvider>
    }
    const { result, rerender } = renderHook(() => useAppUpdate(), { wrapper })
    const firstCheck = result.current.check
    const firstApply = result.current.apply
    rerender()
    expect(result.current.check).toBe(firstCheck)
    expect(result.current.apply).toBe(firstApply)
  })
})
