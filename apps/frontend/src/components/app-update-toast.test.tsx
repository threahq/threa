import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, userEvent, waitFor } from "@/test"
import { SonnerRoot, toast } from "@/lib/sonner-module"
import { AppUpdateProvider } from "@/hooks/use-app-update"
import type { AppUpdateState } from "@/lib/app-update"
import { TestAppUpdateController, asAppUpdateController } from "@/test/app-update-controller"
import * as contextsModule from "@/contexts"
import * as useMobileModule from "@/hooks/use-mobile"
import { AppToastHost, AppUpdateNotifier } from "./app-update-toast"

function renderNotifier(initial: Partial<AppUpdateState> = {}) {
  const controller = new TestAppUpdateController(initial)
  const view = render(
    <AppUpdateProvider controller={asAppUpdateController(controller)}>
      <SonnerRoot />
      <AppUpdateNotifier />
    </AppUpdateProvider>
  )
  return { controller, view }
}

function visibleToasts(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>("[data-sonner-toast]")
}

afterEach(() => {
  act(() => toast.dismiss())
})

describe("AppUpdateNotifier", () => {
  it("should announce a build that is downloaded and ready", async () => {
    renderNotifier({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" })

    expect(await screen.findByText("A new version of Threa is ready")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
  })

  it("should announce a build once, even when the phase re-settles on the same build", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    act(() => controller.emit({ phase: "checking" }))
    act(() => controller.emit({ phase: "ready", readyBuildId: "def5678-1" }))

    await waitFor(() => expect(visibleToasts()).toHaveLength(1))
    expect(screen.getByText("A new version of Threa is ready")).toBeInTheDocument()
  })

  it("should keep the notice open and show the shared apply running when the action is clicked", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })

    await userEvent.click(await screen.findByRole("button", { name: "Reload" }))

    expect(controller.applyCalls).toBe(1)
    expect(await screen.findByText("Updating Threa…")).toBeInTheDocument()
    await waitFor(() => expect(visibleToasts()).toHaveLength(1))
    expect(visibleToasts()[0]).toHaveAttribute("data-dismissible", "false")
    // The action has to go with the notice's own state: Sonner merges updates,
    // so a surviving "Reload" would let the user fire the apply again.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument())
    expect(controller.applyCalls).toBe(1)
  })

  it("should keep the notice up when the phase stops saying ready but the build stays parked", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    act(() => controller.emit({ phase: "unavailable" }))

    await waitFor(() => expect(visibleToasts()).toHaveLength(1))
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
  })

  it("should reflect an apply started on another surface without opening a second notice", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    act(() => controller.emit({ phase: "applying" }))

    expect(await screen.findByText("Updating Threa…")).toBeInTheDocument()
    expect(visibleToasts()).toHaveLength(1)
  })

  it("should stay silent when an apply runs with no notice on screen", async () => {
    const { controller } = renderNotifier({ phase: "idle" })

    act(() => controller.emit({ phase: "applying" }))

    await waitFor(() => expect(visibleToasts()).toHaveLength(0))
  })

  it("should replace the notice in place when a newer build supersedes the ready one", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    act(() => controller.emit({ phase: "ready", readyVersion: "ghi9012", readyBuildId: "ghi9012-1" }))

    await waitFor(() => expect(visibleToasts()).toHaveLength(1))
  })

  it("should withdraw the notice when the ready build is gone", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    act(() => controller.emit({ phase: "current", readyVersion: null, readyBuildId: null }))

    await waitFor(() => expect(visibleToasts()).toHaveLength(0))
  })

  it("should offer another attempt when activation fails, keeping the current build running", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }))

    act(() => controller.emit({ phase: "failed", failure: "activation-timeout" }))

    expect(await screen.findByText("Threa couldn't finish updating")).toBeInTheDocument()
    expect(screen.getByText("The build you have keeps running.")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(controller.applyCalls).toBe(2)
  })

  it("should leave a ready notice up when a background check fails", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    act(() => controller.emit({ phase: "failed", failure: "check-failed" }))

    await waitFor(() => expect(visibleToasts()).toHaveLength(1))
    expect(screen.getByText("A new version of Threa is ready")).toBeInTheDocument()
  })
})

describe("AppUpdateNotifier state transitions", () => {
  async function failActivation(controller: TestAppUpdateController) {
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }))
    act(() => controller.emit({ phase: "failed", failure: "activation-timeout" }))
    await screen.findByText("Threa couldn't finish updating")
  }

  it("should read as ready again when the same build is parked after a failed activation", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await failActivation(controller)

    act(() => controller.emit({ phase: "ready", readyBuildId: "def5678-1", failure: null }))

    expect(await screen.findByText("A new version of Threa is ready")).toBeInTheDocument()
    expect(visibleToasts()).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
    expect(screen.queryByText("The build you have keeps running.")).not.toBeInTheDocument()
    expect(visibleToasts()[0]).not.toHaveAttribute("data-type", "error")
  })

  it("should drop the failure wording and styling when a newer build supersedes a failed one", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await failActivation(controller)

    act(() => controller.emit({ phase: "ready", readyVersion: "ghi9012", readyBuildId: "ghi9012-1", failure: null }))

    await screen.findByText("A new version of Threa is ready")
    expect(screen.queryByText("The build you have keeps running.")).not.toBeInTheDocument()
    expect(visibleToasts()[0]).not.toHaveAttribute("data-type", "error")
  })

  it("should carry no failure detail into the retry it started", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await failActivation(controller)

    await userEvent.click(screen.getByRole("button", { name: "Try again" }))

    expect(await screen.findByText("Updating Threa…")).toBeInTheDocument()
    expect(screen.queryByText("The build you have keeps running.")).not.toBeInTheDocument()
    expect(visibleToasts()[0]).toHaveAttribute("data-dismissible", "false")
  })

  it("should hand dismissal back when a newer build lands while an apply is running", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }))
    await screen.findByText("Updating Threa…")

    act(() => controller.emit({ phase: "ready", readyVersion: "ghi9012", readyBuildId: "ghi9012-1" }))

    await screen.findByText("A new version of Threa is ready")
    expect(visibleToasts()[0]).toHaveAttribute("data-dismissible", "true")
    expect(visibleToasts()[0]).not.toHaveAttribute("data-type", "loading")
  })

  it("should stay closed when the user dismissed the notice and the same build re-settles", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    act(() => toast.dismiss("app-update"))
    await waitFor(() => expect(visibleToasts()).toHaveLength(0))

    act(() => controller.emit({ phase: "checking" }))
    act(() => controller.emit({ phase: "ready", readyBuildId: "def5678-1" }))

    await waitFor(() => expect(visibleToasts()).toHaveLength(0))
  })

  it("should stay closed when the user dismissed a failure notice and the build is parked again", async () => {
    const { controller } = renderNotifier({ phase: "ready", readyBuildId: "def5678-1" })
    await failActivation(controller)

    act(() => toast.dismiss("app-update"))
    await waitFor(() => expect(visibleToasts()).toHaveLength(0))

    act(() => controller.emit({ phase: "ready", readyBuildId: "def5678-1", failure: null }))

    await waitFor(() => expect(visibleToasts()).toHaveLength(0))
  })
})

/**
 * The production composition: the real `<Toaster>` and the notifier as one
 * mount, driven through the real sonner store. Sonner never replays — a toast
 * raised before a toaster subscribes, or while none is mounted, is gone — so
 * these are the tests that fail if the two ever drift apart again.
 */
describe("AppToastHost", () => {
  beforeEach(() => {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({ resolvedTheme: "light" } as unknown as ReturnType<
      typeof contextsModule.usePreferences
    >)
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function renderHost(initial: Partial<AppUpdateState> = {}, { mounted = true }: { mounted?: boolean } = {}) {
    const controller = new TestAppUpdateController(initial)

    function Harness({ hostMounted }: { hostMounted: boolean }) {
      return (
        <AppUpdateProvider controller={asAppUpdateController(controller)}>
          {hostMounted ? <AppToastHost /> : null}
        </AppUpdateProvider>
      )
    }

    const view = render(<Harness hostMounted={mounted} />)
    return {
      controller,
      setHostMounted: (next: boolean) => view.rerender(<Harness hostMounted={next} />),
    }
  }

  it("should announce a build already parked when the host mounts", async () => {
    renderHost({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" })

    expect(await screen.findByText("A new version of Threa is ready")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
  })

  it("should announce a build that turned ready long before the host mounted", async () => {
    const { controller, setHostMounted } = renderHost({ phase: "idle" }, { mounted: false })

    act(() => controller.emit({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" }))
    await waitFor(() => expect(visibleToasts()).toHaveLength(0))

    setHostMounted(true)

    expect(await screen.findByText("A new version of Threa is ready")).toBeInTheDocument()
  })

  it("should offer the parked build again when the host remounts", async () => {
    const { setHostMounted } = renderHost({ phase: "ready", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    setHostMounted(false)
    await waitFor(() => expect(visibleToasts()).toHaveLength(0))
    setHostMounted(true)

    expect(await screen.findByText("A new version of Threa is ready")).toBeInTheDocument()
  })

  it("should stay dismissed across a host remount once the user waves the build off", async () => {
    const { controller, setHostMounted } = renderHost({ phase: "ready", readyBuildId: "def5678-1" })

    await userEvent.click(await screen.findByText("A new version of Threa is ready"))
    await waitFor(() => expect(controller.getState().dismissedBuildId).toBe("def5678-1"))
    await waitFor(() => expect(visibleToasts()).toHaveLength(0))

    setHostMounted(false)
    setHostMounted(true)
    act(() => controller.emit({ phase: "checking" }))
    act(() => controller.emit({ phase: "ready", readyBuildId: "def5678-1" }))
    await waitFor(() => expect(visibleToasts()).toHaveLength(0))

    // The remounted host is live, not merely quiet: the next build still lands.
    act(() => controller.emit({ phase: "ready", readyVersion: "ghi9012", readyBuildId: "ghi9012-1" }))
    expect(await screen.findByText("A new version of Threa is ready")).toBeInTheDocument()
  })

  it("should announce a build that returns after being withdrawn", async () => {
    const { controller } = renderHost({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" })
    await screen.findByText("A new version of Threa is ready")

    act(() => controller.emit({ phase: "current", readyVersion: null, readyBuildId: null }))
    await waitFor(() => expect(visibleToasts()).toHaveLength(0))

    act(() => controller.emit({ phase: "ready", readyVersion: "def5678", readyBuildId: "def5678-1" }))

    expect(await screen.findByText("A new version of Threa is ready")).toBeInTheDocument()
    // A withdrawal Sonner reports back as a dismissal must not be filed as the
    // user's, or the returning build would be suppressed instead.
    await waitFor(() => expect(visibleToasts()).toHaveLength(1))
    expect(controller.getState().dismissedBuildId).toBeNull()
  })

  it("should keep showing the update running when the host remounts mid-apply", async () => {
    const { controller, setHostMounted } = renderHost({ phase: "ready", readyBuildId: "def5678-1" })
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }))
    await screen.findByText("Updating Threa…")

    setHostMounted(false)
    setHostMounted(true)

    expect(await screen.findByText("Updating Threa…")).toBeInTheDocument()
    expect(visibleToasts()[0]).toHaveAttribute("data-dismissible", "false")
    expect(controller.applyCalls).toBe(1)
  })
})
