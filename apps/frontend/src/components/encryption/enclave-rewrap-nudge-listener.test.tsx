import { afterEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { EnclaveRewrapNeededPayload } from "@threahq/types"
import * as contexts from "@/contexts"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as e2eSessionStore from "@/stores/e2e-session-store"
import * as streamKeyCache from "@/lib/crypto/stream-key-cache"
import { EnclaveRewrapNudgeListener } from "./enclave-rewrap-nudge-listener"

const WORKSPACE_ID = "ws_1"
const OWNER_ID = "usr_owner"
const PAYLOAD: EnclaveRewrapNeededPayload = {
  workspaceId: WORKSPACE_ID,
  targetUserId: OWNER_ID,
  rootStreamId: "stream_root",
}

/** Minimal Socket.io stand-in: registers handlers and lets the test emit to them. */
function makeFakeSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  return {
    on: (event: string, handler: (payload: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
    },
    off: (event: string, handler: (payload: unknown) => void) => {
      handlers.get(event)?.delete(handler)
    },
    emit: (event: string, payload: unknown) => {
      handlers.get(event)?.forEach((h) => h(payload))
    },
  }
}

type FakeSocket = ReturnType<typeof makeFakeSocket>

const UNLOCKED_OWNER = { status: "unlocked", keyId: "e2ek_owner", privateKey: {} as CryptoKey }

function arrange(session: object, userId: string | undefined = OWNER_ID): FakeSocket {
  const socket = makeFakeSocket()
  vi.spyOn(contexts, "useSocket").mockReturnValue(socket as never)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(userId)
  vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(session as never)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <EnclaveRewrapNudgeListener workspaceId={WORKSPACE_ID} />
    </QueryClientProvider>
  )
  return socket
}

afterEach(() => vi.restoreAllMocks())

describe("EnclaveRewrapNudgeListener", () => {
  it("re-wraps the stuck stream's actor keys when an unlocked owner receives the nudge", async () => {
    const revive = vi.spyOn(streamKeyCache, "reviveStaleActorWraps").mockResolvedValue("revived")
    const socket = arrange(UNLOCKED_OWNER)

    socket.emit("enclave:rewrap_needed", PAYLOAD)

    await waitFor(() => expect(revive).toHaveBeenCalledTimes(1))
    expect(revive).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      streamId: "stream_root",
      userId: OWNER_ID,
      ownerKeyId: "e2ek_owner",
      ownerPrivateKey: UNLOCKED_OWNER.privateKey,
    })
  })

  it("does nothing while the session is locked — the per-stream affordance heals on the next unlock", () => {
    const revive = vi.spyOn(streamKeyCache, "reviveStaleActorWraps").mockResolvedValue("revived")
    const socket = arrange({ status: "locked" })

    socket.emit("enclave:rewrap_needed", PAYLOAD)

    expect(revive).not.toHaveBeenCalled()
  })

  it("ignores a nudge addressed to a different user (only the owner can re-wrap)", () => {
    const revive = vi.spyOn(streamKeyCache, "reviveStaleActorWraps").mockResolvedValue("revived")
    const socket = arrange(UNLOCKED_OWNER)

    socket.emit("enclave:rewrap_needed", { ...PAYLOAD, targetUserId: "usr_someone_else" })

    expect(revive).not.toHaveBeenCalled()
  })

  it("ignores a nudge for a different workspace", () => {
    const revive = vi.spyOn(streamKeyCache, "reviveStaleActorWraps").mockResolvedValue("revived")
    const socket = arrange(UNLOCKED_OWNER)

    socket.emit("enclave:rewrap_needed", { ...PAYLOAD, workspaceId: "ws_other" })

    expect(revive).not.toHaveBeenCalled()
  })
})
