import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { toast } from "sonner"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PersonaConfigResponse, PersonaResolvedConfig } from "@threa/types"
import { personasApi, streamsApi } from "@/api"
import { ServicesProvider } from "@/contexts"
import { spyOnExport } from "@/test"
import * as streamContentModule from "@/components/timeline"
import { personaKeys, usePersonaConfig } from "@/hooks/use-personas"
import * as drawerModule from "@/components/ui/drawer"
import { PersonaTestChatDrawer, PersonaTestChatPane } from "./persona-test-chat"

const WS = "ws_1"
const PERSONA = "persona_system_ariadne"

let streamContentProps: { workspaceId: string; streamId: string; autoFocus?: boolean } | null = null
function StreamContentStub(props: { workspaceId: string; streamId: string; autoFocus?: boolean }) {
  streamContentProps = props
  return <div data-testid="test-chat-surface">{props.streamId}</div>
}

beforeEach(() => {
  streamContentProps = null
  spyOnExport(streamContentModule, "StreamContent").mockReturnValue(StreamContentStub as never)
})
afterEach(() => vi.restoreAllMocks())

function resolved(): PersonaResolvedConfig {
  return {
    id: PERSONA,
    workspaceId: null,
    slug: "ariadne",
    name: "Ariadne",
    description: null,
    avatarEmoji: ":thread:",
    systemPrompt: "You are Ariadne.",
    model: "openrouter:anthropic/claude-sonnet-4.6",
    escalationModel: null,
    temperature: null,
    maxTokens: null,
    enabledTools: ["send_message"],
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "system",
    status: "active",
    visibility: "visible",
    e2eCapable: true,
  }
}

function config(testStreamId: string | null): PersonaConfigResponse {
  const r = resolved()
  return {
    kind: "builtin",
    defaults: r,
    overridePatch: null,
    overrideUpdatedAt: null,
    resolved: r,
    draft: testStreamId ? { patch: {}, testStreamId, updatedAt: "2026-07-11T00:00:00Z" } : null,
    availableModels: [{ id: "openrouter:anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" }],
  }
}

function makeClient(initial: PersonaConfigResponse) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(personaKeys.config(WS, PERSONA), initial)
  return queryClient
}

/** Drives `testStreamId` off the config cache exactly like the page does, so the
 *  hook's cache write is what mounts/unmounts the chat surface. */
function PaneHarness() {
  const { data } = usePersonaConfig(WS, PERSONA)
  return (
    <PersonaTestChatPane
      workspaceId={WS}
      personaId={PERSONA}
      testStreamId={data?.draft?.testStreamId ?? null}
      syncState="synced"
    />
  )
}

function renderPane(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider>
        <MemoryRouter>
          <PaneHarness />
        </MemoryRouter>
      </ServicesProvider>
    </QueryClientProvider>
  )
}

describe("PersonaTestChatPane", () => {
  it("starts a test chat: creates the stream and mounts the chat surface", async () => {
    const create = vi.spyOn(personasApi, "createTestStream").mockResolvedValue({ streamId: "stream_test_1" })
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config(null))
    const user = userEvent.setup()
    renderPane(makeClient(config(null)))

    expect(screen.queryByTestId("test-chat-surface")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Start test chat" }))

    expect(create).toHaveBeenCalledWith(WS, PERSONA)
    await waitFor(() => expect(screen.getByTestId("test-chat-surface")).toBeInTheDocument())
    expect(streamContentProps).toMatchObject({ workspaceId: WS, streamId: "stream_test_1", autoFocus: true })
  })

  it("ends a test chat: archives the stream and returns to the empty state", async () => {
    const archive = vi.spyOn(streamsApi, "archive").mockResolvedValue(undefined)
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config("stream_test_1"))
    const user = userEvent.setup()
    renderPane(makeClient(config("stream_test_1")))

    expect(screen.getByTestId("test-chat-surface")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "End test chat" }))

    expect(archive).toHaveBeenCalledWith(WS, "stream_test_1")
    await waitFor(() => expect(screen.getByRole("button", { name: "Start test chat" })).toBeInTheDocument())
    expect(screen.queryByTestId("test-chat-surface")).not.toBeInTheDocument()
  })

  it("keeps the chat mounted and surfaces an error when ending fails", async () => {
    vi.spyOn(streamsApi, "archive").mockRejectedValue(new Error("boom"))
    const toastError = vi.spyOn(toast, "error").mockReturnValue("" as never)
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config("stream_test_1"))
    const user = userEvent.setup()
    renderPane(makeClient(config("stream_test_1")))

    await user.click(screen.getByRole("button", { name: "End test chat" }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // Archive failed → pointer kept → chat still mounted, End re-enabled to retry.
    expect(screen.getByTestId("test-chat-surface")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Start test chat" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "End test chat" })).toBeEnabled()
  })

  it("unmounts the chat surface when the draft's test stream disappears (Save/Discard)", async () => {
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config("stream_test_1"))
    const queryClient = makeClient(config("stream_test_1"))
    renderPane(queryClient)

    expect(screen.getByTestId("test-chat-surface")).toBeInTheDocument()

    // Save/Discard archive the test stream and drop the draft server-side; the
    // config query reflects it → the pane must fall back to the empty state.
    act(() => {
      queryClient.setQueryData(personaKeys.config(WS, PERSONA), config(null))
    })

    await waitFor(() => expect(screen.queryByTestId("test-chat-surface")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Start test chat" })).toBeInTheDocument()
  })
})

/** Drives `testStreamId` off the config cache exactly like the page does. */
function DrawerHarness() {
  const { data } = usePersonaConfig(WS, PERSONA)
  return (
    <PersonaTestChatDrawer
      workspaceId={WS}
      personaId={PERSONA}
      testStreamId={data?.draft?.testStreamId ?? null}
      syncState="synced"
    />
  )
}

function renderDrawer(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider>
        <MemoryRouter>
          <DrawerHarness />
        </MemoryRouter>
      </ServicesProvider>
    </QueryClientProvider>
  )
}

describe("PersonaTestChatDrawer (mobile)", () => {
  beforeEach(() => {
    // Render the vaul Drawer as a plain open/closed container (the established
    // stream-sheet pattern) so the test exercises open/close + mount without a
    // real drawer in jsdom. The stub also exposes an explicit close control.
    spyOnExport(drawerModule, "Drawer").mockReturnValue((({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean
      onOpenChange?: (open: boolean) => void
      children: React.ReactNode
    }) => (
      <div data-state={open ? "open" : "closed"}>
        {open && (
          <button type="button" onClick={() => onOpenChange?.(false)}>
            close-drawer
          </button>
        )}
        {open ? children : null}
      </div>
    )) as unknown as typeof drawerModule.Drawer)
    spyOnExport(drawerModule, "DrawerContent").mockReturnValue((({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    )) as unknown as typeof drawerModule.DrawerContent)
    spyOnExport(drawerModule, "DrawerTitle").mockReturnValue((({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    )) as unknown as typeof drawerModule.DrawerTitle)
  })

  it("opens the drawer, starts the session, and mounts the chat", async () => {
    const create = vi.spyOn(personasApi, "createTestStream").mockResolvedValue({ streamId: "stream_test_9" })
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config(null))
    const user = userEvent.setup()
    renderDrawer(makeClient(config(null)))

    expect(screen.queryByTestId("test-chat-surface")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Test draft" }))

    expect(create).toHaveBeenCalledWith(WS, PERSONA)
    await waitFor(() => expect(screen.getByTestId("test-chat-surface")).toBeInTheDocument())
    expect(streamContentProps).toMatchObject({ workspaceId: WS, streamId: "stream_test_9", autoFocus: true })
  })

  it("closing the drawer keeps the session — close is not End", async () => {
    const archive = vi.spyOn(streamsApi, "archive").mockResolvedValue(undefined)
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config("stream_test_1"))
    const user = userEvent.setup()
    renderDrawer(makeClient(config("stream_test_1")))

    await user.click(screen.getByRole("button", { name: "Test draft" }))
    await waitFor(() => expect(screen.getByTestId("test-chat-surface")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "close-drawer" }))
    // Closing tears down the drawer content but must not archive the stream or
    // drop the draft — the bound session survives so a reopen resumes it.
    expect(screen.queryByTestId("test-chat-surface")).not.toBeInTheDocument()
    expect(archive).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Test draft" }))
    await waitFor(() => expect(screen.getByTestId("test-chat-surface")).toBeInTheDocument())
    expect(archive).not.toHaveBeenCalled()
  })

  it("ends the test chat inside the drawer, archiving and returning to the empty state", async () => {
    const archive = vi.spyOn(streamsApi, "archive").mockResolvedValue(undefined)
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config("stream_test_1"))
    const user = userEvent.setup()
    renderDrawer(makeClient(config("stream_test_1")))

    await user.click(screen.getByRole("button", { name: "Test draft" }))
    expect(screen.getByTestId("test-chat-surface")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "End test chat" }))

    expect(archive).toHaveBeenCalledWith(WS, "stream_test_1")
    await waitFor(() => expect(screen.getByRole("button", { name: "Start test chat" })).toBeInTheDocument())
    expect(screen.queryByTestId("test-chat-surface")).not.toBeInTheDocument()
  })
})
