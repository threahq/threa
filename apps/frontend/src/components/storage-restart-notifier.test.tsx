import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, userEvent } from "@/test"
import { SonnerRoot, toast } from "@/lib/sonner-module"
import * as contextsModule from "@/contexts"
import * as useMobileModule from "@/hooks/use-mobile"
// eslint-disable-next-line no-restricted-imports -- test drives the store the notifier's hook reads
import { requestStorageRestart, resetStorageRestartForTests } from "@/db/sqlite-mirror/storage-mode"
import { StorageRestartNotifier } from "./storage-restart-notifier"

describe("StorageRestartNotifier", () => {
  let reloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetStorageRestartForTests()
    reloadSpy = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ reload: reloadSpy } as unknown as Location)
    vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
      resolvedTheme: "light",
    } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  })

  afterEach(() => {
    act(() => toast.dismiss())
    vi.restoreAllMocks()
    resetStorageRestartForTests()
  })

  it("offers a restart once storage asks for one, reloading only when the user takes it", async () => {
    render(
      <>
        <SonnerRoot />
        <StorageRestartNotifier />
      </>
    )
    expect(screen.queryByText("Storage upgrade ready")).toBeNull()

    act(() => requestStorageRestart("threa-account-a"))
    expect(await screen.findByText("Storage upgrade ready")).toBeInTheDocument()
    expect(reloadSpy).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Restart" }))
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it("stays waved off for the session once dismissed, even when another database asks", async () => {
    render(
      <>
        <SonnerRoot />
        <StorageRestartNotifier />
      </>
    )
    act(() => requestStorageRestart("threa-account-a"))
    await screen.findByText("Storage upgrade ready")

    act(() => toast.dismiss("storage-restart"))
    await vi.waitFor(() => expect(screen.queryByText("Storage upgrade ready")).toBeNull())
    act(() => requestStorageRestart("threa-account-b"))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect({ shown: screen.queryByText("Storage upgrade ready"), reloads: reloadSpy.mock.calls.length }).toEqual({
      shown: null,
      reloads: 0,
    })
  })
})
