import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ServicesProvider, type StreamService } from "@/contexts"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as e2eSession from "@/stores/e2e-session-store"
import * as streamKeyCache from "@/lib/crypto/stream-key-cache"
import * as messageEnvelope from "@/lib/crypto/message-envelope"
import * as descriptionSectionModule from "./description-section"
import { clearStreamNameCache, getCachedStreamName, streamNameCacheKey } from "@/lib/crypto/stream-name-cache"
import { StreamTypes, Visibilities, type Stream } from "@threa/types"
import { GeneralTab } from "./general-tab"

const WS = "ws_1"
const USER = "usr_alice"

function encryptedScratchpad(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_pad_1",
    workspaceId: WS,
    type: StreamTypes.SCRATCHPAD,
    displayName: null,
    slug: null,
    description: null,
    visibility: Visibilities.PRIVATE,
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "on",
    companionPersonaId: null,
    createdBy: USER,
    createdAt: "2026-03-31T10:00:00Z",
    updatedAt: "2026-03-31T10:00:00Z",
    archivedAt: null,
    e2eEnabled: true,
    sealedNameCiphertext: "old_ct",
    sealedNameEnvelope: { v: 0 },
    ...overrides,
  }
}

function unlocked(): ReturnType<typeof e2eSession.getE2eSessionState> {
  return {
    status: "unlocked",
    keyId: "e2ek_alice",
    publicKey: null,
    privateKey: {} as CryptoKey,
    deviceTrusted: true,
    error: null,
  } as ReturnType<typeof e2eSession.getE2eSessionState>
}

function locked(): ReturnType<typeof e2eSession.getE2eSessionState> {
  return {
    status: "locked",
    keyId: null,
    publicKey: null,
    privateKey: null,
    deviceTrusted: false,
    error: null,
  } as ReturnType<typeof e2eSession.getE2eSessionState>
}

function renderTab(stream: Stream, update: ReturnType<typeof vi.fn>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ streams: { update } as unknown as StreamService }}>
        <GeneralTab workspaceId={WS} stream={stream} currentUserId={USER} notificationLevel={null} />
      </ServicesProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  // The description section mounts the full rich-text editor (auth + workspace
  // context); stub it so these rename tests stay focused and provider-light.
  vi.spyOn(descriptionSectionModule, "DescriptionSection").mockImplementation(() => (
    <div data-testid="description-section" />
  ))
})

afterEach(() => {
  clearStreamNameCache()
  vi.restoreAllMocks()
})

describe("GeneralTab display-name rename (stream settings surface)", () => {
  it("seals the new name and sends a sealed-only update when the session is unlocked", async () => {
    vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(USER)
    // The component's lock gate reads `useE2eSession`; `sealStreamRename` reads
    // `getE2eSessionState`. They live in the same module, so the hook calls its
    // local binding — spy both to drive the unlocked path end to end.
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue(unlocked())
    vi.spyOn(e2eSession, "getE2eSessionState").mockReturnValue(unlocked())
    vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue({
      key: new Uint8Array(32),
      keyGeneration: 0,
    } as never)
    vi.spyOn(messageEnvelope, "sealStreamName").mockResolvedValue({ ciphertext: "Y3Q=", envelope: { v: 1 } as never })

    const stream = encryptedScratchpad()
    const update = vi.fn().mockResolvedValue({ ...stream, displayName: null, sealedNameCiphertext: "Y3Q=" })

    const view = renderTab(stream, update)

    await userEvent.type(screen.getByPlaceholderText("Scratchpad name"), "Therapy notes")
    await userEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith(WS, stream.id, {
      sealedNameCiphertext: "Y3Q=",
      sealedNameEnvelope: { v: 1 },
    })
    // No plaintext name on the wire (INV-E1).
    expect(update.mock.calls[0]![2]).not.toHaveProperty("displayName")
    // The new name is immediately resolvable on this device (no re-decrypt flicker).
    expect(getCachedStreamName(streamNameCacheKey(WS, stream.id, "Y3Q="))).toBe("Therapy notes")
    view.unmount()
  })

  it("makes the field read-only and never updates while the session is locked", async () => {
    vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(USER)
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue(locked())
    const sealSpy = vi.spyOn(messageEnvelope, "sealStreamName")

    const update = vi.fn()
    const view = renderTab(encryptedScratchpad(), update)

    const input = screen.getByPlaceholderText("Scratchpad name")
    expect(input).toBeDisabled()
    expect(screen.getByText("Unlock this scratchpad to rename it.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
    expect(sealSpy).not.toHaveBeenCalled()
    view.unmount()
  })
})
