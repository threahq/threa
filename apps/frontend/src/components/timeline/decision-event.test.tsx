import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DecisionRequest, DecisionResolvedEventPayload, StreamEvent } from "@threahq/types"
import { toast } from "sonner"
import { decisionsApi } from "@/api"
import { ApiError } from "@/api/client"
import * as hooksModule from "@/hooks"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as decisionCacheModule from "@/lib/crypto/decision-cache"
import * as decisionCardModule from "@/lib/crypto/decision-card"
import * as e2eSessionModule from "@/stores/e2e-session-store"
import * as streamStoreModule from "@/stores/stream-store"
import { PanelProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DecisionEvent } from "./decision-event"

const BOT = { id: "bot_1", name: "Kris's Runner" }

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: (actorId: string | null) => (actorId === "usr_kris" ? "Kristoffer Remback" : "Someone"),
    getBot: (botId: string) => (botId === BOT.id ? BOT : undefined),
    getActorAvatar: () => ({ fallback: "K", avatarUrl: null }),
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_kris")
})

function decision(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    id: "dec_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    requesterBotId: BOT.id,
    title: "Force-push the rebased branch?",
    bodyMarkdown: "The rebase dropped **two** commits.",
    options: [
      { id: "opt_yes", label: "Force-push", tone: "primary" },
      { id: "opt_wait", label: "Wait for me", tone: "neutral" },
      { id: "opt_abort", label: "Abort", tone: "destructive" },
    ],
    allowNote: false,
    status: "open",
    version: 3,
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  }
}

function requestedEvent(request: DecisionRequest): StreamEvent {
  return {
    id: "evt_decision",
    streamId: "stream_1",
    sequence: "20",
    broadcastSequence: "12",
    eventType: "decision:requested",
    actorId: BOT.id,
    actorType: "bot",
    createdAt: "2026-09-16T09:00:00.000Z",
    payload: { decisionId: request.id, decision: request },
  }
}

function renderCard(opts?: { request?: DecisionRequest; statusPatch?: DecisionResolvedEventPayload }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <TooltipProvider>
          <PanelProvider>
            <DecisionEvent
              event={requestedEvent(opts?.request ?? decision())}
              workspaceId="ws_1"
              streamId="stream_1"
              statusPatch={opts?.statusPatch}
            />
          </PanelProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("DecisionEvent", () => {
  it("renders the request from the payload: requester, title, body, one button per option with its tone", () => {
    renderCard()

    expect(screen.getByText("Kris's Runner")).toBeInTheDocument()
    expect(screen.getByText("Force-push the rebased branch?")).toBeInTheDocument()
    expect(screen.getByText(/The rebase dropped/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Force-push" }).className).toContain("bg-primary")
    expect(screen.getByRole("button", { name: "Wait for me" }).className).toContain("border-input")
    expect(screen.getByRole("button", { name: "Abort" }).className).toContain("text-destructive")
  })

  it("falls back to 'A bot' when the requester is not a bot this viewer knows", () => {
    renderCard({ request: decision({ requesterBotId: "bot_unknown" }) })
    expect(screen.getByText("A bot")).toBeInTheDocument()
  })

  it("shows the note field only when the request allows a note", () => {
    renderCard()
    expect(screen.queryByLabelText("Note (optional)")).not.toBeInTheDocument()

    renderCard({ request: decision({ allowNote: true }) })
    expect(screen.getByLabelText("Note (optional)")).toBeInTheDocument()
  })

  it("resolves with the clicked option, the typed note and the card's version, then flips in place", async () => {
    const resolve = vi.spyOn(decisionsApi, "resolve").mockResolvedValue({
      decision: decision({
        status: "resolved",
        version: 4,
        resolution: {
          optionId: "opt_yes",
          note: "only if CI is green",
          decidedBy: "usr_kris",
          decidedAt: "2026-09-16T09:05:00.000Z",
        },
      }),
    })
    const success = vi.spyOn(toast, "success")

    renderCard({ request: decision({ allowNote: true }) })
    await userEvent.type(screen.getByLabelText("Note (optional)"), "only if CI is green")
    await userEvent.click(screen.getByRole("button", { name: "Force-push" }))

    expect(resolve).toHaveBeenCalledWith("ws_1", "dec_1", {
      optionId: "opt_yes",
      note: "only if CI is green",
      version: 3,
    })
    // Flips in place: the other options drop, the chosen one stays. INV-63: no success toast.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Wait for me" })).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: /Force-push/ })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText("only if CI is green")).toBeInTheDocument()
    expect(success).not.toHaveBeenCalled()
  })

  it("omits the note when the field is left empty", async () => {
    const resolve = vi.spyOn(decisionsApi, "resolve").mockResolvedValue({ decision: decision() })

    renderCard({ request: decision({ allowNote: true }) })
    await userEvent.click(screen.getByRole("button", { name: "Wait for me" }))

    expect(resolve).toHaveBeenCalledWith("ws_1", "dec_1", { optionId: "opt_wait", note: undefined, version: 3 })
  })

  it("reconciles from the server when the resolve lost the race", async () => {
    vi.spyOn(decisionsApi, "resolve").mockRejectedValue(
      new ApiError(
        409,
        "DECISION_NOT_OPEN",
        "Decision is not open",
        decision({
          status: "resolved",
          version: 4,
          resolution: { optionId: "opt_abort", decidedBy: "usr_kris", decidedAt: "2026-09-16T09:05:00.000Z" },
        }) as unknown as Record<string, unknown>
      )
    )
    const info = vi.spyOn(toast, "info").mockImplementation(() => "")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Force-push" }))

    await waitFor(() => expect(screen.getByRole("button", { name: /Abort/ })).toHaveAttribute("aria-disabled", "true"))
    expect(screen.queryByRole("button", { name: "Force-push" })).not.toBeInTheDocument()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it("keeps the card open with one toast when the 409 carries no row", async () => {
    vi.spyOn(decisionsApi, "resolve").mockRejectedValue(new ApiError(409, "DECISION_NOT_OPEN", "Decision is not open"))
    const info = vi.spyOn(toast, "info").mockImplementation(() => "")
    const error = vi.spyOn(toast, "error").mockImplementation(() => "")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Force-push" }))

    await waitFor(() => expect(info).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: "Wait for me" })).toBeInTheDocument()
    expect(error).not.toHaveBeenCalled()
  })

  it("keeps the pressed button mounted and focused when the answer lands", async () => {
    vi.spyOn(decisionsApi, "resolve").mockResolvedValue({
      decision: decision({
        status: "resolved",
        version: 4,
        resolution: { optionId: "opt_yes", decidedBy: "usr_kris", decidedAt: "2026-09-16T09:05:00.000Z" },
      }),
    })

    renderCard()
    const pressed = screen.getByRole("button", { name: "Force-push" })
    await userEvent.click(pressed)

    await waitFor(() => expect(screen.queryByRole("button", { name: "Wait for me" })).not.toBeInTheDocument())
    expect(pressed).toBeInTheDocument()
    expect(document.activeElement).toBe(pressed)
    expect(pressed).toHaveAttribute("aria-disabled", "true")
    expect(pressed).toHaveAttribute("aria-live", "polite")
    expect(pressed).toHaveAccessibleName("Chosen: Force-push")
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument()
  })

  it("says the requester asked for a decision once it is terminal", () => {
    renderCard({ request: decision({ status: "cancelled" }) })
    expect(screen.getByText(/asked for a decision/)).toBeInTheDocument()
  })

  it("shows the failure toast when the resolve call throws anything else", async () => {
    vi.spyOn(decisionsApi, "resolve").mockRejectedValue(new Error("boom"))
    const error = vi.spyOn(toast, "error").mockImplementation(() => "")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Force-push" }))

    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: "Force-push" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Wait for me" })).toBeInTheDocument()
  })

  it("renders the authoritative resolved patch: chosen label, decider, note, no buttons", () => {
    renderCard({
      statusPatch: {
        decisionId: "dec_1",
        status: "resolved",
        version: 4,
        resolution: {
          optionId: "opt_abort",
          note: "the branch is shared",
          decidedBy: "usr_kris",
          decidedAt: "2026-09-16T09:05:00.000Z",
        },
      },
    })

    expect(screen.getByRole("button", { name: /Abort/ })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText(/Kristoffer Remback/)).toBeInTheDocument()
    expect(screen.getByText("the branch is shared")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Force-push" })).not.toBeInTheDocument()
  })

  it("does not let a lower-version patch regress a higher one it already applied", () => {
    const { rerender } = renderCard({
      statusPatch: {
        decisionId: "dec_1",
        status: "resolved",
        version: 5,
        resolution: { optionId: "opt_abort", decidedBy: "usr_kris", decidedAt: "2026-09-16T09:05:00.000Z" },
      },
    })
    expect(screen.getByRole("button", { name: /Abort/ })).toBeInTheDocument()

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
          <TooltipProvider>
            <PanelProvider>
              <DecisionEvent
                event={requestedEvent(decision())}
                workspaceId="ws_1"
                streamId="stream_1"
                statusPatch={{
                  decisionId: "dec_1",
                  status: "cancelled",
                  version: 4,
                }}
              />
            </PanelProvider>
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )

    expect(screen.getByRole("button", { name: /Abort/ })).toBeInTheDocument()
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument()
  })

  it("renders a cancelled request as terminal with no buttons", () => {
    renderCard({ request: decision({ status: "cancelled" }) })
    expect(screen.getByText("Cancelled")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Force-push" })).not.toBeInTheDocument()
  })

  it("renders an expired request as terminal with no decider", () => {
    renderCard({ request: decision({ status: "expired" }) })
    expect(screen.getByText("Expired")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument()
  })

  it("renders nothing without a payload", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <PanelProvider>
          <DecisionEvent
            event={{ ...requestedEvent(decision()), payload: undefined }}
            workspaceId="ws_1"
            streamId="stream_1"
          />
        </PanelProvider>
      </MemoryRouter>
    )
    expect(container).toBeEmptyDOMElement()
  })
})

/**
 * A sealed card on an encrypted stream: the wire carries placeholders where the
 * question is, and the words live in `ciphertext`. These cases drive the card
 * through the decrypt layer's states with the cache and session stubbed — the
 * crypto itself is covered in `lib/crypto/decision-card.test.ts`.
 */
describe("DecisionEvent (sealed card)", () => {
  const PLACEHOLDER = "\u200b"

  function sealedDecision(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
    return decision({
      title: PLACEHOLDER,
      bodyMarkdown: PLACEHOLDER,
      options: [
        { id: "opt_yes", label: PLACEHOLDER, tone: "primary" },
        { id: "opt_wait", label: PLACEHOLDER, tone: "neutral" },
      ],
      ciphertext: "Y2lwaGVy",
      envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" },
      ...overrides,
    })
  }

  function unlock() {
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "unlocked",
      keyId: "ek_1",
      publicKey: null,
      privateKey: {} as CryptoKey,
      deviceTrusted: true,
      error: null,
    } as ReturnType<typeof e2eSessionModule.useE2eSession>)
    vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue({
      id: "stream_1",
      rootStreamId: null,
    } as ReturnType<typeof streamStoreModule.useStreamFromStore>)
    vi.spyOn(decisionCacheModule, "requestSealedDecision").mockResolvedValue({ status: "pending", value: null })
    vi.spyOn(decisionCacheModule, "requestSealedDecisionNote").mockResolvedValue({ status: "pending", value: null })
  }

  function cacheCard(value: { title: string; bodyMarkdown?: string; optionLabels: Record<string, string> }) {
    vi.spyOn(decisionCacheModule, "getCachedSealedDecision").mockReturnValue({ status: "decrypted", value })
  }

  it("shows a lock notice and no way to answer while the session is locked", () => {
    renderCard({ request: sealedDecision({ allowNote: true }) })

    expect(screen.getByText("Unlock this scratchpad to read this decision")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /.+/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Note (optional)")).not.toBeInTheDocument()
  })

  it("renders the decrypted question and option labels once the card opens", () => {
    unlock()
    cacheCard({
      title: "Force-push the rebased branch?",
      bodyMarkdown: "The rebase dropped **two** commits.",
      optionLabels: { opt_yes: "Force-push", opt_wait: "Wait for me" },
    })

    renderCard({ request: sealedDecision() })

    expect(screen.getByText("Force-push the rebased branch?")).toBeInTheDocument()
    expect(screen.getByText(/The rebase dropped/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Force-push" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Wait for me" })).toBeInTheDocument()
  })

  it("seals the note and sends it in place of the plaintext one", async () => {
    unlock()
    cacheCard({ title: "Force-push?", optionLabels: { opt_yes: "Force-push", opt_wait: "Wait for me" } })
    const envelope = { v: 2, keyGeneration: 1, iv: "aXY=", aad: "bm90ZQ==" }
    const seal = vi
      .spyOn(decisionCardModule, "sealDecisionNote")
      .mockResolvedValue({ ciphertext: "c2VhbGVk", envelope })
    const resolve = vi.spyOn(decisionsApi, "resolve").mockResolvedValue({
      decision: sealedDecision({
        status: "resolved",
        version: 4,
        resolution: {
          optionId: "opt_yes",
          noteCiphertext: "c2VhbGVk",
          noteEnvelope: envelope,
          decidedBy: "usr_kris",
          decidedAt: "2026-09-16T09:05:00.000Z",
        },
      }),
    })

    renderCard({ request: sealedDecision({ allowNote: true }) })
    await userEvent.type(screen.getByLabelText("Note (optional)"), "only if CI is green")
    await userEvent.click(screen.getByRole("button", { name: "Force-push" }))

    await waitFor(() => expect(resolve).toHaveBeenCalled())
    expect(seal).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionId: "dec_1",
        streamId: "stream_1",
        decidedBy: "usr_kris",
        note: "only if CI is green",
      })
    )
    expect(resolve).toHaveBeenCalledWith("ws_1", "dec_1", {
      optionId: "opt_yes",
      note: undefined,
      sealedNote: { ciphertext: "c2VhbGVk", envelope },
      version: 3,
    })
  })

  it("keeps the answer unsent when the note can't be sealed", async () => {
    unlock()
    cacheCard({ title: "Force-push?", optionLabels: { opt_yes: "Force-push", opt_wait: "Wait for me" } })
    vi.spyOn(decisionCardModule, "sealDecisionNote").mockRejectedValue(new Error("no key"))
    const resolve = vi.spyOn(decisionsApi, "resolve")
    const error = vi.spyOn(toast, "error")

    renderCard({ request: sealedDecision({ allowNote: true }) })
    await userEvent.type(screen.getByLabelText("Note (optional)"), "only if CI is green")
    await userEvent.click(screen.getByRole("button", { name: "Force-push" }))

    await waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't seal your note"))
    expect(resolve).not.toHaveBeenCalled()
  })

  it("shows the decrypted note on a card that has been answered", () => {
    unlock()
    cacheCard({ title: "Force-push?", optionLabels: { opt_yes: "Force-push", opt_wait: "Wait for me" } })
    vi.spyOn(decisionCacheModule, "getCachedSealedDecisionNote").mockReturnValue({
      status: "decrypted",
      value: "only if CI is green",
    })

    renderCard({
      request: sealedDecision({
        status: "resolved",
        version: 4,
        resolution: {
          optionId: "opt_yes",
          noteCiphertext: "c2VhbGVk",
          noteEnvelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "bm90ZQ==" },
          decidedBy: "usr_kris",
          decidedAt: "2026-09-16T09:05:00.000Z",
        },
      }),
    })

    expect(screen.getByText("only if CI is green")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Force-push/ })).toBeInTheDocument()
  })
})
