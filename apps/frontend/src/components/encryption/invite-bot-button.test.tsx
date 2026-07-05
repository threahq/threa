import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes } from "@threa/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as inviteActorModule from "@/hooks/use-invite-actor"
import * as inputModeModule from "@/hooks/use-input-mode"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"
import { InviteBotButton } from "./invite-bot-button"

// The invited-bot pills carry a security claim ("can read this encrypted
// scratchpad") and, on a phone-width header, fold into a "+N" overflow. Both are
// exercised here: the copy must track wrap state (a bot invited while locked is
// pending, not yet a reader), and the overflow must be reachable by keyboard /
// touch (a focusable button + a tap drawer), not a hover-only tooltip.
// The bot list is the bootstrap-synced store (shared + the viewer's own
// personal bots), so a personal harness bot must reach the picker too.

const BOTS = [
  { id: "bot_wrapped", name: "Pi", type: "personal", archivedAt: null, avatarEmoji: "🤖" },
  { id: "bot_pending", name: "Claude", type: "personal", archivedAt: null, avatarEmoji: "🤖" },
  { id: "bot_overflow", name: "Ariadne", type: "shared", archivedAt: null, avatarEmoji: "🤖" },
  { id: "bot_free", name: "Scout", type: "personal", archivedAt: null, avatarEmoji: "🤖" },
] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceBots>

function arrange(inputMode: "mouse" | "touch") {
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue(BOTS)
  vi.spyOn(inviteActorModule, "useInviteActor").mockReturnValue({
    invite: vi.fn(),
    isInviting: false,
  } as unknown as ReturnType<typeof inviteActorModule.useInviteActor>)
  vi.spyOn(inputModeModule, "useInputMode").mockReturnValue(inputMode)

  const stream = {
    id: "stream_e2e",
    type: StreamTypes.SCRATCHPAD,
    isDraft: false,
    e2eEnabled: true,
    // bot_wrapped has a wrap (keyId set → can read); bot_pending was invited
    // while locked (keyId null → pending); bot_overflow is the 3rd, folded.
    e2eActors: [
      { kind: "bot", actorId: "bot_wrapped", keyId: "bik_1" },
      { kind: "bot", actorId: "bot_pending", keyId: null },
      { kind: "bot", actorId: "bot_overflow", keyId: "bik_3" },
    ],
  } as unknown as VirtualStream

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <InviteBotButton workspaceId="ws_1" stream={stream} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("InviteBotButton", () => {
  afterEach(() => vi.restoreAllMocks())

  it("labels a wrapped bot as a reader and a locked-invited bot as pending", async () => {
    arrange("mouse")
    // Wrapped bot: the strong "can read" claim, which is now true.
    expect(await screen.findByLabelText("Pi can read this encrypted scratchpad")).toBeInTheDocument()
    // Invited-while-locked bot: pending copy, not the false "can read" claim.
    expect(screen.getByLabelText("Claude is invited; unlock to grant it access")).toBeInTheDocument()
  })

  it("folds the 3rd+ invited bot into a focusable overflow that names the folded bots", async () => {
    arrange("mouse")
    // VISIBLE_CAP = 2, so the 3rd invited bot folds. The overflow is a real
    // button (keyboard/touch reachable, unlike a bare tooltip span) and its
    // accessible name carries the folded bot names.
    const overflow = await screen.findByRole("button", { name: /1 more agents invited: Ariadne/ })
    expect(overflow.tagName).toBe("BUTTON")
  })

  it("reveals the folded bots in a tap drawer on touch", async () => {
    arrange("touch")
    const overflow = await screen.findByRole("button", { name: /1 more agents invited: Ariadne/ })
    await userEvent.click(overflow)
    // The drawer discloses the folded set — unreachable via a hover-only tooltip.
    expect(await screen.findByText("Agents with access")).toBeInTheDocument()
    const drawer =
      screen.getByText("Agents with access").closest("[role='dialog'], [data-vaul-drawer]") ?? document.body
    await waitFor(() => expect(within(drawer as HTMLElement).getByText("Ariadne")).toBeInTheDocument())
  })

  it("offers the un-invited bot in the picker, including a personal one", async () => {
    arrange("mouse")
    const trigger = await screen.findByRole("button", { name: "Invite an agent to this scratchpad" })
    // Scout is a PERSONAL bot — the regression was the picker querying the
    // shared-only bots endpoint, which hid an owner's own harness bots.
    await userEvent.click(trigger)
    expect(await screen.findByRole("menuitem", { name: /Scout/ })).toBeInTheDocument()
  })
})
