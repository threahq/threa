import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import { e2eKeysApi } from "@/api/e2e-keys"
import { DEFAULT_KDF_PARAMS } from "@/lib/crypto/passphrase"
import { getE2eSessionState, lock, resetE2eSessionStoreCache, setupNewKey } from "@/stores/e2e-session-store"
import { clearStreamKeyCache } from "@/lib/crypto/stream-key-cache"
import { E2eUnlockProvider } from "./e2e-unlock-provider"
import { StreamEncryptionGate } from "./stream-encryption-gate"

const FAST_PARAMS = { ...DEFAULT_KDF_PARAMS, m: 8 * 1024, t: 1 }
const USER_ID = "usr_test"
const TIMELINE = "timeline-content"

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
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(USER_ID)
})

afterEach(() => {
  resetE2eSessionStoreCache()
  clearStreamKeyCache()
  vi.restoreAllMocks()
})

function renderGate(workspaceId: string, encrypted: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <E2eUnlockProvider workspaceId={workspaceId}>
        <StreamEncryptionGate workspaceId={workspaceId} encrypted={encrypted}>
          <div>{TIMELINE}</div>
        </StreamEncryptionGate>
      </E2eUnlockProvider>
    </QueryClientProvider>
  )
}

describe("StreamEncryptionGate", () => {
  it("renders children for an unencrypted stream", () => {
    const ws = freshWorkspaceId()
    renderGate(ws, false)
    expect(screen.getByText(TIMELINE)).toBeInTheDocument()
  })

  it("renders children once the session is unlocked", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "correct-horse-battery-staple", { params: FAST_PARAMS })
    renderGate(ws, true)
    expect(await screen.findByText(TIMELINE)).toBeInTheDocument()
    expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked")
  })

  it("hides the timeline and shows an unlock page for a locked stream", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "correct-horse-battery-staple", { params: FAST_PARAMS })
    await lock(ws, USER_ID)

    renderGate(ws, true)

    expect(await screen.findByText("This scratchpad is encrypted")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^unlock$/i })).toBeInTheDocument()
    // The gate replaces the timeline entirely — children must not be mounted.
    expect(screen.queryByText(TIMELINE)).not.toBeInTheDocument()
  })

  it("shows a setup page (no timeline) when the user has no key yet", async () => {
    const ws = freshWorkspaceId()
    renderGate(ws, true)

    expect(await screen.findByRole("heading", { name: "Set up encryption" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /set up encryption/i })).toBeInTheDocument()
    expect(screen.queryByText(TIMELINE)).not.toBeInTheDocument()
  })

  it("opens the unlock modal from the gate's Unlock button", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "correct-horse-battery-staple", { params: FAST_PARAMS })
    await lock(ws, USER_ID)

    renderGate(ws, true)

    await userEvent.click(await screen.findByRole("button", { name: /^unlock$/i }))
    expect(await screen.findByText("Unlock encrypted scratchpads")).toBeInTheDocument()
  })
})
