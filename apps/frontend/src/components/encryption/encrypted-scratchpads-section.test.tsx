import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClientProvider, QueryClient } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import * as authModule from "@/auth"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { e2eKeysApi } from "@/api/e2e-keys"
import { DEFAULT_KDF_PARAMS } from "@/lib/crypto/passphrase"
import { getDeviceUnlockMethod, resetE2eSessionStoreCache, setupNewKey } from "@/stores/e2e-session-store"
import { createMockUser } from "@/test/fixtures/users"
import { E2eUnlockProvider } from "./e2e-unlock-provider"
import { EncryptedScratchpadsSection } from "./encrypted-scratchpads-section"

// Fast Argon2id preset shared with the store/crypto suites so the setup +
// one PIN enrollment derivation stay well under a second.
const FAST_PARAMS = { ...DEFAULT_KDF_PARAMS, m: 8 * 1024, t: 1 }

const WORKSPACE_ID = "ws_settings_test"
const USER_ID = "usr_settings_test"
const WORKOS_ID = "workos_settings_test"

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
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(USER_ID)
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    user: { id: WORKOS_ID },
  } as unknown as ReturnType<typeof authModule.useAuth>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
    createMockUser({ id: USER_ID, workosUserId: WORKOS_ID }),
  ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
})

afterEach(async () => {
  resetE2eSessionStoreCache()
  vi.restoreAllMocks()
})

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}`]}>
        <E2eUnlockProvider workspaceId={WORKSPACE_ID}>
          <Routes>
            <Route path="/w/:workspaceId" element={<EncryptedScratchpadsSection />} />
          </Routes>
        </E2eUnlockProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("EncryptedScratchpadsSection — quick-unlock management", () => {
  it("lets a trusted, unlocked device enroll a PIN from settings", async () => {
    // Unlock with the device trusted so the method block renders.
    await setupNewKey(WORKSPACE_ID, USER_ID, "correct-horse", { params: FAST_PARAMS, trustDevice: true })
    expect(await getDeviceUnlockMethod(WORKSPACE_ID, USER_ID)).toBe("remembered")

    const user = userEvent.setup()
    renderSection()

    // The method block starts on automatic unlock.
    await screen.findByText(/Unlocks automatically on this device/i)

    await user.click(screen.getByRole("button", { name: /set a pin/i }))
    await user.type(await screen.findByLabelText("New device PIN"), "246810")
    await user.click(screen.getByRole("button", { name: /save pin/i }))

    // The displayed method flips to PIN, and the store row is now PIN-gated.
    await screen.findByText(/Unlocks with your 6-digit PIN/i)
    await waitFor(async () => {
      expect(await getDeviceUnlockMethod(WORKSPACE_ID, USER_ID)).toBe("pin")
    })
  })

  it("hides the method block until the device is kept unlocked", async () => {
    // Unlocked but not trusted — only the master toggle, no method block.
    await setupNewKey(WORKSPACE_ID, USER_ID, "correct-horse", { params: FAST_PARAMS })

    renderSection()

    await screen.findByText("Keep me unlocked on this device")
    expect(screen.queryByText("Unlock method on this device")).not.toBeInTheDocument()
  })
})
