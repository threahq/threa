import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, act, waitFor } from "@testing-library/react"
import { StreamTypes, type StreamType } from "@threa/types"
import { db, type CachedStream } from "@/db"
import { resetWorkspaceStoreCache, seedWorkspaceCache } from "@/stores/workspace-store"
import { clearStreamNameCache } from "@/lib/crypto/stream-name-cache"
import { useDecryptStreamNames } from "@/hooks/use-decrypt-stream-names"
import { useSealedNamePendingResolver, useStreamNameDecrypting } from "@/hooks/use-decrypted-stream-name"
import { useStreamName } from "@/hooks/use-stream-name"
import * as e2eSession from "@/stores/e2e-session-store"
import * as workspaces from "@/hooks/use-workspaces"
import * as messageEnvelope from "@/lib/crypto/message-envelope"

// End-to-end of the reactive render path the unit tests can't reach: mount the
// real per-workspace decryptor next to the canonical resolver hook and prove a
// landing decrypt propagates (cache emit -> useWorkspaceStreams overlay
// re-render -> useStreamName) so every label surface flips placeholder ->
// decrypted name, and stays on the placeholder while locked.

const WS = "workspace_1"
const STREAM = "stream_scratch"
const CIPHERTEXT = "ct_sealed_name"

function sealedScratchpad(): CachedStream {
  return {
    id: STREAM,
    workspaceId: WS,
    type: StreamTypes.SCRATCHPAD as StreamType,
    // The enclave auto-title never writes plaintext, so the locked/undecrypted
    // resolver must fall through to the placeholder.
    displayName: null,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    archivedAt: null,
    e2eEnabled: true,
    sealedNameCiphertext: CIPHERTEXT,
    sealedNameEnvelope: { v: 2 },
    _cachedAt: Date.now(),
  }
}

function session(overrides: Partial<e2eSession.E2eSessionState>): e2eSession.E2eSessionState {
  return {
    status: "unlocked",
    keyId: "ek_owner",
    publicKey: new Uint8Array(),
    privateKey: {} as CryptoKey,
    deviceTrusted: true,
    error: null,
    ...overrides,
  }
}

function Harness() {
  useDecryptStreamNames(WS)
  const name = useStreamName(WS, STREAM, "sidebar")
  return <span data-testid="label">{name}</span>
}

const SEALED_STREAM = {
  id: STREAM,
  e2eEnabled: true,
  sealedNameCiphertext: CIPHERTEXT,
  sealedNameEnvelope: { v: 2 },
  rootStreamId: null,
}

function DecryptingHarness() {
  useDecryptStreamNames(WS)
  const decrypting = useStreamNameDecrypting(WS, SEALED_STREAM)
  return <span data-testid="state">{decrypting ? "decrypting" : "settled"}</span>
}

const PLAINTEXT_STREAM = { id: "stream_plain", e2eEnabled: false, sealedNameCiphertext: null, rootStreamId: null }

// Mirrors how the list surfaces (sidebar builder, coordinated-loading reveal
// gate) consume the single authority: wire it once, then apply across rows.
function ListHarness() {
  useDecryptStreamNames(WS)
  const isPending = useSealedNamePendingResolver(WS)
  const anyPending = [SEALED_STREAM, PLAINTEXT_STREAM].some(isPending)
  return <span data-testid="any-pending">{anyPending ? "pending" : "settled"}</span>
}

async function seedSealedStream() {
  await db.streams.put(sealedScratchpad())
  seedWorkspaceCache(WS, {
    workspace: {
      id: WS,
      name: "Workspace",
      slug: "workspace",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      _cachedAt: Date.now(),
    },
    users: [],
    streams: [sealedScratchpad()],
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

beforeEach(async () => {
  resetWorkspaceStoreCache()
  clearStreamNameCache()
  await db.streams.clear()
  vi.spyOn(workspaces, "useWorkspaceUserId").mockReturnValue("user_1")
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("decrypted stream name overlay (reactive integration)", () => {
  it("flips placeholder -> decrypted name through the resolver when the decrypt lands", async () => {
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue(session({ status: "unlocked" }))
    // Hold the decrypt open so the placeholder is observable before it resolves.
    let resolveDecrypt: (value: string | null) => void = () => {}
    vi.spyOn(messageEnvelope, "tryOpenStreamName").mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveDecrypt = resolve
        })
    )

    await seedSealedStream()
    render(<Harness />)

    // Decrypt in flight: the resolver shows the locked-state placeholder.
    expect(screen.getByTestId("label")).toHaveTextContent("New scratchpad")

    // The decrypt lands → cache emits → useWorkspaceStreams re-overlays →
    // useStreamName re-renders with the tamper-evident name. No per-surface wiring.
    await act(async () => {
      resolveDecrypt("Quarterly Plan")
    })
    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent("Quarterly Plan"))
  })

  it("keeps the placeholder and never decrypts while the session is locked", async () => {
    const open = vi.spyOn(messageEnvelope, "tryOpenStreamName").mockResolvedValue("Should Not Appear")
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue(session({ status: "locked", privateKey: null }))

    await seedSealedStream()
    render(<Harness />)

    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent("New scratchpad"))
    expect(open).not.toHaveBeenCalled()
  })
})

describe("useStreamNameDecrypting (cold-load loading state)", () => {
  it("reports decrypting until the name lands, so the header shows a loader not the placeholder", async () => {
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue(session({ status: "unlocked" }))
    let resolveDecrypt: (value: string | null) => void = () => {}
    vi.spyOn(messageEnvelope, "tryOpenStreamName").mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveDecrypt = resolve
        })
    )

    await seedSealedStream()
    render(<DecryptingHarness />)

    expect(screen.getByTestId("state")).toHaveTextContent("decrypting")

    await act(async () => {
      resolveDecrypt("Quarterly Plan")
    })
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("settled"))
  })

  it("is settled (placeholder, not a loader) while the session is locked", async () => {
    vi.spyOn(messageEnvelope, "tryOpenStreamName").mockResolvedValue("Should Not Appear")
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue(session({ status: "locked", privateKey: null }))

    await seedSealedStream()
    render(<DecryptingHarness />)

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("settled"))
  })
})

describe("useSealedNamePendingResolver (the single list authority)", () => {
  it("reports pending across rows until the sealed name lands, ignoring plaintext rows", async () => {
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue(session({ status: "unlocked" }))
    let resolveDecrypt: (value: string | null) => void = () => {}
    vi.spyOn(messageEnvelope, "tryOpenStreamName").mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveDecrypt = resolve
        })
    )

    await seedSealedStream()
    render(<ListHarness />)

    // One sealed name is still decrypting → the list reports pending; the
    // plaintext row never contributes pending.
    expect(screen.getByTestId("any-pending")).toHaveTextContent("pending")

    await act(async () => {
      resolveDecrypt("Quarterly Plan")
    })
    await waitFor(() => expect(screen.getByTestId("any-pending")).toHaveTextContent("settled"))
  })

  it("never reports pending while the session is locked (so the reveal gate can't deadlock)", async () => {
    vi.spyOn(messageEnvelope, "tryOpenStreamName").mockResolvedValue("Should Not Appear")
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue(session({ status: "locked", privateKey: null }))

    await seedSealedStream()
    render(<ListHarness />)

    await waitFor(() => expect(screen.getByTestId("any-pending")).toHaveTextContent("settled"))
  })
})
