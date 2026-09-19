import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes } from "@threahq/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import * as e2eActorsModule from "@/hooks/use-e2e-actors"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"
import { InviteActorButton } from "./invite-actor-button"

// The enclave pill is the only surface that can take Ariadne's grant back, so
// the revoke has to be reachable from it — and gated behind a confirm, because
// it rolls the stream key and deletes the copies she was given.
function arrange(actors: Array<{ kind: string; actorId: string; keyId: string | null }>) {
  const invite = vi.fn()
  const revoke = vi.fn().mockResolvedValue(undefined)
  vi.spyOn(e2eActorsModule, "useInviteActor").mockReturnValue({ invite, isInviting: false } as unknown as ReturnType<
    typeof e2eActorsModule.useInviteActor
  >)
  vi.spyOn(e2eActorsModule, "useRevokeActor").mockReturnValue({ revoke, isRevoking: false } as unknown as ReturnType<
    typeof e2eActorsModule.useRevokeActor
  >)

  const stream = {
    id: "stream_e2e",
    type: StreamTypes.SCRATCHPAD,
    isDraft: false,
    e2eEnabled: true,
    e2eActors: actors,
  } as unknown as VirtualStream

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <InviteActorButton workspaceId="ws_1" stream={stream} kind="enclave" />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return { invite, revoke }
}

describe("InviteActorButton", () => {
  afterEach(() => vi.restoreAllMocks())

  it("invites when the actor is absent", async () => {
    const user = userEvent.setup()
    const { invite, revoke } = arrange([])

    await user.click(screen.getByLabelText("Invite Ariadne to this scratchpad"))

    expect(invite).toHaveBeenCalledWith("enclave")
    expect(revoke).not.toHaveBeenCalled()
  })

  it("confirms before revoking, and revokes the actor id the stream lists", async () => {
    const user = userEvent.setup()
    // The row is pinned to the enclave sentinel; revoke names it as listed
    // rather than re-deriving a kind → id mapping in the component.
    const { revoke } = arrange([{ kind: "enclave", actorId: "enclave", keyId: "eek_1" }])

    await user.click(screen.getByLabelText("Remove Ariadne from this scratchpad"))

    expect(await screen.findByText(/loses access to everything sent from now on/i)).toBeInTheDocument()
    expect(revoke).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Remove Ariadne" }))

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("enclave", "enclave"))
  })

  it("keeps the grant when the confirm is dismissed", async () => {
    const user = userEvent.setup()
    const { revoke } = arrange([{ kind: "enclave", actorId: "enclave", keyId: "eek_1" }])

    await user.click(screen.getByLabelText("Remove Ariadne from this scratchpad"))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    expect(revoke).not.toHaveBeenCalled()
  })
})
