import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import { e2eKeysApi } from "@/api/e2e-keys"
import { DEFAULT_KDF_PARAMS } from "@/lib/crypto/passphrase"
import { getE2eSessionState, lock, resetE2eSessionStoreCache, setupNewKey } from "@/stores/e2e-session-store"
import { E2eUnlockProvider } from "./e2e-unlock-provider"
import { ComposerEncryptionNotice, StreamHeaderEncryptionAction } from "./stream-encryption-affordance"

// Match the fast Argon2id preset the crypto/store suites use so unlock stays
// well under a second.
const FAST_PARAMS = { ...DEFAULT_KDF_PARAMS, m: 8 * 1024, t: 1 }

const USER_ID = "usr_test"

interface InMemoryServerKey {
  keyId: string
  publicKey: string
  encryptedPrivateBundle: string
  kdfSalt: string
  kdfParams: typeof FAST_PARAMS
  createdAt: string
}

let serverKey: InMemoryServerKey | null = null
let keyCounter = 0
let wsCounter = 0

// Each test gets its own workspace scope, so IDB rows persisted by one case
// (the device key written on unlock) can never bleed into the next — no shared
// teardown, and no direct `@/db` access from a component test (INV-15).
function freshWorkspaceId(): string {
  return `ws_test_${++wsCounter}`
}

beforeEach(() => {
  serverKey = null
  keyCounter = 0
  vi.spyOn(e2eKeysApi, "get").mockImplementation(async () => serverKey)
  vi.spyOn(e2eKeysApi, "set").mockImplementation(async (_ws, input) => {
    const rotated = serverKey !== null
    serverKey = {
      keyId: `e2ek_test_${++keyCounter}`,
      publicKey: input.publicKey,
      encryptedPrivateBundle: input.encryptedPrivateBundle,
      kdfSalt: input.kdfSalt,
      kdfParams: input.kdfParams as typeof FAST_PARAMS,
      createdAt: new Date().toISOString(),
    }
    return { key: serverKey, rotated }
  })
  // The affordance + provider both resolve the workspace user id via this hook.
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(USER_ID)
})

afterEach(() => {
  resetE2eSessionStoreCache()
  vi.restoreAllMocks()
})

function renderWithProvider(workspaceId: string, ui: React.ReactNode) {
  return render(<E2eUnlockProvider workspaceId={workspaceId}>{ui}</E2eUnlockProvider>)
}

describe("StreamHeaderEncryptionAction", () => {
  it("renders nothing for an unencrypted stream", () => {
    const ws = freshWorkspaceId()
    renderWithProvider(ws, <StreamHeaderEncryptionAction workspaceId={ws} encrypted={false} />)
    expect(screen.queryByRole("button", { name: /unlock/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /set up/i })).not.toBeInTheDocument()
  })

  it("renders nothing once the session is unlocked", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "correct-horse-battery-staple", { params: FAST_PARAMS })
    renderWithProvider(ws, <StreamHeaderEncryptionAction workspaceId={ws} encrypted />)
    await waitFor(() => expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked"))
    expect(screen.queryByRole("button", { name: /^unlock$/i })).not.toBeInTheDocument()
  })

  it("offers setup when no key exists yet and opens the setup modal", async () => {
    const ws = freshWorkspaceId()
    renderWithProvider(ws, <StreamHeaderEncryptionAction workspaceId={ws} encrypted />)
    const setupButton = await screen.findByRole("button", { name: /set up encryption/i })
    await userEvent.click(setupButton)
    expect(await screen.findByText("Set up encrypted scratchpads")).toBeInTheDocument()
  })

  it("offers unlock for a locked stream, then unlocks with the correct passphrase", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "correct-horse-battery-staple", { params: FAST_PARAMS })
    await lock(ws, USER_ID)

    renderWithProvider(ws, <StreamHeaderEncryptionAction workspaceId={ws} encrypted />)

    const unlockButton = await screen.findByRole("button", { name: /^unlock$/i })
    await userEvent.click(unlockButton)

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Unlock encrypted scratchpads")).toBeInTheDocument()

    // Inline entry points default the "keep me unlocked" toggle to checked.
    const trustCheckbox = within(dialog).getByRole("checkbox", { name: /keep me unlocked/i })
    expect(trustCheckbox).toBeChecked()

    await userEvent.type(within(dialog).getByLabelText("Passphrase"), "correct-horse-battery-staple")
    await userEvent.click(within(dialog).getByRole("button", { name: /^unlock$/i }))

    await waitFor(() => expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked"))
    // Default-checked toggle means the device is trusted after unlocking.
    expect(getE2eSessionState(ws, USER_ID).deviceTrusted).toBe(true)
  })
})

describe("ComposerEncryptionNotice", () => {
  it("prompts to unlock a locked encrypted stream", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "pp-correct-horse", { params: FAST_PARAMS })
    await lock(ws, USER_ID)

    renderWithProvider(ws, <ComposerEncryptionNotice workspaceId={ws} encrypted />)

    expect(await screen.findByText(/unlock it to read and write/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^unlock$/i })).toBeInTheDocument()
  })

  it("renders nothing for an unencrypted stream", () => {
    const ws = freshWorkspaceId()
    renderWithProvider(ws, <ComposerEncryptionNotice workspaceId={ws} encrypted={false} />)
    expect(screen.queryByRole("button", { name: /unlock/i })).not.toBeInTheDocument()
  })
})
