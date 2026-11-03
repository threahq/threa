import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, userEvent } from "@/test"
// eslint-disable-next-line no-restricted-imports -- test drives the store the lock's hook reads
import { reportStorageUpgrade, resetStorageRestartForTests } from "@/db/sqlite-mirror/storage-mode"
import { StorageUpgradeLock } from "./storage-upgrade-lock"

describe("StorageUpgradeLock", () => {
  afterEach(() => resetStorageRestartForTests())

  it("holds the app with the copy's progress until the upgrade ends, and Escape does not dismiss it", async () => {
    render(
      <>
        <button type="button" autoFocus>
          Behind
        </button>
        <StorageUpgradeLock />
      </>
    )
    expect(screen.queryByRole("alertdialog")).toBeNull()

    act(() => reportStorageUpgrade({ copied: 0, total: null }))
    const lock = await screen.findByRole("alertdialog", { name: "Upgrading storage" })
    await vi.waitFor(() => expect(lock).toHaveFocus())
    act(() => reportStorageUpgrade({ copied: 25, total: 100 }))
    await userEvent.keyboard("{Escape}")
    expect({
      locked: screen.queryByRole("alertdialog") !== null,
      progress: screen.getByRole("progressbar", { name: "Storage upgrade progress" }).getAttribute("aria-valuenow"),
    }).toEqual({ locked: true, progress: "25" })

    act(() => reportStorageUpgrade(null))
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })
})
