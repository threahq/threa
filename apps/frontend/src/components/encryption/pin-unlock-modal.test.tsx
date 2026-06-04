import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import { e2eKeysApi } from "@/api/e2e-keys"
import { DEFAULT_KDF_PARAMS } from "@/lib/crypto/passphrase"
import {
  getE2eSessionState,
  loadE2eKeyForUser,
  resetE2eSessionStoreCache,
  setupNewKey,
} from "@/stores/e2e-session-store"
import { PinUnlockModal } from "./pin-unlock-modal"

const FAST_PARAMS = { ...DEFAULT_KDF_PARAMS, m: 8 * 1024, t: 1 }
const USER = "usr_pin"
const PIN = "135790"

// Fresh workspace per test so the device-key IDB row from one case can't bleed
// into the next — no direct `@/db` access from a component test (INV-15).
let wsCounter = 0
const freshWs = () => `ws_pin_${++wsCounter}`

let serverKey: Record<string, unknown> | null = null
let keyCounter = 0

beforeEach(() => {
  serverKey = null
  keyCounter = 0
  vi.spyOn(e2eKeysApi, "get").mockImplementation(async () => serverKey as never)
  vi.spyOn(e2eKeysApi, "set").mockImplementation(async (_ws, input) => {
    serverKey = {
      keyId: `e2ek_${++keyCounter}`,
      publicKey: input.publicKey,
      encryptedPrivateBundle: input.encryptedPrivateBundle,
      kdfSalt: input.kdfSalt,
      kdfParams: input.kdfParams,
      createdAt: new Date().toISOString(),
    }
    return { key: serverKey, rotated: false } as never
  })
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(USER)
})

afterEach(async () => {
  // `input-otp` (rendered via PinInput) defers a selection-sync `setState` with
  // `setTimeout(…, 50)` and never clears it on unmount. If that timer fires after
  // Vitest tears down the jsdom environment, React reads a `window` that's gone
  // and throws "window is not defined" as an unhandled error — failing the whole
  // run even though every assertion passed. Drain it here, while `window` still
  // exists. 50ms is the library's longest deferral, and its callback only touches
  // caret-mirror state (not the value/selection deps), so it can't re-arm itself.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  resetE2eSessionStoreCache()
  vi.restoreAllMocks()
})

/** Set up an account with a device PIN, then simulate a reload → pin-locked. */
async function arrangePinLocked(ws: string): Promise<void> {
  await setupNewKey(ws, USER, "pp-correct-horse", { params: FAST_PARAMS, pin: PIN })
  resetE2eSessionStoreCache()
  await loadE2eKeyForUser(ws, USER)
  await waitFor(() => expect(getE2eSessionState(ws, USER).pinProtected).toBe(true))
}

function pinInput(): HTMLInputElement {
  // The OTP primitive renders a single hidden input that holds the full value.
  const input = document.querySelector<HTMLInputElement>("input[data-input-otp]")
  if (!input) throw new Error("PIN input not found")
  return input
}

describe("PinUnlockModal", () => {
  it("unlocks with the correct PIN and fires onUnlocked", async () => {
    const ws = freshWs()
    await arrangePinLocked(ws)
    const onUnlocked = vi.fn()
    render(
      <PinUnlockModal
        open
        workspaceId={ws}
        userId={USER}
        onOpenChange={() => {}}
        onUnlocked={onUnlocked}
        onUsePassphrase={() => {}}
      />
    )

    expect(await screen.findByText("Enter your PIN")).toBeInTheDocument()
    await userEvent.type(pinInput(), PIN)

    await waitFor(() => expect(getE2eSessionState(ws, USER).status).toBe("unlocked"))
    expect(onUnlocked).toHaveBeenCalledTimes(1)
  })

  it("shows the attempts-left error on a wrong PIN and stays locked", async () => {
    const ws = freshWs()
    await arrangePinLocked(ws)
    render(<PinUnlockModal open workspaceId={ws} userId={USER} onOpenChange={() => {}} onUsePassphrase={() => {}} />)

    await userEvent.type(pinInput(), "000000")
    expect(await screen.findByText(/attempt.*left/i)).toBeInTheDocument()
    expect(getE2eSessionState(ws, USER).status).toBe("locked")
  })

  it("offers a passphrase fallback", async () => {
    const ws = freshWs()
    await arrangePinLocked(ws)
    const onUsePassphrase = vi.fn()
    render(
      <PinUnlockModal open workspaceId={ws} userId={USER} onOpenChange={() => {}} onUsePassphrase={onUsePassphrase} />
    )
    await userEvent.click(screen.getByRole("button", { name: /use passphrase/i }))
    expect(onUsePassphrase).toHaveBeenCalledTimes(1)
  })
})
