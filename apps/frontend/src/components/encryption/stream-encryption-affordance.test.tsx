import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { E2eKeyWrapsResponse } from "@threa/types"
import { buildWrapAad, bytesToBase64, generateStreamKey, wrapStreamKey } from "@threa/crypto"
import { generateUIK } from "@/lib/crypto/keys"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as streamStoreModule from "@/stores/stream-store"
import { e2eKeysApi } from "@/api/e2e-keys"
import { e2eKeyWrapsApi } from "@/api/e2e-key-wraps"
import { DEFAULT_KDF_PARAMS } from "@/lib/crypto/passphrase"
import { getE2eSessionState, lock, resetE2eSessionStoreCache, setupNewKey } from "@/stores/e2e-session-store"
import { clearStreamKeyCache } from "@/lib/crypto/stream-key-cache"
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
  // The repair/revive probes resolve the stream's root from the store to scope
  // themselves to the top-level scratchpad. Default every stream to a hydrated
  // top-level row; thread cases override with a row carrying `rootStreamId`.
  mockStreamRow(null)
})

/**
 * Stub `useStreamFromStore` so a probed stream resolves to a hydrated row.
 * `rootStreamId === null` is a top-level scratchpad (its own root); a non-null
 * value marks a thread whose key lives on that root.
 */
function mockStreamRow(rootStreamId: string | null): void {
  vi.spyOn(streamStoreModule, "useStreamFromStore").mockImplementation((id) =>
    id ? ({ id, rootStreamId } as unknown as ReturnType<typeof streamStoreModule.useStreamFromStore>) : undefined
  )
}

afterEach(() => {
  resetE2eSessionStoreCache()
  clearStreamKeyCache()
  vi.restoreAllMocks()
})

function renderWithProvider(workspaceId: string, ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <E2eUnlockProvider workspaceId={workspaceId}>{ui}</E2eUnlockProvider>
    </QueryClientProvider>
  )
}

const STREAM_ID = "stream_test"

/** A wrap set the server returns once an owner wrap exists (content unused — the
 *  affordance only checks `wraps.length`). */
function nonEmptyWraps(): E2eKeyWrapsResponse {
  return {
    currentKeyGeneration: 0,
    wraps: [{ keyGeneration: 0, recipientKeyId: "e2ek_owner", recipientKind: "user", wrapEnc: "ZW5j", wrapCt: "Y3Q=" }],
    ownerUserId: USER_ID,
    liveActorRecipients: [],
  }
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

describe("repair (unlocked stream missing its owner wrap)", () => {
  it("offers Finish setup when the wrap set is empty, then provisions and clears", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "pp-correct-horse", { params: FAST_PARAMS })
    await waitFor(() => expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked"))

    // The orphaned-create state: the stream exists but no owner wrap was stored.
    // After repair stores one, the refetch returns a non-empty set.
    let stored = false
    vi.spyOn(e2eKeyWrapsApi, "get").mockImplementation(async () =>
      stored ? nonEmptyWraps() : { currentKeyGeneration: 0, wraps: [], ownerUserId: USER_ID, liveActorRecipients: [] }
    )
    const storeSpy = vi.spyOn(e2eKeyWrapsApi, "store").mockImplementation(async () => {
      stored = true
    })

    renderWithProvider(ws, <StreamHeaderEncryptionAction workspaceId={ws} encrypted streamId={STREAM_ID} />)

    const repairButton = await screen.findByRole("button", { name: /finish setup/i })
    await userEvent.click(repairButton)

    await waitFor(() => expect(storeSpy).toHaveBeenCalledTimes(1))
    // Once the wrap exists, the refetched probe is non-empty and the CTA clears.
    await waitFor(() => expect(screen.queryByRole("button", { name: /finish setup/i })).not.toBeInTheDocument())
  })

  it("renders nothing when the stream already has an owner wrap", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "pp-correct-horse", { params: FAST_PARAMS })
    await waitFor(() => expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked"))

    const getSpy = vi.spyOn(e2eKeyWrapsApi, "get").mockResolvedValue(nonEmptyWraps())

    renderWithProvider(ws, <ComposerEncryptionNotice workspaceId={ws} encrypted streamId={STREAM_ID} />)

    await waitFor(() => expect(getSpy).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: /finish setup/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /unlock/i })).not.toBeInTheDocument()
  })

  it("never offers Finish setup in a thread, whose empty wrap set is by design", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "pp-correct-horse", { params: FAST_PARAMS })
    await waitFor(() => expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked"))

    // A thread shares the root's SSK and carries no wraps of its own — an empty
    // set here is expected, not a broken setup. The probe must not fire (and so
    // must not even query the thread's wraps).
    mockStreamRow("stream_root")
    const getSpy = vi.spyOn(e2eKeyWrapsApi, "get").mockResolvedValue({
      currentKeyGeneration: 1,
      wraps: [],
      ownerUserId: USER_ID,
      liveActorRecipients: [],
    })
    const storeSpy = vi.spyOn(e2eKeyWrapsApi, "store").mockResolvedValue(undefined)

    renderWithProvider(ws, <ComposerEncryptionNotice workspaceId={ws} encrypted streamId="stream_thread" />)

    // The probe gates synchronously on `isRootScratchpad`, so a disabled query
    // never schedules its fetch — flush microtasks (deterministic, no timer
    // race) and assert nothing fired.
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByRole("button", { name: /finish setup/i })).not.toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
    expect(storeSpy).not.toHaveBeenCalled()
  })
})

describe("actor wrap revive (live actor key missing its wrap)", () => {
  it("silently re-wraps the current SSK to the stale actor key when the unlocked owner views the stream", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "pp-correct-horse", { params: FAST_PARAMS })
    await waitFor(() => expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked"))
    const session = getE2eSessionState(ws, USER_ID)

    // The owner holds the only wrap; the enclave restarted, so its live EIK
    // (a fresh X25519 key) has no wrap at the current generation.
    const ssk = generateStreamKey()
    const eik = await generateUIK()
    const ownerWrap = await wrapStreamKey({
      key: ssk,
      recipientPublicKey: session.publicKey!,
      aad: buildWrapAad({ streamId: STREAM_ID, keyGeneration: 0, recipientKeyId: session.keyId! }),
    })
    vi.spyOn(e2eKeyWrapsApi, "get").mockResolvedValue({
      currentKeyGeneration: 0,
      wraps: [
        {
          keyGeneration: 0,
          recipientKeyId: session.keyId!,
          recipientKind: "user",
          wrapEnc: bytesToBase64(ownerWrap.enc),
          wrapCt: bytesToBase64(ownerWrap.ct),
        },
      ],
      ownerUserId: USER_ID,
      liveActorRecipients: [
        { recipientKeyId: "eik_fresh", recipientKind: "enclave", publicKey: bytesToBase64(eik.publicKey) },
      ],
    })
    const reviveSpy = vi.spyOn(e2eKeyWrapsApi, "reviveActorWraps").mockResolvedValue(undefined)

    renderWithProvider(ws, <StreamHeaderEncryptionAction workspaceId={ws} encrypted streamId={STREAM_ID} />)

    // Headless heal: no CTA, no dialog — just the re-wrap POST for the live key.
    await waitFor(() => expect(reviveSpy).toHaveBeenCalledTimes(1))
    const [, , input] = reviveSpy.mock.calls[0]!
    expect(input.keyGeneration).toBe(0)
    expect(input.wraps.map((w) => w.recipientKeyId)).toEqual(["eik_fresh"])
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("heals against the root when the owner is viewing a thread", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "pp-correct-horse", { params: FAST_PARAMS })
    await waitFor(() => expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked"))
    const session = getE2eSessionState(ws, USER_ID)

    const ROOT_ID = "stream_root_heal"
    mockStreamRow(ROOT_ID)

    // The owner's wrap lives on the ROOT; its AAD binds to the root id, so the
    // heal must resolve the SSK (and re-wrap) against the root, not the thread.
    const ssk = generateStreamKey()
    const eik = await generateUIK()
    const ownerWrap = await wrapStreamKey({
      key: ssk,
      recipientPublicKey: session.publicKey!,
      aad: buildWrapAad({ streamId: ROOT_ID, keyGeneration: 0, recipientKeyId: session.keyId! }),
    })
    const getSpy = vi.spyOn(e2eKeyWrapsApi, "get").mockResolvedValue({
      currentKeyGeneration: 0,
      wraps: [
        {
          keyGeneration: 0,
          recipientKeyId: session.keyId!,
          recipientKind: "user",
          wrapEnc: bytesToBase64(ownerWrap.enc),
          wrapCt: bytesToBase64(ownerWrap.ct),
        },
      ],
      ownerUserId: USER_ID,
      liveActorRecipients: [
        { recipientKeyId: "eik_fresh", recipientKind: "enclave", publicKey: bytesToBase64(eik.publicKey) },
      ],
    })
    const reviveSpy = vi.spyOn(e2eKeyWrapsApi, "reviveActorWraps").mockResolvedValue(undefined)

    renderWithProvider(ws, <StreamHeaderEncryptionAction workspaceId={ws} encrypted streamId="stream_thread_heal" />)

    await waitFor(() => expect(reviveSpy).toHaveBeenCalledTimes(1))
    // Both the probe fetch and the re-wrap POST target the root id, never the thread.
    expect(getSpy.mock.calls.every(([, streamId]) => streamId === ROOT_ID)).toBe(true)
    const [, reviveStreamId, input] = reviveSpy.mock.calls[0]!
    expect(reviveStreamId).toBe(ROOT_ID)
    expect(input.wraps.map((w) => w.recipientKeyId)).toEqual(["eik_fresh"])
  })

  it("does not revive for a non-owner viewer", async () => {
    const ws = freshWorkspaceId()
    await setupNewKey(ws, USER_ID, "pp-correct-horse", { params: FAST_PARAMS })
    await waitFor(() => expect(getE2eSessionState(ws, USER_ID).status).toBe("unlocked"))

    const getSpy = vi.spyOn(e2eKeyWrapsApi, "get").mockResolvedValue({
      currentKeyGeneration: 0,
      wraps: [],
      ownerUserId: "usr_someone_else",
      liveActorRecipients: [{ recipientKeyId: "eik_fresh", recipientKind: "enclave", publicKey: "AA==" }],
    })
    const reviveSpy = vi.spyOn(e2eKeyWrapsApi, "reviveActorWraps")

    renderWithProvider(ws, <StreamHeaderEncryptionAction workspaceId={ws} encrypted streamId={STREAM_ID} />)

    await waitFor(() => expect(getSpy).toHaveBeenCalled())
    expect(reviveSpy).not.toHaveBeenCalled()
  })
})
